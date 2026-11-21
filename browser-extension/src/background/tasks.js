import { ENGINE, ENGINE_LABEL, STATUS_ORDER } from '../shared/constants.js';
import { enqueue, listTasks, taskAction, wake } from './bridge.js';
import { browserAction, handoffToBrowser, listBrowserTasks } from './browser-engine.js';
import { getSettings } from './settings.js';

const ALARM_NAME = 'yunx-poll';
const NOTIFIED_KEY = 'nativeNotified';
const NOTIFIED_INIT_KEY = 'nativeNotifiedInit';

function normalizeNative(task, engine) {
  const status = ['pending', 'downloading', 'paused', 'completed', 'failed'].includes(task.status)
    ? task.status
    : 'downloading';
  return {
    id: `${engine === ENGINE.MINI ? 'm' : 'f'}:${task.id}`,
    nativeId: task.id,
    engine,
    name: task.name || 'download',
    url: task.url || '',
    pageUrl: task.pageUrl || '',
    referer: task.referer || '',
    site: task.site || '',
    category: task.category || 'other',
    size: Number(task.size) || 0,
    downloaded: Number(task.downloaded) || 0,
    status,
    speed: Number(task.speed) || 0,
    etaMs: Number(task.etaMs) || 0,
    error: task.error || '',
    savePath: task.savePath || '',
    createdAt: Number(task.createdAt) || Date.now(),
    mime: task.mime || '',
    source: engine,
    canResume: status === 'paused' || status === 'failed',
  };
}

async function safeNativeTasks(engine) {
  const result = await listTasks(engine);
  if (!result || result.ok === false || !Array.isArray(result.tasks)) return [];
  return result.tasks.map((task) => normalizeNative(task, engine));
}

