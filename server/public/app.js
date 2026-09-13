import { MAX_QUEUE, MODES, normalizeSongs, nextIndex, restoreState, formatTime } from './player-state.js';

const $ = selector => document.querySelector(selector);
const view = $('#view');
const audio = $('#audio');
const storageKey = 'ncm-web-player-v1';
let raw = null;
try { raw = localStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
const state = restoreState(raw);
state.theme ||= matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
let visibleSongs = [];
let currentView = 'discover';
let searchQuery = '';
let searchTotal = 0;
let searchOffset = 0;
let viewRequest;
let playbackRequest;
let playbackVersion = 0;
let loadingSong = false;
let retryAction;
let discoverData = [];
let qrPoll;
let lyricsLines = [];
let lyricsSongId = null;
let lyricsRequest;
let lastPlayerSongId = null;

function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ ...state, currentId: state.queue[state.index]?.id }));
  } catch { /* Playback remains available in private or storage-limited browsers. */ }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, action, label) {
  const node = element('button', className, text);
  node.type = 'button';
  if (label) { node.setAttribute('aria-label', label); node.title = label; }
  node.addEventListener('click', action);
  return node;
}

function cover(url, className = 'cover-small', lazy = true) {
  const node = element('div', className, '♫');
  node.setAttribute('aria-hidden', 'true');
  if (typeof url === 'string' && /^https:\/\//.test(url)) {
    const img = element('img');
    img.alt = '';
    img.loading = lazy ? 'lazy' : 'eager';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    img.addEventListener('error', () => img.replaceWith(document.createTextNode('♫')), { once: true });
    node.replaceChildren(img);
  }
  return node;
}

function notice(message = '') {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
}

async function api(path, signal) {
  const response = await fetch(path, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}

function heading(title, subtitle, kicker) {
  $('#title').textContent = title;
  $('#subtitle').textContent = subtitle;
  $('#kicker').textContent = kicker;
}

function empty(title, message, action, actionLabel = '重新加载') {
  const box = element('div', 'empty');
  box.append(element('span', 'empty-symbol', '♫'), element('h2', '', title), element('p', '', message));
  if (action) box.append(button(actionLabel, 'primary', action));
  view.replaceChildren(box);
}

function busy() {
  view.setAttribute('aria-busy', 'true');
  const skeleton = element('div', 'playlist-grid');
  skeleton.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 8; i++) skeleton.append(element('div', 'skeleton'));
  view.replaceChildren(skeleton);
}

function beginView(name) {
  viewRequest?.abort();
  viewRequest = new AbortController();
  currentView = name;
  retryAction = null;
  visibleSongs = [];
  notice();
  view.setAttribute('aria-busy', 'false');
  $('#refresh').hidden = name !== 'discover';
  document.querySelectorAll('[data-view]').forEach(nav => {
    const active = nav.dataset.view === name || (name === 'playlist' && nav.dataset.view === 'discover');
    nav.classList.toggle('active', active);
    if (active) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  });
  return viewRequest.signal;
}

async function loadView(name, title, subtitle, kicker, loader, render) {
  const signal = beginView(name);
  heading(title, subtitle, kicker);
  busy();
  retryAction = route;
  const refresh = $('#refresh');
  // Keep the label stable when a previous discover request was aborted.
  const refreshLabel = '↻ 刷新推荐';
  if (name === 'discover') {
    refresh.disabled = true;
    refresh.textContent = '加载中…';
  }
  try {
    const data = await loader(signal);
    if (!signal.aborted) render(data);
  } catch (error) {
    if (!signal.aborted) empty('暂时没有连接上', error.message, route);
  } finally {
    if (name === 'discover' && !signal.aborted) {
      refresh.disabled = false;
      refresh.textContent = refreshLabel;
    }
    if (!signal.aborted) view.setAttribute('aria-busy', 'false');
  }
}

function playCount(count) {
  if (!Number.isFinite(count)) return '';
  return count >= 100000000 ? `${(count / 100000000).toFixed(1)}亿` : count >= 10000 ? `${(count / 10000).toFixed(1)}万` : String(count);
}

