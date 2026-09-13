// Shared, DOM-free queue rules. Stored state never contains cookies or media URLs.
export const MAX_QUEUE = 1000;
export const MODES = ['loop', 'single', 'shuffle'];

export function normalizeSongs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(s => {
    if (!s || !/^[1-9]\d{0,15}$/.test(String(s.id)) || typeof s.name !== 'string' || seen.has(String(s.id))) return false;
    seen.add(String(s.id));
    return true;
  }).slice(0, MAX_QUEUE).map(s => ({
    // The server normally returns this small web DTO. Accept the native
    // NcmClient field names as well so a Rust server can serialize SongInfo
    // directly without an intermediate Node-shaped response.
    id: String(s.id), name: s.name.slice(0, 500),
    artists: (typeof s.artists === 'string' ? s.artists : typeof s.singer === 'string' ? s.singer : '').slice(0, 500),
    album: (typeof s.album === 'string' ? s.album : '').slice(0, 500),
    cover: [s.cover, s.pic_url, s.picUrl].find(url => typeof url === 'string' && /^https?:\/\//.test(url))?.replace(/^http:/, 'https:') || '',
    duration: Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0,
  }));
}

export function nextIndex(length, index, mode, direction = 1, ended = false, random = Math.random) {
  if (!length) return -1;
  if (index < 0 || index >= length) return 0;
  if (mode === 'single' && ended) return index;
  if (mode === 'shuffle' && length > 1) return (index + 1 + Math.floor(random() * (length - 1))) % length;
  return (index + direction + length) % length;
}

export function restoreState(raw) {
  let saved;
  try { saved = JSON.parse(raw); } catch { saved = null; }
  const queue = normalizeSongs(saved?.queue);
  const favorites = normalizeSongs(saved?.favorites);
  const index = queue.findIndex(s => s.id === String(saved?.currentId));
  return {
    queue, favorites, index,
    volume: Number.isFinite(saved?.volume) ? Math.min(1, Math.max(0, saved.volume)) : 0.7,
    mode: MODES.includes(saved?.mode) ? saved.mode : 'loop',
    theme: ['light', 'dark'].includes(saved?.theme) ? saved.theme : null,
  };
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
