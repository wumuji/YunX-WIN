import { CATEGORY_LABEL, ENGINE_LABEL, STATUS_LABEL } from './src/shared/constants.js';
import { extensionCategory, formatBytes, formatDuration, formatSpeed, formatTime } from './src/shared/format.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  tasks: [],
  summary: {},
  engines: {},
  native: null,
  filter: 'all',
  source: 'all',
  sort: 'status',
  query: '',
  selected: new Set(),
  byteSamples: new Map(),
  pollTimer: null,
  toastTimer: null,
  miniSettingsLoaded: false,
};

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) resolve({ ok: false, error: error.message });
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

function toast(message, error = false) {
  const box = $('toast');
  box.textContent = message;
  box.classList.toggle('error', Boolean(error));
  box.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'auto';
}

function engineOn(name) {
  return Boolean(state.engines?.[name]?.connected);
}

function renderEngines() {
  document.querySelectorAll('.engine-chip[data-engine]').forEach((chip) => {
    chip.classList.toggle('on', engineOn(chip.dataset.engine));
  });
  document.querySelector('.engine-chip.browser')?.classList.add('on');
  const mini = state.engines?.mini;
  const full = state.engines?.full;
  $('mini-meta').textContent = mini?.connected
    ? `已连接 · 端口 ${mini.port}${mini.version ? ` · ${mini.version}` : ''}`
    : '未连接';
  $('full-meta').textContent = full?.connected
    ? `已连接 · 端口 ${full.port}${full.version ? ` · ${full.version}` : ''}`
    : '未连接';
  $('native-meta').textContent = state.native?.ok
    ? `Native Host：可用${state.native.mode ? ` · ${state.native.mode}` : ''}`
    : 'Native Host：不可用（需运行 native-host 注册脚本或安装完整版）';
}

function refreshSpeedSamples(task) {
  const now = Date.now();
  const previous = state.byteSamples.get(task.id);
  if (!previous || now - previous.at < 700) {
    state.byteSamples.set(task.id, {
      bytes: task.downloaded,
      at: previous?.at || now,
      speed: previous?.speed || 0,
    });
    return previous?.speed || 0;
  }
  const deltaBytes = Math.max(0, task.downloaded - previous.bytes);
  const seconds = Math.max(0.7, (now - previous.at) / 1000);
  const instant = deltaBytes / seconds;
  const speed = previous.speed ? previous.speed * 0.55 + instant * 0.45 : instant;
  state.byteSamples.set(task.id, { bytes: task.downloaded, at: now, speed });
  return speed;
}

function taskSpeed(task) {
  if (task.status !== 'downloading') return 0;
  if (task.engine !== 'browser' && task.speed > 0) return task.speed;
  return refreshSpeedSamples(task);
}

