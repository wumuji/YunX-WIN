import { ENGINE } from '../shared/constants.js';
import { extensionCategory, safeFilename } from '../shared/format.js';
import { getStatus, getMiniSettings, getNativeStatus, invalidateStatus, postFull, resolveShare, setMiniSettings, wake } from './bridge.js';
import { getSettings, setSettings } from './settings.js';
import { clearCooldown, cooldownRemaining, getSiteMode, listSiteRules, removeSiteRule, rootDomainOf, setCooldown, setSiteMode } from './sites.js';
import { routeDownload } from './router.js';
import { getTabResources } from './sniff.js';
import { clearCompletedAll, handoffTask, listAllTasks, relayTask, summarize, taskActionById } from './tasks.js';
import { closePanel, openPanel } from './panel.js';
import { applyDownloadUiOptions } from './ui-options.js';

async function enginesSnapshot(force = false) {
  const status = await getStatus(force);
  const map = (record, mode) => (record
    ? { connected: true, mode, port: record.port, version: record.version, capabilities: record.capabilities }
    : { connected: false, mode });
  return {
    full: map(status.full, ENGINE.FULL),
    mini: map(status.mini, ENGINE.MINI),
  };
}

async function startBrowserDownload(payload) {
  const settings = await getSettings();
  const options = {
    url: payload.url,
    conflictAction: 'uniquify',
    saveAs: false,
  };
  if (payload.fileName) options.filename = `YunX/${safeFilename(payload.fileName)}`;
  if (payload.referer) options.headers = [{ name: 'Referer', value: payload.referer }];
  const id = await chrome.downloads.download(options);
  if (settings.openPanelOnDownload) await openPanel().catch(() => {});
  return { ok: true, engine: ENGINE.BROWSER, id };
}

async function normalizePayload(payload) {
  const next = { ...payload };
  next.headers = { ...(payload.headers || {}) };
  if (!next.headers.Cookie) {
    try {
      const cookies = await chrome.cookies.getAll({ url: next.url });
      const cookie = cookies
        .filter((item) => item && item.name)
        .map((item) => `${item.name}=${item.value}`)
        .join('; ');
      if (cookie) next.headers.Cookie = cookie;
    } catch {
      // ignore
    }
  }
  const referer = next.referer || next.pageUrl || '';
  if (!next.headers.Referer && referer) next.headers.Referer = referer;
  if (!next.headers['User-Agent']) next.headers['User-Agent'] = navigator.userAgent;
  next.rootDomain = next.rootDomain || rootDomainOf(next.pageUrl || next.url);
  return next;
}

export async function manualDownload(payload) {
  payload = await normalizePayload(payload);
  const routed = await routeDownload(payload, { userInitiated: true });
  if (routed.ok && (routed.engine === ENGINE.MINI || routed.engine === ENGINE.FULL)) return routed;
  if (routed.engine === 'passthrough') {
    return { ok: false, error: '该链接不支持扩展下载，请使用浏览器原生方式' };
  }
  if (routed.ok === false && (routed.kind === 'share' || routed.kind === 'video' || routed.kind === 'p2p')) {
    return routed;
  }
  try {
    const browser = await startBrowserDownload(payload);
    return { ...browser, fallback: true, error: routed.error || '' };
  } catch (error) {
    return { ok: false, error: error?.message || '浏览器下载失败' };
  }
}

