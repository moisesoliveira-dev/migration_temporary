import { runTicketMigration } from '../migration/messages.js';

async function main() {
  const ticketId = process.argv[2];
  const onlyTicket = process.argv.includes('--only-ticket');
  if (!ticketId) {
    console.error('Uso: node src/scripts/migrate-ticket.js <ticketId> [--only-ticket]');
    process.exit(1);
  }

  const result = await runTicketMigration({ ticketId, onlyTicket }, (event) => {
    if (event.type === 'pages') {
      process.stdout.write(`\r  página ${event.page} (${event.loaded}/${event.total || '?'} msgs)`);
      return;
    }
    if (event.type === 'start') {
      console.log(`Database: ${event.database}`);
      return;
    }
    if (event.type === 'log') console.error(event.message);
  });

  process.stdout.write('\n');
  console.log(
    `Contato ${result.contactId || '?'} | api_count=${result.apiCount} | a gravar=${result.selected}${onlyTicket ? ` (só ticket #${ticketId})` : ''}`,
  );
  console.log(`Concluído. novas=${result.ok} ja_no_couch=${result.skipped} falhas=${result.fail}`);
}

main().catch((error) => {
  console.error('Erro na migração:', error.response?.data || error.message);
  process.exit(1);
});
