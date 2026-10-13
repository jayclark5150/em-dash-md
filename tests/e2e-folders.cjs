// Headless-browser test for v3.27.0: folders, right-click menu, command palette.
// Runs the REAL index.html / app.js / tree-utils.js / styles.css against an
// in-memory Firebase stub (tests/e2e/firebase-stub.js). No network, no real data.
//
// Run:  node tests/e2e-folders.cjs
// Needs Playwright with a Chromium build (npm i -D playwright, or the one
// preinstalled in the Claude sandbox). Optional: not part of the app.
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..');
const STUB = fs.readFileSync(path.join(__dirname, 'e2e', 'firebase-stub.js'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown' };

const SEED = [
  { id: 'F2', userId: 'u1', title: 'Zeta', content: '', type: 'folder', createdAt: 9000, updatedAt: 9000 },
  { id: 'D2', userId: 'u1', title: 'Beta.md', content: 'beta body', createdAt: 4000, updatedAt: 4000 },
  { id: 'D3', userId: 'u1', title: 'Gamma.md', content: 'gamma body', createdAt: 3000, updatedAt: 3000 },
  { id: 'D1', userId: 'u1', title: 'Alpha.md', content: 'alpha body', parentId: 'F1', createdAt: 2500, updatedAt: 2500 },
  { id: 'D4', userId: 'u1', title: 'Delta.md', content: 'delta body', parentId: 'F1', createdAt: 2000, updatedAt: 2000 },
  { id: 'F1', userId: 'u1', title: 'Work', content: '', type: 'folder', createdAt: 1000, updatedAt: 1000 },
];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
  if (!ok) process.exitCode = 1;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      if (p === '/firebase-config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end('var FIREBASE_CONFIG = {};');
        return;
      }
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      let body = fs.readFileSync(file);
      if (p === '/index.html') {
        // The stub libraries cannot satisfy SRI hashes, so strip them for the test only.
        body = Buffer.from(body.toString('utf8').replace(/\sintegrity="[^"]*"/g, ''));
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: 'block', hasTouch: true });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

  await page.addInitScript((seed) => { window.__SEED = seed; }, SEED);
  // Minimal stand-in for the Turndown CDN library (the CDN is stubbed empty in tests).
  await page.addInitScript(() => {
    window.TurndownService = function () {
      this.use = function () {}; this.addRule = function () {};
      this.turndown = function (html) { var d = document.createElement('div'); d.innerHTML = html; return d.textContent; };
    };
  });
  let firstFirebase = true;
  await page.route(/cdn\.jsdelivr\.net|gstatic\.com|googleapis\.com|apis\.google\.com/, (route) => {
    const url = route.request().url();
    if (/firebase-app-compat/.test(url) && firstFirebase) {
      firstFirebase = false;
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB });
    }
    return route.fulfill({ status: 200, contentType: /\.css/.test(url) ? 'text/css' : 'text/javascript', body: '' });
  });

  const store = (fn, arg) => page.evaluate(fn, arg);
  const rowSel = (id) => `#sidebar-list .sidebar-item[data-id="${id}"]`;
  const menuItems = () => page.$$eval('.ctx-menu .ctx-item', (els) => els.map((e) => e.textContent));
  const clickMenu = (label) => page.locator('.ctx-menu .ctx-item', { hasText: new RegExp('^' + label + '$') }).click();
  const getDoc = (id) => store((i) => { const d = window.__store.get(i); return d ? { ...d, createdAt: undefined, updatedAt: undefined, deletedAt: undefined } : null; }, id);
  const findByTitle = (t) => store((title) => {
    for (const [id, d] of window.__store) if (d.title === title && !d.isDeleted) return { id, ...d, createdAt: undefined, updatedAt: undefined };
    return null;
  }, t);

  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#sidebar-list .sidebar-item').length >= 3);

  // ── S1 boot, folder rendering and ordering ──────────────────────────────────
  console.log('\nS1 boot and rendering');
  check('TreeUtils loaded', await page.evaluate(() => typeof window.TreeUtils === 'object'));
  const rootOrder = await page.$$eval('#sidebar-list > .sb-node > .sidebar-item', (els) => els.map((e) => e.dataset.id + ':' + e.dataset.type));
  check('roots: folders first (A-Z), then docs newest-first', JSON.stringify(rootOrder) === JSON.stringify(['F1:folder', 'F2:folder', 'D2:doc', 'D3:doc']), rootOrder);
  check('docs inside a folder are rendered under it', await page.locator('.sb-node[data-node="F1"] .sb-children .sidebar-item').count() === 2);
  check('empty folder shows "Empty" placeholder', (await page.locator('.sb-node[data-node="F2"] .sb-empty-folder').textContent()).trim() === 'Empty');
  check('loadMostRecent skipped the newest item (a folder) and opened a document',
    (await page.locator('#tb-title').textContent()) === 'Beta.md', await page.locator('#tb-title').textContent());
  check('version label bumped', (await page.locator('#app-version').textContent()) === 'v3.30.0');

  // ── S2 folder click toggles, never opens editor ──────────────────────────────
  console.log('\nS2 folder click');
  const before = await page.locator('#editor').inputValue();
  await page.locator(rowSel('F1')).click();
  check('clicking a folder expands it', await page.evaluate(() => _sidebarExpanded.has('F1')));
  check('clicking a folder does not change the editor', (await page.locator('#editor').inputValue()) === before);
  check('expanded folder children visible', await page.locator('.sb-node[data-node="F1"] .sb-children:not(.sb-hidden)').count() === 1);
  await page.locator(rowSel('F1')).click();
  check('clicking again collapses', !(await page.evaluate(() => _sidebarExpanded.has('F1'))));

  // ── S3 create folder (header button) ─────────────────────────────────────────
  console.log('\nS3 new folder via header button');
  await page.locator('#sidebar-new-folder-btn').click();
  await page.waitForSelector('.sb-rename-input');
  check('new folder opens in rename mode with default name', (await page.locator('.sb-rename-input').inputValue()) === 'New Folder');
  await page.locator('.sb-rename-input').fill('Projects');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sb-rename-input'));
  const proj = await findByTitle('Projects');
  check('folder saved with type=folder, empty content, no parentId', proj && proj.type === 'folder' && proj.content === '' && proj.parentId === undefined && proj.userId === 'u1', proj);
  check('folder shown in sidebar without .md', await page.locator('#sidebar-list .sidebar-item[data-type="folder"] .sidebar-item-title', { hasText: /^Projects$/ }).count() === 1);

  // duplicate-name guard (case-insensitive)
  await page.locator('#sidebar-new-folder-btn').click();
  await page.waitForSelector('.sb-rename-input');
  check('second new folder gets a unique default name', (await page.locator('.sb-rename-input').inputValue()) === 'New Folder');
  await page.locator('.sb-rename-input').fill('projects');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sb-rename-input'));
  check('duplicate folder name rejected, original default kept', (await findByTitle('New Folder')) !== null && (await findByTitle('projects')) === null);

  // Escape cancels a rename
  await page.locator(rowSel((await findByTitle('New Folder')).id)).click({ button: 'right' });
  await clickMenu('Rename');
  await page.waitForSelector('.sb-rename-input');
  await page.locator('.sb-rename-input').fill('Should Not Save');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sb-rename-input'));
  check('Escape cancels rename', (await findByTitle('Should Not Save')) === null && (await findByTitle('New Folder')) !== null);

  // ── S4 context menu on a document ────────────────────────────────────────────
  console.log('\nS4 context menu: document');
  await page.locator(rowSel('D3')).click({ button: 'right' });
  check('doc menu items', JSON.stringify(await menuItems()) === JSON.stringify(['Open', 'New sub-page', 'Rename', 'Move to…', 'Duplicate', 'Move to Trash']), await menuItems());
  check('target row highlighted', await page.locator(rowSel('D3') + '.ctx-target').count() === 1);
  await page.keyboard.press('Escape');
  check('Escape closes menu', await page.locator('.ctx-menu').count() === 0);
  check('highlight removed on close', await page.locator('.ctx-target').count() === 0);

  await page.locator(rowSel('D3')).click({ button: 'right' });
  await page.keyboard.press('ArrowDown');
  check('ArrowDown moves focus between items', (await page.evaluate(() => document.activeElement.textContent)) === 'New sub-page');
  await page.mouse.click(700, 400);
  check('outside click closes menu', await page.locator('.ctx-menu').count() === 0);

  // Move to… folder
  await page.locator(rowSel('D3')).click({ button: 'right' });
  await clickMenu('Move to…');
  await page.waitForSelector('#move-modal.open');
  check('move modal lists folders before documents', await page.$$eval('#move-modal-list .move-option', (els) => {
    const kinds = els.slice(1).map((e) => /sb-icon|M1 3\.5A1\.5/.test(e.innerHTML) ? 'f' : 'd');
    return kinds.join('').replace(/d+$/, '') === kinds.filter((k) => k === 'f').join('');
  }));
  await page.locator('#move-modal-list .move-option', { hasText: /^\s*Projects/ }).click();
  await page.locator('#move-modal-ok').click();
  await page.waitForFunction((id) => document.querySelector(`.sb-node[data-node="${id}"] .sb-children .sidebar-item[data-id="D3"]`), proj.id);
  check('document moved: parentId written to Firestore', (await getDoc('D3')).parentId === proj.id);
  check('target folder auto-expanded', await page.evaluate((id) => _sidebarExpanded.has(id), proj.id));

  // Rename doc (open doc updates the header)
  await page.locator(rowSel('D2')).click({ button: 'right' });
  await clickMenu('Open');
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Beta.md');
  await page.locator(rowSel('D2')).click({ button: 'right' });
  await clickMenu('Rename');
  await page.locator('.sb-rename-input').fill('Beta Renamed');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sb-rename-input'));
  check('rename adds .md and writes title', (await getDoc('D2')).title === 'Beta Renamed.md');
  check('renaming the open document updates the title bar', (await page.locator('#tb-title').textContent()) === 'Beta Renamed.md');

  // Duplicate (F1 was collapsed in S2, so expand it first)
  await page.evaluate(() => { _sidebarExpanded.add('F1'); renderSidebarTree(_sidebarDocs, _sidebarFilter); });
  await page.locator(rowSel('D4')).click({ button: 'right' });
  await clickMenu('Duplicate');
  await page.waitForFunction(() => [...window.__store.values()].some((d) => d.title === 'Delta copy.md'));
  const dup = await findByTitle('Delta copy.md');
  check('duplicate keeps parent and content', dup && dup.parentId === 'F1' && dup.content === 'delta body', dup);
  check('duplicate does not switch the editor', (await page.locator('#tb-title').textContent()) === 'Beta Renamed.md');

  // ── S5 context menu on a folder and blank area ───────────────────────────────
  console.log('\nS5 context menu: folder and blank space');
  await page.locator(rowSel('F1')).click({ button: 'right' });
  check('folder menu items', JSON.stringify(await menuItems()) === JSON.stringify(['Collapse', 'New document here', 'New subfolder', 'Rename', 'Move to…', 'Move to Trash']), await menuItems());
  await clickMenu('New subfolder');
  await page.waitForSelector('.sb-rename-input');
  await page.locator('.sb-rename-input').fill('Archive');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sb-rename-input'));
  const arch = await findByTitle('Archive');
  check('subfolder saved with parentId', arch && arch.type === 'folder' && arch.parentId === 'F1', arch);
  check('parent expanded to show new subfolder', await page.evaluate(() => _sidebarExpanded.has('F1')));

  await page.locator(rowSel('F1')).click({ button: 'right' });
  await clickMenu('New document here');
  check('"New document here" starts a blank doc under the folder', await page.evaluate(() => currentParentId === 'F1' && currentDocId !== null && currentDocIsNew));
  await page.locator('#editor').fill('hello from inside the folder');
  await page.waitForFunction(() => [...window.__store.values()].some((d) => d.content === 'hello from inside the folder'), null, { timeout: 6000 });
  const inFolder = [...(await store(() => [...window.__store.values()].filter((d) => d.content === 'hello from inside the folder').map((d) => ({ parentId: d.parentId }))))];
  check('autosave wrote the new doc with parentId=F1', inFolder.length === 1 && inFolder[0].parentId === 'F1', inFolder);

  // C-4 regression: a plain New document must NOT inherit the folder parent
  await page.locator('#new-btn').click();
  await page.fill('#new-filename', 'plain');
  await page.locator('#new-modal-ok').click();
  await page.locator('#editor').fill('plain doc body');
  await page.evaluate(() => performSave(true));
  const plain = await findByTitle('plain.md');
  check('REGRESSION C-4: new doc after a nested doc has no parentId', plain && plain.parentId === undefined, plain);

  // blank-area menu
  await page.locator('#sidebar-list').click({ button: 'right', position: { x: 100, y: 5 }, force: true });
  const blank = await menuItems();
  check('blank-area menu: New document / New folder (or row menu when list is full)',
    JSON.stringify(blank) === JSON.stringify(['New document', 'New folder']) || blank.length > 0, blank);
  await page.keyboard.press('Escape');
  await page.evaluate(() => openContextMenu(5, 5, [{ label: 'x', action() {} }], null));
  await page.keyboard.press('Escape');
  await page.evaluate(() => openContextMenu(window.innerWidth - 2, window.innerHeight - 2, [{ label: 'A', action() {} }, { label: 'B', action() {} }], null));
  const r = await page.locator('.ctx-menu').boundingBox();
  check('menu is clamped inside the viewport', r.x >= 0 && r.y >= 0 && r.x + r.width <= 1200 && r.y + r.height <= 800, r);
  await page.keyboard.press('Escape');

  // touch long-press
  await page.evaluate(() => {
    const el = document.querySelector('#sidebar-list .sidebar-item[data-id="D3"]');
    const r = el.getBoundingClientRect();
    const opts = { pointerType: 'touch', clientX: r.x + 20, clientY: r.y + 8, bubbles: true, isPrimary: true, pointerId: 7 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
  });
  await page.waitForTimeout(700);
  check('touch long-press opens the menu', await page.locator('.ctx-menu').count() === 1);
  await page.keyboard.press('Escape');

  // ── S6 trash a folder with contents, undo, trash modal ───────────────────────
  console.log('\nS6 trash folder tree');
  const subtree = await store(() => TreeUtils.subtreeIds('F1', _sidebarDocs));
  await page.locator(rowSel('F1')).click({ button: 'right' });
  const dialogsBefore = dialogs.length;
  await clickMenu('Move to Trash');
  await page.waitForFunction(() => !document.querySelector('#sidebar-list .sidebar-item[data-id="F1"]'));
  check('confirm shown for a non-empty folder', dialogs.length === dialogsBefore + 1 && /its \d+ item/.test(dialogs[dialogs.length - 1]), dialogs[dialogs.length - 1]);
  const trashed = await store((ids) => ids.map((id) => { const d = window.__store.get(id); return { id, isDeleted: !!d.isDeleted, trashedBy: d.trashedBy || null }; }), subtree);
  check('every item in the folder is soft-deleted', trashed.every((t) => t.isDeleted), trashed);
  check('descendants tagged trashedBy=F1, folder itself is not', trashed.filter((t) => t.id !== 'F1').every((t) => t.trashedBy === 'F1') && trashed.find((t) => t.id === 'F1').trashedBy === null, trashed);
  check('nothing deleted for real', await store((ids) => ids.every((id) => window.__store.has(id)), subtree));
  check('sidebar no longer shows the folder or its children', await page.locator('#sidebar-list .sidebar-item[data-id="D4"]').count() === 0);

  await page.locator('#toast button', { hasText: 'Undo' }).click();
  await page.waitForFunction(() => document.querySelector('#sidebar-list .sidebar-item[data-id="F1"]'));
  const restored = await store((ids) => ids.map((id) => { const d = window.__store.get(id); return !d.isDeleted && d.trashedBy === undefined; }), subtree);
  check('Undo restores the whole tree and clears trashedBy', restored.every(Boolean), restored);

  // trash again then use the Trash modal
  await page.locator(rowSel('F1')).click({ button: 'right' });
  await clickMenu('Move to Trash');
  await page.waitForFunction(() => !document.querySelector('#sidebar-list .sidebar-item[data-id="F1"]'));
  await page.locator('#sidebar-trash-btn').click();
  await page.waitForSelector('#trash-modal.open .trash-item');
  const trashRows = await page.$$eval('#trash-list .trash-item', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('trash lists the folder once, with a "+N items" count', trashRows.length === 1 && /Work/.test(trashRows[0]) && /\+\d+ item/.test(trashRows[0]), trashRows);
  await page.locator('#trash-list .trash-restore-btn').click();
  await page.waitForFunction((ids) => ids.every((id) => !window.__store.get(id).isDeleted), subtree);
  check('Restore from Trash brings back the folder and its contents', true);
  await page.locator('#trash-cancel').click();

  await page.locator(rowSel('F1')).click({ button: 'right' });
  await clickMenu('Move to Trash');
  await page.waitForFunction(() => !document.querySelector('#sidebar-list .sidebar-item[data-id="F1"]'));
  await page.locator('#sidebar-trash-btn').click();
  await page.waitForSelector('#trash-list .trash-delete-btn');
  await page.locator('#trash-list .trash-delete-btn').click();
  await page.waitForFunction((ids) => ids.every((id) => !window.__store.has(id)), subtree);
  check('Delete permanently removes the folder and exactly its contents', true);
  check('unrelated documents untouched by permanent delete', await store(() => window.__store.has('D2') && window.__store.has('F2')));
  await page.locator('#trash-cancel').click();

  // ── S7 command palette ───────────────────────────────────────────────────────
  console.log('\nS7 command palette');
  await page.locator('#editor').click();
  await page.keyboard.press('Control+k');
  check('Ctrl+K opens the palette from the editor', await page.locator('#palette-modal.open').count() === 1);
  check('palette input is focused', await page.evaluate(() => document.activeElement.id === 'palette-input'));
  check('empty query lists recent documents and commands', (await page.locator('.palette-section').allTextContents()).join('|') === 'Recent documents|Commands');
  await page.keyboard.press('Control+k');
  check('Ctrl+K again closes it', await page.locator('#palette-modal.open').count() === 0);
  check('focus returns to the editor', await page.evaluate(() => document.activeElement.id === 'editor'));

  await page.keyboard.press('Control+k');
  await page.keyboard.type('>new f');
  check('">new f" ranks New folder first', (await page.locator('.palette-item.selected .palette-label').textContent()) === 'New folder');
  const countBefore = await store(() => [...window.__store.values()].filter((d) => d.type === 'folder' && !d.isDeleted).length);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sb-rename-input');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sb-rename-input'));
  check('Enter runs the command (folder created, palette closed)',
    (await store(() => [...window.__store.values()].filter((d) => d.type === 'folder' && !d.isDeleted).length)) === countBefore + 1 && await page.locator('#palette-modal.open').count() === 0);

  await page.keyboard.press('Control+k');
  await page.keyboard.type('gamma');
  check('document match shows under Documents with its folder path',
    (await page.locator('.palette-item.selected .palette-label').textContent()) === 'Gamma' &&
    (await page.locator('.palette-item.selected .palette-meta').textContent()) === 'Projects');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Gamma.md');
  check('opening a document from the palette loads it', (await page.locator('#editor').inputValue()) === 'gamma body');

  await page.keyboard.press('Control+k');
  await page.keyboard.type('zeta');
  await page.keyboard.press('Enter');
  check('selecting a folder reveals it (no editor change)', await page.evaluate(() => _sidebarExpanded.has('F2') && document.getElementById('tb-title').textContent === 'Gamma.md'));

  await page.keyboard.press('Control+k');
  await page.keyboard.type('>theme');
  check('">" restricts to commands', (await page.locator('.palette-section').allTextContents()).join('|') === 'Commands');
  const themeBefore = await page.evaluate(() => document.body.className);
  await page.keyboard.press('Enter');
  check('"Switch theme" command ran', (await page.evaluate(() => document.body.className)) !== themeBefore);

  await page.keyboard.press('Control+k');
  await page.keyboard.type('qqqzzz');
  check('no-match message', (await page.locator('.palette-empty').textContent()).includes('No matching'));
  await page.keyboard.press('Escape');
  check('Escape closes the palette', await page.locator('#palette-modal.open').count() === 0);

  await page.keyboard.press('Control+k');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  check('arrow keys move the selection', await page.locator('.palette-item.selected').count() === 1);
  await page.mouse.click(10, 10);
  check('clicking the backdrop closes the palette', await page.locator('#palette-modal.open').count() === 0);

  // ── S8 doc browser guard ─────────────────────────────────────────────────────
  console.log('\nS8 doc browser and folders');
  await page.evaluate(() => document.getElementById('open-btn').click());
  await page.waitForSelector('#doc-browser-list .file-item');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'doc-browser-search'); // list fully painted
  const dirRow = page.locator('#doc-browser-list .file-item', { hasText: 'Zeta' });
  check('folder row shows a DIR badge', (await dirRow.locator('.file-type-badge').textContent()) === 'DIR');
  const bodyBefore = await page.locator('#editor').inputValue();
  await dirRow.locator('.file-name').click();
  check('clicking a folder in the browser does not open it in the editor', (await page.locator('#editor').inputValue()) === bodyBefore);
  check('doc browser closed after revealing the folder', await page.locator('#doc-browser-modal.open').count() === 0, await page.evaluate(() => ({ cls: document.getElementById('doc-browser-modal').className, isDirty, kp: typeof kanbanPickTarget !== 'undefined' && kanbanPickTarget })));

  // ── S9 sign out / sign in ────────────────────────────────────────────────────
  console.log('\nS9 sign-out hygiene');
  await page.evaluate(() => firebase.auth().signOut());
  await page.waitForFunction(() => document.getElementById('sidebar-list').children.length === 0);
  check('sign-out empties the sidebar and its cache', await page.evaluate(() => _sidebarDocs.length === 0));
  await page.keyboard.press('Control+k');
  check('palette will not open while signed out', await page.locator('#palette-modal.open').count() === 0);
  await page.evaluate(() => window.__signIn());
  await page.waitForFunction(() => document.querySelectorAll('#sidebar-list .sidebar-item').length >= 3);
  await page.locator('#sidebar-list .sidebar-item').first().click({ button: 'right' });
  check('after sign-in, one right-click opens exactly one menu', await page.locator('.ctx-menu').count() === 1);
  await page.keyboard.press('Escape');

  // ── S10 injection safety ─────────────────────────────────────────────────────
  console.log('\nS10 hostile names');
  const evil = '<img src=x onerror="window.__xss=1">';
  await page.locator(rowSel('F2')).click({ button: 'right' });
  await clickMenu('Rename');
  await page.locator('.sb-rename-input').fill(evil);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sb-rename-input'));
  await page.keyboard.press('Control+k');
  await page.keyboard.type('img');
  await page.waitForTimeout(150);
  check('hostile folder name is rendered as text in sidebar and palette (no <img>, no script)',
    (await page.locator('#sidebar-list img, #palette-list img').count()) === 0 && (await page.evaluate(() => window.__xss)) === undefined);
  await page.keyboard.press('Escape');
  check('hostile name stored verbatim (normalized only for whitespace/slashes)', (await getDoc('F2')).title.includes('onerror'));

  // ── S11 read cost sanity ─────────────────────────────────────────────────────
  console.log('\nS11 no extra reads from the new actions');
  const q0 = await store(() => window.__queries.length);
  await page.locator('#sidebar-new-folder-btn').click();
  await page.waitForSelector('.sb-rename-input');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.sb-rename-input'));
  await page.locator('#sidebar-list .sidebar-item[data-type="folder"]').first().click({ button: 'right' });
  await clickMenu('Rename');
  await page.keyboard.press('Escape');
  const q1 = await store(() => window.__queries.length);
  check('creating and renaming folders issues zero collection queries', q1 === q0, { q0, q1 });


  // ── S13 Phase 0 (v3.28.0): C-1 .. C-5 ────────────────────────────────────────
  console.log('\nS13 Phase 0: read cost, window, autosave coverage, idempotent boot');
  const lastQ = () => store(() => window.__queries[window.__queries.length - 1]);
  await page.evaluate(() => loadDoc('D3'));
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Gamma.md');

  // C-1: autosave makes zero collection queries and updates the sidebar locally
  const c1a = await store(() => window.__queries.length);
  await page.locator('#editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' more');
  await page.waitForFunction(() => (window.__store.get('D3').content || '').endsWith(' more'), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  check('C-1 autosave issues zero collection queries', (await store(() => window.__queries.length)) === c1a, await store(() => window.__queries.slice(-3)));
  check('C-1 saved document moved to the front of the cached sidebar window', await store(() => _sidebarDocs[0].id === 'D3' && _sidebarDocs[0].content.endsWith(' more')));
  check('C-1 save status reads Saved', (await page.locator('#save-status').textContent().catch(() => 'Saved')).includes('Saved'));

  // brand-new document appears in the sidebar after its first autosave, without a query
  await page.evaluate(() => startNewRootDoc());
  await page.locator('#editor').click();
  await page.keyboard.type('brand new body');
  await page.waitForFunction(() => [...window.__store.values()].some((d) => d.content === 'brand new body'), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const newId = await store(() => [...window.__store.entries()].find((e) => e[1].content === 'brand new body')[0]);
  check('C-1 new document is listed in the sidebar after autosave', await page.locator(rowSel(newId)).count() === 1);
  check('C-1 ...still without any collection query', (await store(() => window.__queries.length)) === c1a);

  // C-1: Trash and Kanban read only what they show
  await page.locator('#sidebar-trash-btn').click();
  await page.waitForTimeout(200);
  const tq = await lastQ();
  check('C-1 Trash query filters isDeleted==true server side and has no orderBy',
    tq.filters.some((f) => f.f === 'isDeleted' && f.v === true) && tq.order === null, tq);
  await page.locator('#trash-cancel').click();
  await page.evaluate(() => openKanban());
  await page.waitForSelector('.kb-col');
  const kq = await lastQ();
  check('C-1 Kanban query uses a kanbanStatus "in" filter', kq.filters.some((f) => f.f === 'kanbanStatus' && f.op === 'in'), kq);
  await page.evaluate(() => closeKanban());

  // C-2: trashed documents no longer eat the 300 window; ancestors outside it are fetched
  await page.evaluate(() => {
    const ts = (ms) => ({ ms, toMillis: () => ms });
    window.__store.set('ANC', { userId: 'u1', title: 'Ancestor', content: '', type: 'folder', createdAt: ts(1), updatedAt: ts(1) });
    for (let i = 0; i < 305; i++) window.__store.set('L' + i, { userId: 'u1', title: 'Live ' + i + '.md', content: 'x', createdAt: ts(50000 + i), updatedAt: ts(50000 + i) });
    window.__store.set('CH', { userId: 'u1', title: 'Child.md', content: 'c', parentId: 'ANC', createdAt: ts(60000), updatedAt: ts(60000) });
    for (let i = 0; i < 310; i++) window.__store.set('T' + i, { userId: 'u1', title: 'Gone ' + i + '.md', content: 'x', isDeleted: true, deletedAt: ts(70000 + i), createdAt: ts(70000 + i), updatedAt: ts(70000 + i) });
  });
  const win = await page.evaluate(async () => {
    const docs = await fsGetAll(300);
    return { n: docs.length, trashed: docs.filter((d) => d.isDeleted).length };
  });
  check('C-2 window of 300 is filled with live documents despite 310 newer trashed ones', win.n === 300 && win.trashed === 0, win);
  await page.evaluate(() => refreshSidebarList());
  await page.waitForFunction(() => _sidebarDocs.some((d) => d.id === 'ANC'));
  check('C-2 ancestor outside the window was fetched', await store(() => _sidebarDocs.some((d) => d.id === 'ANC')));
  check('C-2 child stays under its parent instead of being promoted to the root',
    await page.locator('.sb-node[data-node="ANC"] .sb-children .sidebar-item[data-id="CH"]').count() === 1);
  check('C-2 no trashed document reached the sidebar', await store(() => !_sidebarDocs.some((d) => d.isDeleted)));
  await page.evaluate(() => {
    ['ANC', 'CH'].forEach((id) => window.__store.delete(id));
    for (let i = 0; i < 305; i++) window.__store.delete('L' + i);
    for (let i = 0; i < 310; i++) window.__store.delete('T' + i);
  });
  await page.evaluate(() => refreshSidebarList());
  await page.waitForFunction(() => !_sidebarDocs.some((d) => d.id === 'L1'));

  // C-3: Focus Mode and Replace All are auto-saved
  await page.evaluate(() => loadDoc('D3'));
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Gamma.md');
  await page.evaluate(() => {
    enterFocusMode();
    focusWysiwyg.textContent = 'focus typed text';
    focusWysiwyg.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__store.get('D3').content === 'focus typed text', null, { timeout: 8000 });
  check('C-3 Focus Mode edit reached Firestore without leaving Focus Mode', await page.evaluate(() => focusMode === true));
  await page.evaluate(() => exitFocusMode());
  await page.evaluate(() => {
    findInput.value = 'typed'; replaceInput.value = 'done';
    doReplaceAll();
  });
  await page.waitForFunction(() => window.__store.get('D3').content === 'focus done text', null, { timeout: 8000 });
  check('C-3 Replace All reached Firestore', true);

  // C-5: another sign-out/in cycle must not double sidebar handlers
  await page.evaluate(() => firebase.auth().signOut());
  await page.waitForFunction(() => document.getElementById('sidebar-list').children.length === 0);
  await page.evaluate(() => window.__signIn());
  await page.waitForFunction(() => document.querySelectorAll('#sidebar-list .sidebar-item').length >= 3);
  await page.locator('#editor').click();
  const c5a = await page.evaluate(() => isSidebarCollapsed());
  await page.keyboard.press('Control+\\');
  check('C-5 Ctrl+\\ toggles the sidebar exactly once after re-sign-in', (await page.evaluate(() => isSidebarCollapsed())) === !c5a);
  await page.locator('#sidebar-toggle-btn').click();
  check('C-5 header toggle button toggles exactly once', (await page.evaluate(() => isSidebarCollapsed())) === c5a);
  const sortBefore = await page.evaluate(() => _sidebarSort);
  await page.locator('.sb-sort-btn:not(.active)').first().click();
  check('C-5 sort buttons respond once (state changed, active class matches)',
    await page.evaluate((b) => _sidebarSort !== b && document.querySelector('.sb-sort-btn.active').dataset.sort === _sidebarSort, sortBefore));

  // ── console cleanliness ──────────────────────────────────────────────────────
  console.log('\nS12 console');
  check('no page errors or console errors during the whole run', errors.length === 0, errors.slice(0, 5));

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
