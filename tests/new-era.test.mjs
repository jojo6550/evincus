import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newEra } from '../scripts/new-era.mjs';

const INDEX = `// Era order, newest first.
import { merge } from './merge.js';
// eras:imports
import * as era_core from './core/era.js';

const ERAS = [
  // eras:list
  era_core,
];
`;

function setup(index = INDEX) {
  const dir = mkdtempSync(join(tmpdir(), 'eras-'));
  writeFileSync(join(dir, 'index.js'), index);
  writeFileSync(join(dir, 'shared.js'), "export const SIZES = ['S'];\n");
  mkdirSync(join(dir, 'core'));
  return { dir, root: pathToFileURL(dir + '/') };
}

const state = dir => JSON.stringify(readdirSync(dir, { recursive: true }).sort()) + readFileSync(join(dir, 'index.js'), 'utf8');

test('creates the folder, the template and index entries above the existing eras', async () => {
  const { dir, root } = setup();
  newEra({ root, slug: 'summer-26', name: `Rock 'n' "Roll"` });

  assert.ok(existsSync(join(dir, 'summer-26', 'img')));
  const index = readFileSync(join(dir, 'index.js'), 'utf8');
  const imp = "import * as era_summer_26 from './summer-26/era.js';";
  assert.ok(index.includes(imp));
  assert.ok(index.indexOf(imp) < index.indexOf('import * as era_core'));
  assert.ok(index.indexOf('  era_summer_26,') > index.indexOf('// eras:list'));
  assert.ok(index.indexOf('  era_summer_26,') < index.indexOf('  era_core,'));

  const mod = await import(pathToFileURL(join(dir, 'summer-26', 'era.js')).href);
  assert.equal(mod.era.slug, 'summer-26');
  assert.equal(mod.era.name, `Rock 'n' "Roll"`);
  assert.equal(mod.era.hero, 'hero.jpg');
  assert.equal(mod.era.dropsAt, null);
  assert.deepEqual(mod.products, []);
  assert.match(readFileSync(join(dir, 'summer-26', 'era.js'), 'utf8'), /TODO/);
});

test('keeps CRLF line endings in index.js', () => {
  const { dir, root } = setup(INDEX.replace(/\n/g, '\r\n'));
  newEra({ root, slug: 'drop-two', name: 'Drop Two' });
  const index = readFileSync(join(dir, 'index.js'), 'utf8');
  assert.equal(index.replace(/\r\n/g, '').includes('\n'), false);
});

for (const [label, args] of [
  ['empty slug', { slug: '', name: 'X' }],
  ['missing slug', { name: 'X' }],
  ['uppercase slug', { slug: 'Summer', name: 'X' }],
  ['underscore slug', { slug: 'summer_26', name: 'X' }],
  ['leading dash', { slug: '-x', name: 'X' }],
  ['trailing dash', { slug: 'x-', name: 'X' }],
  ['path in slug', { slug: '../x', name: 'X' }],
  ['missing name', { slug: 'x' }],
  ['blank name', { slug: 'x', name: '   ' }],
  ['duplicate slug', { slug: 'core', name: 'Core' }],
]) {
  test(`rejects ${label} and changes nothing`, () => {
    const { dir, root } = setup();
    const before = state(dir);
    assert.throws(() => newEra({ root, ...args }), Error);
    assert.equal(state(dir), before);
  });
}

test('rejects an index.js without markers and changes nothing', () => {
  const { dir, root } = setup(INDEX.replace('// eras:list\n', ''));
  const before = state(dir);
  assert.throws(() => newEra({ root, slug: 'x', name: 'X' }), /marker/);
  assert.equal(state(dir), before);
});
