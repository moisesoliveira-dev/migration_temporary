import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

function createInitialState() {
  const now = new Date().toISOString();
  return {
    version: 3,
    startedAt: now,
    updatedAt: now,
    // contatos cujo histórico completo já foi gravado e confirmado no CouchDB
    processedContacts: {},
    stats: {
      contactsDone: 0,
      messagesOk: 0,
      messagesSkipped: 0,
      messagesFail: 0,
    },
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return createInitialState();
    throw error;
  }
}

/**
 * Checkpoint da migração por contato.
 * Um contato só entra aqui depois que TODAS as mensagens do seu histórico
 * foram gravadas (ou confirmadas existentes) no CouchDB.
 */
export async function createMigrationState(filePath = process.env.MIGRATION_STATE_FILE) {
  const resolvedPath = path.resolve(filePath || '.migration-state.json');
  let state = await readJsonIfExists(resolvedPath);

  if (state.version !== 3) {
    state = createInitialState();
  }

  async function save() {
    state.updatedAt = new Date().toISOString();
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    const tmpPath = `${resolvedPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmpPath, resolvedPath);
  }

  return {
    filePath: resolvedPath,

    hasProcessedContact(contactId) {
      return Boolean(state.processedContacts[String(contactId)]);
    },

    async markContactProcessed(contactId, info) {
      state.processedContacts[String(contactId)] = {
        processedAt: new Date().toISOString(),
        ...info,
      };
      state.stats.contactsDone = Object.keys(state.processedContacts).length;
      if (info?.stats) {
        state.stats.messagesOk += info.stats.ok || 0;
        state.stats.messagesSkipped += info.stats.skipped || 0;
        state.stats.messagesFail += info.stats.fail || 0;
      }
      await save();
    },

    async clear() {
      try {
        await unlink(resolvedPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      state = createInitialState();
    },

    getStats() {
      return { ...state.stats };
    },
  };
}
