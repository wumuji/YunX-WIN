import { ENGINE, MAX_META } from '../shared/constants.js';
import { extensionCategory, safeFilename } from '../shared/format.js';
import { getSettings } from './settings.js';
import { cooldownRemaining, getSiteMode, rootDomainOf, setCooldown } from './sites.js';
import { routeDownload } from './router.js';
import { classifyUrl } from './classify.js';
import { openPanel } from './panel.js';

const META_KEY = 'taskMeta';
const IGNORE_URLS = new Map();
let metaLock = Promise.resolve();

function withMetaLock(fn) {
  const next = metaLock.then(fn, fn);
  metaLock = next.catch(() => {});
  return next;
}

async function readMeta() {
  const data = await chrome.storage.local.get(META_KEY);
  return data[META_KEY] || {};
}

async function writeMeta(meta) {
  const entries = Object.entries(meta)
    .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0))
    .slice(0, MAX_META);
  await chrome.storage.local.set({ [META_KEY]: Object.fromEntries(entries) });
}

export async function saveTaskMeta(downloadId, patch) {
  return withMetaLock(async () => {
    const meta = await readMeta();
    meta[downloadId] = { ...(meta[downloadId] || {}), ...patch, ts: Date.now() };
    await writeMeta(meta);
  });
}

export async function removeTaskMeta(downloadId) {
  return withMetaLock(async () => {
    const meta = await readMeta();
    if (meta[downloadId]) {
      delete meta[downloadId];
      await writeMeta(meta);
    }
  });
}

export async function getTaskMeta() {
  return readMeta();
}

function filenameOf(item) {
  const value = String(item.filename || '').split(/[\\/]/).filter(Boolean);
  return value[value.length - 1] || 'download';
}

function statusOf(item) {
  if (item.state === 'complete') return 'completed';
  if (item.state === 'interrupted') return 'failed';
  if (item.paused) return 'paused';
  return 'downloading';
}

function cookieHeader(cookies) {
  return (cookies || [])
    .filter((cookie) => cookie && cookie.name)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function buildPayload(item) {
  const settings = await getSettings();
  const url = item.finalUrl || item.url;
  const name = filenameOf(item);
  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ url });
  } catch {
    cookies = [];
  }
  const referer = item.referrer || '';
  const headers = {};
  const cookie = cookieHeader(cookies);
  if (cookie) headers.Cookie = cookie;
  if (referer) headers.Referer = referer;
  headers['User-Agent'] = navigator.userAgent;
  return {
    url,
    fileName: name,
    fileSize: Number(item.totalBytes) > 0 ? Number(item.totalBytes) : 0,
    headers,
    pageUrl: referer,
    referer,
    mime: item.mime || '',
    rootDomain: rootDomainOf(referer || url),
    title: name,
    threads: settings.defaultThreads,
    concurrency: settings.defaultConcurrency,
    speedLimit: settings.speedLimit,
  };
}

async function searchDownload(id) {
  try {
    const items = await chrome.downloads.search({ id });
    return items && items[0];
  } catch {
    return null;
  }
}

function rememberIgnored(url) {
  IGNORE_URLS.set(url, Date.now());
  setTimeout(() => IGNORE_URLS.delete(url), 15000);
}

/** 让接下来 15 秒内同一 URL 的浏览器下载不再被接管（交还浏览器 / 重新发起时用） */
export function ignoreUrlOnce(url) {
  if (url) rememberIgnored(url);
}

/**
 * 下载被接管后按需弹出下载浮窗。
 * 浮窗是隐藏原生气泡后的唯一可见入口，因此这里是「插件气泡接管」的核心动作。
 */
async function maybeOpenPanel() {
  try {
    const settings = await getSettings();
    if (!settings.openPanelOnDownload) return;
    await openPanel();
  } catch {
    // 浮窗打不开不影响下载本身
  }
}

