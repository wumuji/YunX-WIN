export const ENGINE = Object.freeze({
  FULL: 'full',
  MINI: 'mini',
  BROWSER: 'browser',
});

export const PORT_RANGES = Object.freeze({
  [ENGINE.FULL]: [37021, 37030],
  [ENGINE.MINI]: [37031, 37040],
});

export const STATUS_ORDER = Object.freeze({
  failed: 0,
  downloading: 1,
  pending: 2,
  paused: 3,
  completed: 4,
});

export const STATUS_LABEL = Object.freeze({
  failed: '失败',
  downloading: '下载中',
  pending: '等待中',
  paused: '已暂停',
  completed: '已完成',
});

export const ENGINE_LABEL = Object.freeze({
  full: 'YunX',
  mini: 'Mini',
  browser: '浏览器',
});

export const CATEGORY_LABEL = Object.freeze({
  video: '视频',
  audio: '音频',
  image: '图片',
  document: '文档',
  archive: '压缩包',
  app: '应用',
  program: '应用',
  font: '字体',
  torrent: '种子',
  other: '其他',
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  takeover: true,
  sniff: true,
  hideNativeUi: true,
  openPanelOnDownload: true,
  deleteFileOnRemove: false,
  skipDeleteConfirm: false,
  notifyComplete: true,
  route: 'auto',
  autoWakeMini: true,
  autoWakeFull: true,
  defaultThreads: 32,
  defaultConcurrency: 3,
  speedLimit: 0,
  idleMinutes: 10,
  theme: 'auto',
  sites: {},
});

export const COOLDOWN_MS = 5 * 60 * 1000;
export const PORT_SCAN_TIMEOUT_MS = 350;
export const STATUS_CACHE_MS = 15000;
export const MAX_META = 2000;
export const MAX_RESOURCES_PER_TAB = 300;
export const MAX_RESOURCE_URLS = 2000;
