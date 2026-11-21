import { getSettings, setSettings } from './settings.js';
import { COOLDOWN_MS } from '../shared/constants.js';

const TWO_LEVEL_TLDS = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.sg', 'com.my', 'com.br', 'com.mx', 'com.tr', 'com.ru', 'co.in',
]);

export function rootDomainOf(value) {
  let host = '';
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    host = url.hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

export async function getSiteMode(rootDomain) {
  if (!rootDomain) return 'takeover';
  const settings = await getSettings();
  const rule = settings.sites?.[rootDomain];
  return rule?.mode === 'passthrough' ? 'passthrough' : 'takeover';
}

export async function setSiteMode(rootDomain, mode) {
  if (!rootDomain) return getSettings();
  const settings = await getSettings();
  const sites = { ...(settings.sites || {}) };
  if (mode === 'takeover') delete sites[rootDomain];
  else sites[rootDomain] = { mode: 'passthrough' };
  return setSettings({ sites });
}

export async function removeSiteRule(rootDomain) {
  return setSiteMode(rootDomain, 'takeover');
}

async function sessionGet(key) {
  const store = chrome.storage.session || chrome.storage.local;
  const data = await store.get(key);
  return data[key];
}

async function sessionSet(key, value) {
  const store = chrome.storage.session || chrome.storage.local;
  await store.set({ [key]: value });
}

async function sessionRemove(key) {
  const store = chrome.storage.session || chrome.storage.local;
  await store.remove(key);
}

export async function setCooldown(rootDomain) {
  if (!rootDomain) return 0;
  const until = Date.now() + COOLDOWN_MS;
  await sessionSet(`cd:${rootDomain}`, until);
  return until;
}

export async function cooldownRemaining(rootDomain) {
  if (!rootDomain) return 0;
  const until = Number(await sessionGet(`cd:${rootDomain}`)) || 0;
  const remain = until - Date.now();
  if (remain <= 0) {
    if (until) await sessionRemove(`cd:${rootDomain}`);
    return 0;
  }
  return remain;
}

export async function clearCooldown(rootDomain) {
  if (!rootDomain) return;
  await sessionRemove(`cd:${rootDomain}`);
}

export async function listSiteRules() {
  const settings = await getSettings();
  return Object.entries(settings.sites || {}).map(([domain, rule]) => ({
    domain,
    mode: rule?.mode === 'passthrough' ? 'passthrough' : 'takeover',
  }));
}
