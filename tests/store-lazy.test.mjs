import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The catalog comes only from the API. The era files are the server's one-time seed and never reach visitors.
test('store.js never loads the era catalog', () => {
  const src = readFileSync(new URL('../assets/js/store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /data\/eras/);
  assert.match(src, /registerImages\(/);
});