function renderDiscover(data) {
  const playlists = Array.isArray(data) ? data : data?.playlists || data?.data;
  discoverData = (Array.isArray(playlists) ? playlists : []).map(p => ({
    ...p,
    // SongList is the native Rust model; the web DTO uses shorter aliases.
    cover: p.cover || p.cover_img_url || p.coverImgUrl || '',
    count: Number.isFinite(p.count) ? p.count : (Number.isFinite(p.track_count) ? p.track_count : 0),
    plays: Number.isFinite(p.plays) ? p.plays : (Number.isFinite(p.play_count) ? p.play_count : 0),
  }));
  if (!discoverData.length) return empty('还没有推荐歌单', '稍后刷新，看看有没有新的音乐。', route);
  const hero = element('section', 'hero');
  const copy = element('div', 'hero-copy');
  copy.append(element('span', 'eyebrow', 'A LITTLE MUSIC, A BETTER DAY'), element('h2', '', '把日常，调成喜欢的频率。'), element('p', '', '戴上耳机，让音乐带你去想去的地方。'));
  copy.append(button('探索今日歌单  ↗', 'primary', () => navigate(`playlist/${discoverData[0].id}`)));
  const record = element('div', 'record');
  record.setAttribute('aria-hidden', 'true');
  hero.append(copy, record);
  const title = element('div', 'section-heading');
  title.append(element('h2', '', '为你发现'), element('span', '', `${discoverData.length} 张歌单 · 无限种心情`));
  const grid = element('div', 'playlist-grid');
  discoverData.forEach(p => {
    const card = button('', 'playlist-card', () => navigate(`playlist/${p.id}`), `打开歌单：${p.name}`);
    const art = cover(p.cover, 'artwork');
    const count = playCount(p.plays);
    if (count) art.append(element('span', 'play-count', `▷ ${count}`));
    art.append(element('span', 'card-play', '↗'));
    card.append(art, element('strong', '', p.name), element('small', '', p.count ? `${p.count} 首歌曲` : '精选歌单'));
    grid.append(card);
  });
  view.replaceChildren(hero, title, grid);
}

function isFavorite(id) { return state.favorites.some(s => s.id === id); }

function toggleFavorite(song) {
  if (isFavorite(song.id)) state.favorites = state.favorites.filter(s => s.id !== song.id);
  else {
    if (state.favorites.length >= MAX_QUEUE) return notice(`最多收藏 ${MAX_QUEUE} 首歌曲，请先移除部分收藏。`);
    state.favorites.unshift(song);
  }
  save();
  syncFavorites();
  if (currentView === 'favorites') renderLibrary('favorites');
}

function syncFavorites() {
  $('#favorites-count').textContent = String(state.favorites.length);
  $('#favorites-count').hidden = state.favorites.length === 0;
  document.querySelectorAll('[data-favorite]').forEach(node => {
    const active = isFavorite(node.dataset.favorite);
    node.textContent = active ? '♥' : '♡';
    node.setAttribute('aria-pressed', String(active));
    node.setAttribute('aria-label', active ? '取消收藏' : '收藏歌曲');
    node.title = active ? '取消收藏' : '收藏歌曲';
  });
  const current = state.queue[state.index];
  const active = Boolean(current && isFavorite(current.id));
  $('#favorite-current').disabled = !current;
  $('#favorite-current').textContent = active ? '♥' : '♡';
  $('#favorite-current').setAttribute('aria-pressed', String(active));
  $('#favorite-current').setAttribute('aria-label', active ? '取消收藏当前歌曲' : '收藏当前歌曲');
}

function addToQueue(song) {
  if (state.queue.some(s => s.id === song.id)) return notice('这首歌已经在播放队列中。');
  if (state.queue.length >= MAX_QUEUE) return notice(`播放队列最多容纳 ${MAX_QUEUE} 首歌曲。`);
  state.queue.push(song);
  save();
  syncPlayer();
  notice(`已加入播放队列：${song.name}`);
}