async function reissueInBrowser(item, payload) {
  try {
    rememberIgnored(payload.url);
    const options = {
      url: payload.url,
      conflictAction: 'uniquify',
      saveAs: false,
    };
    if (payload.fileName) options.filename = `YunX/${safeFilename(payload.fileName)}`;
    if (payload.referer) {
      options.headers = [{ name: 'Referer', value: payload.referer }];
    }
    const newId = await chrome.downloads.download(options);
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
    const meta = {
      source: 'browser',
      reissued: true,
      url: payload.url,
      pageUrl: payload.pageUrl,
      referer: payload.referer,
      category: extensionCategory(payload.fileName),
      site: payload.rootDomain,
    };
    if (Number.isFinite(newId)) await saveTaskMeta(newId, meta);
    return true;
  } catch {
    await chrome.downloads.resume(item.id).catch(() => {});
    return false;
  }
}

/**
 * 把任务「交给浏览器」：先设站点冷却 + 忽略该 URL，再发起浏览器下载。
 *
 * 顺序是关键。之前 manager 直接调 chrome.downloads.download，新建的下载会立刻触发
 * onCreated → 被本扩展再次接管（刚发出就被 Mini 接走又抹掉），所以第一次点击看起来没反应，
 * 第二次才生效（那时冷却已经写进去了）。这里把冷却/忽略放到下载之前，保证一次点击即生效。
 */
export async function handoffToBrowser(task) {
  const url = String(task?.url || '');
  if (!/^https?:/i.test(url)) return { ok: false, error: '该任务没有可交还的直链' };
  const site = task.site || rootDomainOf(url);
  if (site) await setCooldown(site);
  rememberIgnored(url);
  const options = { url, conflictAction: 'uniquify', saveAs: false };
  if (task.referer) options.headers = [{ name: 'Referer', value: task.referer }];
  if (task.name) options.filename = safeFilename(task.name);
  try {
    const newId = await chrome.downloads.download(options);
    if (!Number.isFinite(newId)) return { ok: false, error: '浏览器拒绝了该下载' };
    await saveTaskMeta(newId, {
      source: 'browser',
      url,
      pageUrl: task.pageUrl || '',
      referer: task.referer || '',
      category: task.category || extensionCategory(task.name || ''),
      site,
    });
    return { ok: true, browserId: newId, id: `b:${newId}`, site };
  } catch (error) {
    return { ok: false, error: error?.message || '浏览器下载失败' };
  }
}

async function handleCreated(item) {
  try {
    if (!item || item.byExtensionId === chrome.runtime.id) return;
    const url = item.finalUrl || item.url || '';
    if (!/^https?:/i.test(url)) return;
    if (IGNORE_URLS.has(url)) {
      IGNORE_URLS.delete(url);
      return;
    }
    const settings = await getSettings();
    // 原生气泡被隐藏时，即便这次不接管（站点放行 / 冷却中 / 接管关闭），
    // 也要让用户看得见下载，否则又回到「下载了但界面上没有任务」。
    if (settings.hideNativeUi) await maybeOpenPanel();
    if (!settings.enabled || !settings.takeover) return;

    const root = rootDomainOf(item.referrer || url);
    if (root) {
      const mode = await getSiteMode(root);
      if (mode === 'passthrough') return;
      if (await cooldownRemaining(root)) return;
    }

    await chrome.downloads.pause(item.id).catch(() => {});
    const paused = (await searchDownload(item.id)) || item;
    if (paused.state === 'complete') {
      await chrome.downloads.resume(item.id).catch(() => {});
      return;
    }

    const payload = await buildPayload(paused);
    const classification = classifyUrl(payload.url, payload.mime);
    if (classification.kind === 'passthrough') {
      await chrome.downloads.resume(item.id).catch(() => {});
      return;
    }

    const routed = await routeDownload(payload, { userInitiated: false, auto: true });
    if (routed.ok && (routed.engine === ENGINE.MINI || routed.engine === ENGINE.FULL)) {
      // 任务已由引擎接管：抹掉浏览器那条记录即可，不再为它写本地元数据
      // （onErased 会清掉对应 meta，这里写进去反而会留下悬空条目）
      await chrome.downloads.cancel(item.id).catch(() => {});
      await chrome.downloads.erase({ id: item.id }).catch(() => {});
      await maybeOpenPanel();
      return;
    }

    if (routed.engine === 'passthrough') {
      await chrome.downloads.resume(item.id).catch(() => {});
      return;
    }

    if (settings.hideNativeUi) {
      const ok = await reissueInBrowser(paused, payload);
      if (ok) {
        await maybeOpenPanel();
        return;
      }
    }
    await chrome.downloads.resume(item.id).catch(() => {});
    await saveTaskMeta(item.id, {
      source: 'browser',
      url: payload.url,
      pageUrl: payload.pageUrl,
      referer: payload.referer,
      category: extensionCategory(payload.fileName),
      site: payload.rootDomain,
      routeError: routed.error || '',
    });
    await maybeOpenPanel();
  } catch (error) {
    console.warn('[YunX Fetch] takeover failed', error);
    try {
      await chrome.downloads.resume(item.id);
    } catch {
      // ignore
    }
  }
}

