import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The site only needs the bundled era catalog when the API is unreachable. A static import would make
// every visitor download every era module, upcoming drops included.
test('store.js loads the era catalog only on the fallback path', () => {
  const src = readFileSync(new URL('../assets/js/store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import[^;]*data\/eras\/index\.js/m);
  assert.match(src, /await import\(['"]\.\.\/\.\.\/data\/eras\/index\.js['"]\)/);
});
