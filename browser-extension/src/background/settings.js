import { DEFAULT_SETTINGS } from '../shared/constants.js';

const STORAGE_KEY = 'settings';

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch || {}) };
  if (patch && patch.sites) next.sites = { ...current.sites, ...patch.sites };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export async function getTheme() {
  const settings = await getSettings();
  return settings.theme || 'auto';
}
