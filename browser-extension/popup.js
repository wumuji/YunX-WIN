/**
 * 云析下载助手 —— popup 脚本
 * 展示云析连接状态、开关设置、当前页面嗅探到的资源（带分类与图片/视频预览），
 * 并可一键交给云析下载；B 站视频页额外提供专属卡片（清晰度 + 下载方式）。
 * 同时负责外观（自动 / 亮 / 暗）的读取、应用与持久化。
 */

'use strict';

const $ = (id) => document.getElementById(id);

/** 分类显示名（与 background.js 保持一致） */
const CATEGORY_LABELS = {
  image: '图片', video: '视频', audio: '音频', document: '文档',
  archive: '压缩包', program: '程序', font: '字体', other: '其他',
};

/** 分类筛选的展示顺序 */
const CATEGORY_ORDER = ['image', 'video', 'audio', 'document', 'archive', 'program', 'font', 'other'];

/** B 站清晰度 qn → 文案 */
const QN_LABEL = {
  6: '240P', 7: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
  80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K',
};

/** 读不到页面清晰度列表时的兜底档位（高→低） */
const FALLBACK_QUALITIES = [120, 116, 112, 80, 64, 32, 16];

/**
 * 已适配的「视频平台专属卡片」识别表（顺序即优先级）。
 *
 * - [quality] = true 的平台（目前只有 B 站）会展示「清晰度 + 下载方式」两个下拉，
 *   并在页面里读取当前播放清晰度；其余平台只给一个「交给云析下载」按钮 ——
 *   它们的清晰度档位插件端读不到，交给云析解析时按平台最高可用档处理。
 * - [re] 只做「是不是这个平台的视频页」的粗判，真正的链接识别与短链展开在云析侧完成。
 */
const VIDEO_PLATFORMS = [
  {
    key: 'bilibili', label: 'bilibili', color: '#fb7299', quality: true,
    re: /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com\/video\//i,
  },
  {
    key: 'douyin', label: '抖音', color: '#fe2c55', quality: false,
    re: /^https?:\/\/([a-z0-9-]+\.)*(douyin\.com|iesdouyin\.com)\//i,
  },
  {
    key: 'weibo', label: '微博', color: '#e6162d', quality: false,
    re: /^https?:\/\/([a-z0-9-]+\.)*(weibo\.com|weibo\.cn)\//i,
  },
  {
    key: 'acfun', label: 'AcFun', color: '#fd4c5d', quality: false,
    re: /^https?:\/\/([a-z0-9-]+\.)*acfun\.cn\//i,
  },
];

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return (tabs && tabs[0]) || null;
}

