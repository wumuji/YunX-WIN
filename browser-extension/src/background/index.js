import { getSettings } from './settings.js';
import { initDownloads } from './browser-engine.js';
import { initSniff } from './sniff.js';
import { initMessages, manualDownload } from './messages.js';
import { afterTasksMayChange, pollNativeTasks, updateBadge } from './tasks.js';
import { rootDomainOf } from './sites.js';
import { applyDownloadUiOptions } from './ui-options.js';
import { initPanel } from './panel.js';

const MENU_OPEN = 'yunx-open-manager';
const MENU_LINK = 'yunx-download-link';
const MENU_MEDIA = 'yunx-download-media';

let badgeTimer = null;

function scheduleBadgeRefresh() {
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    afterTasksMayChange().catch(() => {});
  }, 600);
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_OPEN,
      title: '打开云析下载中心',
      contexts: ['action'],
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: '用 YunX Fetch 下载此链接',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: MENU_MEDIA,
      title: '用 YunX Fetch 下载此媒体',
      contexts: ['video', 'audio', 'image'],
    });
  });
}

async function onMenuClicked(info, tab) {
  if (info.menuItemId === MENU_OPEN) {
    const url = chrome.runtime.getURL('manager.html');
    const tabs = await chrome.tabs.query({ url });
    if (tabs && tabs[0]) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
    return;
  }
  const url = info.linkUrl || info.srcUrl || '';
  if (!url) return;
  const payload = {
    url,
    fileName: '',
    fileSize: 0,
    headers: {},
    pageUrl: tab?.url || info.pageUrl || '',
    referer: tab?.url || '',
    mime: '',
    rootDomain: rootDomainOf(tab?.url || url),
    title: tab?.title || '',
  };
  const result = await manualDownload(payload);
  if (!result?.ok) {
    chrome.notifications.create(`yunx-context-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'YunX Fetch 下载失败',
      message: result?.error || '请确认 YunX Mini / 完整版是否已启动',
    });
  }
}

async function notifyBrowserFinished(downloadId, state) {
  if (state !== 'complete' && state !== 'interrupted') return;
  try {
    const settings = await getSettings();
    if (!settings.notifyComplete) return;
    const store = chrome.storage.session || chrome.storage.local;
    const key = 'browserNotified';
    const data = await store.get(key);
    const notified = data[key] || {};
    const taskKey = `b:${downloadId}`;
    if (notified[taskKey]) return;
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items && items[0];
    if (!item) return;
    const name = String(item.filename || '').split(/[\\/]/).filter(Boolean).pop() || '文件';
    const failed = state === 'interrupted';
    await chrome.notifications.create(`yunx-${taskKey}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: failed ? '下载失败' : '下载完成',
      message: `${name}${failed && item.error ? `\n${item.error}` : ''}`,
    });
    notified[taskKey] = Date.now();
    await store.set({ [key]: Object.fromEntries(Object.entries(notified).slice(-500)) });
  } catch {
    // ignore
  }
}

export function init() {
  initMessages();
  initDownloads();
  initSniff();
  initPanel();

  chrome.runtime.onInstalled.addListener(() => {
    createMenus();
    applyDownloadUiOptions();
    updateBadge([]);
  });

  chrome.runtime.onStartup.addListener(() => {
    applyDownloadUiOptions();
    afterTasksMayChange().catch(() => {});
  });

  // 设置变化后立即同步「隐藏原生气泡」的状态（与浮窗开关联动）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) applyDownloadUiOptions().catch(() => {});
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    onMenuClicked(info, tab).catch(() => {});
  });

  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-manager') chrome.runtime.openOptionsPage();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'yunx-poll') pollNativeTasks().catch(() => {});
  });

  chrome.downloads.onChanged.addListener((delta) => {
    scheduleBadgeRefresh();
    chrome.runtime.sendMessage({ type: 'fetch.tasks.changed' }).catch(() => {});
    if (delta.state?.current) notifyBrowserFinished(delta.id, delta.state.current).catch(() => {});
  });

  chrome.notifications.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
  });

  applyDownloadUiOptions().catch(() => {});
  afterTasksMayChange().catch(() => {});
}

init();
