import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobManager } from '../jobs/manager.js';
import { createScheduler } from '../jobs/scheduler.js';
import { loadSettings, saveSettings } from '../settings.js';
import { getEnvSnapshot, getMediaDatabaseName, getMessageDatabaseName } from '../runtime-config.js';
import {
  compareMessageDatabases,
  getDatabaseInfo,
  listCouchDatabases,
  maskCouchUrl,
  sampleLatestMessages,
} from '../couchdb/inspect.js';
import { createMigrationState } from '../migration/state.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function checkAuth(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true; // sem token = aberto (local)
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
  return bearer === token || queryToken === token || req.headers['x-admin-token'] === token;
}

export async function startControlPanel(options = {}) {
  const port = Number(options.port || process.env.PORT || 3847);
  const jobManager = createJobManager();
  const scheduler = createScheduler(jobManager);
  await loadSettings();
  await scheduler.start();

  async function handleApi(req, res, url) {
    if (!checkAuth(req)) {
      sendJson(res, 401, { error: 'Não autorizado. Configure ADMIN_TOKEN e envie Bearer/token.' });
      return;
    }

    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/status') {
      const settings = await loadSettings();
      const messageDb = await getMessageDatabaseName();
      let mediaDb = null;
      try {
        mediaDb = await getMediaDatabaseName();
      } catch {
        mediaDb = null;
      }

      let dbInfo = null;
      let sample = null;
      let dbError = null;
      try {
        dbInfo = await getDatabaseInfo(messageDb);
        sample = await sampleLatestMessages(messageDb, { limit: 8, scan: 400 });
      } catch (error) {
        dbError = error.message;
      }

      let mediaInfo = null;
      if (mediaDb) {
        try {
          mediaInfo = await getDatabaseInfo(mediaDb);
        } catch (error) {
          mediaInfo = { error: error.message };
        }
      }

      const state = await createMigrationState();
      const active = jobManager.getActive();

      sendJson(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        env: getEnvSnapshot(),
        couchUrl: maskCouchUrl(config.couchdb.url),
        settings,
        effective: {
          messageDatabase: messageDb,
          mediaDatabase: mediaDb,
        },
        database: { info: dbInfo, sample, error: dbError },
        mediaDatabase: mediaInfo,
        checkpoint: state.getStats(),
        jobs: {
          active: active
            ? {
                id: active.id,
                type: active.type,
                status: active.status,
                progress: active.progress,
                updatedAt: active.updatedAt,
              }
            : null,
          recent: jobManager.list().slice(0, 10),
        },
        scheduler: scheduler.status(),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/databases') {
      try {
        const databases = await listCouchDatabases();
        sendJson(res, 200, { databases });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/compare') {
      const a = url.searchParams.get('a') || 'gosac_geral';
      const b = url.searchParams.get('b') || 'gosac_messages';
      try {
        const comparison = await compareMessageDatabases(a, b);
        sendJson(res, 200, comparison);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
      const id = pathname.replace('/api/jobs/', '');
      const job = jobManager.get(id);
      if (!job) {
        sendJson(res, 404, { error: 'Job não encontrado' });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/jobs') {
      sendJson(res, 200, { jobs: jobManager.list() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/settings') {
      sendJson(res, 200, await loadSettings());
      return;
    }

    if (req.method === 'PUT' && pathname === '/api/settings') {
      try {
        const body = await readBody(req);
        const saved = await saveSettings(body);
        await scheduler.reload();
        sendJson(res, 200, saved);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/jobs/stop') {
      const ok = jobManager.requestStop();
      sendJson(res, 200, { stopped: ok });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/jobs/migrate-messages') {
      try {
        const body = await readBody(req);
        const job = await jobManager.startFullMigration(body);
        sendJson(res, 202, { id: job.id, type: job.type });
      } catch (error) {
        sendJson(res, error.code === 'JOB_BUSY' ? 409 : 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/jobs/incremental-sync') {
      try {
        const body = await readBody(req);
        const job = await jobManager.startIncrementalSync(body);
        sendJson(res, 202, { id: job.id, type: job.type });
      } catch (error) {
        sendJson(res, error.code === 'JOB_BUSY' ? 409 : 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/jobs/migrate-ticket') {
      try {
        const body = await readBody(req);
        const job = await jobManager.startTicketMigration(body);
        sendJson(res, 202, { id: job.id, type: job.type });
      } catch (error) {
        sendJson(res, error.code === 'JOB_BUSY' ? 409 : 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/jobs/migrate-media') {
      try {
        const body = await readBody(req);
        const job = await jobManager.startMediaMigration(body);
        sendJson(res, 202, { id: job.id, type: job.type });
      } catch (error) {
        sendJson(res, error.code === 'JOB_BUSY' ? 409 : 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/jobs/daily-check') {
      try {
        const body = await readBody(req);
        const job = await jobManager.runDailyCheck(body);
        sendJson(res, 202, { id: job.id, type: job.type });
      } catch (error) {
        sendJson(res, error.code === 'JOB_BUSY' ? 409 : 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/checkpoint/reset') {
      const state = await createMigrationState();
      await state.clear();
      sendJson(res, 200, { ok: true, stats: state.getStats() });
      return;
    }

    sendJson(res, 404, { error: 'Rota não encontrada' });
  }

  async function handleStatic(req, res, url) {
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(PUBLIC_DIR, filePath);
    if (!abs.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const data = await readFile(abs);
      const ext = path.extname(abs);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      await handleStatic(req, res, url);
    } catch (error) {
      sendJson(res, 500, { error: error.message || String(error) });
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`Painel de controle em http://localhost:${port}`);
  if (process.env.ADMIN_TOKEN) {
    console.log('Auth: ADMIN_TOKEN ativo (Bearer / x-admin-token / ?token=)');
  } else {
    console.log('Auth: ADMIN_TOKEN ausente — painel aberto (ok para uso local).');
  }

  return { server, jobManager, scheduler, port };
}