export function initDownloads() {
  chrome.downloads.onCreated.addListener((item) => {
    handleCreated(item);
  });
  chrome.downloads.onErased.addListener((id) => {
    removeTaskMeta(id).catch(() => {});
  });
}

export async function listBrowserTasks() {
  let items = [];
  try {
    items = await chrome.downloads.search({
      limit: 500,
      orderBy: ['-startTime'],
    });
  } catch {
    items = [];
  }
  const meta = await getTaskMeta();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return items
    .filter((item) => {
      if (item.state === 'in_progress' || item.paused) return true;
      return Number(item.startTime ? Date.parse(item.startTime) : 0) >= cutoff;
    })
    .map((item) => {
      const info = meta[item.id] || {};
      const name = filenameOf(item);
      const total = Number(item.totalBytes) > 0 ? Number(item.totalBytes) : 0;
      const downloaded = Number(item.bytesReceived) || 0;
      const start = item.startTime ? Date.parse(item.startTime) : Date.now();
      return {
        id: `b:${item.id}`,
        nativeId: item.id,
        engine: 'browser',
        name,
        url: item.finalUrl || item.url,
        pageUrl: info.pageUrl || item.referrer || '',
        referer: info.referer || item.referrer || '',
        site: info.site || rootDomainOf(item.referrer || item.url),
        category: info.category || extensionCategory(name),
        size: total,
        downloaded,
        status: statusOf(item),
        speed: 0,
        etaMs: 0,
        error: item.error || '',
        savePath: item.state === 'complete' ? item.filename : '',
        createdAt: Number.isFinite(start) ? start : Date.now(),
        mime: item.mime || '',
        source: info.source || 'browser',
        paused: Boolean(item.paused),
        canResume: item.state === 'interrupted' || item.paused,
      };
    });
}

export async function browserAction(taskId, action, options = {}) {
  const id = Number(String(taskId).replace(/^b:/, ''));
  if (!Number.isFinite(id)) return { ok: false, error: 'bad-id' };
  const item = await searchDownload(id);
  if (!item) return { ok: false, error: 'not-found' };
  switch (action) {
    case 'pause':
      await chrome.downloads.pause(id);
      return { ok: true };
    case 'resume':
      await chrome.downloads.resume(id);
      return { ok: true };
    case 'retry':
      if (item.canResume !== false && (item.state === 'interrupted' || item.paused)) {
        await chrome.downloads.resume(id);
        return { ok: true };
      }
      if (item.state === 'interrupted') {
        await chrome.downloads.resume(id);
        return { ok: true };
      }
      return { ok: false, error: 'cannot-retry' };
    case 'remove':
    case 'cancel': {
      if (item.state === 'in_progress' || item.paused) {
        await chrome.downloads.cancel(id).catch(() => {});
      }
      if (options.deleteLocal) {
        await chrome.downloads.removeFile(id).catch(() => {});
      }
      await chrome.downloads.erase({ id });
      await removeTaskMeta(id);
      return { ok: true };
    }
    case 'open':
      await chrome.downloads.open(id);
      return { ok: true };
    case 'reveal':
      chrome.downloads.show(id);
      return { ok: true };
    case 'copy':
      return { ok: true, url: item.finalUrl || item.url };
    default:
      return { ok: false, error: 'unknown-action' };
  }
}

export async function clearCompletedBrowserTasks() {
  const tasks = await listBrowserTasks();
  const completed = tasks.filter((task) => task.status === 'completed');
  for (const task of completed) {
    await chrome.downloads.erase({ id: task.nativeId }).catch(() => {});
    await removeTaskMeta(task.nativeId);
  }
  return { ok: true, removed: completed.length };
}