function filteredTasks() {
  const query = state.query.trim().toLowerCase();
  const list = state.tasks.filter((task) => {
    if (state.source !== 'all' && task.engine !== state.source) return false;
    if (state.filter === 'downloading' && !['downloading', 'pending'].includes(task.status)) return false;
    if (state.filter !== 'all' && state.filter !== 'downloading' && task.status !== state.filter) return false;
    if (!query) return true;
    return [task.name, task.url, task.site, task.pageUrl, task.error]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  if (state.sort === 'time') list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else if (state.sort === 'name') list.sort((a, b) => collator.compare(a.name, b.name));
  else if (state.sort === 'size') list.sort((a, b) => (b.size || 0) - (a.size || 0));
  else if (state.sort === 'progress') {
    list.sort((a, b) => {
      const pa = a.size > 0 ? a.downloaded / a.size : 0;
      const pb = b.size > 0 ? b.downloaded / b.size : 0;
      return pb - pa;
    });
  }
  return list;
}

function taskRow(task) {
  const row = el('div', `task${task.status === 'failed' ? ' failed' : ''}`);
  row.dataset.id = task.id;

  const check = el('input', 'task-select');
  check.type = 'checkbox';
  check.checked = state.selected.has(task.id);
  check.dataset.select = task.id;
  check.setAttribute('aria-label', `选择 ${task.name}`);
  row.appendChild(check);

  const main = el('div', 'task-main');
  const head = el('div', 'task-head');
  head.appendChild(el('div', 'task-name', task.name));
  head.appendChild(el('span', `badge ${task.engine}`, ENGINE_LABEL[task.engine] || task.engine));
  head.appendChild(el('span', `badge status-${task.status}`, STATUS_LABEL[task.status] || task.status));
  main.appendChild(head);

  const meta = el('div', 'task-meta');
  if (task.site) meta.appendChild(el('span', '', task.site));
  meta.appendChild(el('span', '', `${formatBytes(task.downloaded)}${task.size > 0 ? ` / ${formatBytes(task.size)}` : ''}`));
  if (task.category) meta.appendChild(el('span', '', CATEGORY_LABEL[task.category] || task.category));
  if (task.createdAt) meta.appendChild(el('span', '', formatTime(task.createdAt)));
  main.appendChild(meta);

  const speed = taskSpeed(task);
  const percent = task.size > 0 ? Math.min(100, (task.downloaded / task.size) * 100) : 0;
  const progressRow = el('div', 'progress-row');
  const progress = el('div', 'progress');
  if (task.status === 'downloading' && task.size <= 0) progress.classList.add('indeterminate');
  const bar = el('i');
  bar.style.width = `${percent.toFixed(1)}%`;
  progress.appendChild(bar);
  progressRow.appendChild(progress);
  let progressText = '';
  if (task.status === 'downloading') {
    progressText = `${percent.toFixed(1)}% · ${formatSpeed(speed)}${task.etaMs ? ` · 剩 ${formatDuration(task.etaMs)}` : ''}`;
  } else if (task.status === 'completed') {
    progressText = '已完成';
  } else if (task.status === 'paused') {
    progressText = `${percent.toFixed(1)}% · 已暂停`;
  } else if (task.status === 'failed') {
    progressText = '失败';
  } else {
    progressText = '等待中';
  }
  progressRow.appendChild(el('div', 'progress-text', progressText));
  main.appendChild(progressRow);

  if (task.error) main.appendChild(el('div', 'task-error', task.error));
  row.appendChild(main);

  const actions = el('div', 'task-actions');
  const add = (action, label, danger = false, options = {}) => {
    const btn = el('button', `mini-act${danger ? ' danger' : ''}`, label);
    btn.dataset.action = action;
    btn.dataset.id = task.id;
    if (options.disabled) {
      btn.disabled = true;
      if (options.title) btn.title = options.title;
    }
    actions.appendChild(btn);
  };
  if (task.status === 'downloading' || task.status === 'pending') add('pause', '暂停');
  if (task.status === 'paused') add('resume', '继续');
  if (task.status === 'failed') add('retry', '重试');
  if (task.status === 'completed') {
    add('open', '打开');
    add('reveal', '所在文件夹');
  }
  if (task.url && task.status !== 'completed') add('copy', '复制链接');
  if (task.url && task.status !== 'completed') {
    add('return-to-browser', '交给浏览器', false, {
      disabled: task.engine === 'browser', title: '当前已在浏览器下载',
    });
    add('relay-mini', '交给 YunX Mini', false, {
      disabled: task.engine === 'mini', title: '当前已在 YunX Mini 中',
    });
    add('relay-full', '交给 YunX 完整版', false, {
      disabled: task.engine === 'full', title: '当前已在 YunX 完整版中',
    });
  }
  add('remove', '删除', true);
  row.appendChild(actions);
  return row;
}

function renderTasks() {
  const list = filteredTasks();
  const box = $('task-list');
  box.replaceChildren();
  const empty = $('empty-state');
  const hasAny = state.tasks.length > 0;
  empty.hidden = list.length > 0;
  if (list.length === 0) {
    $('empty-title').textContent = hasAny ? '没有匹配的任务' : '暂无下载任务';
    $('empty-desc').textContent = hasAny
      ? '调整筛选条件或搜索关键词试试。'
      : '在网页中点击下载，YunX Fetch 会自动接管并显示在这里。';
    $('btn-wake-mini').hidden = hasAny;
    $('btn-wake-full').hidden = hasAny;
    $('btn-clear-completed').hidden = true;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const task of list) frag.appendChild(taskRow(task));
  box.appendChild(frag);
  $('btn-clear-completed').hidden = !state.tasks.some((task) => task.status === 'completed');
}

function renderSummary() {
  const summary = state.summary || {};
  $('stat-downloading').textContent = String(summary.downloading || 0);
  $('stat-completed').textContent = String(summary.completed || 0);
  $('stat-failed').textContent = String(summary.failed || 0);
  $('stat-paused').textContent = String(summary.paused || 0);
  const live = state.tasks.reduce((sum, task) => sum + taskSpeed(task), 0);
  const total = live > 0 ? live : summary.totalSpeed || 0;
  $('total-speed').textContent = total > 0 ? formatSpeed(total) : '—';
}

function renderBatch() {
  const bar = $('batchbar');
  bar.hidden = state.selected.size === 0;
  $('batch-count').textContent = `已选择 ${state.selected.size} 项`;
}

function render() {
  renderSummary();
  renderEngines();
  renderTasks();
  renderBatch();
}

async function refreshTasks() {
  const response = await send({ type: 'fetch.tasks.list' });
  if (!response?.ok) return;
  state.tasks = response.tasks || [];
  state.summary = response.summary || {};
  state.engines = response.engines || state.engines;
  const ids = new Set(state.tasks.map((task) => task.id));
  for (const id of Array.from(state.selected)) {
    if (!ids.has(id)) state.selected.delete(id);
  }
  render();
}

function scheduleRefresh(delay = 1000) {
  clearTimeout(state.pollTimer);
  if (document.hidden) return;
  state.pollTimer = setTimeout(async () => {
    await refreshTasks();
    scheduleRefresh(state.tasks.some((task) => ['downloading', 'pending'].includes(task.status)) ? 1000 : 2500);
  }, delay);
}

async function loadSettings() {
  const response = await send({ type: 'fetch.settings.get' });
  if (!response?.ok) return;
  state.settings = response.settings;
  applyTheme(state.settings.theme);
  $('sw-enabled').checked = Boolean(state.settings.enabled);
  $('sw-takeover').checked = Boolean(state.settings.takeover);
  $('sw-sniff').checked = Boolean(state.settings.sniff);
  $('sw-hide-ui').checked = Boolean(state.settings.hideNativeUi);
  $('sw-panel').checked = state.settings.openPanelOnDownload !== false;
  $('sw-delete-file').checked = Boolean(state.settings.deleteFileOnRemove);
  $('sw-skip-confirm').checked = Boolean(state.settings.skipDeleteConfirm);
  $('sw-notify').checked = Boolean(state.settings.notifyComplete);
  $('route-mode').value = state.settings.route || 'auto';
  $('sw-wake-mini').checked = Boolean(state.settings.autoWakeMini);
  $('sw-wake-full').checked = Boolean(state.settings.autoWakeFull);
  $('theme-mode').value = state.settings.theme || 'auto';
  loadUiPermission();
}

/** 显示 downloads.ui 授权状态：未授权时「隐藏原生气泡」不会生效 */
async function loadUiPermission() {
  const response = await send({ type: 'fetch.permissions.status' });
  const node = $('ui-permission');
  if (!node) return;
  const granted = Boolean(response?.downloadsUi);
  node.textContent = granted
    ? '下载气泡权限：已授权（隐藏后由下载浮窗展示任务）'
    : '下载气泡权限：未授权，暂不能隐藏原生气泡（部分 Edge 版本不支持该权限）';
}

async function saveSettings(patch) {
  const response = await send({ type: 'fetch.settings.set', settings: patch });
  if (response?.ok) {
    state.settings = response.settings;
    applyTheme(state.settings.theme);
  } else {
    toast(response?.error || '保存设置失败', true);
  }
  return response;
}

async function loadMiniSettings() {
  const response = await send({ type: 'fetch.mini.settings.get' });
  const group = $('mini-settings-group');
  const connected = Boolean(response?.ok);
  state.miniSettingsLoaded = connected;
  group.classList.toggle('disabled', !connected);
  group.querySelectorAll('input, button').forEach((input) => { input.disabled = !connected; });
  if (!connected) return;
  $('mini-threads').value = response.threads ?? state.settings?.defaultThreads ?? 32;
  $('mini-concurrency').value = response.concurrency ?? state.settings?.defaultConcurrency ?? 3;
  $('mini-speed').value = Math.round((response.speedLimit || 0) / 1024);
  $('mini-retry').value = response.retryCount ?? 3;
  $('mini-idle').value = response.idleMinutes ?? state.settings?.idleMinutes ?? 10;
  $('mini-savedir').value = response.saveDir || '';
}

async function saveMiniSettings() {
  if (!state.miniSettingsLoaded) {
    toast('YunX Mini 未连接', true);
    return;
  }
  const settings = {
    threads: Number($('mini-threads').value) || 32,
    concurrency: Number($('mini-concurrency').value) || 3,
    speedLimit: Math.max(0, Number($('mini-speed').value) || 0) * 1024,
    retryCount: Number($('mini-retry').value) || 0,
    idleMinutes: Number($('mini-idle').value) || 0,
    saveDir: $('mini-savedir').value.trim(),
  };
  const response = await send({ type: 'fetch.mini.settings.set', settings });
  if (response?.ok) toast('Mini 参数已保存');
  else toast(response?.error || '保存失败，请确认 Mini 正在运行', true);
}

async function loadSiteRules() {
  const response = await send({ type: 'fetch.site.rules.get' });
  if (!response?.ok) return;
  const box = $('site-list');
  box.replaceChildren();
  const rules = response.rules || [];
  if (!rules.length) {
    box.appendChild(el('p', 'hint', '暂无自定义站点规则，默认全部接管。'));
    return;
  }
  for (const rule of rules) {
    const row = el('div', 'site-item');
    row.appendChild(el('span', '', rule.domain));
    const right = el('div');
    const label = el('span', 'hint', rule.mode === 'passthrough' ? '放行' : '接管');
    const remove = el('button', 'mini-act danger', '删除');
    remove.dataset.removeSite = rule.domain;
    right.appendChild(label);
    right.appendChild(remove);
    row.appendChild(right);
    box.appendChild(row);
  }
}

async function loadNativeStatus() {
  const response = await send({ type: 'fetch.native.status' });
  state.native = response;
  renderEngines();
}

async function handleAction(action, id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(task.url);
      toast('链接已复制');
    } catch {
      toast('复制失败', true);
    }
    return;
  }
  if (action === 'open' || action === 'reveal') {
    if (task.engine !== 'browser') {
      const response = await send({ type: 'fetch.task.action', id, action });
      if (!response?.ok) toast(response?.error || '操作失败', true);
      return;
    }
    if (action === 'open') await chrome.downloads.open(task.nativeId);
    else chrome.downloads.show(task.nativeId);
    return;
  }
  if (action === 'relay-mini' || action === 'relay-full') {
    const target = action === 'relay-mini' ? 'mini' : 'full';
    const label = target === 'mini' ? 'YunX Mini' : 'YunX 完整版';
    if (!window.confirm(`将「${task.name}」交给 ${label} 下载？`)) return;
    const response = await send({ type: 'fetch.task.relay', id, target });
    if (!response?.ok) toast(response?.error || '转交失败', true);
    else toast(`已交给 ${label}`);
    await refreshTasks();
    return;
  }
  if (action === 'return-to-browser') {
    const confirmed = window.confirm(`将「${task.name}」交给浏览器原生下载？`);
    if (!confirmed) return;
    // 冷却与忽略由后台在发起下载之前完成，保证一次点击即生效
    const response = await send({ type: 'fetch.task.handoff', id });
    if (!response?.ok) {
      toast(response?.error || '交还浏览器失败', true);
    } else {
      toast('已交给浏览器下载，该站点 5 分钟内不再接管');
    }
    await refreshTasks();
    return;
  }
  if (action === 'remove') {
    const deleteLocal = Boolean(state.settings?.deleteFileOnRemove);
    const hint = deleteLocal ? '（同时删除本地文件）' : '（保留本地文件）';
    if (!state.settings?.skipDeleteConfirm && !window.confirm(`删除任务「${task.name}」${hint}？`)) return;
    const response = await send({ type: 'fetch.task.action', id, action, deleteLocal });
    if (!response?.ok) toast(response?.error || '删除失败', true);
    await refreshTasks();
    return;
  }
  const response = await send({ type: 'fetch.task.action', id, action });
  if (!response?.ok) toast(response?.error || '操作失败', true);
  await refreshTasks();
}

