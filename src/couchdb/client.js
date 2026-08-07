import nano from 'nano';
import { config } from '../config.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableCouchError(error) {
  const code = error.code || error.cause?.code;
  const reason = String(error.reason || error.message || '');
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    reason.includes('ETIMEDOUT') ||
    reason.includes('ECONNRESET') ||
    reason.includes('ECONNREFUSED') ||
    error.statusCode === 429 ||
    error.statusCode >= 500
  );
}

async function withCouchRetry(label, fn) {
  let lastError;
  const retries = config.couchdb.retries;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableCouchError(error) || attempt === retries) break;

      const waitMs = config.couchdb.retryDelayMs * attempt;
      console.warn(
        `${label}: tentativa ${attempt}/${retries} falhou (${error.code || error.reason || error.message}); retry em ${waitMs}ms`,
      );
      await sleep(waitMs);
    }
  }

  const detail = lastError?.code || lastError?.reason || lastError?.message || String(lastError);
  throw new Error(
    `${label} falhou após ${retries} tentativas: ${detail}. ` +
      'O Railway precisa alcançar o CouchDB na porta 443. Verifique firewall/IP liberado e se o servidor está no ar.',
  );
}

/**
 * Conecta ao CouchDB e garante que o database exista.
 * @param {string} [dbName] nome do database (padrão: COUCHDB_DATABASE)
 */
export async function getCouchDatabase(dbName = config.couchdb.database) {
  const name = dbName;
  console.log(`Conectando ao CouchDB database="${name}"...`);

  const couch = await withCouchRetry(`CouchDB list(${name})`, async () => {
    const client = nano(config.couchdb.url);
    const databases = await client.db.list();
    if (!databases.includes(name)) {
      await client.db.create(name);
      console.log(`Database CouchDB criado: ${name}`);
    }
    return client;
  });

  console.log(`CouchDB OK: database="${name}"`);
  return couch.use(name);
}

/**
 * Upsert de documento por _id (evita duplicar na reexecução).
 */
export async function upsertDoc(db, doc) {
  if (!doc._id) {
    throw new Error('Documento CouchDB precisa de _id');
  }

  try {
    const existing = await db.get(doc._id);
    return db.insert({ ...doc, _rev: existing._rev });
  } catch (error) {
    if (error.statusCode === 404) {
      return db.insert(doc);
    }
    throw error;
  }
}

/**
 * Confirma se um documento já existe no CouchDB sem regravá-lo.
 */
export async function docExists(db, id) {
  try {
    await db.head(id);
    return true;
  } catch (error) {
    if (error.statusCode === 404) return false;
    throw error;
  }
}

/**
 * Transforma mensagem Gosac em documento CouchDB.
 */
export function messageToDoc(message, ticket) {
  return {
    _id: `msg:${message.id}`,
    type: 'message',
    source: 'gosac',
    ticketId: message.ticketId ?? ticket?.id,
    ticket: ticket
      ? {
          id: ticket.id,
          status: ticket.status,
          isGroup: ticket.isGroup,
          contactName: ticket.contact?.name,
          contactNumber: ticket.contact?.number,
        }
      : undefined,
    body: message.body,
    fromMe: message.fromMe,
    mediaType: message.mediaType,
    mediaUrl: message.mediaUrl,
    mediaPath: message.mediaPath,
    kind: message.kind,
    messageId: message.messageId,
    contactId: message.contactId,
    contact: message.contact
      ? {
          id: message.contact.id,
          name: message.contact.name,
          number: message.contact.number,
          isGroup: message.contact.isGroup,
          kind: message.contact.kind,
        }
      : undefined,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    migratedAt: new Date().toISOString(),
    raw: message,
  };
}
