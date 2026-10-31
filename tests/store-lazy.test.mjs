import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The catalog comes only from the API. The era files are the server's one-time seed and never reach visitors.
test('store.js never loads the era catalog', () => {
  const src = readFileSync(new URL('../assets/js/store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /data\/eras/);
  assert.match(src, /registerImages\(/);
});

test('when /api/catalog fails, the home and eras grids show a notice instead of an empty grid, and the beacon still fires', () => {
  const read = p => readFileSync(new URL(`../assets/${p}`, import.meta.url), 'utf8');
  const store = read('js/store.js');
  assert.match(store, /OFFLINE_NOTE = `<p class="grid__note mono u-smoke">The store can't load right now\. Try again in a minute\.<\/p>`/);
  assert.match(store, /catch \{\s*beaconOnce\('api-unreachable'\);/);
  assert.match(read('js/index.js'), /if \(!isLive\(\)\) grid\.innerHTML = OFFLINE_NOTE;/);
  assert.match(read('js/eras.js'), /: isLive\(\) \? '<p class="mono u-smoke">No eras to show yet\.<\/p>' : OFFLINE_NOTE;/);
  assert.match(read('css/index.css'), /\.grid__note \{ grid-column: 1 \/ -1;/);
  for (const p of ['js/index.js', 'js/eras.js', 'js/store.js']) assert.doesNotMatch(read(p), /style=|\.style\./, p);
});
