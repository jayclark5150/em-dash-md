// Unit tests for tree-utils.js (pure helpers behind folders, the sidebar tree,
// the context menu and the command palette).
// Run: node tests/tree-utils.test.cjs   (no dependencies)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(path.join(__dirname, '..', 'tree-utils.js'), 'utf8');
const sandbox = {};
vm.runInNewContext(code, sandbox);
const T = sandbox.TreeUtils;

// Values built inside the vm context have a different Array/Object prototype,
// so compare through JSON instead of reference-equal deepStrictEqual.
const eq = (actual, expected) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// ── normalizeName ──
test('normalizeName trims, collapses spaces, strips separators', () => {
  assert.strictEqual(T.normalizeName('  My   Folder  '), 'My Folder');
  assert.strictEqual(T.normalizeName('a/b\\c'), 'a-b-c');
  assert.strictEqual(T.normalizeName('tab\there'), 'tab here');
});
test('normalizeName returns empty for blank, null, control-only input', () => {
  assert.strictEqual(T.normalizeName(''), '');
  assert.strictEqual(T.normalizeName('   '), '');
  assert.strictEqual(T.normalizeName(null), '');
  assert.strictEqual(T.normalizeName('\u0001\u0002'), '');
});
test('normalizeName caps length at 120', () => {
  assert.strictEqual(T.normalizeName('x'.repeat(500)).length, 120);
});

// ── uniqueName / nameTaken ──
test('uniqueName returns base when free', () => {
  assert.strictEqual(T.uniqueName('New Folder', []), 'New Folder');
  assert.strictEqual(T.uniqueName('New Folder', ['Other']), 'New Folder');
});
test('uniqueName numbers collisions, case-insensitive, skipping taken numbers', () => {
  assert.strictEqual(T.uniqueName('New Folder', ['new folder']), 'New Folder 2');
  assert.strictEqual(T.uniqueName('New Folder', ['New Folder', 'New Folder 2']), 'New Folder 3');
  assert.strictEqual(T.uniqueName('New Folder', ['New Folder', 'New Folder 3']), 'New Folder 2');
});
test('nameTaken is case-insensitive', () => {
  assert.strictEqual(T.nameTaken('Work', ['work']), true);
  assert.strictEqual(T.nameTaken('Work', ['Play']), false);
});

// ── orderSiblings ──
test('orderSiblings puts folders first A-Z, keeps other order stable', () => {
  const list = [
    { id: 'd1', title: 'z doc' }, { id: 'f2', title: 'beta', type: 'folder' },
    { id: 'd2', title: 'a doc' }, { id: 'f1', title: 'Alpha', type: 'folder' },
  ];
  eq(T.orderSiblings(list).map(d => d.id), ['f1', 'f2', 'd1', 'd2']);
});
test('orderSiblings does not mutate its input', () => {
  const list = [{ id: 'd', title: 'x' }, { id: 'f', title: 'y', type: 'folder' }];
  T.orderSiblings(list);
  eq(list.map(d => d.id), ['d', 'f']);
});

// ── subtreeIds ──
const docs = [
  { id: 'root', type: 'folder' },
  { id: 'a', parentId: 'root' },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'root' },
  { id: 'other' },
];
test('subtreeIds returns root plus all descendants', () => {
  eq(T.subtreeIds('root', docs).sort(), ['a', 'b', 'c', 'root']);
  eq(T.subtreeIds('a', docs).sort(), ['a', 'b']);
  eq(T.subtreeIds('other', docs), ['other']);
});
test('subtreeIds survives a parentId cycle', () => {
  const cyc = [{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }];
  eq(T.subtreeIds('x', cyc).sort(), ['x', 'y']);
});

// ── ancestorTitles ──
test('ancestorTitles lists parents root-first and strips .md', () => {
  const list = [
    { id: '1', title: 'Work' },
    { id: '2', title: 'Projects.md', parentId: '1' },
    { id: '3', title: 'Plan.md', parentId: '2' },
  ];
  const byId = new Map(list.map(d => [d.id, d]));
  eq(T.ancestorTitles('3', byId), ['Work', 'Projects']);
  eq(T.ancestorTitles('1', byId), []);
});
test('ancestorTitles stops at a missing parent and at cycles', () => {
  const a = new Map([['a', { id: 'a', title: 'A', parentId: 'gone' }]]);
  eq(T.ancestorTitles('a', a), []);
  const cyc = new Map([['x', { id: 'x', title: 'X', parentId: 'y' }], ['y', { id: 'y', title: 'Y', parentId: 'x' }]]);
  assert.ok(T.ancestorTitles('x', cyc).length <= 2);
});

// ── fuzzyScore / rank ──
test('fuzzyScore: empty query matches everything with 0', () => {
  assert.strictEqual(T.fuzzyScore('', 'anything'), 0);
});
test('fuzzyScore: no match returns -1', () => {
  assert.strictEqual(T.fuzzyScore('xyz', 'daily diary'), -1);
  assert.strictEqual(T.fuzzyScore('abc', ''), -1);
});
test('fuzzyScore: prefix beats mid-word substring beats scattered', () => {
  const prefix = T.fuzzyScore('dai', 'Daily Diary');
  const word = T.fuzzyScore('dia', 'Daily Diary');
  const mid = T.fuzzyScore('ail', 'Daily Diary');
  const scattered = T.fuzzyScore('ddy', 'Daily Diary');
  assert.ok(prefix > word, 'prefix > word-start');
  assert.ok(word > mid, 'word-start > mid');
  assert.ok(mid > scattered, 'substring > scattered');
  assert.ok(scattered > 0);
});
test('fuzzyScore: multi-word query matches words in any order', () => {
  assert.ok(T.fuzzyScore('diary daily', 'Daily Diary') > 0);
  assert.strictEqual(T.fuzzyScore('diary zebra', 'Daily Diary'), -1);
});
test('rank: filters, orders best first, respects limit, stable on ties', () => {
  const items = [
    { n: 'Export as PDF' }, { n: 'New folder' }, { n: 'New document' }, { n: 'Toggle sidebar' },
  ];
  const out = T.rank('new', items, i => [i.n]);
  eq(out.map(i => i.n), ['New folder', 'New document']);
  assert.strictEqual(T.rank('new', items, i => [i.n], 1).length, 1);
  assert.strictEqual(T.rank('', items, i => [i.n]).length, 4);
  eq(T.rank('', items, i => [i.n]).map(i => i.n), items.map(i => i.n));
});
test('rank: uses the best of several searchable strings', () => {
  const items = [{ label: 'Switch theme', kw: 'dark light colors' }];
  assert.strictEqual(T.rank('dark', items, i => [i.label, i.kw]).length, 1);
});

// ── clampMenu ──
test('clampMenu keeps the menu inside the viewport', () => {
  eq(T.clampMenu(10, 10, 200, 100, 1000, 800), { left: 10, top: 10 });
  eq(T.clampMenu(950, 10, 200, 100, 1000, 800), { left: 794, top: 10 });
  eq(T.clampMenu(10, 780, 200, 100, 1000, 800), { left: 10, top: 694 });
  const tiny = T.clampMenu(0, 0, 500, 500, 100, 100);
  assert.ok(tiny.left >= 0 && tiny.top >= 0);
});

// ── isFolder ──
test('isFolder only true for type folder', () => {
  assert.strictEqual(T.isFolder({ type: 'folder' }), true);
  assert.strictEqual(T.isFolder({}), false);
  assert.strictEqual(T.isFolder(null), false);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', SOME FAILED' : ''));
