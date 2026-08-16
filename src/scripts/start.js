import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { startControlPanel } from '../server/index.js';

/**
 * Entry point do Railway / produção.
 *
 * - CONTROL_PANEL=true  → sobe painel web (sync contínuo/diário + jobs)
 * - senão: one-shot pelas flags MIGRATE_* (comportamento antigo)
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

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
  if (envFlag('CONTROL_PANEL', false)) {
    console.log('CONTROL_PANEL=true — iniciando painel de controle (processo persistente).');
    await startControlPanel();
    return;
  }

  const runMessages = config.migrateEnabled;
  const runMedia = config.mediaMigrateEnabled;

  console.log('Controle de deploy:');
  console.log(`  CONTROL_PANEL=false (one-shot)`);
  console.log(`  MIGRATE_ENABLED=${runMessages}`);
  console.log(`  MEDIA_MIGRATE_ENABLED=${runMedia}`);

  if (!runMessages && !runMedia) {
    console.log(
      'Nenhuma migração ligada. Deploy ok; nenhum dado foi alterado no CouchDB.',
    );
    console.log('Dica: use CONTROL_PANEL=true para o painel web com sync contínuo.');
    process.exit(0);
  }

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