async function batchAction(action) {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  if (action === 'clear') {
    state.selected.clear();
    renderBatch();
    renderTasks();
    return;
  }
  const deleteLocal = Boolean(state.settings?.deleteFileOnRemove);
  if (action === 'remove') {
    const hint = deleteLocal ? '（同时删除本地文件）' : '（保留本地文件）';
    if (!state.settings?.skipDeleteConfirm && !window.confirm(`删除选中的 ${ids.length} 个任务${hint}？`)) return;
  }
  for (const id of ids) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) continue;
    if (action === 'pause' && ['downloading', 'pending'].includes(task.status)) {
      await send({ type: 'fetch.task.action', id, action: 'pause' });
    } else if (action === 'resume' && task.status === 'paused') {
      await send({ type: 'fetch.task.action', id, action: 'resume' });
    } else if (action === 'remove') {
      await send({ type: 'fetch.task.action', id, action: 'remove', deleteLocal });
    }
  }
  if (action === 'remove') state.selected.clear();
  await refreshTasks();
}

async function wakeEngine(target) {
  toast(target === 'mini' ? '正在唤醒 YunX Mini…' : '正在唤醒 YunX 完整版…');
  const response = await send({ type: 'fetch.engine.wake', target });
  if (response?.ok) {
    toast(target === 'mini' ? 'YunX Mini 已启动' : 'YunX 完整版已启动');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await loadSettings();
    await loadMiniSettings();
    await loadNativeStatus();
    await refreshTasks();
  } else {
    toast(response?.error || '唤醒失败：请确认已安装 native host', true);
  }
}