function renderSongs(songs) {
  const table = element('table', 'song-table');
  const caption = element('caption', 'sr-only', '歌曲列表，点击歌曲名称或播放按钮开始播放');
  const head = element('thead');
  const labels = element('tr');
  ['#', '歌曲 / 歌手', '专辑', '时长', '操作'].forEach(label => {
    const th = element('th', '', label);
    th.scope = 'col';
    labels.append(th);
  });
  head.append(labels);
  const body = element('tbody');
  songs.forEach((song, index) => {
    const row = element('tr');
    row.dataset.song = song.id;
    const number = element('td');
    const start = () => currentView === 'queue' ? playIndex(state.queue.findIndex(s => s.id === song.id)) : startQueue(songs, index);
    // Clicking an empty area of a row should switch tracks too; action
    // buttons keep their own behavior.
    row.addEventListener('click', event => {
      if (!event.target.closest('button,input,a')) start();
    });
    const play = button(String(index + 1).padStart(2, '0'), 'row-play', start, `播放 ${song.name}`);
    play.dataset.trackNumber = String(index + 1).padStart(2, '0');
    number.append(play);
    const name = element('td');
    const main = element('div', 'song-main');
    const text = element('div', 'song-text');
    text.append(button(song.name, 'song-title', start, `播放 ${song.name}`), element('span', 'song-artist', song.artists || '未知歌手'));
    main.append(cover(song.cover), text);
    name.append(main);
    const album = element('td', 'song-album', song.album || '—');
    album.title = song.album;
    const actions = element('td', 'song-actions');
    const favorite = button('♡', '', () => toggleFavorite(song), '收藏歌曲');
    favorite.dataset.favorite = song.id;
    actions.append(favorite, currentView === 'queue'
      ? button('×', '', () => removeFromQueue(song.id), `从队列移除 ${song.name}`)
      : button('+', '', () => addToQueue(song), `加入播放队列：${song.name}`));
    row.append(number, name, album, element('td', 'song-time', formatTime(song.duration / 1000)), actions);
    body.append(row);
  });
  table.append(caption, head, body);
  return table;
}

function songsToolbar(songs, extra = '') {
  const bar = element('div', 'toolbar');
  bar.append(button('▶ 播放全部', 'primary', () => startQueue(songs, 0)));
  if (songs.length > 1) {
    bar.append(button('⤨ 随机播放', 'outline', () => {
      state.mode = 'shuffle';
      save();
      startQueue(songs, Math.floor(Math.random() * songs.length));
    }));
  }
  if (currentView === 'queue') bar.append(button('清空队列', 'outline', clearQueue));
  bar.append(element('span', 'muted', extra || `${songs.length} 首歌曲`));
  return bar;
}

function renderPlaylist(data) {
  visibleSongs = normalizeSongs(data.songs);
  const playlistCount = Number.isFinite(data.count) ? data.count : (Number.isFinite(data.track_count) ? data.track_count : visibleSongs.length);
  const playlistPlays = Number.isFinite(data.plays) ? data.plays : (Number.isFinite(data.play_count) ? data.play_count : 0);
  const playlistCover = data.cover || data.cover_img_url || data.coverImgUrl || '';
  heading(data.name || '歌单详情', `${playlistCount} 首歌曲 · ${playCount(playlistPlays) || '0'} 次播放`, 'PLAYLIST / 歌单');
  const detail = element('div', 'detail');
  const copy = element('div', 'detail-copy');
  copy.append(element('p', '', data.description || '每一首歌，都有值得停留的理由。'));
  if (data.description?.length > 100) {
    const more = element('details');
    more.append(element('summary', '', '完整简介'), element('p', '', data.description));
    copy.append(more);
  }
  copy.append(button('← 返回发现', 'outline', () => navigate('discover')));
  detail.append(cover(playlistCover, 'detail-cover', false), copy);
  view.replaceChildren(detail);
  if (!visibleSongs.length) {
    view.append(element('p', 'empty', '歌单暂无可用歌曲。'));
    return;
  }
  const count = playlistCount > visibleSongs.length ? `已加载 ${visibleSongs.length} / ${playlistCount} 首（以接口返回为准）` : '';
  view.append(songsToolbar(visibleSongs, count), renderSongs(visibleSongs));
  syncPlayer();
}

function renderSearch(data, append = false) {
  // Rust handlers may serialize Vec<SongInfo> directly; the web DTO wraps it
  // as { songs, total }. Supporting both keeps the client decoupled from the
  // transport representation.
  const page = normalizeSongs(Array.isArray(data) ? data : data?.songs || data?.data);
  visibleSongs = append ? normalizeSongs([...visibleSongs, ...page]) : page;
  searchTotal = Number.isSafeInteger(data?.total) && data.total >= 0 ? data.total : visibleSongs.length;
  heading(`“${searchQuery}”`, `找到 ${searchTotal} 首歌曲`, 'SEARCH / 搜索结果');
  if (!visibleSongs.length) return empty('没有找到相关歌曲', '换一个歌名或歌手名，再试一次。', () => $('#search-input').focus(), '重新搜索');
  view.replaceChildren(songsToolbar(visibleSongs, `已显示 ${visibleSongs.length} / ${searchTotal} 首`), renderSongs(visibleSongs));
  if (page.length && searchOffset + 30 < searchTotal && searchOffset < 9990 && visibleSongs.length < MAX_QUEUE) {
    const pagination = element('div', 'pagination');
    pagination.append(button('加载更多', 'outline', loadMore));
    view.append(pagination);
  }
  syncPlayer();
}