function fmtSize(n) {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch (e) { return ''; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setStatus(text, cls) {
  $('status-text').textContent = text;
  $('status').className = 'status' + (cls ? ' ' + cls : '');
}

let currentTab = null;

/** 资源与筛选状态 */
const state = { all: [], filter: 'all', tasks: [], tab: 'downloads', settings: {} };

/** 主题固定跟随浏览器：外观设置在下载中心里配置，弹窗不再提供切换 */
function applySystemTheme() {
  document.documentElement.dataset.theme = 'auto';
}

// ---------------------------------------------------------------- 资源渲染

function emptyHtml(title, sub) {
  return '<div class="empty">' +
    '<div class="empty-title">' + escapeHtml(title) + '</div>' +
    '<div class="empty-sub">' + escapeHtml(sub) + '</div>' +
    '</div>';
}

function renderResources(list) {
  state.all = Array.isArray(list) ? list : [];
  const cats = {};
  for (const r of state.all) cats[r.category || 'other'] = 1;
  if (state.filter !== 'all' && !cats[state.filter]) state.filter = 'all';
  renderFilters();
  renderItems();
}

function makeChip(cat, label, n) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (state.filter === cat ? ' active' : '');
  b.textContent = label + ' ' + n;
  b.addEventListener('click', () => {
    state.filter = cat;
    renderFilters();
    renderItems();
  });
  return b;
}

function renderFilters() {
  const box = $('filters');
  const counts = {};
  for (const r of state.all) {
    const c = r.category || 'other';
    counts[c] = (counts[c] || 0) + 1;
  }
  const cats = Object.keys(counts).sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  // 只有一种分类时没必要给筛选条
  if (cats.length <= 1) { box.hidden = true; box.innerHTML = ''; return; }

  box.hidden = false;
  box.innerHTML = '';
  box.appendChild(makeChip('all', '全部', state.all.length));
  for (const c of cats) box.appendChild(makeChip(c, CATEGORY_LABELS[c] || '其他', counts[c]));
}

function renderItems() {
  const box = $('list');
  const list = state.filter === 'all'
    ? state.all
    : state.all.filter((r) => (r.category || 'other') === state.filter);
  $('count').textContent = String(list.length);

  if (!state.all.length) {
    box.innerHTML = emptyHtml('暂无嗅探到的资源', '播放视频或点击页面上的下载按钮后再试');
    return;
  }
  if (!list.length) {
    box.innerHTML = emptyHtml('该分类下暂无资源', '切换上方分类查看其它资源');
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of list) frag.appendChild(makeItem(r));
  box.innerHTML = '';
  box.appendChild(frag);
}

function makeItem(r) {
  const cat = r.category || 'other';
  const previewable = (cat === 'image' || cat === 'video');

  const row = document.createElement('div');
  row.className = 'item';

  if (previewable) {
    const thumb = document.createElement('div');
    thumb.className = 'item-thumb';
    thumb.title = '点击预览';
    if (cat === 'image') {
      const img = document.createElement('img');
      img.src = r.url;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => { thumb.innerHTML = '<span>IMG</span>'; });
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<span>▶</span>';
    }
    thumb.addEventListener('click', () => openPreview(r));
    row.appendChild(thumb);
  }

  const main = document.createElement('div');
  main.className = 'item-main';

  const name = document.createElement('div');
  name.className = 'item-name' + (previewable ? ' clickable' : '');
  name.title = previewable ? ('点击预览：' + r.url) : r.url;
  name.textContent = r.fileName || r.url;
  if (previewable) name.addEventListener('click', () => openPreview(r));

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const bits = [];
  if (r.size > 0) bits.push(fmtSize(r.size));
  if (r.mime) bits.push(r.mime);
  bits.push(hostOf(r.url));
  meta.innerHTML =
    '<span class="tag cat-' + cat + '">' + escapeHtml(CATEGORY_LABELS[cat] || '其他') + '</span>' +
    '<span class="tag">' + (r.source === 'dom' ? '页面' : '网络') + '</span>' +
    '<span class="text">' + escapeHtml(bits.filter(Boolean).join(' · ')) + '</span>';

  main.appendChild(name);
  main.appendChild(meta);
  row.appendChild(main);

  if (previewable) {
    const pv = document.createElement('button');
    pv.type = 'button';
    pv.className = 'mini-btn';
    pv.textContent = '预览';
    pv.addEventListener('click', () => openPreview(r));
    row.appendChild(pv);
  }

  const btn = document.createElement('button');
  btn.className = 'dl-btn';
  btn.textContent = '下载';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '处理中';
    const resp = await send({
      type: 'yunx-download',
      url: r.url,
      fileName: r.fileName || '',
      size: r.size || -1,
      mime: r.mime || '',
      pageUrl: currentTab ? currentTab.url : '',
    });
    if (!resp || !resp.ok) {
      btn.disabled = false;
      btn.textContent = '下载';
      $('hint').textContent = (resp && resp.error) || '提交失败：请确认云析正在运行。';
      return;
    }
    if (resp.action === 'accept') {
      btn.textContent = '已交给云析';
      $('hint').textContent = '已交给云析下载（在云析弹窗里确认保存目录与线程数）。';
    } else if (resp.action === 'return') {
      btn.disabled = false;
      btn.textContent = '下载';
      $('hint').textContent = '云析未接管，已归还浏览器下载。';
    } else {
      btn.disabled = false;
      btn.textContent = '下载';
    }
  });

  row.appendChild(btn);
  return row;
}

// ---------------------------------------------------------------- 图片 / 视频预览

