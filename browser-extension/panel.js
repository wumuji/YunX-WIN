import { ENGINE_LABEL, STATUS_LABEL } from './src/shared/constants.js';
import { formatBytes, formatDuration, formatSpeed } from './src/shared/format.js';

const $ = (id) => document.getElementById(id);
const ACTIVE = ['downloading', 'pending', 'paused', 'failed'];

let tasks = [];
let settings = { deleteFileOnRemove: false };
let timer = null;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: 'empty-response' });
    });
  });
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function percentOf(task) {
  if (task.status === 'completed') return 100;
  if (!task.size || task.size <= 0) return 0;
  return Math.min(100, Math.round((task.downloaded / task.size) * 100));
}

function metaText(task) {
  const percent = percentOf(task);
  if (task.status === 'completed') {
    return `${formatBytes(task.size || task.downloaded)} · ${STATUS_LABEL.completed}`;
  }
  if (task.status === 'failed') return task.error || STATUS_LABEL.failed;
  const parts = [];
  if (task.size > 0) parts.push(`${percent}% · ${formatBytes(task.downloaded)} / ${formatBytes(task.size)}`);
  else parts.push(formatBytes(task.downloaded));
  if (task.status === 'downloading' && task.speed > 0) parts.push(formatSpeed(task.speed));
  if (task.etaMs > 0 && task.status === 'downloading') parts.push(`剩余 ${formatDuration(task.etaMs)}`);
  if (task.status === 'paused') parts.push(STATUS_LABEL.paused);
  if (task.status === 'pending') parts.push(STATUS_LABEL.pending);
  return parts.join(' · ');
}

async function act(id, action, extra = {}) {
  const response = await send({ type: 'fetch.task.action', id, action, ...extra });
  if (!response?.ok) {
    window.alert(response?.error || '操作失败');
    return false;
  }
  await load();
  return true;
}

async function removeTask(task) {
  const withFile = Boolean(settings.deleteFileOnRemove);
  const hint = withFile ? '（同时删除本地文件）' : '（保留本地文件）';
  if (!settings.skipDeleteConfirm && !window.confirm(`删除任务「${task.name}」${hint}？`)) return;
  await act(task.id, 'remove', { deleteLocal: withFile });
}

function buttonsFor(task) {
  const box = el('div', 'p-btns');
  const add = (action, label, danger = false, extra = {}) => {
    const btn = el('button', `p-btn${danger ? ' danger' : ''}`, label);
    btn.addEventListener('click', () => {
      if (action === 'remove') removeTask(task);
      else act(task.id, action, extra);
    });
    box.appendChild(btn);
  };
  if (task.status === 'downloading' || task.status === 'pending') add('pause', '暂停');
  if (task.status === 'paused') add('resume', '继续');
  if (task.status === 'failed') add('retry', '重试');
  if (task.status === 'completed') add('open', '打开');
  add('remove', '删除', true);
  return box;
}

function itemOf(task) {
  const row = el('div', 'p-item');
  const top = el('div', 'p-item-top');
  top.appendChild(el('span', 'p-name', task.name || 'download'));
  const tagText = `${ENGINE_LABEL[task.engine] || task.engine}${task.status === 'failed' ? ' · 失败' : ''}`;
  const tagClass = ['p-tag', task.engine === 'browser' ? 'browser' : '', task.status === 'failed' ? 'failed' : '', task.status === 'completed' ? 'completed' : ''].filter(Boolean).join(' ');
  top.appendChild(el('span', tagClass, tagText));
  row.appendChild(top);

  const bar = el('div', 'p-bar');
  const fill = el('i');
  fill.style.width = `${percentOf(task)}%`;
  bar.appendChild(fill);
  row.appendChild(bar);

  const meta = el('div', 'p-meta');
  meta.appendChild(el('span', '', metaText(task)));
  meta.appendChild(el('span', '', task.site || ''));
  row.appendChild(meta);

  row.appendChild(buttonsFor(task));
  return row;
}

function render(summary = {}) {
  const active = tasks.filter((task) => ACTIVE.includes(task.status));
  const recent = tasks.filter((task) => task.status === 'completed').slice(0, 3);
  const list = [...active, ...recent];
  $('p-count').textContent = String(active.length);
  $('p-empty').hidden = list.length > 0;
  const box = $('p-list');
  box.replaceChildren(...list.map(itemOf));
  $('p-foot').hidden = list.length === 0;
  $('p-speed').textContent = summary.totalSpeed > 0 ? formatSpeed(summary.totalSpeed) : '—';
  $('p-summary').textContent = list.length
    ? `${summary.downloading || 0} 下载中 · ${summary.completed || 0} 已完成`
    : '';
}

async function load() {
  try {
    const [list, st] = await Promise.all([
      send({ type: 'fetch.tasks.list' }),
      send({ type: 'fetch.settings.get' }),
    ]);
    if (st?.ok) settings = st.settings;
    if (list?.ok) {
      tasks = list.tasks || [];
      render(list.summary || {});
    }
  } catch {
    // 下次轮询重试
  }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  const active = tasks.some((task) => ACTIVE.includes(task.status));
  timer = setTimeout(load, document.hidden ? 4000 : active ? 1000 : 2500);
}

$('p-center').addEventListener('click', () => {
  send({ type: 'fetch.manager.open' });
});

$('p-close').addEventListener('click', () => window.close());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'fetch.tasks.changed') load();
});

load();