async function loadMore(event) {
  const control = event.currentTarget;
  control.disabled = true;
  control.textContent = '正在加载…';
  const signal = viewRequest.signal;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(searchQuery)}&offset=${searchOffset + 30}`, signal);
    if (signal.aborted) return;
    searchOffset += 30;
    renderSearch(data, true);
  } catch (error) {
    if (!signal.aborted) { notice(error.message); control.disabled = false; control.textContent = '重试加载'; }
  }
}

function renderLibrary(name) {
  visibleSongs = name === 'queue' ? [...state.queue] : [...state.favorites];
  heading(name === 'queue' ? '播放队列' : '我的收藏', name === 'queue' ? '接下来，让这些声音陪伴你。' : '喜欢的旋律，值得再听一次。收藏保存在当前浏览器。', name === 'queue' ? 'UP NEXT / 待播放' : 'YOUR COLLECTION / 喜欢');
  if (!visibleSongs.length) {
    empty(name === 'queue' ? '队列还是空的' : '把喜欢的歌留在这里', name === 'queue' ? '在歌曲旁点击 +，添加接下来想听的音乐。' : '点击歌曲旁的爱心，建立自己的音乐收藏。', () => navigate('discover'), '去发现音乐');
    // Account playlists are independent from browser-local song favorites.
    if (name === 'favorites') loadFavoritePlaylists();
    return;
  }
  view.replaceChildren(songsToolbar(visibleSongs), renderSongs(visibleSongs));
  syncPlayer();
  if (name === 'favorites') loadFavoritePlaylists();
}

async function loadFavoritePlaylists() {
  try {
    const data = await api('/api/user/playlists');
    if (currentView !== 'favorites' || !Array.isArray(data?.playlists) || !data.playlists.length) return;
    const headingNode = element('div', 'section-heading playlist-section-heading');
    headingNode.append(element('h2', '', '我的歌单'), element('span', '', `${data.playlists.length} 个歌单`));
    const grid = element('div', 'playlist-grid compact-playlists');
    data.playlists.forEach(item => {
      const card = button('', 'playlist-card', () => navigate(`playlist/${item.id}`), `打开歌单：${item.name}`);
      card.append(cover(item.cover || item.cover_img_url, 'artwork'), element('strong', '', item.name), element('small', '', item.author || '收藏歌单'));
      grid.append(card);
    });
    view.prepend(grid);
    view.prepend(headingNode);
  } catch { /* Logged-out users can still use local song favorites. */ }
}

function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('playlist/') && /^[1-9]\d{0,15}$/.test(hash.slice(9))) {
    return loadView('playlist', '歌单详情', '正在寻找你喜欢的声音…', 'PLAYLIST / 歌单', signal => api(`/api/playlist/${hash.slice(9)}`, signal), renderPlaylist);
  }
  if (hash === 'queue' || hash === 'favorites') { beginView(hash); renderLibrary(hash); return; }
  if (hash === 'search' || hash.startsWith('search?')) {
    searchQuery = new URLSearchParams(hash.split('?')[1]).get('q')?.trim() || '';
    $('#search-input').value = searchQuery;
    if (!searchQuery) {
      beginView('search');
      heading('搜索音乐', '找到你脑海里的那段旋律。', 'FIND YOUR SOUND');
      empty('想听什么？', '输入歌曲或歌手名，开始探索。');
      $('#search-input').focus();
      return;
    }
    searchOffset = 0;
    return loadView('search', `“${searchQuery}”`, '正在搜索…', 'SEARCH / 搜索结果', signal => api(`/api/search?q=${encodeURIComponent(searchQuery)}`, signal), renderSearch);
  }
  return loadView('discover', '发现音乐', '从一张歌单，开启今天的音乐旅程。', 'YOUR DAILY SOUNDTRACK', signal => api('/api/discover', signal), renderDiscover);
}

function stopPlayback() {
  playbackVersion++;
  playbackRequest?.abort();
  loadingSong = false;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function clearQueue() {
  stopPlayback();
  state.queue = [];
  state.index = -1;
  save();
  renderLibrary('queue');
  syncPlayer();
}

function removeFromQueue(id) {
  const index = state.queue.findIndex(s => s.id === id);
  if (index < 0) return;
  const removedCurrent = index === state.index;
  if (removedCurrent) stopPlayback();
  state.queue.splice(index, 1);
  if (removedCurrent) state.index = -1;
  else if (index < state.index) state.index--;
  save();
  renderLibrary('queue');
  syncPlayer();
}

function startQueue(songs, index) {
  const selected = songs[index];
  if (!selected) return;
  state.queue = normalizeSongs(songs);
  playIndex(state.queue.findIndex(s => s.id === selected.id));
}

async function playIndex(index) {
  if (!state.queue[index]) return;
  stopPlayback();
  const version = playbackVersion;
  playbackRequest = new AbortController();
  state.index = index;
  loadingSong = true;
  notice();
  save();
  syncPlayer();
  try {
    const data = await api(`/api/song/${state.queue[index].id}`, playbackRequest.signal);
    if (version !== playbackVersion) return;
    // SongUrl is a Vec in ncm-api; accept either that native response or the
    // compact { url, trial } object exposed by the web server.
    const playable = Array.isArray(data) ? data[0] : Array.isArray(data?.data) ? data.data[0] : data?.data || data;
    const mediaUrl = playable?.url;
    if (!/^https?:\/\//.test(mediaUrl)) throw new Error('没有可用的播放地址。');
    audio.src = mediaUrl.replace(/^http:/, 'https:');
    if (playable?.trial) notice('当前歌曲为试听片段。');
    await audio.play();
  } catch (error) {
    if (version !== playbackVersion) return;
    notice(error.name === 'NotAllowedError' ? '浏览器暂停了自动播放，请点击播放按钮继续。' : error.message);
  } finally {
    if (version === playbackVersion) { loadingSong = false; syncPlayer(); }
  }
}

async function togglePlay() {
  if (loadingSong) return;
  if (!audio.paused) { audio.pause(); return; }
  if (!audio.getAttribute('src') || audio.error) return playIndex(state.index < 0 ? 0 : state.index);
  try { await audio.play(); } catch { notice('播放失败，请点击歌曲重新获取播放地址。'); }
}

function skip(direction = 1, ended = false) {
  playIndex(nextIndex(state.queue.length, state.index, state.mode, direction, ended));
}

function syncTimeline() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  $('#elapsed').textContent = formatTime(audio.currentTime);
  $('#duration').textContent = formatTime(duration || (state.queue[state.index]?.duration || 0) / 1000);
  $('#seek').disabled = !duration;
  $('#seek').value = duration ? String(audio.currentTime / duration * 100) : '0';
  $('#seek').setAttribute('aria-valuetext', `${formatTime(audio.currentTime)} / ${formatTime(duration)}`);
  $('#lyrics-elapsed').textContent = formatTime(audio.currentTime);
  $('#lyrics-duration').textContent = formatTime(duration || (state.queue[state.index]?.duration || 0) / 1000);
  $('#lyrics-seek').disabled = !duration;
  $('#lyrics-seek').value = duration ? String(audio.currentTime / duration * 100) : '0';
  syncLyrics(audio.currentTime);
}

function syncPlayer() {
  const current = state.queue[state.index];
  const panel = $('#lyrics-panel');
  panel.style.setProperty('--lyrics-backdrop', current?.cover ? `url("${current.cover.replace(/"/g, '%22')}")` : 'none');
  if (lastPlayerSongId !== (current?.id || null)) {
    const keepFullscreen = document.fullscreenElement === panel || panel.classList.contains('is-fullscreen');
    lyricsRequest?.abort();
    lyricsLines = [];
    lyricsSongId = current?.id || null;
    // A fullscreen player is persistent across track changes. Only the
    // compact lyrics popover is closed when a different song starts.
    if (!current || (!panel.hidden && !keepFullscreen)) panel.hidden = true;
    lastPlayerSongId = current?.id || null;
    if (current && keepFullscreen) loadLyrics();
  }
  $('#queue-count').textContent = String(state.queue.length);
  $('#current-title').textContent = current?.name || '音乐，即将响起';
  $('#current-title').title = current?.name || '';
  $('#current-artist').textContent = loadingSong ? '正在准备播放…' : current?.artists || '选择一首，开始聆听';
  $('#lyrics-track-title').textContent = current?.name || '音乐，即将响起';
  $('#lyrics-track-artist').textContent = loadingSong ? '正在准备播放…' : current?.artists || '选择一首，开始聆听';
  const lyricCover = $('#lyrics-cover');
  if (lyricCover.dataset.cover !== (current?.cover || '')) {
    const art = cover(current?.cover, 'lyrics-cover', false);
    lyricCover.replaceWith(art);
    art.id = 'lyrics-cover';
    art.dataset.cover = current?.cover || '';
  }
  if ($('#current-cover').dataset.cover !== (current?.cover || '')) {
    const art = cover(current?.cover, 'cover-small', false);
    $('#current-cover').replaceChildren(...art.childNodes);
    $('#current-cover').dataset.cover = current?.cover || '';
  }
  $('#play').disabled = !state.queue.length || loadingSong;
  $('#play').textContent = loadingSong ? '…' : audio.paused ? '▶' : 'Ⅱ';
  $('#play').setAttribute('aria-label', loadingSong ? '正在加载' : audio.paused ? '播放' : '暂停');
  $('#previous').disabled = !state.queue.length;
  $('#next').disabled = !state.queue.length;
  $('#lyrics-toggle').disabled = !current;
  $('#player-fullscreen').disabled = !current;
  const modes = { loop: ['↻', '列表循环'], single: ['↺₁', '单曲循环'], shuffle: ['⇄', '随机播放'] };
  $('#mode').textContent = modes[state.mode][0];
  $('#mode').setAttribute('aria-label', `播放模式：${modes[state.mode][1]}`);
  $('#mode').title = `播放模式：${modes[state.mode][1]}`;
  document.querySelectorAll('[data-song]').forEach(row => {
    const active = row.dataset.song === current?.id;
    row.classList.toggle('is-current', active);
    const play = row.querySelector('.row-play');
    play.textContent = active ? (audio.paused ? '▶' : '♫') : play.dataset.trackNumber;
  });
  syncFavorites();
  syncTimeline();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = current ? (audio.paused ? 'paused' : 'playing') : 'none';
    if ('MediaMetadata' in window) navigator.mediaSession.metadata = current ? new MediaMetadata({ title: current.name, artist: current.artists, album: current.album, artwork: current.cover ? [{ src: current.cover }] : [] }) : null;
  }
}