function openSettings(open) {
  const drawer = $('settings-drawer');
  const mask = $('drawer-mask');
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  mask.hidden = !open;
  if (open) {
    loadNativeStatus();
    loadMiniSettings();
    loadSiteRules();
  }
}

function bindEvents() {
  $('btn-refresh').addEventListener('click', async () => {
    await send({ type: 'fetch.engine.refresh' });
    await refreshTasks();
    toast('已刷新');
  });
  $('btn-settings').addEventListener('click', () => openSettings(true));
  $('btn-close-settings').addEventListener('click', () => openSettings(false));
  $('drawer-mask').addEventListener('click', () => openSettings(false));

  $('status-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    state.filter = tab.dataset.filter;
    document.querySelectorAll('#status-tabs .tab').forEach((item) => {
      item.classList.toggle('active', item === tab);
    });
    renderTasks();
  });

  $('source-filter').addEventListener('change', (event) => {
    state.source = event.target.value;
    renderTasks();
  });
  $('sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderTasks();
  });
  let searchTimer = null;
  $('search-input').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value;
      renderTasks();
    }, 120);
  });

  $('task-list').addEventListener('click', (event) => {
    const select = event.target.closest('[data-select]');
    if (select) {
      const id = select.dataset.select;
      if (select.checked) state.selected.add(id);
      else state.selected.delete(id);
      renderBatch();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    handleAction(button.dataset.action, button.dataset.id).catch((error) => {
      toast(error?.message || '操作失败', true);
    });
  });

  $('batchbar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-batch]');
    if (!button) return;
    batchAction(button.dataset.batch).catch(() => toast('批量操作失败', true));
  });

  $('btn-clear-completed').addEventListener('click', async () => {
    const deleteLocal = Boolean(state.settings?.deleteFileOnRemove);
    const hint = deleteLocal ? '（同时删除本地文件）' : '（保留本地文件）';
    if (!state.settings?.skipDeleteConfirm && !window.confirm(`清除所有已完成任务${hint}？`)) return;
    const response = await send({ type: 'fetch.task.clearCompleted', deleteLocal });
    if (response?.ok) toast(`已清除 ${response.removed || 0} 个任务`);
    state.selected.clear();
    await refreshTasks();
  });

  $('btn-wake-mini').addEventListener('click', () => wakeEngine('mini'));
  $('btn-wake-full').addEventListener('click', () => wakeEngine('full'));
  document.querySelectorAll('[data-wake]').forEach((button) => {
    button.addEventListener('click', () => wakeEngine(button.dataset.wake));
  });

  const bindSwitch = (id, key, after = null) => {
    $(id).addEventListener('change', async (event) => {
      await saveSettings({ [key]: event.target.checked });
      if (after) await after(event.target.checked);
    });
  };
  bindSwitch('sw-enabled', 'enabled');
  bindSwitch('sw-takeover', 'takeover');
  bindSwitch('sw-sniff', 'sniff');
  bindSwitch('sw-panel', 'openPanelOnDownload');
  bindSwitch('sw-delete-file', 'deleteFileOnRemove');
  bindSwitch('sw-skip-confirm', 'skipDeleteConfirm');
  bindSwitch('sw-notify', 'notifyComplete');
  bindSwitch('sw-wake-mini', 'autoWakeMini');
  bindSwitch('sw-wake-full', 'autoWakeFull');

  $('sw-hide-ui').addEventListener('change', async (event) => {
    const checked = event.target.checked;
    try {
      const granted = checked
        ? await chrome.permissions.request({ permissions: ['downloads.ui'] })
        : await chrome.permissions.contains({ permissions: ['downloads.ui'] });
      if (checked && !granted) {
        event.target.checked = false;
        toast('当前浏览器未授予隐藏下载气泡权限', true);
        return;
      }
      await saveSettings({ hideNativeUi: checked });
      const applied = await send({ type: 'fetch.ui.apply' });
      await loadUiPermission();
      if (applied?.ok && applied.enabled === false) {
        toast('已隐藏 Edge 下载气泡，任务将显示在下载浮窗中');
      } else if (checked) {
        toast('已保存，但当前条件下仍保留原生气泡', true);
      } else {
        toast('已恢复 Edge 下载气泡');
      }
    } catch {
      event.target.checked = !checked;
      toast('当前 Edge 版本不支持隐藏下载气泡', true);
    }
  });

  $('route-mode').addEventListener('change', (event) => saveSettings({ route: event.target.value }));
  $('theme-mode').addEventListener('change', (event) => {
    applyTheme(event.target.value);
    saveSettings({ theme: event.target.value });
  });

  $('btn-save-mini').addEventListener('click', saveMiniSettings);

  $('btn-add-site').addEventListener('click', async () => {
    const domain = $('site-domain').value.trim();
    if (!domain) return;
    const mode = $('site-mode').value;
    const response = await send({ type: 'fetch.site.rule.set', domain, mode });
    if (response?.ok) {
      $('site-domain').value = '';
      await loadSiteRules();
      toast('站点规则已保存');
    } else {
      toast(response?.error || '保存失败', true);
    }
  });

  $('site-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-site]');
    if (!button) return;
    await send({ type: 'fetch.site.rule.remove', domain: button.dataset.removeSite });
    await loadSiteRules();
    toast('站点规则已删除');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(state.pollTimer);
    } else {
      refreshTasks();
      scheduleRefresh(400);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'fetch.tasks.changed' && !document.hidden) {
      clearTimeout(state.pollTimer);
      scheduleRefresh(250);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') openSettings(false);
    if (event.key === '/' && document.activeElement !== $('search-input')) {
      event.preventDefault();
      $('search-input').focus();
    }
  });
}

async function init() {
  bindEvents();
  await loadSettings();
  if (location.hash === '#settings') openSettings(true);
  await refreshTasks();
  loadSiteRules();
  loadNativeStatus();
  loadMiniSettings();
  scheduleRefresh(500);
}

init().catch((error) => {
  console.error(error);
  toast('初始化失败，请重新加载扩展', true);
});
