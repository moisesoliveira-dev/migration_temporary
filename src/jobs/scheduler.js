import { loadSettings } from '../settings.js';

/**
 * Agenda sync contínuo de mensagens, mídia e verificação diária.
 * Regra: só um job por vez (mensagens e mídia nunca rodam juntos).
 */
export function createScheduler(jobManager) {
  let continuousTimer = null;
  let continuousMediaTimer = null;
  let dailyTimer = null;
  let lastContinuousAt = null;
  let lastContinuousMediaAt = null;
  let lastDailyAt = null;
  let lastContinuousError = null;
  let lastContinuousMediaError = null;
  let lastDailyError = null;
  let running = false;
  /** @type {ReturnType<typeof setTimeout>[]} */
  const startupTimeouts = [];

  function clearTimers() {
    if (continuousTimer) {
      clearInterval(continuousTimer);
      continuousTimer = null;
    }
    if (continuousMediaTimer) {
      clearInterval(continuousMediaTimer);
      continuousMediaTimer = null;
    }
    if (dailyTimer) {
      clearTimeout(dailyTimer);
      dailyTimer = null;
    }
    while (startupTimeouts.length) {
      clearTimeout(startupTimeouts.pop());
    }
  }

  async function tickContinuousMessages() {
    const settings = await loadSettings();
    if (!settings.continuousSync?.enabled) return;
    if (jobManager.getActive()) return;

    try {
      await jobManager.startIncrementalSync({
        maxTickets: settings.continuousSync.maxTickets,
        messagePages: settings.continuousSync.messagePages,
      });
      lastContinuousAt = new Date().toISOString();
      lastContinuousError = null;
    } catch (error) {
      if (error.code === 'JOB_BUSY') return;
      lastContinuousError = error.message;
    }
  }

  async function tickContinuousMedia() {
    const settings = await loadSettings();
    if (!settings.continuousMedia?.enabled) return;
    if (jobManager.getActive()) return;

    try {
      await jobManager.startMediaMigration({
        max: settings.continuousMedia.maxPerCycle ?? 80,
      });
      lastContinuousMediaAt = new Date().toISOString();
      lastContinuousMediaError = null;
    } catch (error) {
      if (error.code === 'JOB_BUSY') return;
      lastContinuousMediaError = error.message;
    }
  }

  function msUntilDaily(hour, minute, offsetHours) {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
    const local = new Date(utc + offsetHours * 3_600_000);
    const target = new Date(local);
    target.setHours(hour, minute, 0, 0);
    if (target <= local) target.setDate(target.getDate() + 1);
    return target.getTime() - local.getTime();
  }

  async function scheduleDaily() {
    if (dailyTimer) {
      clearTimeout(dailyTimer);
      dailyTimer = null;
    }

    const settings = await loadSettings();
    if (!settings.dailyCheck?.enabled) return;

    const wait = msUntilDaily(
      settings.dailyCheck.hour,
      settings.dailyCheck.minute,
      settings.dailyCheck.timezoneOffsetHours ?? -3,
    );

    dailyTimer = setTimeout(async () => {
      dailyTimer = null;
      const s = await loadSettings();
      if (!s.dailyCheck?.enabled) {
        scheduleDaily();
        return;
      }
      if (!jobManager.getActive()) {
        try {
          await jobManager.runDailyCheck({
            includeMedia: s.dailyCheck.includeMedia,
          });
          lastDailyAt = new Date().toISOString();
          lastDailyError = null;
        } catch (error) {
          if (error.code !== 'JOB_BUSY') lastDailyError = error.message;
        }
      }
      scheduleDaily();
    }, wait);
  }

  return {
    async start() {
      if (running) await this.reload();
      running = true;
      await this.reload();
    },

    async reload() {
      clearTimers();
      if (!running) return;

      const settings = await loadSettings();

      if (settings.continuousSync?.enabled) {
        const ms = Math.max(1, Number(settings.continuousSync.intervalMinutes) || 5) * 60_000;
        continuousTimer = setInterval(() => {
          tickContinuousMessages().catch(() => {});
        }, ms);
        startupTimeouts.push(
          setTimeout(() => tickContinuousMessages().catch(() => {}), 15_000),
        );
      }

      if (settings.continuousMedia?.enabled) {
        const ms = Math.max(1, Number(settings.continuousMedia.intervalMinutes) || 15) * 60_000;
        continuousMediaTimer = setInterval(() => {
          tickContinuousMedia().catch(() => {});
        }, ms);
        // atrasa o 1º ciclo de mídia para não colidir com o de mensagens
        startupTimeouts.push(
          setTimeout(() => tickContinuousMedia().catch(() => {}), 45_000),
        );
      }

      await scheduleDaily();
    },

    stop() {
      running = false;
      clearTimers();
    },

    status() {
      return {
        running,
        continuousTimer: Boolean(continuousTimer),
        continuousMediaTimer: Boolean(continuousMediaTimer),
        dailyTimer: Boolean(dailyTimer),
        lastContinuousAt,
        lastContinuousMediaAt,
        lastDailyAt,
        lastContinuousError,
        lastContinuousMediaError,
        lastDailyError,
        lockNote:
          'Mensagens e mídia nunca rodam ao mesmo tempo (manual ou contínuo). Se um estiver ativo, o outro espera o próximo ciclo.',
      };
    },
  };
}