function openPreview(r) {
  const cat = r.category || 'other';
  const box = $('preview-body');
  box.innerHTML = '';
  $('preview-name').textContent = r.fileName || r.url;

  if (cat === 'image') {
    const img = document.createElement('img');
    img.src = r.url;
    img.alt = '';
    img.addEventListener('error', () => {
      box.innerHTML = '<div class="preview-fail">图片加载失败<br>可能需要登录，或该图片不允许跨站预览</div>';
    });
    box.appendChild(img);
  } else if (cat === 'video') {
    const v = document.createElement('video');
    v.src = r.url;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    v.addEventListener('error', () => {
      box.innerHTML = '<div class="preview-fail">视频预览失败<br>该地址可能限制跨站播放，可直接交给云析下载</div>';
    });
    box.appendChild(v);
  } else {
    return;
  }
  $('preview').hidden = false;
}

function closePreview() {
  const box = $('preview-body');
  box.innerHTML = '';
  $('preview').hidden = true;
}

function bindPreview() {
  $('preview-close').addEventListener('click', closePreview);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('preview').hidden) closePreview();
  });
}

// ---------------------------------------------------------------- bilibili 专属卡片

function biliQnLabel(qn) {
  return QN_LABEL[qn] || ('画质 ' + qn);
}

function bvidFromUrl(u) {
  const m = String(u || '').match(/\/video\/(BV[0-9a-zA-Z]{10}|av\d+)/i);
  return m ? m[1] : '';
}

/**
 * 注入到页面主世界执行：读取 B 站播放器当前清晰度与可选清晰度列表。
 * 必须自包含（不能引用 popup 作用域变量），因为会被序列化后在页面里跑。
 */
function readBiliInfo() {
  const out = { bvid: '', title: document.title || '', current: 0, qualities: [] };
  try {
    const m = location.pathname.match(/\/video\/(BV[0-9a-zA-Z]{10}|av\d+)/i);
    if (m) out.bvid = m[1];
  } catch (e) { /* ignore */ }

  let cur = 0;
  try {
    if (window.player && typeof window.player.getQuality === 'function') {
      const q = window.player.getQuality();
      if (typeof q === 'number') cur = q;
    }
  } catch (e) { /* ignore */ }

  const pi = window.__playinfo__ && window.__playinfo__.data;
  if (pi) {
    const list = [];
    const seen = {};
    const add = (qn, label) => {
      if (!qn || seen[qn]) return;
      seen[qn] = 1;
      list.push({ qn: qn, label: label || '' });
    };
    try {
      for (const f of (pi.support_formats || [])) {
        add(f.quality, f.new_description || f.display_desc || f.description);
      }
      for (const qn of (pi.accept_quality || [])) add(qn, '');
    } catch (e) { /* ignore */ }

    if (!cur) {
      try {
        if (pi.dash && pi.dash.video && pi.dash.video.length) cur = pi.dash.video[0].id;
        else if (typeof pi.quality === 'number') cur = pi.quality;
      } catch (e) { /* ignore */ }
    }
    out.qualities = list;
  }
  out.current = cur;
  return out;
}

/** 当前标签页命中已适配的视频平台时展示专属卡片（B 站额外读取清晰度档位） */
async function loadVideoCard(tab) {
  const card = $('video-card');
  const url = (tab && tab.url) || '';
  const pf = VIDEO_PLATFORMS.find((p) => p.re.test(url));
  if (!pf) {
    card.hidden = true;
    card.dataset.platform = '';
    return;
  }
  card.hidden = false;
  card.dataset.platform = pf.key;
  $('vcard-badge').textContent = pf.label;
  $('vcard-badge').style.background = pf.color;
  $('vcard-id').textContent = '';
  $('vcard-title').textContent = '正在读取视频信息…';
  $('video-hint').textContent = '';
  $('vcard-fields').hidden = !pf.quality;
  $('video-download').disabled = false;
  $('video-download').textContent = '交给 YunX 下载';

  // 只有 B 站能从页面里读到清晰度；其余平台直接用标签页标题，交给云析解析
  if (!pf.quality) {
    $('vcard-title').textContent = tab.title || (pf.label + '视频');
    $('video-hint').textContent = '云析会解析当前页面，按该平台可用的最高清晰度下载。';
    return;
  }

  let info = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: readBiliInfo,
    });
    info = (results && results[0] && results[0].result) || null;
  } catch (e) {
    info = null;
  }
  if (!info) info = { bvid: '', title: tab.title || '', current: 0, qualities: [] };

  const bvid = info.bvid || bvidFromUrl(tab.url);
  $('vcard-id').textContent = bvid || '';
  $('vcard-title').textContent = info.title || tab.title || 'B 站视频';

  let quals = Array.isArray(info.qualities) ? info.qualities.filter((q) => q && q.qn) : [];
  if (!quals.length) quals = FALLBACK_QUALITIES.map((qn) => ({ qn: qn, label: '' }));
  quals.sort((a, b) => b.qn - a.qn);

  const sel = $('video-quality');
  sel.innerHTML = '';
  const cur = info.current || 0;
  let hasCurrent = false;
  for (const q of quals) {
    const o = document.createElement('option');
    o.value = String(q.qn);
    const tail = q.label ? ('（' + q.label + '）') : '';
    o.textContent = biliQnLabel(q.qn) + tail + (q.qn === cur ? ' · 当前播放' : '');
    if (q.qn === cur) hasCurrent = true;
    sel.appendChild(o);
  }
  if (hasCurrent) sel.value = String(cur);
  else sel.selectedIndex = 0;
}