async function loadLyrics() {
  const current = state.queue[state.index];
  if (!current) return;
  lyricsRequest?.abort();
  lyricsRequest = new AbortController();
  lyricsLines = [];
  lyricsSongId = current.id;
  $('#lyrics-panel').hidden = false;
  $('#lyrics-meta').textContent = `${current.name} · ${current.artists || '未知歌手'}`;
  $('#lyrics-content').replaceChildren(element('p', 'lyrics-placeholder', '正在加载歌词…'));
  try {
    const data = await api(`/api/song/${current.id}/lyrics`, lyricsRequest.signal);
    if (lyricsSongId !== current.id) return;
    lyricsLines = parseLyrics(data.lyrics, data.translation);
    renderLyrics();
    syncLyrics(audio.currentTime);
  } catch (error) {
    if (error.name !== 'AbortError') $('#lyrics-content').replaceChildren(element('p', 'lyrics-placeholder', error.message));
  }
}

function parseLyrics(raw, translated) {
  const source = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('\n') : '';
  const translation = typeof translated === 'string' ? translated : Array.isArray(translated) ? translated.join('\n') : '';
  const parse = text => {
    const result = [];
    text.split(/\r?\n/).forEach(line => {
      const matches = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      const content = line.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
      if (!content || !matches.length) return;
      matches.forEach(match => {
        const fraction = Number(match[3] || 0);
        const seconds = Number(match[1]) * 60 + Number(match[2]) + (match[3] ? fraction / (match[3].length === 3 ? 1000 : 100) : 0);
        result.push({ time: seconds, text: content });
      });
    });
    return result.sort((a, b) => a.time - b.time);
  };
  const main = parse(source);
  const trans = parse(translation);
  if (!main.length) return (source || translation).split(/\r?\n/).map(text => ({ time: null, text: text.trim() })).filter(line => line.text);
  const translations = new Map();
  trans.forEach(line => {
    const previous = translations.get(line.time);
    translations.set(line.time, previous ? `${previous} / ${line.text}` : line.text);
  });
  return main.map(line => ({ ...line, translation: translations.get(line.time) || '' }));
}

