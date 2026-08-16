import nano from 'nano';
import { config } from '../config.js';
import { getCouchDatabase } from './client.js';
import { readSyncWatermark } from './watermark.js';

/**
 * Lista databases e info básica (sem senha na URL).
 */
export async function listCouchDatabases() {
  const client = nano(config.couchdb.url);
  const databases = await client.db.list();
  return databases.filter((name) => !name.startsWith('_'));
}

export async function getDatabaseInfo(dbName) {
  const client = nano(config.couchdb.url);
  const info = await client.db.get(dbName);
  return {
    name: dbName,
    docCount: info.doc_count,
    docDelCount: info.doc_del_count,
    updateSeq: info.update_seq,
    sizes: info.sizes,
    compactRunning: info.compact_running,
  };
}

async function ensureMessageCreatedAtIndex(db) {
  try {
    await db.createIndex({
      index: { fields: ['type', 'createdAt'] },
      name: 'idx-message-createdAt',
      ddoc: 'idx-message-createdAt',
    });
  } catch {
    // já existe ou indisponível
  }
}

function mapMessageRow(doc) {
  return {
    _id: doc._id,
    createdAt: doc.createdAt,
    migratedAt: doc.migratedAt,
    ticketId: doc.ticketId,
    contactId: doc.contactId,
    contactName: doc.contact?.name || doc.ticket?.contactName,
    bodyPreview: String(doc.body || '').slice(0, 120),
    mediaType: doc.mediaType,
  };
}

/**
 * Mensagens mais recentes por createdAt (Mango) + watermark para o Overview.
 */
export async function sampleLatestMessages(dbName, { limit = 20, scan = 2500 } = {}) {
  const db = await getCouchDatabase(dbName, { quiet: true });
  const watermark = await readSyncWatermark(dbName).catch(() => null);

  let latest = [];
  let source = 'scan';

  try {
    await ensureMessageCreatedAtIndex(db);
    const found = await db.find({
      selector: {
        type: 'message',
        createdAt: { $gt: null },
      },
      sort: [{ type: 'asc' }, { createdAt: 'desc' }],
      limit,
    });
    latest = (found.docs || []).map(mapMessageRow);
    if (latest.length) source = 'mango';
  } catch {
    // fallback
  }

  if (!latest.length) {
    const page = await db.list({
      include_docs: true,
      limit: scan,
      descending: true,
    });
    const messages = [];
    for (const row of page.rows) {
      const doc = row.doc;
      if (!doc || doc.type !== 'message') continue;
      messages.push(mapMessageRow(doc));
    }
    messages.sort(
      (a, b) =>
        new Date(b.migratedAt || b.createdAt || 0) -
        new Date(a.migratedAt || a.createdAt || 0),
    );
    latest = messages.slice(0, limit);
    source = 'scan-migratedAt';
  }

  const byCreated = [...latest].sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
  );
  const byMigrated = [...latest].sort(
    (a, b) => new Date(b.migratedAt || 0) - new Date(a.migratedAt || 0),
  );

  return {
    scanned: latest.length,
    messageSamples: latest.length,
    newestCreatedAt: watermark?.newestCreatedAt || byCreated[0]?.createdAt || null,
    newestMigratedAt: byMigrated[0]?.migratedAt || watermark?.updatedAt || null,
    watermark: watermark?.newestCreatedAt || null,
    source,
    latest: byCreated.slice(0, limit),
  };
}

/**
 * Compara duas databases de mensagens (ex.: gosac_geral vs gosac_messages).
 */
export async function compareMessageDatabases(a, b) {
  const [infoA, infoB, sampleA, sampleB] = await Promise.all([
    getDatabaseInfo(a).catch((e) => ({ name: a, error: e.message })),
    getDatabaseInfo(b).catch((e) => ({ name: b, error: e.message })),
    sampleLatestMessages(a, { limit: 5, scan: 300 }).catch((e) => ({
      error: e.message,
    })),
    sampleLatestMessages(b, { limit: 5, scan: 300 }).catch((e) => ({
      error: e.message,
    })),
  ]);

  return {
    a: { info: infoA, sample: sampleA },
    b: { info: infoB, sample: sampleB },
  };
}

export function maskCouchUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = u.username ? '***' : '';
    return u.toString();
  } catch {
    return '(url inválida)';
  }
}
