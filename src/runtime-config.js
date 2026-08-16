import { config } from './config.js';
import { loadSettings } from './settings.js';

/**
 * Nomes efetivos de database (settings runtime sobrescrevem .env).
 */
export async function getMessageDatabaseName() {
  const settings = await loadSettings();
  return settings.couchdbDatabase || config.couchdb.database;
}

export async function getMediaDatabaseName() {
  const settings = await loadSettings();
  if (settings.couchdbMediaDatabase) return settings.couchdbMediaDatabase;
  try {
    return config.couchdb.mediaDatabase;
  } catch {
    return process.env.COUCHDB_MEDIA_DATABASE || 'gosac_media';
  }
}

export function getEnvSnapshot() {
  return {
    gosacBaseUrl: config.gosac.baseUrl,
    couchdbDatabaseEnv: config.couchdb.database,
    couchdbMediaDatabaseEnv: (() => {
      try {
        return config.couchdb.mediaDatabase;
      } catch {
        return null;
      }
    })(),
    migrateEnabledEnv: config.migrateEnabled,
    mediaMigrateEnabledEnv: config.mediaMigrateEnabled,
  };
}
