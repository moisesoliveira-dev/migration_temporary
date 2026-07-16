import { createGosacClient } from '../gosac/client.js';
import { docExists, getCouchDatabase, messageToDoc, upsertDoc } from '../couchdb/client.js';

/**
 * Migra o histórico completo do contato de um ticket para o CouchDB.
 * (A API /messages/:ticketId devolve todas as conversas do contato.)
 *
 * Uso:
 *   node src/scripts/migrate-ticket.js <ticketId>
 *   node src/scripts/migrate-ticket.js <ticketId> --only-ticket   # grava só msgs desse ticket
 */
async function main() {
  const ticketId = process.argv[2];
  const onlyTicket = process.argv.includes('--only-ticket');
  if (!ticketId) {
    console.error('Uso: node src/scripts/migrate-ticket.js <ticketId> [--only-ticket]');
    process.exit(1);
  }

  const gosac = createGosacClient();
  const db = await getCouchDatabase();

  const { messages, count, ticket } = await gosac.getAllMessages(
    ticketId,
    { pageDelayMs: 200 },
    (page, batch, total) => {
      process.stdout.write(`\r  página ${page} (${Math.min(page * 20, total)}/${total} msgs)`);
    },
  );
  process.stdout.write('\n');

  const unique = new Map();
  for (const message of messages) unique.set(message.id, message);

  let selected = [...unique.values()];
  if (onlyTicket) {
    selected = selected.filter((m) => String(m.ticketId) === String(ticketId));
  }
  selected.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  console.log(
    `Contato ${ticket?.contactId} (${ticket?.contact?.name || '?'}) | api_count=${count} | a gravar=${selected.length}${onlyTicket ? ` (só ticket #${ticketId})` : ''}`,
  );

  let ok = 0;
  let skipped = 0;
  let fail = 0;

  for (const message of selected) {
    const doc = messageToDoc(message, String(message.ticketId) === String(ticketId) ? ticket : undefined);
    try {
      if (await docExists(db, doc._id)) {
        skipped += 1;
      } else {
        await upsertDoc(db, doc);
        ok += 1;
      }
    } catch (error) {
      fail += 1;
      console.error(`Falha na mensagem ${message.id}:`, error.message);
    }
  }

  console.log(`Concluído. novas=${ok} ja_no_couch=${skipped} falhas=${fail}`);
}

main().catch((error) => {
  console.error('Erro na migração:', error.response?.data || error.message);
  process.exit(1);
});
