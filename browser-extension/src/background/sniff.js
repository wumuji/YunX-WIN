import { MAX_RESOURCES_PER_TAB } from '../shared/constants.js';

const tabStore = new Map();
const URL_INDEX = new Map();

const MEDIA_MIME = /^(video|audio|image)\//i;
const DOWNLOAD_MIME = /(octet-stream|zip|rar|7z|tar|gzip|x-msdownload|x-msi|vnd\.android\.package-archive|pdf)/i;
const EXT_RE = /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|rmvb|mp3|flac|wav|aac|m4a|ogg|opus|jpg|jpeg|png|gif|webp|bmp|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|epub|csv|zip|rar|7z|tar|gz|bz2|xz|zst|exe|msi|apk|dmg|pkg|deb|rpm|iso|torrent|m3u8|mpd)(?:[?#]|$)/i;
const FONT_MIME = /^font\/|woff|ttf|otf/i;

function categoryFor(mime, url) {
  const m = String(mime || '').toLowerCase();
  const u = String(url || '').toLowerCase();
  if (/^video\//.test(m) || /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|rmvb|m3u8|mpd)/.test(u)) return 'video';
  if (/^audio\//.test(m) || /\.(mp3|flac|wav|aac|m4a|ogg|opus)/.test(u)) return 'audio';
  if (/^image\//.test(m) || /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)/.test(u)) return 'image';
  if (/pdf|word|excel|powerpoint|epub|text\//.test(m) || /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|epub|csv)/.test(u)) return 'document';
  if (/zip|rar|7z|tar|gzip|x-compressed/.test(m) || /\.(zip|rar|7z|tar|gz|bz2|xz|zst)/.test(u)) return 'archive';
  if (/x-msdownload|x-msi|android|dmg|pkg|deb|rpm/.test(m) || /\.(exe|msi|apk|dmg|pkg|deb|rpm|appimage|iso)/.test(u)) return 'program';
  if (FONT_MIME.test(m) || /\.(woff2?|ttf|otf|eot)/.test(u)) return 'font';
  if (/torrent/.test(m) || /\.torrent/.test(u)) return 'other';
  return 'other';
}

function nameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const base = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    return base || parsed.hostname;
  } catch {
    return url;
  }
}

function filenameFromDisposition(value, fallback) {
  if (!value) return fallback;
  const star = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/^"|"$/g, ''));
    } catch {
      return star[1];
    }
  }
  const plain = value.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1] : fallback;
}

function ensureTab(tabId, pageUrl = '') {
  let entry = tabStore.get(tabId);
  if (!entry) {
    entry = { pageUrl, items: new Map(), updated: 0 };
    tabStore.set(tabId, entry);
  }
  if (pageUrl) entry.pageUrl = pageUrl;
  return entry;
}

function remember(tabId, resource) {
  if (!resource?.url || !/^https?:/i.test(resource.url)) return;
  const entry = ensureTab(tabId);
  entry.items.set(resource.url, { ...(entry.items.get(resource.url) || {}), ...resource });
  entry.updated = Date.now();
  URL_INDEX.set(resource.url, tabId);
  if (entry.items.size > MAX_RESOURCES_PER_TAB) {
    const first = entry.items.keys().next().value;
    entry.items.delete(first);
  }
  if (URL_INDEX.size > 4000) {
    const first = URL_INDEX.keys().next().value;
    URL_INDEX.delete(first);
  }
}

function shouldRemember(url, mime, disposition) {
  if (/^(blob|data):/i.test(url)) return false;
  if (/attachment/i.test(disposition || '')) return true;
  if (MEDIA_MIME.test(mime || '') || DOWNLOAD_MIME.test(mime || '') || FONT_MIME.test(mime || '')) return true;
  return EXT_RE.test(url);
}

function onHeaders(details) {
  if (details.tabId < 0) return;
  if (details.type === 'main_frame') return;
  const headers = details.responseHeaders || [];
  const get = (name) => headers.find((h) => h.name?.toLowerCase() === name)?.value || '';
  const mime = get('content-type').split(';')[0].trim().toLowerCase();
  const disposition = get('content-disposition');
  if (!shouldRemember(details.url, mime, disposition)) return;
  const fileName = filenameFromDisposition(disposition, nameFromUrl(details.url));
  const size = Number(get('content-length')) || 0;
  remember(details.tabId, {
    url: details.url,
    fileName,
    category: categoryFor(mime, details.url),
    size,
    mime,
    source: 'network',
  });
}

const DOM_COLLECTOR = () => {
  const out = [];
  const seen = new Set();
  const add = (url, name, category, mime) => {
    if (!url || seen.has(url) || !/^https?:/i.test(url)) return;
    seen.add(url);
    out.push({ url, fileName: name || '', category: category || 'other', mime: mime || '', size: 0, source: 'dom' });
  };
  const baseName = (u) => {
    try {
      const p = new URL(u, location.href);
      return decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || '');
    } catch {
      return '';
    }
  };
  document.querySelectorAll('a[href]').forEach((el) => {
    const url = el.href;
    if (!/\.(zip|rar|7z|tar|gz|mp4|mkv|avi|mov|mp3|flac|pdf|docx?|xlsx?|apk|exe|iso|torrent)(?:[?#]|$)/i.test(url)) return;
    add(url, el.download || baseName(url), 'other');
  });
  document.querySelectorAll('img[src]').forEach((el) => add(el.currentSrc || el.src, baseName(el.src), 'image'));
  document.querySelectorAll('video[src], video source[src]').forEach((el) => add(el.src, baseName(el.src), 'video', 'video/mp4'));
  document.querySelectorAll('audio[src], audio source[src]').forEach((el) => add(el.src, baseName(el.src), 'audio', 'audio/mpeg'));
  return { pageUrl: location.href, title: document.title || '', items: out };
};

async function collectDom(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: DOM_COLLECTOR,
    });
    const result = results?.[0]?.result;
    if (!result) return;
    const entry = ensureTab(tabId, result.pageUrl);
    entry.title = result.title;
    for (const item of result.items || []) {
      remember(tabId, {
        ...item,
        category: item.category === 'other' ? categoryFor(item.mime, item.url) : item.category,
      });
    }
  } catch {
    // 受限页面（chrome://、扩展页等）忽略
  }
}

export function initSniff() {
  chrome.webRequest.onHeadersReceived.addListener(
    onHeaders,
    { urls: ['<all_urls>'], types: ['sub_frame', 'xmlhttprequest', 'media', 'object', 'other'] },
    ['responseHeaders'],
  );
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabStore.delete(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && changeInfo.url) {
      tabStore.set(tabId, { pageUrl: changeInfo.url, items: new Map(), updated: 0 });
    }
  });
}

export async function getTabResources(tabId) {
  let entry = tabStore.get(tabId);
  if (!entry) entry = ensureTab(tabId);
  if (!entry.updated || Date.now() - entry.updated > 1500) {
    await collectDom(tabId);
    entry = tabStore.get(tabId) || entry;
  }
  const items = Array.from(entry.items.values())
    .sort((a, b) => (b.size || 0) - (a.size || 0));
  return {
    pageUrl: entry.pageUrl || '',
    title: entry.title || '',
    resources: items,
  };
}

export async function collectTabResources(tabId) {
  await collectDom(tabId);
  return getTabResources(tabId);
}
