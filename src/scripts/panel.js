import { startControlPanel } from '../server/index.js';

/**
 * Sobe o painel web de controle (sync contínuo, diário, jobs, databases).
 *
 *   npm run panel
 *   PORT=3847 ADMIN_TOKEN=segredo npm run panel
 */
startControlPanel().catch((error) => {
  console.error('Falha ao iniciar painel:', error.message);
  process.exit(1);
});
