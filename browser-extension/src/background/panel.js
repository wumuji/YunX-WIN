/**
 * 下载浮窗（代替 Edge 原生下载气泡的常驻入口）。
 *
 * 扩展无法用代码打开工具栏 popup，所以这里用小窗口承载「气泡」：
 * 下载触发时按需弹出/复用同一个窗口，展示任务列表；原生下载 UI 被隐藏时它是唯一可见入口。
 */

const PANEL_PAGE = 'panel.html';
const SESSION_KEY = 'panelWindowId';

let panelId = null;
let opening = null;

function store() {
  return chrome.storage.session || chrome.storage.local;
}

async function readStoredId() {
  if (panelId) return panelId;
  try {
    const data = await store().get(SESSION_KEY);
    panelId = Number(data[SESSION_KEY]) || null;
  } catch {
    panelId = null;
  }
  return panelId;
}

async function writeStoredId(id) {
  panelId = id || null;
  try {
    await store().set({ [SESSION_KEY]: id || 0 });
  } catch {
    // 忽略
  }
}

async function windowAlive(id) {
  if (!id) return false;
  try {
    await chrome.windows.get(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * 优先在页面内展示气泡（与 Edge 原生下载气泡同样的位置与交互）。
 * 内容脚本无法运行的页面（edge://、扩展页、PDF 内置查看器等）返回 false，由调用方回退到小窗。
 */
async function showBubbleInActiveTab(message = 'yunx-bubble-open') {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab?.id) return false;
    const url = tab.url || '';
    // 已经在看下载中心/浮窗时不再叠加气泡或另开窗口
    if (url.startsWith(chrome.runtime.getURL(''))) return true;
    if (!/^https?:/i.test(url)) return false;
    await chrome.tabs.sendMessage(tab.id, { type: message });
    return true;
  } catch {
    return false;
  }
}

/**
 * 打开（或复用）下载浮窗。
 * @param {{focus?: boolean}} options focus=true 时把已有浮窗拉到前台
 */
export async function openPanel({ focus = false } = {}) {
  if (opening) return opening;
  opening = (async () => {
    if (await showBubbleInActiveTab('yunx-bubble-open')) return 'bubble';
    const id = await readStoredId();
    if (await windowAlive(id)) {
      if (focus) {
        await chrome.windows.update(id, { focused: true }).catch(() => {});
      }
      return id;
    }
    await writeStoredId(null);
    try {
      const win = await chrome.windows.create({
        url: chrome.runtime.getURL(PANEL_PAGE),
        type: 'popup',
        width: 430,
        height: 560,
        focused: Boolean(focus),
      });
      await writeStoredId(win.id);
      return win.id;
    } catch {
      return null;
    }
  })();
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

export async function closePanel() {
  const inTab = await showBubbleInActiveTab('yunx-bubble-close');
  const id = await readStoredId();
  await writeStoredId(null);
  if (!id) return { ok: true, inTab };
  try {
    await chrome.windows.remove(id);
  } catch {
    // 已经关掉了
  }
  return { ok: true, inTab };
}

export function initPanel() {
  chrome.windows.onRemoved.addListener((id) => {
    if (id === panelId) writeStoredId(null);
  });
}
