import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * MIGRATE_ENABLED:
 * - true / 1 / yes / on  → roda a migração
 * - false / ausente      → sobe e encerra sem migrar (seguro no Railway)
 */
export const config = {
  migrateEnabled: envFlag('MIGRATE_ENABLED', false),
  gosac: {
    baseUrl: (process.env.GOSAC_BASE_URL || 'https://cmmodulados.gosac.com.br').replace(/\/$/, ''),
    get apiKey() {
      return required('GOSAC_API_KEY');
    },
    timeoutMs: Number(process.env.GOSAC_TIMEOUT_MS || 120_000),
    retries: Number(process.env.GOSAC_RETRIES || 3),
    retryDelayMs: Number(process.env.GOSAC_RETRY_DELAY_MS || 2_000),
  },
  couchdb: {
    get url() {
      return required('COUCHDB_URL');
    },
    database: process.env.COUCHDB_DATABASE || 'gosac_messages',
  },
};