function renderLyrics() {
  const content = $('#lyrics-content');
  content.replaceChildren();
  if (!lyricsLines.length) {
    content.append(element('p', 'lyrics-placeholder', '暂无歌词'));
    return;
  }
  lyricsLines.forEach((line, index) => {
    const item = element('button', 'lyrics-line');
    item.type = 'button';
    item.dataset.index = String(index);
    item.append(element('span', 'lyrics-text', line.text));
    if (line.translation) item.append(element('small', 'lyrics-translation', line.translation));
    item.addEventListener('click', () => {
      if (line.time == null || !Number.isFinite(audio.duration)) return;
      audio.currentTime = line.time;
      if (audio.paused) togglePlay();
    });
    content.append(item);
  });
}

function syncLyrics(time) {
  if (!lyricsLines.length || lyricsLines[0].time == null) return;
  let active = 0;
  for (let i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].time <= time) active = i;
    else break;
  }
  const content = $('#lyrics-content');
  content.querySelectorAll('.lyrics-line.is-active').forEach(node => node.classList.remove('is-active'));
  const current = content.querySelector(`[data-index="${active}"]`);
  if (!current) return;
  current.classList.add('is-active');
  if (!content.matches(':hover')) current.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function refreshLoginStatus() {
  try {
    const data = await api('/api/login/status');
    const loggedIn = Boolean(data.loggedIn);
    $('#login').textContent = loggedIn ? (data.nickname || '已登录') : '登录';
    $('#login-status').textContent = loggedIn ? `已登录：${data.nickname || '网易云用户'}` : '使用桌面版同样的账号登录，登录状态会保存到本机。';
    return loggedIn;
  } catch { return false; }
}