export async function handle(msg) {
  switch (msg.type) {
    case 'fetch.status': {
      const [engines, tasks, native] = await Promise.all([
        enginesSnapshot(true),
        listAllTasks(),
        getNativeStatus(),
      ]);
      return { ok: true, engines, tasks, summary: summarize(tasks), native };
    }
    case 'fetch.settings.get':
      return { ok: true, settings: await getSettings() };
    case 'fetch.settings.set': {
      const settings = await setSettings(msg.settings || msg.patch || {});
      applyDownloadUiOptions().catch(() => {});
      return { ok: true, settings };
    }
    case 'fetch.tasks.list': {
      const tasks = await listAllTasks();
      const engines = await enginesSnapshot(false);
      return { ok: true, tasks, summary: summarize(tasks), engines };
    }
    case 'fetch.task.action':
      return taskActionById(msg.id, msg.action, { deleteLocal: msg.deleteLocal });
    case 'fetch.task.handoff':
      return handoffTask(msg.id, { deleteLocal: Boolean(msg.deleteLocal) });
    case 'fetch.task.relay':
      return relayTask(msg.id, msg.target);
    case 'fetch.task.clearCompleted':
      return clearCompletedAll({ deleteLocal: Boolean(msg.deleteLocal) });
    case 'fetch.downloads.folder': {
      try {
        chrome.downloads.showDefaultFolder();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error?.message || '无法打开下载文件夹' };
      }
    }
    case 'fetch.panel.open':
      return openPanel({ focus: true }).then((id) => ({ ok: Boolean(id), id }));
    case 'fetch.panel.close':
      return closePanel();
    case 'fetch.ui.apply':
      return applyDownloadUiOptions();
    case 'fetch.permissions.status': {
      let granted = false;
      try {
        granted = await chrome.permissions.contains({ permissions: ['downloads.ui'] });
      } catch {
        granted = false;
      }
      return { ok: true, downloadsUi: granted };
    }
    case 'fetch.download':
      return manualDownload(msg.payload || {
        url: msg.url,
        fileName: msg.fileName,
        fileSize: msg.size,
        mime: msg.mime,
        pageUrl: msg.pageUrl,
        referer: msg.referer,
        headers: msg.headers || {},
        rootDomain: rootDomainOf(msg.pageUrl || msg.url),
        threads: msg.threads,
        title: msg.title,
      });
    case 'fetch.resolve': {
      const result = await resolveShare(msg.url, msg.title || '');
      return { ...result, ok: Boolean(result.ok) };
    }
    case 'fetch.engine.wake':
      return wake(msg.target === ENGINE.FULL ? ENGINE.FULL : ENGINE.MINI);
    case 'fetch.mini.settings.get':
      return getMiniSettings();
    case 'fetch.mini.settings.set':
      return setMiniSettings(msg.settings || {});
    case 'fetch.site.rules.get':
      return { ok: true, rules: await listSiteRules(), settings: await getSettings() };
    case 'fetch.site.rule.set': {
      const root = rootDomainOf(msg.domain || '');
      if (!root) return { ok: false, error: '无效域名' };
      await setSiteMode(root, msg.mode === 'passthrough' ? 'passthrough' : 'takeover');
      return { ok: true, rules: await listSiteRules() };
    }
    case 'fetch.site.rule.remove': {
      const root = rootDomainOf(msg.domain || '');
      if (!root) return { ok: false, error: '无效域名' };
      await removeSiteRule(root);
      return { ok: true, rules: await listSiteRules() };
    }
    case 'fetch.cooldown.set': {
      const root = rootDomainOf(msg.url || msg.domain || '');
      if (!root) return { ok: false, error: '无效域名' };
      await setCooldown(root);
      return { ok: true, domain: root };
    }
    case 'fetch.cooldown.status': {
      const root = rootDomainOf(msg.url || msg.domain || '');
      return { ok: true, domain: root, remainMs: await cooldownRemaining(root) };
    }
    case 'fetch.cooldown.clear': {
      const root = rootDomainOf(msg.url || msg.domain || '');
      await clearCooldown(root);
      return { ok: true, domain: root };
    }
    case 'fetch.manager.open': {
      const section = msg.section ? `#${encodeURIComponent(String(msg.section))}` : '';
      const base = chrome.runtime.getURL('manager.html');
      const url = `${base}${section}`;
      const tabs = await chrome.tabs.query({ url: `${base}*` });
      if (tabs && tabs[0]) {
        if (section) await chrome.tabs.update(tabs[0].id, { active: true, url });
        else await chrome.tabs.update(tabs[0].id, { active: true });
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url });
      }
      return { ok: true };
    }
    case 'fetch.native.status':
      return getNativeStatus();
    case 'fetch.engine.refresh':
      invalidateStatus();
      return { ok: true, engines: await enginesSnapshot(true) };

    // ---- 兼容旧 popup ----
    case 'yunx-status': {
      const engines = await enginesSnapshot(true);
      const connected = engines.full.connected || engines.mini.connected;
      return {
        ok: true,
        connected,
        port: engines.full.connected ? engines.full.port : engines.mini.port,
        mode: engines.full.connected ? ENGINE.FULL : engines.mini.connected ? ENGINE.MINI : '',
        engines,
      };
    }
    case 'yunx-get-settings': {
      const settings = await getSettings();
      return {
        ok: true,
        settings: {
          enabled: settings.enabled,
          hijack: settings.takeover,
          sniff: settings.sniff,
          takeover: settings.takeover,
        },
      };
    }
    case 'yunx-set-settings': {
      const patch = msg.settings || {};
      const normalized = { ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, 'hijack')) normalized.takeover = Boolean(patch.hijack);
      delete normalized.hijack;
      await setSettings(normalized);
      return { ok: true };
    }
    case 'yunx-get-resources': {
      const result = await getTabResources(msg.tabId);
      return { ok: true, resources: result.resources || [], pageUrl: result.pageUrl };
    }
    case 'yunx-download':
      return manualDownload(msg.payload || {
        url: msg.url,
        fileName: msg.fileName,
        fileSize: msg.size,
        mime: msg.mime,
        pageUrl: msg.pageUrl,
        referer: msg.referer,
        headers: {},
        rootDomain: rootDomainOf(msg.pageUrl || msg.url),
        title: msg.fileName,
      });
    case 'yunx-bili-download': {
      const result = await postFull('/bili', {
        bvid: msg.bvid,
        pageUrl: msg.pageUrl,
        qn: msg.qn || 0,
        mode: msg.mode || 'merge',
        title: msg.title || '',
      });
      return { ok: Boolean(result.ok), error: result.error || '' };
    }
    case 'yunx-video-download': {
      const result = await postFull('/video', {
        platform: msg.platform,
        url: msg.url,
        title: msg.title || '',
        pageUrl: msg.pageUrl,
      });
      return { ok: Boolean(result.ok), error: result.error || '' };
    }
    case 'yunx-cooldown-status': {
      const root = rootDomainOf(msg.url || '');
      return { ok: true, remainMs: await cooldownRemaining(root), domain: root };
    }
    case 'yunx-cooldown-clear': {
      const root = rootDomainOf(msg.url || '');
      await clearCooldown(root);
      return { ok: true, domain: root };
    }
    case 'yunx-site-mode': {
      const root = rootDomainOf(msg.url || msg.domain || '');
      if (msg.mode) {
        await setSiteMode(root, msg.mode);
        if (msg.mode === 'passthrough') await setCooldown(root);
      }
      return { ok: true, mode: await getSiteMode(root) };
    }
    case 'yunx-open-manager': {
      const url = chrome.runtime.getURL('manager.html');
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    case 'yunx-category': {
      return { ok: true, category: extensionCategory(msg.name || '') };
    }
    default:
      return { ok: false, error: `unknown-message:${msg.type}` };
  }
}

export function initMessages() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    handle(msg, sender)
      .then((response) => sendResponse(response || { ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || 'internal-error' }));
    return true;
  });
}
