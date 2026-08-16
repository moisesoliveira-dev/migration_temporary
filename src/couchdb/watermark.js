import { getCouchDatabase } from './client.js';

const WATERMARK_ID = 'meta:sync-watermark';

/**
 * Lê watermark persistido no próprio CouchDB (última msg conhecida).
 */
export async function readSyncWatermark(dbName) {
  const db = await getCouchDatabase(dbName, { quiet: true });
  try {
    const doc = await db.get(WATERMARK_ID);
    return {
      newestCreatedAt: doc.newestCreatedAt || null,
      newestMessageId: doc.newestMessageId || null,
      updatedAt: doc.updatedAt || null,
      _rev: doc._rev,
    };
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

/**
 * Descobre a msg mais recente por createdAt (scan limitado) se não houver watermark.
 */
export async function discoverNewestCreatedAt(dbName, { scan = 3000 } = {}) {
  const db = await getCouchDatabase(dbName, { quiet: true });
  const page = await db.list({ include_docs: true, limit: scan, descending: true });
  let newestCreatedAt = null;
  let newestMessageId = null;
  let newestTs = 0;

  for (const row of page.rows) {
    const doc = row.doc;
    if (!doc || doc.type !== 'message' || !doc.createdAt) continue;
    const ts = new Date(doc.createdAt).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts >= newestTs) {
      newestTs = ts;
      newestCreatedAt = doc.createdAt;
      newestMessageId = doc._id;
    }
  }

  return { newestCreatedAt, newestMessageId, scanned: page.rows.length };
}

export async function resolveSyncWatermark(dbName) {
  const stored = await readSyncWatermark(dbName);
  if (stored?.newestCreatedAt) {
    return {
      newestCreatedAt: stored.newestCreatedAt,
      newestMessageId: stored.newestMessageId,
      source: 'stored',
    };
  }
  const discovered = await discoverNewestCreatedAt(dbName);
  return {
    newestCreatedAt: discovered.newestCreatedAt,
    newestMessageId: discovered.newestMessageId,
    source: discovered.newestCreatedAt ? 'discovered' : 'empty',
  };
}

/**
 * Atualiza watermark se o createdAt for mais novo.
 */
export async function bumpSyncWatermark(dbName, { createdAt, messageId } = {}) {
  if (!createdAt) return null;
  const ts = new Date(createdAt).getTime();
  if (Number.isNaN(ts)) return null;

  const db = await getCouchDatabase(dbName, { quiet: true });
  let existing = null;
  try {
    existing = await db.get(WATERMARK_ID);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  const prevTs = existing?.newestCreatedAt
    ? new Date(existing.newestCreatedAt).getTime()
    : 0;
  if (ts < prevTs) return existing;

  const doc = {
    _id: WATERMARK_ID,
    type: 'sync_watermark',
    newestCreatedAt: createdAt,
    newestMessageId: messageId || existing?.newestMessageId || null,
    updatedAt: new Date().toISOString(),
  };
  if (existing?._rev) doc._rev = existing._rev;

  try {
    await db.insert(doc);
  } catch (error) {
    // conflito de rev — ignora; próximo ciclo corrige
    if (error.statusCode !== 409) throw error;
  }
  return doc;
}