async function startQrLogin() {
  $('#qr-start').disabled = true;
  $('#login-status').textContent = '正在生成二维码…';
  try {
    const data = await api('/api/login/qr/create');
    $('#qr-image').src = `/api/login/qr/image?key=${encodeURIComponent(data.key)}`;
    $('#qr-image').hidden = false;
    $('#qr-refresh').hidden = false;
    $('#login-status').textContent = '请使用网易云音乐 App 扫码登录。';
    clearInterval(qrPoll);
    qrPoll = setInterval(async () => {
      try {
        const result = await api(`/api/login/qr/check?key=${encodeURIComponent(data.key)}`);
        if (result.loggedIn) { clearInterval(qrPoll); $('#login-status').textContent = '登录成功'; await refreshLoginStatus(); $('#login-dialog').close(); loadView('discover', '发现音乐', '从一张歌单，开启今天的音乐旅程。', 'YOUR DAILY SOUNDTRACK', signal => api('/api/discover', signal), renderDiscover); }
        else if (result.code === 800) { clearInterval(qrPoll); $('#login-status').textContent = '二维码已过期，请刷新。'; }
      } catch { /* Keep polling through transient failures. */ }
    }, 2000);
  } catch (error) { $('#login-status').textContent = error.message; }
  finally { $('#qr-start').disabled = false; }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('#theme').setAttribute('aria-label', `切换${state.theme === 'dark' ? '浅色' : '深色'}主题`);
  document.querySelector('meta[name="theme-color"]').content = state.theme === 'dark' ? '#191c1b' : '#f6f5f2';
}

