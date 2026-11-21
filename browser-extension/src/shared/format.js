export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond) {
  const n = Number(bytesPerSecond) || 0;
  if (n <= 0) return '—';
  return `${formatBytes(n)}/s`;
}

export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '—';
  const total = Math.round(n / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export function formatTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function extensionCategory(name = '') {
  const ext = name.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v', 'rmvb'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'image';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'epub', 'csv'].includes(ext)) return 'document';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst'].includes(ext)) return 'archive';
  if (['exe', 'msi', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage'].includes(ext)) return 'app';
  if (['torrent'].includes(ext)) return 'torrent';
  return 'other';
}

export function safeFilename(name = 'download') {
  return String(name)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 180) || 'download';
}