function bindVideoCard() {
  $('video-download').addEventListener('click', async () => {
    const card = $('video-card');
    const platform = card.dataset.platform || '';
    const btn = $('video-download');
    const tab = currentTab || (await activeTab());
    btn.disabled = true;
    btn.textContent = '提交中…';

    let resp;
    if (platform === 'bilibili') {
      const bvid = $('vcard-id').textContent.trim();
      if (!bvid) {
        btn.disabled = false;
        btn.textContent = '交给云析下载';
        $('video-hint').textContent = '未识别到视频 BV 号，请刷新页面后重试。';
        return;
      }
      resp = await send({
        type: 'yunx-bili-download',
        bvid: bvid,
        qn: parseInt($('video-quality').value, 10) || 0,
        mode: $('video-mode').value || 'merge',
        title: $('vcard-title').textContent,
        pageUrl: tab ? tab.url : '',
      });
    } else {
      resp = await send({
        type: 'yunx-video-download',
        platform: platform,
        url: tab ? tab.url : '',
        title: $('vcard-title').textContent,
        pageUrl: tab ? tab.url : '',
      });
    }

    btn.disabled = false;
    btn.textContent = '交给云析下载';
    if (resp && resp.ok) {
      $('video-hint').textContent =
        platform === 'bilibili'
          ? '已交给云析，将按所选清晰度与方式加入下载队列。'
          : '已交给云析，正在解析并加入下载队列。';
    } else {
      $('video-hint').textContent = (resp && resp.error) || '提交失败：请确认云析正在运行。';
    }
  });
}

// ---------------------------------------------------------------- 归还后冷却提示

/** 倒计时定时器；弹窗关闭时清理 */
let cdTimer = null;

function fmtRemain(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ' 分 ' + (s < 10 ? '0' : '') + s + ' 秒';
}

function stopCdTimer() {
  if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
}

/** 展示/隐藏冷却提示条；remainMs <= 0 时隐藏并停表 */
function renderCooldown(remainMs) {
  const banner = $('cd-banner');
  if (remainMs > 0) {
    banner.hidden = false;
    $('cd-time').textContent = fmtRemain(remainMs);
  } else {
    stopCdTimer();
    banner.hidden = true;
  }
}

/** 查询当前标签页根域名是否处于「归还后」的冷却期，是则开启实时倒计时 */
async function loadCooldown(tab) {
  stopCdTimer();
  const url = (tab && tab.url) || '';
  if (!/^https?:/i.test(url)) { renderCooldown(0); return; }

  const resp = await send({ type: 'yunx-cooldown-status', url: url });
  const remain = resp && resp.ok ? (resp.remainMs || 0) : 0;
  if (remain <= 0) { renderCooldown(0); return; }

  const endAt = Date.now() + remain;
  renderCooldown(remain);
  cdTimer = setInterval(() => {
    const left = endAt - Date.now();
    if (left <= 0) { renderCooldown(0); return; }
    $('cd-time').textContent = fmtRemain(left);
  }, 1000);
}

