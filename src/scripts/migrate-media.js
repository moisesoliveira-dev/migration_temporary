import { config } from '../config.js';
import { runMediaMigration } from '../migration/media.js';

function parseArgs(argv) {
  const opts = { delayMs: 150, max: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--delay' && argv[i + 1]) opts.delayMs = Number(argv[++i]);
    if (argv[i] === '--max' && argv[i + 1]) opts.max = Number(argv[++i]);
  }
  return opts;
}

async function main() {
  if (!config.mediaMigrateEnabled) {
    console.log(
      'MEDIA_MIGRATE_ENABLED=false — migração de mídia desligada. Nenhum arquivo foi alterado.',
    );
    process.exit(0);
  }

  const opts = parseArgs(process.argv.slice(2));
  const result = await runMediaMigration(opts, (event) => {
    if (event.type === 'start') {
      console.log(
        `Migração de mídia | origem=${event.sourceDatabase} → destino=${event.mediaDatabase} | delay=${opts.delayMs}ms | max=${opts.max === Infinity ? 'todos' : opts.max}`,
      );
      console.log('Vai analisar TODAS as mensagens com mídia. 404 = arquivo excluído no Gosac (continua).');
      return;
    }
    if (event.type === 'media') {
      process.stdout.write(`[${event.index}/${event.max ?? '?'}] ${event.messageId}... `);
      return;
    }
    if (event.type === 'log') {
      console.log(event.message.replace(/^msg:[^\s]+\s/, ''));
    }
  });

  console.log('\n========== RESUMO MÍDIA ==========');
  console.log(`scanned_msgs=${result.scanned}`);
  console.log(`com_midia=${result.withMedia}`);
  console.log(`tentados=${result.attempted}`);
  console.log(`novas_ok=${result.ok}`);
  console.log(`ja_no_couch=${result.skipped}`);
  console.log(`falhas_404_excluidos=${result.fail404}`);
  console.log(`falhas_outras=${result.failOther}`);
  if (result.reportId) console.log(`relatório=${result.reportId}`);
  console.log('==================================');
}

main().catch((error) => {
  console.error('Erro na migração de mídia:', error.response?.data || error.message);
  process.exit(1);
});
