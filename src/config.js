import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

export const config = {
  gosac: {
    baseUrl: (process.env.GOSAC_BASE_URL || 'https://cmmodulados.gosac.com.br').replace(/\/$/, ''),
    apiKey: required('GOSAC_API_KEY'),
    timeoutMs: Number(process.env.GOSAC_TIMEOUT_MS || 120_000),
    retries: Number(process.env.GOSAC_RETRIES || 3),
    retryDelayMs: Number(process.env.GOSAC_RETRY_DELAY_MS || 2_000),
  },
  couchdb: {
    url: required('COUCHDB_URL'),
    database: process.env.COUCHDB_DATABASE || 'gosac_messages',
  },
};
