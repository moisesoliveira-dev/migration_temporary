import { config } from '../config.js';
import { createGosacClient } from '../gosac/client.js';
import { docExists, getCouchDatabase, messageToDoc, upsertDoc } from '../couchdb/client.js';
import { createMigrationState } from '../migration/state.js';

/**
 * Migra o histórico COMPLETO de mensagens para o CouchDB.
 *
 * A API GET /messages/:ticketId devolve o histórico inteiro do CONTATO do
 * ticket (todas as conversas dele), paginado em blocos de 20. Por isso a
 * migração agrupa tickets por contato e busca o histórico de cada contato
 * uma única vez, paginando até hasMore=false.
 *
 * Confirmação de envio: somente o CouchDB (documento msg:<id> existente).
 * Controle de deploy: MIGRATE_ENABLED=true|false
 *
 * Uso:
 *   node src/scripts/migrate.js
 *   node src/scripts/migrate.js --reset
 *   node src/scripts/migrate.js --status open
 *   node src/scripts/migrate.js --max-contacts 5
 *   node src/scripts/migrate.js --delay 500 --message-delay 20 --page-delay 300
 */
function parseArgs(argv) {
  const opts = {
    delayMs: 500,
    messageDelayMs: 20,
    pageDelayMs: 300,
    maxContacts: Infinity,
    status: undefined,
    reset: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reset') opts.reset = true;
    if (argv[i] === '--status' && argv[i + 1]) opts.status = argv[++i];
    if (argv[i] === '--max-contacts' && argv[i + 1]) opts.maxContacts = Number(argv[++i]);
    if (argv[i] === '--delay' && argv[i + 1]) opts.delayMs = Number(argv[++i]);
    if (argv[i] === '--message-delay' && argv[i + 1]) opts.messageDelayMs = Number(argv[++i]);
    if (argv[i] === '--page-delay' && argv[i + 1]) opts.pageDelayMs = Number(argv[++i]);
  }
  return opts;
}

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

async function main() {
  if (!config.migrateEnabled) {
    console.log(
      'MIGRATE_ENABLED=false — migração desligada. Deploy ok; nenhum dado foi alterado no CouchDB.',
    );
    process.exit(0);
  }

  const opts = parseArgs(process.argv.slice(2));
  const gosac = createGosacClient();
  const db = await getCouchDatabase();
  const state = await createMigrationState();

  if (opts.reset) {
    await state.clear();
    console.log('Checkpoint local zerado.');
  }

  const ticketParams = {};
  if (opts.status) ticketParams.status = opts.status;

  console.log(
    `Migração por contato | confirmação=CouchDB | delay_contato=${opts.delayMs}ms | delay_pagina=${opts.pageDelayMs}ms | delay_msg=${opts.messageDelayMs}ms`,
  );
  console.log('Checkpoint local:', state.getStats());

  let contactsDone = 0;
  let contactsSkipped = 0;
  let totalOk = 0;
  let totalSkipped = 0;
  let totalFail = 0;

  let ticketPage = 1;
  let hasMoreTickets = true;

  while (hasMoreTickets && contactsDone < opts.maxContacts) {
    const { tickets, hasMore } = await gosac.getTickets({
      ...ticketParams,
      pageNumber: ticketPage,
    });
    console.log(`\nPágina de tickets ${ticketPage}: +${tickets.length}`);

    for (const ticket of tickets) {
      if (contactsDone >= opts.maxContacts) break;

      const contactId = ticket.contactId ?? ticket.contact?.id;
      if (!contactId) {
        console.log(`[skip] ticket #${ticket.id} sem contactId`);
        continue;
      }

      if (state.hasProcessedContact(contactId)) {
        contactsSkipped += 1;
        continue;
      }

      const contactName = ticket.contact?.name || `contato ${contactId}`;
      console.log(`Contato ${contactId} (${contactName}) via ticket #${ticket.id}:`);

      try {
        const { messages, count } = await gosac.getAllMessages(
          ticket.id,
          { pageDelayMs: opts.pageDelayMs },
          (page, batch, total) => {
            const totalPages = total ? Math.ceil(total / 20) : '?';
            process.stdout.write(`\r  páginas ${page}/${totalPages} (${page * 20 >= total ? total : page * 20}/${total} msgs)`);
          },
        );
        process.stdout.write('\n');

        // dedup por id (paginação desc pode repetir itens se chegarem msgs novas no meio)
        const unique = new Map();
        for (const message of messages) unique.set(message.id, message);
        const ordered = sortByDate([...unique.values()]);

        let ok = 0;
        let skipped = 0;
        let fail = 0;

        for (let i = 0; i < ordered.length; i += 1) {
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
            console.error(`  mensagem ${message.id}: ${error.message}`);
          }

          if (opts.messageDelayMs > 0 && i < ordered.length - 1) {
            await sleep(opts.messageDelayMs);
          }
        }

        const ticketIds = [...new Set(ordered.map((m) => m.ticketId))];
        console.log(
          `  total=${ordered.length} (api_count=${count}) | novas=${ok} | ja_no_couch=${skipped} | falhas=${fail} | tickets_do_contato=${ticketIds.length}`,
        );

        totalOk += ok;
        totalSkipped += skipped;
        totalFail += fail;

        if (fail === 0) {
          await state.markContactProcessed(contactId, {
            name: contactName,
            viaTicketId: ticket.id,
            messages: ordered.length,
            tickets: ticketIds.length,
            stats: { ok, skipped, fail },
          });
          contactsDone += 1;
        } else {
          console.log(`  contato ${contactId} NÃO marcado como concluído (houve falhas)`);
        }
      } catch (error) {
        console.error(`  ERRO no contato ${contactId}: ${error.response?.data?.error || error.message}`);
      }

      if (opts.delayMs > 0) await sleep(opts.delayMs);
    }

    hasMoreTickets = hasMore && tickets.length > 0;
    ticketPage += 1;
    if (hasMoreTickets && opts.pageDelayMs > 0) await sleep(opts.pageDelayMs);
  }

  console.log(
    `\nMigração finalizada. contatos_ok=${contactsDone} contatos_pulados=${contactsSkipped} msgs_novas=${totalOk} ja_no_couch=${totalSkipped} falhas=${totalFail}`,
  );
}

main().catch((error) => {
  console.error('Erro na migração:', error.response?.data || error.message);
  process.exit(1);
});
