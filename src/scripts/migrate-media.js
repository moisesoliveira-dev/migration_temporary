import axios from 'axios';
import path from 'node:path';
import { config } from '../config.js';
import { docExists, getCouchDatabase } from '../couchdb/client.js';

/**
 * Baixa arquivos de mediaUrl/mediaPath das mensagens em COUCHDB_DATABASE
 * e grava no COUCHDB_MEDIA_DATABASE como documento + attachment.
 *
 * Percorre TODAS as mensagens com mídia. 404 = arquivo excluído no Gosac
 * (conta como falha, continua). Já existente no CouchDB = pula.
 *
 * Controle: MEDIA_MIGRATE_ENABLED=true|false
 *
 * Uso:
 *   node src/scripts/migrate-media.js
 *   node src/scripts/migrate-media.js --max 10
 *   node src/scripts/migrate-media.js --delay 200
 */
function parseArgs(argv) {
  const opts = { delayMs: 150, max: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--delay' && argv[i + 1]) opts.delayMs = Number(argv[++i]);
    if (argv[i] === '--max' && argv[i + 1]) opts.max = Number(argv[++i]);
  }
  return opts;
}

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

/** Tenta com auth primeiro; se 401/403, tenta sem. 404 propaga. */
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

async function saveReport(mediaDb, report) {
  const doc = {
    _id: `report:media-migrate:${report.startedAt}`,
    type: 'media_migrate_report',
    ...report,
  };
  try {
    await mediaDb.insert(doc);
    console.log(`Relatório salvo em ${config.couchdb.mediaDatabase}/${doc._id}`);
  } catch (error) {
    console.warn(`Não foi possível salvar relatório no CouchDB: ${error.message}`);
  }
}

async function main() {
  if (!config.mediaMigrateEnabled) {
    console.log(
      'MEDIA_MIGRATE_ENABLED=false — migração de mídia desligada. Nenhum arquivo foi alterado.',
    );
    process.exit(0);
  }

  const opts = parseArgs(process.argv.slice(2));
  const sourceDb = await getCouchDatabase(config.couchdb.database);
  const mediaDb = await getCouchDatabase(config.couchdb.mediaDatabase);

  const startedAt = new Date().toISOString();
  console.log(
    `Migração de mídia | origem=${config.couchdb.database} → destino=${config.couchdb.mediaDatabase} | delay=${opts.delayMs}ms | max=${opts.max === Infinity ? 'todos' : opts.max}`,
  );
  console.log('Vai analisar TODAS as mensagens com mídia. 404 = arquivo excluído no Gosac (continua).');

  let scanned = 0;
  let withMedia = 0;
  let attempted = 0;
  let ok = 0;
  let skipped = 0;
  let fail404 = 0;
  let failOther = 0;
  const failures = [];

  for await (const doc of iterateMessageDocs(sourceDb)) {
    scanned += 1;
    const media = pickMediaUrl(doc);
    if (!media) continue;

    withMedia += 1;
    if (attempted >= opts.max) continue;

    attempted += 1;
    const _id = mediaDocId(doc._id);
    process.stdout.write(`[${attempted}/${opts.max === Infinity ? '?' : opts.max}] ${doc._id}... `);

    try {
      if (await docExists(mediaDb, _id)) {
        const existing = await mediaDb.get(_id);
        if (existing._attachments && Object.keys(existing._attachments).length > 0) {
          skipped += 1;
          console.log('ja_no_couch');
          if (opts.delayMs > 0) await sleep(opts.delayMs);
          continue;
        }
      }

      const file = await downloadFileWithFallback(media.url);
      const filename = filenameFromUrl(media.url, file.contentType);
      const result = await saveMediaDoc(mediaDb, doc, media, file, filename);

      if (result.status === 'skipped') {
        skipped += 1;
        console.log(`ja_no_couch (${filename})`);
      } else {
        ok += 1;
        console.log(`OK ${filename} ${file.buffer.length}b`);
      }
    } catch (error) {
      const status = error.response?.status;
      if (status === 404) {
        fail404 += 1;
        console.log(`404 (excluído no Gosac) ${media.url}`);
      } else {
        failOther += 1;
        console.log(`ERRO ${status || ''} ${error.message} | ${media.url}`);
      }
      failures.push({
        messageId: doc._id,
        mediaId: _id,
        url: media.url,
        status: status || null,
        error: error.message,
      });
    }

    if (opts.delayMs > 0) await sleep(opts.delayMs);

    // progresso periódico nos logs do Railway
    if (attempted % 25 === 0) {
      console.log(
        `--- progresso: tentados=${attempted} ok=${ok} ja_no_couch=${skipped} 404=${fail404} outros_erros=${failOther} ---`,
      );
    }
  }

  const finishedAt = new Date().toISOString();
  console.log('\n========== RESUMO MÍDIA ==========');
  console.log(`scanned_msgs=${scanned}`);
  console.log(`com_midia=${withMedia}`);
  console.log(`tentados=${attempted}`);
  console.log(`novas_ok=${ok}`);
  console.log(`ja_no_couch=${skipped}`);
  console.log(`falhas_404_excluidos=${fail404}`);
  console.log(`falhas_outras=${failOther}`);
  console.log('==================================');

  await saveReport(mediaDb, {
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
}

main().catch((error) => {
  console.error('Erro na migração de mídia:', error.response?.data || error.message);
  process.exit(1);
});
