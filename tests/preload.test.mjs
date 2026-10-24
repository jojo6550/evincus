import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

// Every module a page's entry script needs before it runs, as site-root paths: static imports plus dynamic
// imports awaited at a module's top level (env.js loading config.js). Lazy imports inside functions are left out.
function moduleGraph(entry) {
  const seen = new Set();
  const walk = url => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const specs = source.matchAll(/^\s*(?:import|export)\s[^;'"]*?from\s+['"](\.[^'"]+)['"]|^\s*import\s+['"](\.[^'"]+)['"]|^(?:const|let)\s[^=]+=\s*await import\(['"](\.[^'"]+)['"]\)/gm);
    for (const [, from, bare, awaited] of specs) walk(new URL(from ?? bare ?? awaited, url));
  };
  walk(new URL(entry, ROOT));
  return [...seen].map(href => '/' + href.slice(ROOT.href.length)).sort();
}

// The preload list flattens the import waterfall into one round trip; it must not drift from the real imports.
for (const [page, entry] of [['index.html', 'assets/js/index.js'], ['eras.html', 'assets/js/eras.js']]) {
  test(`${page} modulepreloads exactly the modules ${entry} imports`, () => {
    const html = readFileSync(new URL(page, ROOT), 'utf8');
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]).sort();
    assert.deepEqual(preloaded, moduleGraph(entry));
  });
}
