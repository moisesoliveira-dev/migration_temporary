import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  version: 1,
  couchdbDatabase: null, // null = usa COUCHDB_DATABASE do .env
  couchdbMediaDatabase: null,
  continuousSync: {
    enabled: false,
    intervalMinutes: 5,
    maxTickets: 40,
    messagePages: 3,
  },
  dailyCheck: {
    enabled: false,
    hour: 6,
    minute: 0,
    timezoneOffsetHours: -3,
    includeMedia: true,
  },
  updatedAt: null,
};

function settingsPath() {
  return path.resolve(process.env.CONTROL_SETTINGS_FILE || '.control-settings.json');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function mergeSettings(raw) {
  const base = structuredClone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    continuousSync: { ...base.continuousSync, ...(raw.continuousSync || {}) },
    dailyCheck: { ...base.dailyCheck, ...(raw.dailyCheck || {}) },
  };
}

let cache = null;

export async function loadSettings() {
  if (cache) return cache;
  const raw = await readJson(settingsPath());
  cache = mergeSettings(raw);
  return cache;
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    continuousSync: { ...current.continuousSync, ...(patch.continuousSync || {}) },
    dailyCheck: { ...current.dailyCheck, ...(patch.dailyCheck || {}) },
    updatedAt: new Date().toISOString(),
  });

  const filePath = settingsPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, filePath);
  cache = next;
  return cache;
}

export function getCachedSettings() {
  return cache || mergeSettings(null);
}

export function clearSettingsCache() {
  cache = null;
}