function bindCooldown() {
  $('cd-resume').addEventListener('click', async () => {
    const btn = $('cd-resume');
    btn.disabled = true;
    const tab = currentTab || (await activeTab());
    await send({ type: 'yunx-cooldown-clear', url: (tab && tab.url) || '' });
    renderCooldown(0);
    btn.disabled = false;
    $('hint').textContent = '已恢复捕获，该网站的下载将重新交给云析。';
  });
  window.addEventListener('pagehide', stopCdTimer);
}

// ---------------------------------------------------------------- 数据加载

async function loadStatus() {
  const resp = await send({ type: 'yunx-status' });
  if (resp && resp.connected) {
    const mode = resp.mode === 'mini' ? 'YunX Mini' : 'YunX 完整版';
    setStatus(mode + ' 已连接', 'on');
  } else {
    setStatus('未检测到引擎，将使用浏览器下载', 'off');
  }
}

async function loadResources() {
  currentTab = await activeTab();
  const tabId = currentTab ? currentTab.id : -1;
  const resp = await send({ type: 'yunx-get-resources', tabId: tabId });
  renderResources((resp && resp.resources) || []);
  const badge = $('res-count');
  const total = state.all.length;
  badge.hidden = total === 0;
  badge.textContent = String(total);
}

// ---------------------------------------------------------------- 下载中心

function fmtSpeed(n) {
  if (!n || n <= 0) return '';
  return fmtSize(n) + '/s';
}

function fmtEta(ms) {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0');
}

function percentOf(task) {
  if (task.status === 'completed') return 100;
  if (!task.size || task.size <= 0) return 0;
  return Math.min(100, Math.round((task.downloaded / task.size) * 100));
}

function taskMeta(task) {
  if (task.status === 'completed') return fmtSize(task.size || task.downloaded);
  if (task.status === 'failed') return task.error || '失败';
  const parts = [];
  if (task.size > 0) parts.push(percentOf(task) + '% · ' + fmtSize(task.downloaded) + ' / ' + fmtSize(task.size));
  else parts.push(fmtSize(task.downloaded));
  if (task.status === 'downloading' && task.speed > 0) parts.push(fmtSpeed(task.speed));
  if (task.status === 'downloading' && task.etaMs > 0) parts.push('剩余 ' + fmtEta(task.etaMs));
  if (task.status === 'paused') parts.push('已暂停');
  if (task.status === 'pending') parts.push('等待中');
  return parts.join(' · ');
}

function taskNode(task) {
  const row = document.createElement('div');
  row.className = 't-item';

  const head = document.createElement('div');
  head.className = 't-head';
  const name = document.createElement('span');
  name.className = 't-name';
  name.textContent = task.name || 'download';
  name.title = task.name || '';
  const tag = document.createElement('span');
  const engineLabels = { mini: 'YunX Mini', full: 'YunX 完整版', browser: '浏览器' };
  tag.className = 't-tag' +
    (task.engine === 'browser' ? ' browser' : '') +
    (task.status === 'failed' ? ' failed' : '') +
    (task.status === 'completed' ? ' completed' : '');
  tag.textContent = engineLabels[task.engine] || task.engine;
  head.appendChild(name);
  head.appendChild(tag);

  const bar = document.createElement('div');
  bar.className = 't-bar';
  const fill = document.createElement('i');
  fill.style.width = percentOf(task) + '%';
  bar.appendChild(fill);

  const meta = document.createElement('div');
  meta.className = 't-meta';
  const metaText = document.createElement('span');
  metaText.textContent = taskMeta(task);
  const site = document.createElement('span');
  site.className = 'site';
  site.textContent = task.site || '';
  meta.appendChild(metaText);
  meta.appendChild(site);

  row.appendChild(head);
  row.appendChild(bar);
  row.appendChild(meta);

  const acts = document.createElement('div');
  acts.className = 't-acts';
  const action = (label, name2, options = {}) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 't-btn' + (options.danger ? ' danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      const deleteLocal = Boolean(state.settings?.deleteFileOnRemove);
      if (options.confirm && !state.settings?.skipDeleteConfirm) {
        const hint = name2 === 'remove'
          ? (deleteLocal ? '（同时删除本地文件）' : '（保留本地文件）')
          : '';
        if (!window.confirm(`删除任务「${task.name}」${hint}？`)) return;
      }
      btn.disabled = true;
      const payload = { type: 'fetch.task.action', id: task.id, action: name2 };
      if (name2 === 'remove') payload.deleteLocal = deleteLocal;
      const resp = await send(payload);
      if (resp && resp.ok === false) $('hint').textContent = resp.error || '操作失败';
      else if (name2 === 'remove') $('hint').textContent = deleteLocal ? '已删除任务与本地文件' : '已删除任务（文件已保留）';
      await loadTasks();
    });
    acts.appendChild(btn);
  };
  if (task.status === 'downloading' || task.status === 'pending') action('暂停', 'pause');
  if (task.status === 'paused') action('继续', 'resume');
  if (task.status === 'failed') action('重试', 'retry');
  if (task.status === 'completed') action('打开', 'open');
  action('删除', 'remove', { danger: true, confirm: true });
  row.appendChild(acts);
  return row;
}

