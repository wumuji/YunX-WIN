/**
 * 页面内下载气泡（代替独立浮窗，位置与交互对齐 Edge 原生下载气泡）。
 *
 * 只做展示与操作转发：任务数据、路由、删除策略全部由后台决定。
 * 用 Shadow DOM 隔离样式，避免被页面 CSS 污染；尺寸用 clamp/百分比，
 * 窄窗口自动收缩，不会溢出视口。
 */

(function () {
  'use strict';

  if (window.__yunxBubbleInstalled) return;
  window.__yunxBubbleInstalled = true;

  const ACTIVE = ['downloading', 'pending', 'paused', 'failed'];
  const ENGINE_LABEL = { mini: 'YunX Mini', full: 'YunX 完整版', browser: '浏览器' };
  const STATUS_LABEL = {
    pending: '等待中', downloading: '下载中', paused: '已暂停',
    completed: '已完成', failed: '失败',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed;
      top: 8px;
      right: 8px;
      z-index: 2147483647;
      width: clamp(320px, 32vw, 400px);
      max-width: calc(100vw - 16px);
      font: 12px/1.45 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      color: #1b1f27;
      background: #fff;
      border: 1px solid rgba(15, 23, 42, .12);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, .18), 0 2px 8px rgba(15, 23, 42, .08);
      overflow: hidden;
      animation: in .16s ease-out;
    }
    @keyframes in { from { opacity: 0; transform: translateY(-6px); } }
    @media (prefers-color-scheme: dark) {
      .wrap { background: #202329; color: #e7e9ef; border-color: #33373f;
        box-shadow: 0 10px 30px rgba(0, 0, 0, .5); }
      .item { border-color: #2c3038 !important; }
      .btn { color: #e7e9ef !important; border-color: #3a3f49 !important; }
      .head { background: #23262d !important; }
      .bar { background: #343943 !important; }
    }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 12px; background: #f7f8fb;
      border-bottom: 1px solid rgba(15, 23, 42, .08);
    }
    .title { font-weight: 600; font-size: 12.5px; }
    .count {
      min-width: 18px; padding: 0 6px; border-radius: 9px;
      background: #2f6bff; color: #fff; font-size: 11px;
      line-height: 18px; text-align: center;
    }
    .grow { flex: 1; }
    .link {
      border: 0; background: transparent; color: #2f6bff;
      font-size: 11.5px; cursor: pointer; padding: 2px 4px; border-radius: 6px;
    }
    .link:hover { background: rgba(47, 107, 255, .1); }
    .close {
      border: 0; background: transparent; color: #6b7280;
      font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px;
    }
    .close:hover { background: rgba(15, 23, 42, .08); }
    .body { max-height: min(58vh, 420px); overflow-y: auto; }
    .item { padding: 10px 12px; border-top: 1px solid rgba(15, 23, 42, .07); }
    .item:first-child { border-top: 0; }
    .row { display: flex; align-items: center; gap: 8px; }
    .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12.5px; }
    .tag {
      flex: none; font-size: 10.5px; padding: 1px 6px; border-radius: 6px;
      background: rgba(47, 107, 255, .12); color: #2f6bff;
    }
    .tag.browser { background: rgba(139, 92, 246, .14); color: #7c3aed; }
    .tag.failed { background: rgba(229, 72, 77, .14); color: #d13438; }
    .tag.completed { background: rgba(22, 163, 74, .14); color: #15803d; }
    .bar { height: 4px; margin: 7px 0 5px; border-radius: 2px; background: #e8ebf2; overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; background: #2f6bff; border-radius: 2px; transition: width .2s linear; }
    .meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #6b7280; }
    .meta .site { opacity: .8; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btns { display: flex; gap: 6px; margin-top: 8px; }
    .btn {
      flex: 1; min-width: 0; border: 1px solid rgba(15, 23, 42, .14); background: transparent;
      color: inherit; border-radius: 7px; padding: 4px 2px; font-size: 11px;
      cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .btn:hover:not(:disabled) { border-color: #2f6bff; color: #2f6bff; }
    .btn.danger:hover:not(:disabled) { border-color: #e5484d; color: #e5484d; }
    .btn:disabled { opacity: .45; cursor: default; }
    .empty { padding: 30px 16px; text-align: center; color: #6b7280; }
    .empty b { display: block; color: inherit; font-weight: 600; margin-bottom: 4px; }
    .foot {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 12px; border-top: 1px solid rgba(15, 23, 42, .08);
      background: #f7f8fb; font-size: 11px; color: #6b7280;
    }
    @media (prefers-color-scheme: dark) {
      .foot { background: #23262d !important; }
    }
  `;

  let host = null;
  let root = null;
  let timer = null;
  let tasks = [];
  let summary = {};
  let settings = { deleteFileOnRemove: false };
  let hideTimer = null;

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(response || { ok: false, error: 'empty-response' });
        });
      } catch (error) {
        resolve({ ok: false, error: error?.message || 'send-failed' });
      }
    });
  }

  function fmtBytes(n) {
    if (!n || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    let value = n;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
  }

  function fmtSpeed(n) {
    if (!n || n <= 0) return '';
    return `${fmtBytes(n)}/s`;
  }

  function fmtDuration(ms) {
    if (!ms || ms <= 0) return '';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function percentOf(task) {
    if (task.status === 'completed') return 100;
    if (!task.size || task.size <= 0) return 0;
    return Math.min(100, Math.round((task.downloaded / task.size) * 100));
  }

  function metaText(task) {
    if (task.status === 'completed') return fmtBytes(task.size || task.downloaded);
    if (task.status === 'failed') return task.error || STATUS_LABEL.failed;
    const parts = [];
    if (task.size > 0) parts.push(`${percentOf(task)}% · ${fmtBytes(task.downloaded)} / ${fmtBytes(task.size)}`);
    else parts.push(fmtBytes(task.downloaded));
    if (task.status === 'downloading' && task.speed > 0) parts.push(fmtSpeed(task.speed));
    if (task.status === 'downloading' && task.etaMs > 0) parts.push(`剩余 ${fmtDuration(task.etaMs)}`);
    if (task.status === 'paused') parts.push(STATUS_LABEL.paused);
    if (task.status === 'pending') parts.push(STATUS_LABEL.pending);
    return parts.join(' · ');
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  async function act(id, action, extra) {
    const response = await send({ type: 'fetch.task.action', id, action, ...(extra || {}) });
    if (!response?.ok) {
      toastText(response?.error || '操作失败');
      return false;
    }
    await load();
    return true;
  }

  let toastTimer = null;
  function toastText(text) {
    if (!root) return;
    const foot = root.querySelector('.foot-note');
    if (!foot) return;
    foot.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (root) renderFoot(); }, 2600);
  }

  async function removeTask(task) {
    const withFile = Boolean(settings.deleteFileOnRemove);
    if (!settings.skipDeleteConfirm) {
      const hint = withFile ? '（同时删除本地文件）' : '（保留本地文件）';
      if (!window.confirm(`删除任务「${task.name}」${hint}？`)) return;
    }
    const response = await send({
      type: 'fetch.task.action',
      id: task.id,
      action: 'remove',
      deleteLocal: withFile,
    });
    if (!response?.ok) toastText(response?.error || '删除失败');
    else toastText(withFile ? '已删除任务与本地文件' : '已删除任务（保留文件）');
    await load();
  }

  function buttonsFor(task) {
    const box = el('div', 'btns');
    const add = (label, onClick, options) => {
      const opts = options || {};
      const btn = el('button', `btn${opts.danger ? ' danger' : ''}`, label);
      if (opts.disabled) {
        btn.disabled = true;
        if (opts.title) btn.title = opts.title;
      }
      btn.addEventListener('click', onClick);
      box.appendChild(btn);
      return btn;
    };

    if (task.status === 'downloading' || task.status === 'pending') add('暂停', () => act(task.id, 'pause'));
    if (task.status === 'paused') add('继续', () => act(task.id, 'resume'));
    if (task.status === 'failed') add('重试', () => act(task.id, 'retry'));
    if (task.status === 'completed') add('打开', () => act(task.id, 'open'));
    add('删除', () => removeTask(task), { danger: true });
    return box;
  }

  function itemOf(task) {
    const item = el('div', 'item');
    const head = el('div', 'row');
    head.appendChild(el('span', 'name', task.name || 'download'));
    const tagClass = ['tag', task.engine === 'browser' ? 'browser' : '',
      task.status === 'failed' ? 'failed' : '', task.status === 'completed' ? 'completed' : '']
      .filter(Boolean).join(' ');
    head.appendChild(el('span', tagClass, ENGINE_LABEL[task.engine] || task.engine));
    item.appendChild(head);

    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = `${percentOf(task)}%`;
    bar.appendChild(fill);
    item.appendChild(bar);

    const meta = el('div', 'meta');
    meta.appendChild(el('span', '', metaText(task)));
    meta.appendChild(el('span', 'site', task.site || ''));
    item.appendChild(meta);

    item.appendChild(buttonsFor(task));
    return item;
  }

  function renderFoot() {
    if (!root) return;
    const foot = root.querySelector('.foot');
    if (!foot) return;
    const active = tasks.filter((task) => ACTIVE.includes(task.status)).length;
    foot.replaceChildren(
      el('span', 'foot-note', active ? `${active} 个任务进行中` : '没有进行中的任务'),
      el('span', '', summary.totalSpeed > 0 ? fmtSpeed(summary.totalSpeed) : ''),
    );
  }

  function render() {
    if (!root) return;
    const body = root.querySelector('.body');
    const count = root.querySelector('.count');
    if (!body || !count) return;
    const active = tasks.filter((task) => ACTIVE.includes(task.status));
    const recent = tasks.filter((task) => task.status === 'completed').slice(0, 3);
    const list = [...active, ...recent];
    count.textContent = String(active.length);

    if (!list.length) {
      const empty = el('div', 'empty');
      empty.appendChild(el('b', '', '暂无下载任务'));
      empty.appendChild(el('span', '', '在网页中点击下载后会显示在这里'));
      body.replaceChildren(empty);
    } else {
      body.replaceChildren(...list.map(itemOf));
    }
    renderFoot();

    if (!active.length && list.length) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 6000);
    } else {
      clearTimeout(hideTimer);
    }
  }

  async function load() {
    clearTimeout(timer);
    if (!host) return;
    try {
      const [listResponse, settingsResponse] = await Promise.all([
        send({ type: 'fetch.tasks.list' }),
        send({ type: 'fetch.settings.get' }),
      ]);
      if (settingsResponse?.ok) settings = settingsResponse.settings;
      if (listResponse?.ok) {
        tasks = listResponse.tasks || [];
        summary = listResponse.summary || {};
        render();
      }
    } catch {
      // 下一轮重试
    }
    schedule();
  }

  function schedule() {
    if (!host) return;
    const active = tasks.some((task) => ACTIVE.includes(task.status));
    timer = setTimeout(load, active ? 1000 : 2500);
  }

  function onDocPointerDown(event) {
    if (!host) return;
    const path = event.composedPath ? event.composedPath() : [];
    if (path.includes(host)) return;
    hide();
  }

  function onDocKeyDown(event) {
    if (!host) return;
    if (event.key === 'Escape') hide();
  }

  function show() {
    if (host) {
      load();
      return;
    }
    host = document.createElement('div');
    host.id = 'yunx-download-bubble';
    host.style.all = 'initial';
    root = host.attachShadow({ mode: 'open' });

    // 用构造式样式表而不是 <style> 元素：不受页面 CSP 的 style-src 限制（GitHub 等严格站也能正常渲染）
    let styled = false;
    try {
      if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        styled = true;
      }
    } catch {
      styled = false;
    }
    if (!styled) {
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }

    const wrap = el('div', 'wrap');
    const head = el('div', 'head');
    head.appendChild(el('span', 'title', '下载'));
    head.appendChild(el('span', 'count', '0'));
    head.appendChild(el('span', 'grow'));
    const allBtn = el('button', 'link', '全部');
    allBtn.addEventListener('click', () => send({ type: 'fetch.manager.open' }));
    head.appendChild(allBtn);
    const closeBtn = el('button', 'close', '×');
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', hide);
    head.appendChild(closeBtn);

    const body = el('div', 'body');
    const foot = el('div', 'foot');
    wrap.appendChild(head);
    wrap.appendChild(body);
    wrap.appendChild(foot);
    root.appendChild(wrap);
    document.documentElement.appendChild(host);

    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
    load();
  }

  function hide() {
    clearTimeout(timer);
    clearTimeout(hideTimer);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    root = null;
    tasks = [];
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'yunx-bubble-open') {
      if (document.visibilityState === 'visible') show();
    } else if (message?.type === 'yunx-bubble-close') {
      hide();
    } else if (message?.type === 'fetch.tasks.changed' && host) {
      load();
    }
  });
})();