document.querySelectorAll('[data-view]').forEach(nav => nav.addEventListener('click', () => navigate(nav.dataset.view)));
$('#search-form').addEventListener('submit', event => {
  event.preventDefault();
  const q = $('#search-input').value.trim();
  if (q) navigate(`search?q=${encodeURIComponent(q)}`);
});
$('#refresh').addEventListener('click', () => retryAction?.());
$('#show-queue').addEventListener('click', () => navigate('queue'));
$('#play').addEventListener('click', togglePlay);
$('#previous').addEventListener('click', () => skip(-1));
$('#next').addEventListener('click', () => skip());
$('#favorite-current').addEventListener('click', () => { if (state.queue[state.index]) toggleFavorite(state.queue[state.index]); });
$('#mode').addEventListener('click', () => { state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]; save(); syncPlayer(); });
$('#volume').value = state.volume;
audio.volume = state.volume;
$('#volume').addEventListener('input', event => { state.volume = Number(event.target.value); audio.volume = state.volume; save(); });
$('#seek').addEventListener('input', event => { if (Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value) / 100 * audio.duration; });
$('#theme').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); save(); });
async function openFullscreenPlayer() {
  if (!state.queue[state.index]) return;
  const panel = $('#lyrics-panel');
  panel.hidden = false;
  panel.classList.remove('is-opening');
  void panel.offsetWidth;
  panel.classList.add('is-opening');
  try {
    if (panel.requestFullscreen && !document.fullscreenElement) await panel.requestFullscreen();
    else panel.classList.add('is-fullscreen');
  } catch { panel.classList.add('is-fullscreen'); }
  loadLyrics();
}

$('#lyrics-toggle').addEventListener('click', loadLyrics);
$('#player-fullscreen').addEventListener('click', openFullscreenPlayer);
$('#current-cover').addEventListener('click', openFullscreenPlayer);
$('#current-cover').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFullscreenPlayer(); }
});
$('#lyrics-close').addEventListener('click', () => { $('#lyrics-panel').hidden = true; });
$('#lyrics-prev').addEventListener('click', () => skip(-1));
$('#lyrics-next').addEventListener('click', () => skip(1));
$('#lyrics-play').addEventListener('click', togglePlay);
$('#lyrics-seek').addEventListener('input', event => {
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value) / 100 * audio.duration;
});
$('#lyrics-fullscreen').addEventListener('click', async () => {
  const panel = $('#lyrics-panel');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (panel.requestFullscreen) await panel.requestFullscreen();
    else {
      panel.classList.toggle('is-fullscreen');
      $('#lyrics-fullscreen').textContent = panel.classList.contains('is-fullscreen') ? '退出全屏' : '全屏';
    }
  } catch {
    panel.classList.toggle('is-fullscreen');
    $('#lyrics-fullscreen').textContent = panel.classList.contains('is-fullscreen') ? '退出全屏' : '全屏';
  }
});
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === $('#lyrics-panel') || $('#lyrics-panel').classList.contains('is-fullscreen');
  $('#lyrics-fullscreen').textContent = active ? '退出全屏' : '全屏';
  $('#lyrics-fullscreen').setAttribute('aria-label', active ? '退出歌词全屏' : '歌词全屏');
  syncLyrics(audio.currentTime);
});
$('#login').addEventListener('click', async () => { $('#login-dialog').showModal(); await refreshLoginStatus(); });
$('#qr-start').addEventListener('click', startQrLogin);
$('#qr-refresh').addEventListener('click', startQrLogin);
$('#password-login').addEventListener('click', async () => {
  const button = $('#password-login'); button.disabled = true;
  try {
    const data = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#login-user').value.trim(), password: $('#login-password').value }) }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || '登录失败'); return result; });
    $('#login-status').textContent = `登录成功：${data.nickname || ''}`; await refreshLoginStatus(); $('#login-dialog').close();
  } catch (error) { $('#login-status').textContent = error.message; }
  finally { button.disabled = false; }
});
audio.addEventListener('timeupdate', syncTimeline);
audio.addEventListener('durationchange', syncTimeline);
audio.addEventListener('play', syncPlayer);
audio.addEventListener('pause', syncPlayer);
audio.addEventListener('ended', () => skip(1, true));
audio.addEventListener('error', () => { if (audio.getAttribute('src')) { notice('音频加载失败，播放地址可能已过期或浏览器不支持该格式。请点击歌曲重试。'); syncPlayer(); } });
window.addEventListener('hashchange', route);
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.target.closest('input,textarea,button,a,summary,[contenteditable="true"]')) {
    event.preventDefault();
    $('#search-input').focus();
    return;
  }
  if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest('input,textarea,button,a,summary,[contenteditable="true"]')) return;
  event.preventDefault();
  togglePlay();
});
if ('mediaSession' in navigator) {
  for (const [action, handler] of Object.entries({ play: () => { if (audio.paused) togglePlay(); }, pause: () => audio.pause(), previoustrack: () => skip(-1), nexttrack: () => skip(1) })) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Not all browsers support every action. */ }
  }
}
applyTheme();
syncPlayer();
route();
