import { loadSettings } from '../settings.js';

/**
 * Agenda sync contínuo (intervalo) e verificação diária.
 */
export function createScheduler(jobManager) {
  let continuousTimer = null;
  let dailyTimer = null;
  let lastContinuousAt = null;
  let lastDailyAt = null;
  let lastContinuousError = null;
  let lastDailyError = null;
  let running = false;

  function clearTimers() {
    if (continuousTimer) {
      clearInterval(continuousTimer);
      continuousTimer = null;
    }
    if (dailyTimer) {
      clearTimeout(dailyTimer);
      dailyTimer = null;
    }
  }

  async function tickContinuous() {
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
            maxTickets: 100,
            messagePages: 5,
            mediaMax: 300,
          });
          lastDailyAt = new Date().toISOString();
          lastDailyError = null;
        } catch (error) {
          lastDailyError = error.message;
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
          tickContinuous().catch(() => {});
        }, ms);
        // primeira passagem após 15s (dá tempo do painel subir)
        setTimeout(() => tickContinuous().catch(() => {}), 15_000);
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
        dailyTimer: Boolean(dailyTimer),
        lastContinuousAt,
        lastDailyAt,
        lastContinuousError,
        lastDailyError,
      };
    },
  };
}
