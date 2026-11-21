const VIDEO_HOSTS = [
  'bilibili.com', 'b23.tv', 'douyin.com', 'iesdouyin.com', 'weibo.com', 'weibo.cn',
  'acfun.cn', 'xiaohongshu.com', 'xhslink.com', 'kuaishou.com', 'pixiv.net',
  'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'vimeo.com',
];

const SHARE_PATTERNS = [
  /pan\.quark\.cn\/s\//i,
  /drive\.uc\.cn\/s\//i,
  /pan\.xunlei\.com\/s\//i,
  /pan\.baidu\.com\/s\//i,
  /yun\.139\.com\/shareweb\//i,
  /(?:123865|123pan)\.(?:com|cn)\//i,
  /(?:115|115cdn|115rc)\.com\/s\//i,
  /guangyapan\.com\/s\//i,
  /ilanzou\.(?:com|net|org|cn)\/s\//i,
  /(?:lanzou[a-z0-9-]*|lan[zs]o[ux])\.(?:com|net|org|cn)\//i,
];

const P2P_RE = /^(magnet:|ed2k:)/i;

export function classifyUrl(rawUrl, mime = '') {
  const url = String(rawUrl || '').trim();
  if (!url) return { kind: 'passthrough', reason: 'empty' };
  if (P2P_RE.test(url) || /\.torrent(?:[?#]|$)/i.test(url)) return { kind: 'p2p' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'passthrough', reason: 'invalid-url' };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { kind: 'passthrough', reason: 'scheme' };

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const lowerMime = String(mime || '').toLowerCase();

  if (/raw\.githubusercontent\.com$/i.test(host) || /\/releases\/download\//i.test(path)) {
    return { kind: 'direct' };
  }
  if (SHARE_PATTERNS.some((re) => re.test(url)) || /^(www\.)?github\.com$/i.test(host)) {
    return { kind: 'share' };
  }
  if (VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { kind: 'video' };
  }
  if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(path) || /mpegurl|dash\+xml/.test(lowerMime)) {
    return { kind: 'hls' };
  }
  return { kind: 'direct' };
}

export function parseBilibiliBvid(url) {
  const match = String(url || '').match(/\/(BV[0-9A-Za-z]{10})/i);
  return match ? match[1] : '';
}

export function videoPlatformOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.includes('bilibili') || host === 'b23.tv') return 'bilibili';
    if (host.includes('douyin') || host.includes('iesdouyin')) return 'douyin';
    if (host.includes('weibo')) return 'weibo';
    if (host.includes('acfun')) return 'acfun';
    if (host.includes('xiaohongshu') || host === 'xhslink.com') return 'xiaohongshu';
    if (host.includes('kuaishou')) return 'kuaishou';
    if (host.includes('pixiv')) return 'pixiv';
    return host;
  } catch {
    return '';
  }
}
