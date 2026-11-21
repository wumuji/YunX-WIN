import { ENGINE } from '../shared/constants.js';
import { classifyUrl, parseBilibiliBvid, videoPlatformOf } from './classify.js';
import { enqueue, getStatus, postFull, resolveShare, wake } from './bridge.js';
import { getSettings } from './settings.js';

async function ensure(target, allowWake) {
  const status = await getStatus();
  if (status[target]) return status[target];
  if (!allowWake) return null;
  const result = await wake(target);
  return result.ok ? result.status : null;
}

async function tryEnqueue(target, payload) {
  const result = await enqueue(target, payload);
  return result;
}

export async function routeDownload(payload, opts = {}) {
  const settings = await getSettings();
  const { kind, reason } = classifyUrl(payload.url, payload.mime);
  const userInitiated = Boolean(opts.userInitiated);

  if (!settings.enabled) return { engine: ENGINE.BROWSER, kind, reason: 'disabled' };
  if (settings.route === 'browser') return { engine: ENGINE.BROWSER, kind, reason: 'route-browser' };
  if (kind === 'passthrough') return { engine: 'passthrough', kind, reason };

  if (kind === 'share') {
    const full = await ensure(ENGINE.FULL, settings.autoWakeFull);
    if (!full) return { ok: false, engine: ENGINE.FULL, kind, needsFull: true, error: '完整版未运行' };
    const result = await resolveShare(payload.url, payload.title || payload.fileName || '');
    return {
      ok: Boolean(result.ok),
      engine: ENGINE.FULL,
      kind,
      needsFull: true,
      error: result.ok ? '' : result.error || '完整版未接受解析',
    };
  }

  if (kind === 'video') {
    const full = await ensure(ENGINE.FULL, settings.autoWakeFull);
    if (!full) return { ok: false, engine: ENGINE.FULL, kind, needsFull: true, error: '完整版未运行' };
    const platform = payload.platform || videoPlatformOf(payload.url);
    let result;
    if (platform === 'bilibili') {
      const bvid = parseBilibiliBvid(payload.url);
      if (!bvid) return { ok: false, engine: ENGINE.FULL, kind, needsFull: true, error: '无法识别 BV 号' };
      result = await postFull('/bili', {
        bvid,
        pageUrl: payload.pageUrl || payload.url,
        qn: 0,
        mode: 'merge',
        title: payload.title || payload.fileName || '',
      });
    } else {
      result = await postFull('/video', {
        platform,
        url: payload.url,
        title: payload.title || payload.fileName || '',
        pageUrl: payload.pageUrl || payload.url,
      });
    }
    return {
      ok: Boolean(result.ok),
      engine: ENGINE.FULL,
      kind,
      needsFull: true,
      error: result.ok ? '' : result.error || '完整版未接受视频解析',
    };
  }

  if (kind === 'p2p') {
    const full = await ensure(ENGINE.FULL, settings.autoWakeFull);
    if (!full) return { ok: false, engine: ENGINE.FULL, kind, needsFull: true, error: 'P2P 需要完整版' };
    const result = await tryEnqueue(ENGINE.FULL, payload);
    return {
      ok: Boolean(result.ok),
      engine: ENGINE.FULL,
      kind,
      needsFull: true,
      error: result.ok ? '' : result.reason || result.error || '完整版未接受任务',
    };
  }

  if (kind === 'hls') {
    const full = await ensure(ENGINE.FULL, settings.autoWakeFull);
    if (full) {
      const result = await tryEnqueue(ENGINE.FULL, payload);
      if (result.ok) return { ok: true, engine: ENGINE.FULL, kind };
      if (result.code === 'UNSUPPORTED') {
        return { ok: false, engine: ENGINE.BROWSER, kind, error: result.reason || '完整版不支持该链接' };
      }
    }
    return { ok: false, engine: ENGINE.BROWSER, kind, error: 'HLS 需要 YunX 完整版' };
  }

  // direct
  const miniAllowed = settings.route === 'auto' || settings.route === 'mini';
  if (miniAllowed) {
    const mini = await ensure(ENGINE.MINI, settings.autoWakeMini);
    if (mini) {
      const result = await tryEnqueue(ENGINE.MINI, payload);
      if (result.ok) return { ok: true, engine: ENGINE.MINI, kind, id: result.id };
      if (result.code !== 'UNSUPPORTED' && settings.route === 'mini') {
        return { ok: false, engine: ENGINE.BROWSER, kind, error: result.reason || result.error || 'Mini 入队失败' };
      }
    }
  }

  const fullAllowed = settings.route === 'auto' || settings.route === 'full';
  if (fullAllowed) {
    const allowWakeFull = userInitiated && settings.autoWakeFull;
    const full = await ensure(ENGINE.FULL, allowWakeFull);
    if (full) {
      const result = await tryEnqueue(ENGINE.FULL, payload);
      if (result.ok) return { ok: true, engine: ENGINE.FULL, kind, id: result.id };
      if (settings.route === 'full') {
        return { ok: false, engine: ENGINE.BROWSER, kind, error: result.reason || result.error || '完整版入队失败' };
      }
    }
  }

  const routed = await getStatus();
  const autoError = routed.mini
    ? 'Mini 未能接受该任务'
    : routed.full
      ? '完整版未能接受该任务'
      : '未运行 YunX Mini / 完整版';
  return { ok: false, engine: ENGINE.BROWSER, kind, error: opts.userInitiated ? '' : autoError };
}
