import axios from 'axios';
import path from 'node:path';
import { config } from '../config.js';
import { docExists, getCouchDatabase } from '../couchdb/client.js';
import { getMediaDatabaseName, getMessageDatabaseName } from '../runtime-config.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickMediaUrl(doc) {
  const url = doc.mediaUrl || doc.raw?.mediaUrl || null;
  const mediaPath = doc.mediaPath || doc.raw?.mediaPath || null;
  if (url && /^https?:\/\//i.test(url)) return { source: 'mediaUrl', url };
  if (mediaPath && /^https?:\/\//i.test(mediaPath)) return { source: 'mediaPath', url: mediaPath };
  if (url) return { source: 'mediaUrl', url };
  if (mediaPath) return { source: 'mediaPath', url: mediaPath };
  return null;
}

function filenameFromUrl(url, contentType) {
  try {
    const pathname = new URL(url).pathname;
    const base = path.basename(pathname);
    if (base && base !== '/' && base.includes('.')) return decodeURIComponent(base);
  } catch {
    // ignore
  }
  const ext =
    {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'video/mp4': '.mp4',
      'application/pdf': '.pdf',
    }[contentType] || '';
  return `file${ext}`;
}

function mediaDocId(messageDocId) {
  const id = String(messageDocId).replace(/^msg:/, '');
  return `media:${id}`;
}

async function tryDownload(url, headers = {}) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: config.gosac.timeoutMs,
    headers: { Accept: '*/*', ...headers },
    validateStatus: (status) => status >= 200 && status < 400,
  });
  const contentType = response.headers['content-type']?.split(';')[0]?.trim() || 'application/octet-stream';
  return { buffer: Buffer.from(response.data), contentType };
}