function renderTasks(summary) {
  const box = $('task-list');
  const active = state.tasks.filter((t) => ['downloading', 'pending', 'paused', 'failed'].includes(t.status));
  const recent = state.tasks.filter((t) => t.status === 'completed').slice(0, 2);
  const list = [...active, ...recent];

  const badge = $('task-count');
  badge.hidden = active.length === 0;
  badge.textContent = String(active.length);

  $('dl-summary').textContent = active.length
    ? active.length + ' 个任务进行中'
    : list.length ? '最近完成 ' + list.length + ' 个任务' : '暂无下载任务';
  $('dl-speed').textContent = summary && summary.totalSpeed > 0 ? fmtSpeed(summary.totalSpeed) : '';

  box.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 't-empty';
    const title = document.createElement('b');
    title.textContent = '暂无下载任务';
    empty.appendChild(title);
    empty.appendChild(document.createTextNode('在网页中点击下载，任务会出现在这里'));
    box.appendChild(empty);
    return;
  }
  for (const task of list) box.appendChild(taskNode(task));
}

async function loadTasks() {
  const resp = await send({ type: 'fetch.tasks.list' });
  state.tasks = (resp && resp.tasks) || [];
  renderTasks(resp && resp.summary);
}

/** 任务操作需要知道「删除时是否连本地文件一起删」，只读一次即可 */
async function loadTaskSettings() {
  const resp = await send({ type: 'fetch.settings.get' });
  if (resp && resp.ok) state.settings = resp.settings || {};
}

// ---------------------------------------------------------------- 标签页

let resourcesLoaded = false;

async function loadResourcesOnce() {
  if (resourcesLoaded) return;
  resourcesLoaded = true;
  await loadResources();
  await loadVideoCard(currentTab);
  await loadCooldown(currentTab);
}

function showTab(name) {
  state.tab = name === 'resources' ? 'resources' : 'downloads';
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  $('pane-downloads').hidden = state.tab !== 'downloads';
  $('pane-resources').hidden = state.tab !== 'resources';
  $('refresh').hidden = state.tab !== 'resources';
  if (state.tab === 'resources') loadResourcesOnce().catch(() => {});
}

function bindTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  }
}

// ---------------------------------------------------------------- 事件

$('open-manager-2').addEventListener('click', async () => {
  await send({ type: 'fetch.manager.open' });
  window.close();
});

$('open-folder').addEventListener('click', async () => {
  const resp = await send({ type: 'fetch.downloads.folder' });
  if (!resp || resp.ok === false) $('hint').textContent = (resp && resp.error) || '无法打开下载文件夹';
});

$('open-settings').addEventListener('click', async () => {
  await send({ type: 'fetch.manager.open', section: 'settings' });
  window.close();
});

$('refresh').addEventListener('click', async () => {
  $('hint').textContent = '正在刷新…';
  await loadStatus();
  await loadResources();
  await loadVideoCard(currentTab);
  await loadCooldown(currentTab);
  $('hint').textContent = '任务与设置只保存在本机，不上传任何数据。';
});

let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    loadTasks().catch(() => {});
  }, 1200);
  window.addEventListener('pagehide', () => clearInterval(pollTimer));
}

(async function init() {
  applySystemTheme();
  bindTabs();
  bindPreview();
  bindVideoCard();
  bindCooldown();
  await loadStatus();
  await loadTaskSettings();
  await loadTasks();
  showTab('downloads');
  startPolling();
})();
