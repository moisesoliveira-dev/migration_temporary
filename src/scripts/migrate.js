import { config } from '../config.js';
import { runFullMessageMigration } from '../migration/messages.js';

/**
 * CLI da migração completa (usa a mesma engine do painel).
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

async function main() {
  if (!config.migrateEnabled) {
    console.log(
      'MIGRATE_ENABLED=false — migração desligada. Deploy ok; nenhum dado foi alterado no CouchDB.',
    );
    process.exit(0);
  }

  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Migração por contato | confirmação=CouchDB | delay_contato=${opts.delayMs}ms | delay_pagina=${opts.pageDelayMs}ms | delay_msg=${opts.messageDelayMs}ms`,
  );

  const result = await runFullMessageMigration(opts, (event) => {
    if (event.type === 'log') {
      const fn = event.level === 'error' ? console.error : event.level === 'warn' ? console.warn : console.log;
      fn(event.message);
      return;
    }
    if (event.type === 'start') {
      console.log('Checkpoint local:', event.checkpoint);
      console.log(`Database: ${event.database}`);
      return;
    }
    if (event.type === 'pages') {
      const totalPages = event.total ? Math.ceil(event.total / 20) : '?';
      process.stdout.write(`\r  páginas ${event.page}/${totalPages} (${event.loaded}/${event.total || '?'} msgs)`);
      return;
    }
    if (event.type === 'contact') {
      console.log(`Contato ${event.contactId} (${event.name}) via ticket #${event.ticketId}:`);
      return;
    }
    if (event.type === 'contact_done') {
      process.stdout.write('\n');
      console.log(
        `  total=${event.messages} (api_count=${event.apiCount}) | novas=${event.ok} | ja_no_couch=${event.skipped} | falhas=${event.fail} | tickets_do_contato=${event.tickets}`,
      );
      if (event.fail > 0) {
        console.log(`  contato ${event.contactId} NÃO marcado como concluído (houve falhas)`);
      }
    }
  });

  console.log(
    `\nMigração finalizada. contatos_ok=${result.contactsDone} contatos_pulados=${result.contactsSkipped} msgs_novas=${result.totalOk} ja_no_couch=${result.totalSkipped} falhas=${result.totalFail}`,
  );
}

main().catch((error) => {
  console.error('Erro na migração:', error.response?.data || error.message);
  process.exit(1);
});
