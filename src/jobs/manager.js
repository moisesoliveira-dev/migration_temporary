import { randomUUID } from 'node:crypto';
import {
  runFullMessageMigration,
  runIncrementalSync,
  runTicketMigration,
  runCatchUpSync,
} from '../migration/messages.js';
import { runMediaMigration } from '../migration/media.js';

const MAX_LOGS = 400;

/**
 * Gerenciador de jobs em processo (um job ativo por vez).
 */
export function createJobManager() {
  /** @type {Map<string, object>} */
  const jobs = new Map();
  let activeJobId = null;
  let stopRequested = false;

  function pushLog(job, level, message) {
    job.logs.push({
      at: new Date().toISOString(),
      level,
      message: String(message),
    });
    if (job.logs.length > MAX_LOGS) {
      job.logs.splice(0, job.logs.length - MAX_LOGS);
    }
  }

  function makeProgressHandler(job) {
    return (event) => {
      job.updatedAt = new Date().toISOString();
      job.lastEvent = event;

      if (event.type === 'log') {
        pushLog(job, event.level || 'info', event.message);
        return;
      }

      if (event.type === 'start') {
        job.status = 'running';
        job.progress = { ...event };
        pushLog(job, 'info', `Iniciado: ${event.job || job.type}`);
        return;
      }

      if (event.type === 'done') {
        job.result = event;
        pushLog(
          job,
          'info',
          `Finalizado: ok=${event.totalOk ?? event.ok ?? 0} skip=${event.totalSkipped ?? event.skipped ?? 0} fail=${event.totalFail ?? event.fail ?? event.failOther ?? 0}`,
        );
        return;
      }

      if (event.type === 'contact' || event.type === 'ticket' || event.type === 'media' || event.type === 'pages' || event.type === 'contact_done') {
        job.progress = { ...(job.progress || {}), ...event };
        if (event.type === 'contact') {
          pushLog(job, 'info', `Contato ${event.contactId} (${event.name}) via ticket #${event.ticketId}`);
        } else if (event.type === 'ticket') {
          pushLog(job, 'info', `Ticket #${event.ticketId} (${event.name}) [${event.index}/${event.max}]`);
        } else if (event.type === 'contact_done') {
          pushLog(
            job,
            'info',
            `Contato ${event.contactId}: msgs=${event.messages} novas=${event.ok} ja_no_couch=${event.skipped} falhas=${event.fail}`,
          );
        }
      }
    };
  }

  async function runJob(type, runner, opts = {}) {
    if (activeJobId) {
      const active = jobs.get(activeJobId);
      const activeLabel = active?.type || activeJobId;
      const err = new Error(
        `Job bloqueado: "${activeLabel}" ainda está rodando. Mensagens e mídia não operam juntos (manual ou contínuo). Pare o job ativo ou aguarde terminar.`,
      );
      err.code = 'JOB_BUSY';
      err.activeJobId = activeJobId;
      err.activeJobType = active?.type || null;
      throw err;
    }

    const id = `${type}-${randomUUID().slice(0, 8)}`;
    const job = {
      id,
      type,
      status: 'queued',
      opts,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      lastEvent: null,
      result: null,
      error: null,
      logs: [],
    };
    jobs.set(id, job);
    activeJobId = id;
    stopRequested = false;
    job.status = 'running';
    job.startedAt = new Date().toISOString();

    const onProgress = makeProgressHandler(job);
    const shouldStop = () => stopRequested;

    // fire-and-forget; caller receives job id immediately
    (async () => {
      try {
        const result = await runner(opts, onProgress, shouldStop);
        job.result = result;
        job.status = stopRequested ? 'stopped' : 'completed';
      } catch (error) {
        job.status = 'failed';
        job.error = error.message || String(error);
        pushLog(job, 'error', job.error);
      } finally {
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        if (activeJobId === id) activeJobId = null;
        stopRequested = false;
      }
    })();

    return job;
  }

  return {
    list() {
      return [...jobs.values()]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 50)
        .map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          createdAt: j.createdAt,
          startedAt: j.startedAt,
          finishedAt: j.finishedAt,
          updatedAt: j.updatedAt,
          progress: j.progress,
          result: j.result,
          error: j.error,
          logCount: j.logs.length,
        }));
    },

    get(id) {
      return jobs.get(id) || null;
    },

    getActive() {
      return activeJobId ? jobs.get(activeJobId) : null;
    },

    requestStop() {
      if (!activeJobId) return false;
      stopRequested = true;
      const job = jobs.get(activeJobId);
      if (job) pushLog(job, 'warn', 'Parada solicitada…');
      return true;
    },

    startFullMigration(opts) {
      return runJob('migrate-messages', runFullMessageMigration, opts);
    },

    startIncrementalSync(opts) {
      return runJob('incremental-sync', runIncrementalSync, opts);
    },

    startTicketMigration(opts) {
      return runJob('migrate-ticket', runTicketMigration, opts);
    },

    startMediaMigration(opts) {
      return runJob('migrate-media', runMediaMigration, opts);
    },

    async runDailyCheck(opts = {}) {
      return runJob(
        'daily-check',
        async (jobOpts, onProgress, shouldStop) => {
          onProgress({ type: 'start', job: 'daily-check' });
          onProgress({
            type: 'log',
            level: 'info',
            message:
              'Verificação diária: tickets atualizados no dia → todas msgs faltantes (mesmo de dias anteriores) → mídia faltante desde 00:00.',
          });

          const sync = await runCatchUpSync(
            {
              database: jobOpts.database,
              idleTicketsToStop: jobOpts.idleTicketsToStop ?? 40,
              onlyUpdatedToday: jobOpts.onlyUpdatedToday !== false,
              timezoneOffsetHours: jobOpts.timezoneOffsetHours ?? -3,
            },
            onProgress,
            shouldStop,
          );

          let media = null;
          // padrão: mídia SEMPRE entra na diária (só desliga se includeMedia === false)
          const runMedia = jobOpts.includeMedia !== false;
          if (runMedia && !shouldStop()) {
            const mediaSince = sync.dayStart || null;
            onProgress({
              type: 'log',
              level: 'info',
              message: mediaSince
                ? `Mídia: anexos faltantes de msgs desde ${mediaSince} → banco de mídia`
                : 'Mídia: varrendo anexos pendentes (sem filtro de data).',
            });
            media = await runMediaMigration(
              {
                max: Infinity,
                onlyAfterCreatedAt: mediaSince,
                sourceDatabase: jobOpts.database,
                mediaDatabase: jobOpts.mediaDatabase,
              },
              onProgress,
              shouldStop,
            );
          }

          const result = { sync, media, stopped: shouldStop() };
          onProgress({
            type: 'done',
            ...result,
            totalOk: sync.totalOk,
            totalSkipped: sync.totalSkipped,
            totalFail: sync.totalFail,
          });
          return result;
        },
        opts,
      );
    },
  };
}