async function downloadFileWithFallback(url) {
  try {
    return await tryDownload(url, {
      Authorization: `INTEGRATION ${config.gosac.apiKey}`,
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) throw error;
    if (![401, 403].includes(status) && status !== undefined) throw error;
    return tryDownload(url);
  }
}

async function* iterateMessageDocs(db) {
  let startkey;
  const limit = 100;

  for (;;) {
    const params = { include_docs: true, limit };
    if (startkey !== undefined) {
      params.startkey = startkey;
      params.skip = 1;
    }

    const page = await db.list(params);
    if (!page.rows.length) break;

    for (const row of page.rows) {
      if (row.id.startsWith('_')) continue;
      if (row.doc?.type !== 'message') continue;
      yield row.doc;
    }

    startkey = page.rows[page.rows.length - 1].key;
    if (page.rows.length < limit) break;
  }
}

async function saveMediaDoc(mediaDb, messageDoc, media, file, filename) {
  const _id = mediaDocId(messageDoc._id);

  const meta = {
    _id,
    type: 'media',
    source: 'gosac',
    sourceMessageId: messageDoc._id,
    ticketId: messageDoc.ticketId ?? messageDoc.raw?.ticketId,
    contactId: messageDoc.contactId ?? messageDoc.raw?.contactId,
    mediaType: messageDoc.mediaType ?? messageDoc.raw?.mediaType,
    mediaUrl: messageDoc.mediaUrl ?? messageDoc.raw?.mediaUrl,
    mediaPath: messageDoc.mediaPath ?? messageDoc.raw?.mediaPath,
    downloadedFrom: media.url,
    downloadedFromField: media.source,
    filename,
    contentType: file.contentType,
    size: file.buffer.length,
    migratedAt: new Date().toISOString(),
  };

  let rev;
  try {
    const existing = await mediaDb.get(_id);
    const att = existing._attachments?.[filename];
    if (att && att.length === file.buffer.length) {
      return { status: 'skipped', _id };
    }
    rev = existing._rev;
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  if (rev) {
    await mediaDb.insert({ ...meta, _rev: rev });
    const updated = await mediaDb.get(_id);
    rev = updated._rev;
  } else {
    const inserted = await mediaDb.insert(meta);
    rev = inserted.rev;
  }

  await mediaDb.attachment.insert(_id, filename, file.buffer, file.contentType, { rev });
  return { status: 'ok', _id };
}

async function saveReport(mediaDb, mediaDbName, report) {
  const doc = {
    _id: `report:media-migrate:${report.startedAt}`,
    type: 'media_migrate_report',
    ...report,
  };
  try {
    await mediaDb.insert(doc);
    return doc._id;
  } catch (error) {
    return null;
  }
}

/**
 * Migração de mídia reutilizável (painel / CLI).
 */
export async function runMediaMigration(opts = {}, onProgress = () => {}, shouldStop = () => false) {
  const {
    delayMs = 150,
    max = Infinity,
    sourceDatabase,
    mediaDatabase,
    /** Só processa msgs com createdAt estritamente depois deste ISO (catch-up diário) */
    onlyAfterCreatedAt = null,
  } = opts;

  const sourceName = sourceDatabase || (await getMessageDatabaseName());
  const mediaName = mediaDatabase || (await getMediaDatabaseName());
  const sourceDb = await getCouchDatabase(sourceName);
  const mediaDb = await getCouchDatabase(mediaName);
  const afterTs = onlyAfterCreatedAt ? new Date(onlyAfterCreatedAt).getTime() : null;

  const startedAt = new Date().toISOString();
  onProgress({
    type: 'start',
    job: 'migrate-media',
    sourceDatabase: sourceName,
    mediaDatabase: mediaName,
    onlyAfterCreatedAt,
    max: max === Infinity ? null : max,
  });
  if (onlyAfterCreatedAt) {
    onProgress({
      type: 'log',
      level: 'info',
      message: `Mídia apenas para msgs com createdAt > ${onlyAfterCreatedAt} (sem teto de quantidade).`,
    });
  }

  let scanned = 0;
  let withMedia = 0;
  let attempted = 0;
  let ok = 0;
  let skipped = 0;
  let fail404 = 0;
  let failOther = 0;
  const failures = [];

  for await (const doc of iterateMessageDocs(sourceDb)) {
    if (shouldStop()) break;
    scanned += 1;

    if (afterTs != null) {
      const ts = new Date(doc.createdAt || 0).getTime();
      // inclusive: desde o início do dia (00:00)
      if (Number.isNaN(ts) || ts < afterTs) continue;
    }

    const media = pickMediaUrl(doc);
    if (!media) continue;

    withMedia += 1;
    if (attempted >= max) continue;

    attempted += 1;
    const _id = mediaDocId(doc._id);
    onProgress({
      type: 'media',
      index: attempted,
      max: max === Infinity ? null : max,
      messageId: doc._id,
    });

    try {
      if (await docExists(mediaDb, _id)) {
        const existing = await mediaDb.get(_id);
        if (existing._attachments && Object.keys(existing._attachments).length > 0) {
          skipped += 1;
          onProgress({ type: 'log', level: 'info', message: `${doc._id} ja_no_couch` });
          if (delayMs > 0) await sleep(delayMs);
          continue;
        }
      }

      const file = await downloadFileWithFallback(media.url);
      const filename = filenameFromUrl(media.url, file.contentType);
      const result = await saveMediaDoc(mediaDb, doc, media, file, filename);

      if (result.status === 'skipped') {
        skipped += 1;
        onProgress({ type: 'log', level: 'info', message: `${doc._id} ja_no_couch (${filename})` });
      } else {
        ok += 1;
        onProgress({
          type: 'log',
          level: 'info',
          message: `${doc._id} OK ${filename} ${file.buffer.length}b`,
        });
      }
    } catch (error) {
      const status = error.response?.status;
      if (status === 404) {
        fail404 += 1;
        onProgress({
          type: 'log',
          level: 'warn',
          message: `${doc._id} 404 (excluído no Gosac)`,
        });
      } else {
        failOther += 1;
        onProgress({
          type: 'log',
          level: 'error',
          message: `${doc._id} ERRO ${status || ''} ${error.message}`,
        });
      }
      failures.push({
        messageId: doc._id,
        mediaId: _id,
        url: media.url,
        status: status || null,
        error: error.message,
      });
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  const finishedAt = new Date().toISOString();
  const reportId = await saveReport(mediaDb, mediaName, {
    startedAt,
    finishedAt,
    scanned,
    withMedia,
    attempted,
    ok,
    skipped,
    fail404,
    failOther,
    failures: failures.slice(0, 500),
  });

  const result = {
    stopped: shouldStop(),
    sourceDatabase: sourceName,
    mediaDatabase: mediaName,
    scanned,
    withMedia,
    attempted,
    ok,
    skipped,
    fail404,
    failOther,
    reportId,
  };
  onProgress({ type: 'done', ...result });
  return result;
}
