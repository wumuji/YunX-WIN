import { ENGINE, PORT_RANGES, PORT_SCAN_TIMEOUT_MS, STATUS_CACHE_MS } from '../shared/constants.js';

const NATIVE_HOST = 'com.yunx.mini';

let cache = {
  full: null,
  mini: null,
  checkedAt: 0,
};

let inflightScan = null;

class TimeoutError extends Error {}

async function fetchJson(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { response, data };
  } catch (error) {
    if (error?.name === 'AbortError') throw new TimeoutError('timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function pingPort(port, expectedMode) {
  try {
    const { data } = await fetchJson(`http://127.0.0.1:${port}/ping`, {}, PORT_SCAN_TIMEOUT_MS);
    if (!data || data.app !== 'yunx' || !data.token) return null;
    return {
      mode: data.mode || expectedMode,
      port,
      token: data.token,
      version: data.version || '',
      capabilities: data.capabilities || {},
      checkedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

async function scanRange(mode) {
  const [start, end] = PORT_RANGES[mode];
  const ports = [];
  for (let port = start; port <= end; port += 1) ports.push(port);
  const results = await Promise.all(ports.map((port) => pingPort(port, mode)));
  return results.find(Boolean) || null;
}

export async function getStatus(force = false) {
  const fresh = Date.now() - cache.checkedAt < STATUS_CACHE_MS;
  if (!force && fresh) return cache;
  if (inflightScan) return inflightScan;
  inflightScan = (async () => {
    const [full, mini] = await Promise.all([scanRange(ENGINE.FULL), scanRange(ENGINE.MINI)]);
    cache = {
      full: full && full.mode !== ENGINE.MINI ? full : null,
      mini: mini && mini.mode !== ENGINE.FULL ? mini : null,
      checkedAt: Date.now(),
    };
    if (!cache.full && full && full.mode === ENGINE.FULL) cache.full = full;
    if (!cache.mini && mini && mini.mode === ENGINE.MINI) cache.mini = mini;
    return cache;
  })();
  try {
    return await inflightScan;
  } finally {
    inflightScan = null;
  }
}

export function invalidateStatus() {
  cache = { full: null, mini: null, checkedAt: 0 };
}

function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || 'native-host-unavailable'));
        else resolve(response || { ok: false, error: 'empty-response' });
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function getNativeStatus() {
  try {
    const response = await sendNativeMessage({ action: 'status' });
    return { ok: true, ...response };
  } catch (error) {
    return { ok: false, error: error?.message || 'native-host-unavailable' };
  }
}

export async function wake(target) {
  try {
    const response = await sendNativeMessage({ action: 'ensure', target });
    if (!response || response.ok === false) {
      return { ok: false, error: response?.error || 'wake-failed' };
    }
    invalidateStatus();
    const status = await getStatus(true);
    return { ok: Boolean(status[target]), status: status[target] || null };
  } catch (error) {
    return { ok: false, error: error?.message || 'native-host-unavailable' };
  }
}

async function call(target, path, { method = 'GET', body = null, timeoutMs = 3500, retry = true } = {}) {
  const status = await getStatus();
  const engine = status[target];
  if (!engine) return { ok: false, error: 'not-running', engine: target };
  const headers = {
    'X-YunX-Token': engine.token,
  };
  if (body !== null) headers['Content-Type'] = 'application/json';
  try {
    const { response, data } = await fetchJson(
      `http://127.0.0.1:${engine.port}${path}`,
      {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
      },
      timeoutMs,
    );
    if (response.status === 401 && retry) {
      invalidateStatus();
      await getStatus(true);
      return call(target, path, { method, body, timeoutMs, retry: false });
    }
    return { ...data, httpStatus: response.status, engine: target };
  } catch (error) {
    if (error instanceof TimeoutError) return { ok: false, error: 'timeout', engine: target };
    invalidateStatus();
    return { ok: false, error: error?.message || 'request-failed', engine: target };
  }
}

export async function enqueue(target, payload) {
  return call(target, '/enqueue', { method: 'POST', body: payload, timeoutMs: 5000 });
}

export async function listTasks(target) {
  return call(target, '/tasks', { timeoutMs: 2500 });
}

export async function taskAction(target, id, action, deleteLocal = false) {
  return call(target, '/task/action', {
    method: 'POST',
    body: { id, action, deleteLocal },
    timeoutMs: 3500,
  });
}

export async function resolveShare(url, title = '') {
  return call(ENGINE.FULL, '/resolve', { method: 'POST', body: { url, title }, timeoutMs: 5000 });
}

export async function postFull(path, body) {
  return call(ENGINE.FULL, path, { method: 'POST', body, timeoutMs: 5000 });
}

export async function getMiniSettings() {
  return call(ENGINE.MINI, '/settings', { timeoutMs: 2500 });
}

export async function setMiniSettings(patch) {
  return call(ENGINE.MINI, '/settings', { method: 'POST', body: patch, timeoutMs: 3000 });
}

export async function shutdownMini() {
  return call(ENGINE.MINI, '/shutdown', { method: 'POST', body: {}, timeoutMs: 2000 });
}