export async function listAllTasks() {
  const [mini, full, browser] = await Promise.all([
    safeNativeTasks(ENGINE.MINI),
    safeNativeTasks(ENGINE.FULL),
    listBrowserTasks(),
  ]);
  const all = [...browser, ...mini, ...full];
  all.sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 9;
    const sb = STATUS_ORDER[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return all;
}

export function summarize(tasks) {
  const summary = {
    active: 0,
    downloading: 0,
    completed: 0,
    failed: 0,
    paused: 0,
    pending: 0,
    totalSpeed: 0,
    totalSize: 0,
    totalDownloaded: 0,
  };
  for (const task of tasks) {
    if (task.status === 'downloading') {
      summary.downloading += 1;
      summary.active += 1;
    } else if (task.status === 'pending') {
      summary.pending += 1;
      summary.active += 1;
    } else if (task.status === 'completed') summary.completed += 1;
    else if (task.status === 'failed') summary.failed += 1;
    else if (task.status === 'paused') summary.paused += 1;
    summary.totalSpeed += Number(task.speed) || 0;
    summary.totalSize += Number(task.size) || 0;
    summary.totalDownloaded += Number(task.downloaded) || 0;
  }
  return summary;
}

export async function updateBadge(tasks = null) {
  const list = tasks || (await listAllTasks());
  const active = list.filter((task) => task.status === 'downloading' || task.status === 'pending').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#2f6bff' });
  await chrome.action.setBadgeText({ text: active > 0 ? String(Math.min(active, 99)) : '' });
  return active;
}

async function ensurePollAlarm(tasks) {
  const hasNativeActive = tasks.some(
    (task) => (task.engine === ENGINE.MINI || task.engine === ENGINE.FULL)
      && (task.status === 'downloading' || task.status === 'pending'),
  );
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (hasNativeActive && !existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  } else if (!hasNativeActive && existing) {
    await chrome.alarms.clear(ALARM_NAME);
  }
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

async function notify(task) {
  const settings = await getSettings();
  if (!settings.notifyComplete) return;
  const iconUrl = chrome.runtime.getURL('icons/icon128.png');
  const failed = task.status === 'failed';
  await chrome.notifications.create(`yunx-${task.id}`, {
    type: 'basic',
    iconUrl,
    title: failed ? '下载失败' : '下载完成',
    message: `${task.name}${failed && task.error ? `\n${task.error}` : ''}`,
    priority: 0,
  });
}

async function notifyNativeChanges(tasks) {
  const native = tasks.filter((task) => task.engine === ENGINE.MINI || task.engine === ENGINE.FULL);
  const finished = native.filter((task) => task.status === 'completed' || task.status === 'failed');
  const initialized = Boolean(await sessionGet(NOTIFIED_INIT_KEY));
  const notified = (await sessionGet(NOTIFIED_KEY)) || {};
  if (!initialized) {
    for (const task of finished) notified[task.id] = Date.now();
    await sessionSet(NOTIFIED_INIT_KEY, true);
    await sessionSet(NOTIFIED_KEY, notified);
    return;
  }
  let changed = false;
  for (const task of finished) {
    if (notified[task.id]) continue;
    notified[task.id] = Date.now();
    changed = true;
    notify(task).catch(() => {});
  }
  if (changed) {
    const entries = Object.entries(notified).slice(-500);
    await sessionSet(NOTIFIED_KEY, Object.fromEntries(entries));
  }
}

export async function pollNativeTasks() {
  const tasks = await listAllTasks();
  await updateBadge(tasks);
  await notifyNativeChanges(tasks);
  await ensurePollAlarm(tasks);
  chrome.runtime.sendMessage({ type: 'fetch.tasks.changed', tasks }).catch(() => {});
  return tasks;
}

export async function afterTasksMayChange() {
  const tasks = await listAllTasks();
  await updateBadge(tasks);
  await ensurePollAlarm(tasks);
  chrome.runtime.sendMessage({ type: 'fetch.tasks.changed', tasks }).catch(() => {});
}

export async function taskActionById(taskId, action, options = {}) {
  const [prefix] = String(taskId).split(':');
  if (prefix === 'b') return browserAction(taskId, action, options);
  const engine = prefix === 'm' ? ENGINE.MINI : prefix === 'f' ? ENGINE.FULL : '';
  if (!engine) return { ok: false, error: 'bad-task-id' };
  const nativeId = Number(String(taskId).split(':').slice(1).join(':'));
  if (!Number.isFinite(nativeId)) return { ok: false, error: 'bad-task-id' };
  const result = await taskAction(engine, nativeId, action, Boolean(options.deleteLocal));
  if (result.ok) {
    afterTasksMayChange().catch(() => {});
  }
  return result;
}

/**
 * 把引擎任务交还浏览器：由后台统一完成「设冷却 → 发起浏览器下载 → 移除原任务」，
 * 避免页面侧先下载后被自己重新接管（首次点击失效的根因）。
 */
export async function handoffTask(taskId, options = {}) {
  const tasks = await listAllTasks();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.engine === ENGINE.BROWSER) return { ok: false, error: '该任务已经由浏览器下载' };
  const result = await handoffToBrowser(task);
  if (!result.ok) return result;
  await taskActionById(taskId, 'remove', { deleteLocal: Boolean(options.deleteLocal) });
  await afterTasksMayChange();
  return { ok: true, id: result.id, browserId: result.browserId, site: result.site };
}

/**
 * 把任务转交给指定引擎（Mini / 完整版）。
 *
 * 与「交给浏览器」对称：先让目标引擎接单，成功后再移除原任务，
 * 避免出现「原任务没了、新引擎也没接」的空窗。
 */
export async function relayTask(taskId, target) {
  if (target !== ENGINE.MINI && target !== ENGINE.FULL) {
    return { ok: false, error: '未知的目标引擎' };
  }
  const tasks = await listAllTasks();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.engine === target && ['downloading', 'pending', 'paused'].includes(task.status)) {
    return { ok: false, error: `任务已在 ${ENGINE_LABEL[target]} 中` };
  }
  if (!/^https?:/i.test(task.url || '')) {
    return { ok: false, error: '该任务没有可转交的直链' };
  }
  const payload = {
    url: task.url,
    fileName: task.name || '',
    referer: task.referer || '',
    pageUrl: task.pageUrl || '',
    mime: task.mime || '',
    headers: task.headers || {},
  };
  let result = await enqueue(target, payload);
  if (!result?.ok) {
    const woken = await wake(target);
    if (woken?.ok) result = await enqueue(target, payload);
  }
  if (!result?.ok) {
    const reason = result?.reason || result?.error || '';
    if (reason === 'not-running') {
      return { ok: false, error: `${ENGINE_LABEL[target]} 未运行，请先启动或在下载中心唤醒` };
    }
    return { ok: false, error: reason || `${ENGINE_LABEL[target]} 未接受该任务` };
  }
  if (task.engine === ENGINE.BROWSER) {
    await browserAction(task.id, 'remove', { deleteLocal: false });
  } else {
    await taskActionById(taskId, 'remove', { deleteLocal: false });
  }
  await afterTasksMayChange();
  return { ok: true, engine: target };
}

export async function clearCompletedAll(options = {}) {
  const deleteLocal = Boolean(options.deleteLocal);
  const tasks = await listAllTasks();
  const completed = tasks.filter((task) => task.status === 'completed');
  for (const task of completed) {
    const [prefix] = task.id.split(':');
    if (prefix === 'b') {
      await browserAction(task.id, 'remove', { deleteLocal });
    } else {
      await taskActionById(task.id, 'remove', { deleteLocal });
    }
  }
  await afterTasksMayChange();
  return { ok: true, removed: completed.length };
}

export function engineLabel(engine) {
  return ENGINE_LABEL[engine] || engine;
}
