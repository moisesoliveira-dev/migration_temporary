import nano from 'nano';
import { config } from '../config.js';

/**
 * Conecta ao CouchDB e garante que o database exista.
 */
export async function getCouchDatabase() {
  const couch = nano(config.couchdb.url);
  const dbName = config.couchdb.database;

  const databases = await couch.db.list();
  if (!databases.includes(dbName)) {
    await couch.db.create(dbName);
    console.log(`Database CouchDB criado: ${dbName}`);
  }

  return couch.use(dbName);
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
