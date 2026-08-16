import { createGosacClient } from '../gosac/client.js';
import { docExists, getCouchDatabase, messageToDoc, upsertDoc } from '../couchdb/client.js';
import { createMigrationState } from './state.js';
import { getMessageDatabaseName } from '../runtime-config.js';

function sortByDate(items, field = 'createdAt') {
  return [...items].sort((a, b) => {
    const ta = new Date(a[field] || 0).getTime();
    const tb = new Date(b[field] || 0).getTime();
    if (ta === tb) return String(a.id).localeCompare(String(b.id));
    return ta - tb;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Migração completa por contato (histórico inteiro).
 * @param {object} opts
 * @param {(event: object) => void} [onProgress]
 * @param {() => boolean} [shouldStop]
 */
export async function runFullMessageMigration(opts = {}, onProgress = () => {}, shouldStop = () => false) {
  const {
    delayMs = 500,
    messageDelayMs = 20,
    pageDelayMs = 300,
    maxContacts = Infinity,
    status,
    reset = false,
    database,
  } = opts;

  const dbName = database || (await getMessageDatabaseName());
  const gosac = createGosacClient();
  const db = await getCouchDatabase(dbName);
  const state = await createMigrationState();

  if (reset) {
    await state.clear();
    onProgress({ type: 'log', level: 'info', message: 'Checkpoint local zerado.' });
  }

  onProgress({
    type: 'start',
    job: 'migrate-messages',
    database: dbName,
    checkpoint: state.getStats(),
  });

  let contactsDone = 0;
  let contactsSkipped = 0;
  let totalOk = 0;
  let totalSkipped = 0;
  let totalFail = 0;
  let ticketPage = 1;
  let hasMoreTickets = true;
  const ticketParams = status ? { status } : {};

  while (hasMoreTickets && contactsDone < maxContacts) {
    if (shouldStop()) break;

    const { tickets, hasMore } = await gosac.getTickets({
      ...ticketParams,
      pageNumber: ticketPage,
    });
    onProgress({
      type: 'log',
      level: 'info',
      message: `Página de tickets ${ticketPage}: +${tickets.length}`,
    });

    for (const ticket of tickets) {
      if (shouldStop() || contactsDone >= maxContacts) break;

      const contactId = ticket.contactId ?? ticket.contact?.id;
      if (!contactId) {
        onProgress({ type: 'log', level: 'warn', message: `ticket #${ticket.id} sem contactId` });
        continue;
      }

      if (state.hasProcessedContact(contactId)) {
        contactsSkipped += 1;
        continue;
      }

      const contactName = ticket.contact?.name || `contato ${contactId}`;
      onProgress({
        type: 'contact',
        contactId,
        name: contactName,
        ticketId: ticket.id,
      });

      try {
        const { messages, count } = await gosac.getAllMessages(
          ticket.id,
          { pageDelayMs },
          (page, _batch, total) => {
            onProgress({
              type: 'pages',
              contactId,
              page,
              total,
              loaded: Math.min(page * 20, total || page * 20),
            });
          },
        );

        const unique = new Map();
        for (const message of messages) unique.set(message.id, message);
        const ordered = sortByDate([...unique.values()]);

        let ok = 0;
        let skipped = 0;
        let fail = 0;

        for (let i = 0; i < ordered.length; i += 1) {
          if (shouldStop()) break;
          const message = ordered[i];
          const doc = messageToDoc(
            message,
            String(message.ticketId) === String(ticket.id) ? ticket : undefined,
          );

          try {
            if (await docExists(db, doc._id)) {
              skipped += 1;
            } else {
              await upsertDoc(db, doc);
              ok += 1;
            }
          } catch (error) {
            fail += 1;
            onProgress({
              type: 'log',
              level: 'error',
              message: `mensagem ${message.id}: ${error.message}`,
            });
          }

          if (messageDelayMs > 0 && i < ordered.length - 1) await sleep(messageDelayMs);
        }

        const ticketIds = [...new Set(ordered.map((m) => m.ticketId))];
        totalOk += ok;
        totalSkipped += skipped;
        totalFail += fail;

        onProgress({
          type: 'contact_done',
          contactId,
          name: contactName,
          messages: ordered.length,
          apiCount: count,
          ok,
          skipped,
          fail,
          tickets: ticketIds.length,
        });

        if (fail === 0 && !shouldStop()) {
          await state.markContactProcessed(contactId, {
            name: contactName,
            viaTicketId: ticket.id,
            messages: ordered.length,
            tickets: ticketIds.length,
            stats: { ok, skipped, fail },
          });
          contactsDone += 1;
        }
      } catch (error) {
        onProgress({
          type: 'log',
          level: 'error',
          message: `ERRO contato ${contactId}: ${error.response?.data?.error || error.message}`,
        });
      }

      if (delayMs > 0) await sleep(delayMs);
    }

    hasMoreTickets = hasMore && tickets.length > 0;
    ticketPage += 1;
    if (hasMoreTickets && pageDelayMs > 0) await sleep(pageDelayMs);
  }

  const result = {
    stopped: shouldStop(),
    database: dbName,
    contactsDone,
    contactsSkipped,
    totalOk,
    totalSkipped,
    totalFail,
    checkpoint: state.getStats(),
  };
  onProgress({ type: 'done', ...result });
  return result;
}

/**
 * Sync incremental: tickets recentes + páginas novas até achar msgs já no CouchDB.
 */
export async function runIncrementalSync(opts = {}, onProgress = () => {}, shouldStop = () => false) {
  const {
    maxTickets = 40,
    messagePages = 3,
    pageDelayMs = 200,
    messageDelayMs = 10,
    database,
    status,
  } = opts;

  const dbName = database || (await getMessageDatabaseName());
  const gosac = createGosacClient();
  const db = await getCouchDatabase(dbName);

  onProgress({ type: 'start', job: 'incremental-sync', database: dbName, maxTickets, messagePages });

  let ticketsScanned = 0;
  let totalOk = 0;
  let totalSkipped = 0;
  let totalFail = 0;
  let ticketPage = 1;
  let hasMore = true;

  while (hasMore && ticketsScanned < maxTickets) {
    if (shouldStop()) break;

    const { tickets, hasMore: more } = await gosac.getTickets({
      pageNumber: ticketPage,
      ...(status ? { status } : {}),
    });

    for (const ticket of tickets) {
      if (shouldStop() || ticketsScanned >= maxTickets) break;
      ticketsScanned += 1;

      const contactName = ticket.contact?.name || `ticket ${ticket.id}`;
      onProgress({
        type: 'ticket',
        ticketId: ticket.id,
        name: contactName,
        index: ticketsScanned,
        max: maxTickets,
      });

      let pageNumber = 1;
      let hitExistingStreak = 0;
      let pagesDone = 0;

      while (pagesDone < messagePages && hitExistingStreak < 10) {
        if (shouldStop()) break;
        const { messages, raw } = await gosac.getMessages(ticket.id, { pageNumber });
        pagesDone += 1;

        if (!messages.length) break;

        for (const message of messages) {
          if (shouldStop()) break;
          const doc = messageToDoc(
            message,
            String(message.ticketId) === String(ticket.id) ? ticket : undefined,
          );
          try {
            if (await docExists(db, doc._id)) {
              totalSkipped += 1;
              hitExistingStreak += 1;
            } else {
              await upsertDoc(db, doc);
              totalOk += 1;
              hitExistingStreak = 0;
            }
          } catch (error) {
            totalFail += 1;
            onProgress({
              type: 'log',
              level: 'error',
              message: `msg ${message.id}: ${error.message}`,
            });
          }
          if (messageDelayMs > 0) await sleep(messageDelayMs);
        }

        if (!raw?.hasMore) break;
        pageNumber += 1;
        if (pageDelayMs > 0) await sleep(pageDelayMs);
      }
    }

    hasMore = more && tickets.length > 0;
    ticketPage += 1;
    if (hasMore && pageDelayMs > 0) await sleep(pageDelayMs);
  }

  const result = {
    stopped: shouldStop(),
    database: dbName,
    ticketsScanned,
    totalOk,
    totalSkipped,
    totalFail,
  };
  onProgress({ type: 'done', ...result });
  return result;
}

/**
 * Migra um ticket/contato pontual.
 */
export async function runTicketMigration(opts = {}, onProgress = () => {}, shouldStop = () => false) {
  const { ticketId, onlyTicket = false, pageDelayMs = 200, database } = opts;
  if (!ticketId) throw new Error('ticketId obrigatório');

  const dbName = database || (await getMessageDatabaseName());
  const gosac = createGosacClient();
  const db = await getCouchDatabase(dbName);

  onProgress({ type: 'start', job: 'migrate-ticket', ticketId, database: dbName });

  const { messages, count, ticket } = await gosac.getAllMessages(
    ticketId,
    { pageDelayMs },
    (page, _batch, total) => {
      onProgress({ type: 'pages', page, total, loaded: Math.min(page * 20, total || page * 20) });
    },
  );

  const unique = new Map();
  for (const message of messages) unique.set(message.id, message);
  let selected = [...unique.values()];
  if (onlyTicket) {
    selected = selected.filter((m) => String(m.ticketId) === String(ticketId));
  }
  selected = sortByDate(selected);

  let ok = 0;
  let skipped = 0;
  let fail = 0;

  for (const message of selected) {
    if (shouldStop()) break;
    const doc = messageToDoc(
      message,
      String(message.ticketId) === String(ticketId) ? ticket : undefined,
    );
    try {
      if (await docExists(db, doc._id)) skipped += 1;
      else {
        await upsertDoc(db, doc);
        ok += 1;
      }
    } catch (error) {
      fail += 1;
      onProgress({ type: 'log', level: 'error', message: error.message });
    }
  }

  const result = {
    stopped: shouldStop(),
    database: dbName,
    ticketId,
    contactId: ticket?.contactId,
    apiCount: count,
    selected: selected.length,
    ok,
    skipped,
    fail,
  };
  onProgress({ type: 'done', ...result });
  return result;
}
