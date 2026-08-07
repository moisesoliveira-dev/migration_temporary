import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/**
 * Entry point do Railway.
 * Roda as migrações conforme as flags:
 * - MIGRATE_ENABLED=true        → mensagens (gosac → COUCHDB_DATABASE)
 * - MEDIA_MIGRATE_ENABLED=true  → arquivos (COUCHDB_DATABASE → COUCHDB_MEDIA_DATABASE)
 *
 * Se as duas estiverem false, encerra sem erro (deploy "parado").
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runNodeScript(scriptName) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, scriptName);
    console.log(`\n========== iniciando ${scriptName} ==========`);
    const child = spawn(process.execPath, [scriptPath, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} saiu com código ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const runMessages = config.migrateEnabled;
  const runMedia = config.mediaMigrateEnabled;

  console.log('Controle de deploy:');
  console.log(`  MIGRATE_ENABLED=${runMessages}`);
  console.log(`  MEDIA_MIGRATE_ENABLED=${runMedia}`);

  if (!runMessages && !runMedia) {
    console.log(
      'Nenhuma migração ligada. Deploy ok; nenhum dado foi alterado no CouchDB.',
    );
    process.exit(0);
  }

  // Força os scripts filhos a rodarem mesmo se a flag interna estiver inconsistente:
  // eles leem as mesmas env vars.
  if (runMessages) {
    await runNodeScript('migrate.js');
  }

  if (runMedia) {
    await runNodeScript('migrate-media.js');
  }

  console.log('\n========== todas as migrações habilitadas finalizaram ==========');
}

main().catch((error) => {
  console.error('Erro no start:', error.message);
  process.exit(1);
});
