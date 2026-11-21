import { getSettings } from './settings.js';

/**
 * 应用「隐藏浏览器下载气泡」。
 *
 * 只有在同时满足三个条件时才真的把浏览器 UI 关掉，否则保留原生气泡：
 *   1. 有 downloads.ui 权限（Edge 部分版本不支持，未授权时 setUiOptions 会直接抛错）
 *   2. 用户勾选了 hideNativeUi
 *   3. 用户开着下载浮窗（openPanelOnDownload）——浮窗是唯一可见入口，
 *      两者都关掉就等于「下载了但界面上什么都看不到」
 *
 * 这一条正是之前「插件状态下无下载任务显示」的根因：权限已授权、原生气泡被隐藏，
 * 但浮窗不存在，用户只能看到任务被悄悄接管。
 */
export async function applyDownloadUiOptions() {
  if (!chrome.downloads?.setUiOptions) return { ok: false, error: 'unsupported' };
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ permissions: ['downloads.ui'] });
  } catch {
    granted = false;
  }
  const settings = await getSettings();
  const canHide = granted && settings.hideNativeUi && settings.openPanelOnDownload;
  if (!granted) return { ok: false, granted: false, enabled: true };
  try {
    await chrome.downloads.setUiOptions({ enabled: !canHide });
    return { ok: true, granted: true, enabled: !canHide, reason: canHide ? '' : 'panel-off' };
  } catch (error) {
    return { ok: false, granted: true, error: error?.message || 'setUiOptions-failed' };
  }
}
