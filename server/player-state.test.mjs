import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSongs, nextIndex, restoreState, formatTime } from './public/player-state.js';
const a = { id: 1, name: 'A', artists: 'one' };
const b = { id: '2', name: 'B' };
test('normalizes queue records and removes invalid or duplicate ids', () => {
  assert.deepEqual(normalizeSongs([a, b, { id: 1, name: 'duplicate' }, { id: 0, name: 'bad' }, null]).map(s => s.id), ['1', '2']);
});
test('accepts native Rust SongInfo field names', () => {
  assert.deepEqual(normalizeSongs([{ id: 9, name: 'Rust song', singer: 'Singer', album: 'Album', pic_url: 'http://img.invalid/a.jpg', duration: 65000 }]), [{
    id: '9', name: 'Rust song', artists: 'Singer', album: 'Album', cover: 'https://img.invalid/a.jpg', duration: 65000,
  }]);
});
test('advances loop, single and shuffle modes predictably', () => {
  assert.equal(nextIndex(3, 2, 'loop'), 0);
  assert.equal(nextIndex(3, 2, 'loop', -1), 1);
  assert.equal(nextIndex(3, 2, 'single', 1, true), 2);
  assert.equal(nextIndex(3, 0, 'shuffle', 1, false, () => 0), 1);
});
test('restores only safe persisted state', () => {
  const restored = restoreState(JSON.stringify({ queue: [a], currentId: 1, volume: 4, mode: 'bad', theme: 'dark' }));
  assert.equal(restored.index, 0); assert.equal(restored.volume, 1); assert.equal(restored.mode, 'loop'); assert.equal(restored.theme, 'dark');
  assert.equal(restoreState('{').queue.length, 0);
});
test('formats duration for the player', () => { assert.equal(formatTime(0), '0:00'); assert.equal(formatTime(65.8), '1:05'); });
