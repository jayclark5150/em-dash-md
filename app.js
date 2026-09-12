// ── Firebase ──────────────────────────────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const db   = firebase.firestore();
const auth = firebase.auth();

// ── Firestore helpers ─────────────────────────────────────────────────────────
function tsToMs(ts) {
  if (!ts) return Date.now();
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  return typeof ts === 'number' ? ts : Date.now();
}

async function fsGetAll(max) {
  let q = db.collection('documents')
    .where('userId', '==', auth.currentUser.uid)
    .orderBy('updatedAt', 'desc');
  if (max) q = q.limit(max);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function fsGet(id) {
  const snap = await db.collection('documents').doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function fsPut(id, title, content, isNew) {
  const now = firebase.firestore.FieldValue.serverTimestamp();
  const ref = db.collection('documents').doc(id);
  if (isNew) {
    await ref.set({ userId: auth.currentUser.uid, title, content, createdAt: now, updatedAt: now });
  } else {
    await ref.update({ title, content, updatedAt: now });
  }
}

async function fsDelete(id) {
  await db.collection('documents').doc(id).delete();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
let authMode = 'signin';

function showAuthOverlay() {
  document.getElementById('auth-overlay').classList.remove('hidden');
  document.getElementById('signout-btn').style.display = 'none';
}

function hideAuthOverlay() {
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('signout-btn').style.display = '';
}

function setAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

function setAuthLoading(on) {
  document.getElementById('auth-submit-btn').disabled = on;
  document.getElementById('auth-google-btn').disabled = on;
}

function setAuthModeUI(mode) {
  authMode = mode;
  const p2        = document.getElementById('auth-password2');
  const submitBtn = document.getElementById('auth-submit-btn');
  const toggle    = document.getElementById('auth-mode-toggle');
  if (mode === 'signup') {
    submitBtn.textContent = 'Create Account';
    p2.style.display      = '';
    toggle.textContent    = 'Already have an account? Sign in';
  } else {
    submitBtn.textContent = 'Sign In';
    p2.style.display      = 'none';
    toggle.textContent    = "Don't have an account? Create one";
  }
  setAuthError('');
}

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-email':          'Invalid email address.',
    'auth/user-not-found':         'No account found with this email.',
    'auth/wrong-password':         'Incorrect password.',
    'auth/invalid-credential':     'Incorrect email or password.',
    'auth/email-already-in-use':   'An account with this email already exists.',
    'auth/weak-password':          'Password must be at least 6 characters.',
    'auth/too-many-requests':      'Too many attempts. Try again later.',
    'auth/network-request-failed': 'Network error — check your connection.',
  };
  return map[code] || 'Sign-in failed. Please try again.';
}

document.getElementById('auth-mode-toggle').addEventListener('click', () => {
  setAuthModeUI(authMode === 'signin' ? 'signup' : 'signin');
});

document.getElementById('auth-forgot-btn').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  if (!email) { setAuthError('Enter your email address first.'); return; }
  setAuthLoading(true);
  try {
    await auth.sendPasswordResetEmail(email);
    setAuthError('');
    showToast('Password reset email sent');
  } catch (err) {
    setAuthError(friendlyAuthError(err.code));
  } finally {
    setAuthLoading(false);
  }
});

document.getElementById('auth-submit-btn').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const pw    = document.getElementById('auth-password').value;
  const pw2   = document.getElementById('auth-password2').value;
  setAuthError('');
  if (!email || !pw) { setAuthError('Email and password are required.'); return; }
  if (authMode === 'signup') {
    if (pw !== pw2)  { setAuthError('Passwords do not match.'); return; }
    if (pw.length < 6) { setAuthError('Password must be at least 6 characters.'); return; }
  }
  setAuthLoading(true);
  try {
    if (authMode === 'signup') {
      await auth.createUserWithEmailAndPassword(email, pw);
    } else {
      await auth.signInWithEmailAndPassword(email, pw);
    }
    // onAuthStateChanged handles the rest
  } catch (err) {
    setAuthError(friendlyAuthError(err.code));
    setAuthLoading(false);
  }
});

document.getElementById('auth-google-btn').addEventListener('click', async () => {
  setAuthError('');
  setAuthLoading(true);
  try {
    await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  } catch (err) {
    if (err.code === 'auth/popup-blocked') {
      // Popup was blocked — fall back to redirect
      await auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());
    } else if (err.code !== 'auth/popup-closed-by-user') {
      setAuthError(friendlyAuthError(err.code));
      setAuthLoading(false);
    } else {
      setAuthLoading(false);
    }
  }
});

document.getElementById('signout-btn').addEventListener('click', async () => {
  if (isDirty) await performSave(true);
  await auth.signOut();
});

// Also wire Enter key on auth inputs
document.getElementById('auth-email').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('auth-password').focus();
});
document.getElementById('auth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (authMode === 'signup') document.getElementById('auth-password2').focus();
    else document.getElementById('auth-submit-btn').click();
  }
});
document.getElementById('auth-password2').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('auth-submit-btn').click();
});

// ── Handle Google redirect return ─────────────────────────────────────────────
auth.getRedirectResult().catch((err) => {
  if (err.code && err.code !== 'auth/popup-closed-by-user') {
    setAuthError(friendlyAuthError(err.code));
    setAuthLoading(false);
  }
});

// ── Auth state gate ───────────────────────────────────────────────────────────
let appBooted = false;

auth.onAuthStateChanged(async (user) => {
  if (user) {
    hideAuthOverlay();
    setAuthLoading(false);
    if (!appBooted) {
      appBooted = true;
      bootApp();
    }
  } else {
    showAuthOverlay();
    setAuthModeUI('signin');
    clearTimeout(autoSaveTimer);
    currentDocIsNew = true;
    currentDocId = null;
    isDirty      = false;
    editor.value = '';
    setTitle('New Document');
    renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
    document.getElementById('drive-delete-btn').style.display = 'none';
    appBooted = false;
    loadReadmePreview();
  }
});

// ── State ─────────────────────────────────────────────────────────────────────
let currentDocId   = null;
let currentDocIsNew = true; // true until the doc has been written to Firestore at least once
let currentTitle   = 'New Document';
let isDirty        = false;
let autoSaveTimer  = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const editor         = document.getElementById('editor');
const previewInner   = document.getElementById('preview-inner');
const previewPane    = document.getElementById('preview-pane');
const lineNumbers    = document.getElementById('line-numbers');
const tbTitle        = document.getElementById('tb-title');
const titleInput     = document.getElementById('title-input');
const toast          = document.getElementById('toast');

// ── Marked setup ─────────────────────────────────────────────────────────────
if (window.marked && window.hljs) {
  marked.use({
    renderer: {
      code(codeOrToken, infostring) {
        let text, lang;
        if (codeOrToken && typeof codeOrToken === 'object') {
          text = codeOrToken.text;
          lang = codeOrToken.lang;
        } else {
          text = codeOrToken;
          lang = infostring;
        }
        text = (text == null) ? '' : String(text);
        if (lang) lang = lang.trim().split(/\s+/)[0];
        const language = (lang && hljs.getLanguage(lang)) ? lang : 'plaintext';
        const highlighted = hljs.highlight(text, { language }).value;
        return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
      }
    }
  });
}

if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

// ── Render preview ────────────────────────────────────────────────────────────
function renderPreview() {
  if (window.marked && window.DOMPurify) {
    try {
      previewInner.innerHTML = DOMPurify.sanitize(marked.parse(editor.value || ''));
      addCodeCopyButtons();
    } catch (e) {
      console.error('Preview render failed:', e);
    }
  }
}

// ── Copy-to-clipboard button on fenced code blocks ────────────────────────────
const COPY_ICON_SVG  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function addCodeCopyButtons() {
  previewInner.querySelectorAll('pre').forEach((pre) => {
    if (!pre.querySelector('code')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-code-btn';
    btn.setAttribute('aria-label', 'Copy code');
    btn.title = 'Copy code';
    btn.innerHTML = COPY_ICON_SVG;
    wrap.appendChild(btn);
  });
}

previewInner.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-code-btn');
  if (!btn) return;
  const code = btn.parentElement.querySelector('code');
  copyCodeBlock(code ? code.textContent : '', btn);
});

async function copyCodeBlock(text, btn) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (!ok) throw new Error('execCommand copy failed');
    }
    btn.innerHTML = CHECK_ICON_SVG;
    btn.classList.add('copied');
    clearTimeout(btn._copyResetTimer);
    btn._copyResetTimer = setTimeout(() => {
      btn.innerHTML = COPY_ICON_SVG;
      btn.classList.remove('copied');
    }, 1400);
  } catch (e) {
    showToast('Copy failed');
  }
}

// ── Stats & cursor ────────────────────────────────────────────────────────────
function updateStats() {
  const text  = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  document.getElementById('word-count').textContent = `Words: ${words}`;
  document.getElementById('char-count').textContent = `Chars: ${text.length}`;
}

function updateCursor() {
  const before = editor.value.slice(0, editor.selectionStart);
  const lines  = before.split('\n');
  document.getElementById('cursor-pos').textContent =
    `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
}

// Coalesce the expensive re-render/re-sanitize/line-number-rebuild work to at
// most once per animation frame, so a fast typing burst or a large paste
// doesn't re-do this full-document work on every single keystroke.
let renderRaf = null;
function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = null;
    renderPreview();
    updateStats();
    updateLineNumbers();
  });
}

editor.addEventListener('input', () => {
  isDirty = true;
  scheduleRender();
  scheduleAutoSave();
});
editor.addEventListener('click',  updateCursor);
editor.addEventListener('keyup',  updateCursor);

// ── Line numbers ──────────────────────────────────────────────────────────────
function updateLineNumbers() {
  const lines = editor.value.split('\n').length;
  lineNumbers.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join('<br>');
}

let scrollingEditor  = false;
let scrollingPreview = false;
let editorSyncRaf    = null;
let previewSyncRaf   = null;

editor.addEventListener('scroll', () => {
  lineNumbers.scrollTop = editor.scrollTop;
  if (scrollingPreview || editorSyncRaf) return;
  editorSyncRaf = requestAnimationFrame(() => {
    editorSyncRaf = null;
    scrollingEditor = true;
    const ratio = editor.scrollTop / Math.max(1, editor.scrollHeight - editor.clientHeight);
    previewPane.scrollTop = ratio * (previewPane.scrollHeight - previewPane.clientHeight);
    requestAnimationFrame(() => { scrollingEditor = false; });
  });
}, { passive: true });

previewPane.addEventListener('scroll', () => {
  if (scrollingEditor || previewSyncRaf) return;
  previewSyncRaf = requestAnimationFrame(() => {
    previewSyncRaf = null;
    scrollingPreview = true;
    const ratio = previewPane.scrollTop / Math.max(1, previewPane.scrollHeight - previewPane.clientHeight);
    editor.scrollTop = ratio * (editor.scrollHeight - editor.clientHeight);
    lineNumbers.scrollTop = editor.scrollTop;
    requestAnimationFrame(() => { scrollingPreview = false; });
  });
}, { passive: true });

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ── Save status ───────────────────────────────────────────────────────────────
let saveStatusTimer;
function showSaveStatus(msg) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

// ── Title editing ─────────────────────────────────────────────────────────────
tbTitle.addEventListener('click', () => {
  titleInput.value = currentTitle;
  tbTitle.style.display = 'none';
  titleInput.style.display = 'inline-block';
  titleInput.focus();
  titleInput.select();
});

titleInput.addEventListener('blur', commitTitle);
titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  commitTitle();
  if (e.key === 'Escape') { titleInput.style.display = 'none'; tbTitle.style.display = ''; }
});

function commitTitle() {
  const v = titleInput.value.trim();
  if (v) {
    currentTitle = v.endsWith('.md') || v.endsWith('.txt') ? v : v + '.md';
    tbTitle.textContent = currentTitle;
  }
  titleInput.style.display = 'none';
  tbTitle.style.display = '';
  scheduleAutoSave();
}

function setTitle(name) {
  currentTitle = name;
  tbTitle.textContent = name;
}

// ── Zoom controls ─────────────────────────────────────────────────────────────
let zoomLevel = 1.0;
const ZOOM_STEP = 0.1;
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 2.0;

function applyZoom() {
  previewInner.style.transform = `scale(${zoomLevel})`;
  previewInner.style.width     = `${100 / zoomLevel}%`;
  document.getElementById('zoom-pct').textContent = Math.round(zoomLevel * 100) + '%';
}

document.getElementById('zoom-in-btn').addEventListener('click',    () => { zoomLevel = Math.min(ZOOM_MAX, +(zoomLevel + ZOOM_STEP).toFixed(1)); applyZoom(); });
document.getElementById('zoom-out-btn').addEventListener('click',   () => { zoomLevel = Math.max(ZOOM_MIN, +(zoomLevel - ZOOM_STEP).toFixed(1)); applyZoom(); });
document.getElementById('zoom-reset-btn').addEventListener('click', () => { zoomLevel = 1.0; applyZoom(); });

// ── Auto-save ─────────────────────────────────────────────────────────────────
function scheduleAutoSave() {
  if (!auth.currentUser) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => { await performSave(true); }, 2000);
}

async function performSave(silent = false) {
  if (!auth.currentUser) return;
  const content = editor.value;
  const title   = currentTitle || 'Untitled';
  showSaveStatus('Saving…');
  try {
    if (!currentDocId) { currentDocId = crypto.randomUUID(); currentDocIsNew = true; }
    await fsPut(currentDocId, title, content, currentDocIsNew);
    currentDocIsNew = false;
    isDirty = false;
    showSaveStatus('Saved');
  } catch (err) {
    console.error('Save failed:', err);
    showSaveStatus('Save failed');
    if (!silent) showToast('Save failed — check console for details');
    else showToast('Auto-save failed');
  }
}

// ── New file ──────────────────────────────────────────────────────────────────
document.getElementById('new-btn').addEventListener('click', () => {
  if (isDirty && !confirm('You have unsaved changes. Create new document anyway?')) return;
  openNewModal();
});

function openNewModal() {
  document.getElementById('new-filename').value = '';
  document.getElementById('new-modal').classList.add('open');
  setTimeout(() => document.getElementById('new-filename').focus(), 50);
}

function closeNewModal() {
  document.getElementById('new-modal').classList.remove('open');
}

document.getElementById('new-modal-cancel').addEventListener('click', closeNewModal);
document.getElementById('new-modal-ok').addEventListener('click', createNewDoc);
document.getElementById('new-filename').addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  createNewDoc();
  if (e.key === 'Escape') closeNewModal();
});

function createNewDoc() {
  if (isDirty && !confirm('You have unsaved changes. Create a new document anyway?')) return;
  clearTimeout(autoSaveTimer);
  currentDocIsNew = true;
  currentDocId = null;
  isDirty      = false;
  editor.value = '';
  let name = document.getElementById('new-filename').value.trim() || 'untitled.md';
  if (!name.includes('.')) name += '.md';
  setTitle(name);
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  document.getElementById('drive-delete-btn').style.display = 'none';
  closeNewModal();
  editor.focus();
}

// ── Document browser ──────────────────────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function openDocBrowser() {
  const modal = document.getElementById('doc-browser-modal');
  modal.classList.add('open');
  document.getElementById('doc-browser-search').value = '';
  await renderDocBrowserList('');
  document.getElementById('doc-browser-search').focus();
}

function closeDocBrowser() {
  document.getElementById('doc-browser-modal').classList.remove('open');
}

async function renderDocBrowserList(query) {
  const list = document.getElementById('doc-browser-list');
  list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">Loading…</div>';
  let docs;
  try {
    // Soft cap so the doc browser can't blow up on read cost/bandwidth as
    // the library grows; a real fix would split out a lightweight metadata
    // collection instead of always fetching full content.
    docs = await fsGetAll(300);
  } catch (err) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">Error loading documents</div>';
    console.error('renderDocBrowserList:', err);
    return;
  }
  if (query) {
    const q = query.toLowerCase();
    docs = docs.filter(d => (d.title || '').toLowerCase().includes(q) || (d.content || '').toLowerCase().includes(q));
  }
  if (!docs.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">' + (query ? 'No matching documents' : 'No saved documents yet') + '</div>';
    return;
  }
  list.innerHTML = docs.map(d => {
    const date    = new Date(tsToMs(d.updatedAt)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const preview = esc((d.content || '').slice(0, 80).replace(/\n/g, ' '));
    return `<div class="file-item" data-id="${esc(d.id)}">
      <div style="flex:1;min-width:0">
        <div class="file-name">${esc(d.title || 'Untitled')}</div>
        <div class="file-date">${preview}</div>
      </div>
      <div class="file-date" style="margin-left:12px;white-space:nowrap">${esc(date)}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.file-item').forEach(el => {
    el.addEventListener('click', () => loadDoc(el.dataset.id));
  });
}

async function loadDoc(id) {
  if (isDirty && !confirm('You have unsaved changes. Open this document anyway?')) return;
  const doc = await fsGet(id);
  if (!doc) { showToast('Document not found'); return; }
  clearTimeout(autoSaveTimer);
  currentDocId = doc.id;
  currentDocIsNew = false;
  editor.value = doc.content || '';
  setTitle(doc.title || 'Untitled');
  isDirty = false;
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  document.getElementById('drive-delete-btn').style.display = 'inline-flex';
  closeDocBrowser();
  editor.focus();
}

async function loadMostRecent() {
  try {
    // Only need the single newest doc here — no reason to pull every
    // document's full content just to find it.
    const docs = await fsGetAll(1);
    if (docs.length) {
      await loadDoc(docs[0].id);
    } else {
      // No saved docs — clear the pre-login README so the user starts fresh.
      editor.value = '';
      currentDocId = null;
      currentDocIsNew = true;
      setTitle('New Document');
      renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
    }
  } catch (err) {
    console.error('loadMostRecent:', err);
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function deleteCurrentDoc() {
  if (!currentDocId) return;
  if (!confirm(`Delete "${currentTitle}"? This cannot be undone.`)) return;
  try {
    await fsDelete(currentDocId);
    clearTimeout(autoSaveTimer);
    currentDocId = null;
    isDirty      = false;
    editor.value = '';
    setTitle('New Document');
    renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
    document.getElementById('drive-delete-btn').style.display = 'none';
    showToast('Document deleted');
  } catch (err) {
    showToast('Delete failed');
    console.error('deleteCurrentDoc:', err);
  }
}

document.getElementById('drive-delete-btn').addEventListener('click', deleteCurrentDoc);

// ── Doc browser event wiring ──────────────────────────────────────────────────
document.getElementById('open-btn').addEventListener('click', openDocBrowser);
document.getElementById('recent-btn').addEventListener('click', openDocBrowser);
document.getElementById('doc-browser-cancel').addEventListener('click', closeDocBrowser);
document.getElementById('doc-browser-search').addEventListener('input', (e) => {
  renderDocBrowserList(e.target.value);
});
document.getElementById('doc-browser-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('doc-browser-modal')) closeDocBrowser();
});

// ── List continuation ─────────────────────────────────────────────────────────
editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;

  const start     = editor.selectionStart;
  const value     = editor.value;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd   = value.indexOf('\n', start);
  const line      = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);

  const unordered = line.match(/^(\s*)([-*+]) /);
  const ordered   = line.match(/^(\s*)(\d+)\. /);
  const match     = unordered || ordered;
  if (!match) return;

  const prefix  = match[0];
  const content = line.slice(prefix.length).trim();

  e.preventDefault();

  if (content === '') {
    const newValue  = value.slice(0, lineStart) + '\n' + value.slice(lineStart + prefix.length);
    editor.value    = newValue;
    editor.setSelectionRange(lineStart + 1, lineStart + 1);
  } else {
    let newPrefix;
    if (ordered) {
      newPrefix = ordered[1] + (parseInt(ordered[2], 10) + 1) + '. ';
    } else {
      newPrefix = unordered[1] + unordered[2] + ' ';
    }
    const insert    = '\n' + newPrefix;
    const newValue  = value.slice(0, start) + insert + value.slice(start);
    const newCursor = start + insert.length;
    editor.value    = newValue;
    editor.setSelectionRange(newCursor, newCursor);
  }

  isDirty = true;
  renderPreview(); updateStats(); updateLineNumbers(); updateCursor();
  scheduleAutoSave();
});

// ── Find & Replace ────────────────────────────────────────────────────────────
const findBar      = document.getElementById('find-replace-bar');
const findInput    = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const matchInfo    = document.getElementById('match-info');

let findMatches = [];
let findIndex   = -1;

function openFindBar() {
  findBar.classList.add('visible');
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind();
}
function closeFindBar() {
  findBar.classList.remove('visible');
  findMatches = []; findIndex = -1;
  matchInfo.textContent = '';
  findInput.classList.remove('no-match');
  editor.focus();
}
function runFind() {
  matchInfo.textContent = '';
  findMatches = []; findIndex = -1;
  findInput.classList.remove('no-match');
  const q = findInput.value;
  if (!q) return;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let m;
  while ((m = re.exec(editor.value)) !== null) findMatches.push(m.index);
  if (!findMatches.length) { findInput.classList.add('no-match'); matchInfo.textContent = 'No results'; return; }
  findIndex = 0;
  highlightMatch();
}
function highlightMatch() {
  if (!findMatches.length) return;
  const pos = findMatches[findIndex];
  editor.setSelectionRange(pos, pos + findInput.value.length);
  matchInfo.textContent = `${findIndex + 1} / ${findMatches.length}`;
  const linesBefore = editor.value.slice(0, pos).split('\n').length;
  const lineHeight  = parseFloat(getComputedStyle(editor).lineHeight) || 24;
  editor.scrollTop  = Math.max(0, (linesBefore - 4) * lineHeight);
}
function findNext() { if (!findMatches.length) { runFind(); return; } findIndex = (findIndex + 1) % findMatches.length; highlightMatch(); }
function findPrev() { if (!findMatches.length) { runFind(); return; } findIndex = (findIndex - 1 + findMatches.length) % findMatches.length; highlightMatch(); }

function doReplace() {
  if (!findMatches.length) { runFind(); return; }
  const pos = findMatches[findIndex];
  editor.setSelectionRange(pos, pos + findInput.value.length);
  document.execCommand('insertText', false, replaceInput.value);
  isDirty = true; renderPreview(); updateStats();
  runFind();
}
function doReplaceAll() {
  const q = findInput.value;
  if (!q) return;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const count = (editor.value.match(re) || []).length;
  editor.value = editor.value.replace(re, replaceInput.value);
  isDirty = true; renderPreview(); updateStats(); updateLineNumbers();
  showToast(`✓ Replaced ${count} occurrence${count !== 1 ? 's' : ''}`);
  runFind();
}

document.getElementById('find-btn').addEventListener('click',        openFindBar);
document.getElementById('find-close-btn').addEventListener('click',  closeFindBar);
document.getElementById('find-next-btn').addEventListener('click',   findNext);
document.getElementById('find-prev-btn').addEventListener('click',   findPrev);
document.getElementById('replace-btn').addEventListener('click',     doReplace);
document.getElementById('replace-all-btn').addEventListener('click', doReplaceAll);

findInput.addEventListener('input', runFind);
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  { e.shiftKey ? findPrev() : findNext(); }
  if (e.key === 'Escape') closeFindBar();
});
replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  doReplace();
  if (e.key === 'Escape') closeFindBar();
});

// ── Focus Mode (WYSIWYG + Typewriter) ────────────────────────────────────────
let focusMode    = false;
const focusOverlay = document.getElementById('focus-overlay');
const focusWysiwyg = document.getElementById('focus-wysiwyg');

let td;
function getTurndown() {
  if (!td && window.TurndownService) {
    td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  }
  return td;
}

function typewriterScroll() {
  if (!focusMode) return;
  const ta = editor;
  const text = ta.value.substring(0, ta.selectionStart);
  const mirror = document.createElement('div');
  const cs = getComputedStyle(ta);
  ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
   'padding','paddingTop','paddingBottom','paddingLeft','paddingRight',
   'border','borderTop','borderBottom','whiteSpace','wordWrap','width','boxSizing'
  ].forEach(p => mirror.style[p] = cs[p]);
  mirror.style.position   = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow   = 'hidden';
  mirror.style.height     = 'auto';
  mirror.style.top = ta.getBoundingClientRect().top + window.scrollY + 'px';
  mirror.style.left = ta.getBoundingClientRect().left + window.scrollX + 'px';
  mirror.textContent = text;
  const caret = document.createElement('span');
  caret.textContent = '|';
  mirror.appendChild(caret);
  document.body.appendChild(mirror);
  const caretTop = caret.getBoundingClientRect().top;
  document.body.removeChild(mirror);

  const target = window.innerHeight * 0.45;
  const diff = caretTop - target;
  if (Math.abs(diff) > 5) ta.scrollTop += diff;
}

function enterFocusMode() {
  focusMode = true;
  document.body.classList.add('focus-mode');
  document.getElementById('focus-btn').classList.add('active');
  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  focusWysiwyg.innerHTML = (window.marked && window.DOMPurify)
    ? DOMPurify.sanitize(marked.parse(editor.value || ''))
    : editor.value;
  focusWysiwyg.focus();
}

function exitFocusMode() {
  const turndown = getTurndown();
  if (turndown) {
    const md = turndown.turndown(focusWysiwyg.innerHTML);
    if (md !== editor.value) {
      editor.value = md;
      isDirty = true;
      renderPreview();
      updateStats();
      updateLineNumbers();
    }
  }
  focusWysiwyg.innerHTML = '';
  focusMode = false;
  document.body.classList.remove('focus-mode');
  document.getElementById('focus-btn').classList.remove('active');
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  editor.focus();
}

focusWysiwyg.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, text);
});

let wysiwygSyncTimer;
focusWysiwyg.addEventListener('input', () => {
  clearTimeout(wysiwygSyncTimer);
  wysiwygSyncTimer = setTimeout(() => {
    if (!focusMode) return;
    const turndown = getTurndown();
    if (turndown) {
      editor.value = turndown.turndown(focusWysiwyg.innerHTML);
      isDirty = true;
      updateStats();
    }
  }, 600);
});

function toggleFocusMode() {
  focusMode ? exitFocusMode() : enterFocusMode();
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && focusMode) exitFocusMode();
});

document.getElementById('focus-btn').addEventListener('click', toggleFocusMode);
document.getElementById('focus-exit-btn').addEventListener('click', exitFocusMode);

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 's') { e.preventDefault(); if (auth.currentUser) performSave(false); }
  if (mod && e.key === 'n') { e.preventDefault(); if (!isDirty || confirm('Discard changes?')) openNewModal(); }
  if (mod && e.key === 'o') { e.preventDefault(); openDocBrowser(); }
  if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleFocusMode(); return; }
  if (mod && e.key === 'f') { e.preventDefault(); openFindBar(); }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomLevel = Math.min(ZOOM_MAX, +(zoomLevel + ZOOM_STEP).toFixed(1)); applyZoom(); }
  if (mod && e.key === '-') { e.preventDefault(); zoomLevel = Math.max(ZOOM_MIN, +(zoomLevel - ZOOM_STEP).toFixed(1)); applyZoom(); }
  if (mod && e.key === '0') { e.preventDefault(); zoomLevel = 1.0; applyZoom(); }
  if (e.key === 'Escape' && findBar.classList.contains('visible')) closeFindBar();
  if (e.key === 'F11') { e.preventDefault(); toggleFocusMode(); }
  if (e.key === 'Escape' && focusMode) exitFocusMode();
});

// ── PWA install ───────────────────────────────────────────────────────────────
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('install-banner').classList.add('show');
});
document.getElementById('install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  document.getElementById('install-banner').classList.remove('show');
});
document.getElementById('install-close').addEventListener('click', () => {
  document.getElementById('install-banner').classList.remove('show');
});

// ── Unsaved changes warning on navigation ────────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Resizable divider ─────────────────────────────────────────────────────────
(function () {
  const divider      = document.getElementById('divider');
  const editorPane   = document.getElementById('editor-pane');
  const previewWrap  = document.getElementById('preview-wrapper');
  let dragging = false, startX = 0, startEditorW = 0, startPreviewW = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startEditorW  = editorPane.getBoundingClientRect().width;
    startPreviewW = previewWrap.getBoundingClientRect().width;
    divider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const newEditorW  = Math.max(200, startEditorW + dx);
    const newPreviewW = Math.max(200, startPreviewW - dx);
    editorPane.style.flex  = 'none';
    editorPane.style.width = newEditorW + 'px';
    previewWrap.style.flex  = 'none';
    previewWrap.style.width = newPreviewW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(console.error);
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function wrapSelection(before, after) {
  if (after === undefined) after = before;
  const start    = editor.selectionStart;
  const end      = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  const newText  = before + selected + after;
  document.execCommand('insertText', false, newText);
  editor.setSelectionRange(start + before.length, start + before.length + selected.length);
  editor.dispatchEvent(new Event('input'));
  editor.focus();
}

function prefixLines(prefix) {
  const start     = editor.selectionStart;
  const end       = editor.selectionEnd;
  const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd   = editor.value.indexOf('\n', end);
  const blockEnd  = lineEnd === -1 ? editor.value.length : lineEnd;
  const block     = editor.value.slice(lineStart, blockEnd);
  const lines     = block.split('\n');
  const already   = lines.every(l => l.startsWith(prefix));
  const newBlock  = already
    ? lines.map(l => l.slice(prefix.length)).join('\n')
    : lines.map(l => prefix + l).join('\n');
  editor.focus();
  editor.setSelectionRange(lineStart, blockEnd);
  document.execCommand('insertText', false, newBlock);
  editor.dispatchEvent(new Event('input'));
}

function insertHeading(level) {
  const hashes = '#'.repeat(level) + ' ';
  const start     = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd   = editor.value.indexOf('\n', start);
  const end       = lineEnd === -1 ? editor.value.length : lineEnd;
  const line      = editor.value.slice(lineStart, end);
  const stripped  = line.replace(/^#{1,6}\s*/, '');
  editor.focus();
  editor.setSelectionRange(lineStart, end);
  document.execCommand('insertText', false, hashes + stripped);
  editor.dispatchEvent(new Event('input'));
}

// ── Format bar button handlers ────────────────────────────────────────────────
document.getElementById('fmt-bold-btn').addEventListener('click',   () => wrapSelection('**'));
document.getElementById('fmt-italic-btn').addEventListener('click', () => wrapSelection('_'));
document.getElementById('fmt-strike-btn').addEventListener('click', () => wrapSelection('~~'));
document.getElementById('fmt-ul-btn').addEventListener('click',     () => prefixLines('- '));
document.getElementById('fmt-ol-btn').addEventListener('click',     () => prefixLines('1. '));
document.getElementById('fmt-quote-btn').addEventListener('click',  () => prefixLines('> '));
document.getElementById('fmt-code-btn').addEventListener('click',   () => {
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (selected.includes('\n')) {
    wrapSelection('```\n', '\n```');
  } else {
    wrapSelection('`');
  }
});
document.getElementById('fmt-link-btn').addEventListener('click', () => {
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (selected) {
    wrapSelection('[', '](url)');
  } else {
    wrapSelection('[link text](', ')');
  }
});
document.getElementById('fmt-image-btn').addEventListener('click', () => {
  wrapSelection('![alt text](', ')');
});

document.getElementById('fmt-heading-btn').addEventListener('click', () => insertHeading(1));
document.getElementById('fmt-heading-dd').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('fmt-heading-menu').classList.toggle('open');
  document.getElementById('fmt-code-menu').classList.remove('open');
});
document.getElementById('fmt-heading-menu').querySelectorAll('[data-level]').forEach(btn => {
  btn.addEventListener('click', () => {
    insertHeading(parseInt(btn.dataset.level, 10));
    document.getElementById('fmt-heading-menu').classList.remove('open');
  });
});

document.getElementById('fmt-code-dd').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('fmt-code-menu').classList.toggle('open');
  document.getElementById('fmt-heading-menu').classList.remove('open');
});
document.getElementById('fmt-inline-code').addEventListener('click', () => {
  wrapSelection('`');
  document.getElementById('fmt-code-menu').classList.remove('open');
});
document.getElementById('fmt-code-block').addEventListener('click', () => {
  wrapSelection('```\n', '\n```');
  document.getElementById('fmt-code-menu').classList.remove('open');
});

document.addEventListener('click', () => {
  document.getElementById('fmt-heading-menu').classList.remove('open');
  document.getElementById('fmt-code-menu').classList.remove('open');
  document.getElementById('hdr-more-menu').classList.remove('open');
});

document.addEventListener('keydown', (e) => {
  if (document.activeElement !== editor) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'b') { e.preventDefault(); wrapSelection('**'); }
  if (mod && e.key === 'i') { e.preventDefault(); wrapSelection('_'); }
}, true);

// ── View toggles ──────────────────────────────────────────────────────────────
(function () {
  const editorPane   = document.getElementById('editor-pane');
  const previewWrap  = document.getElementById('preview-wrapper');
  const divider      = document.getElementById('divider');
  const btnEdit      = document.getElementById('view-edit-btn');
  const btnSplit     = document.getElementById('view-split-btn');
  const btnPreview   = document.getElementById('view-preview-btn');

  function setView(mode) {
    btnEdit.classList.remove('active');
    btnSplit.classList.remove('active');
    btnPreview.classList.remove('active');
    editorPane.style.flex  = '';
    editorPane.style.width = '';
    previewWrap.style.flex  = '';
    previewWrap.style.width = '';
    if (mode === 'edit') {
      btnEdit.classList.add('active');
      editorPane.style.flex   = '1';
      previewWrap.style.display = 'none';
      divider.style.display   = 'none';
    } else if (mode === 'preview') {
      btnPreview.classList.add('active');
      editorPane.style.display = 'none';
      divider.style.display   = 'none';
    } else {
      btnSplit.classList.add('active');
      editorPane.style.display  = '';
      previewWrap.style.display = '';
      divider.style.display     = '';
    }
  }

  btnEdit.addEventListener('click',    () => { userPickedView = true; setView('edit'); });
  btnSplit.addEventListener('click',   () => { userPickedView = true; setView('split'); });
  btnPreview.addEventListener('click', () => { userPickedView = true; setView('preview'); });

  let userPickedView = false;
  let wasMobile = window.innerWidth <= 700;
  setView(wasMobile ? 'edit' : 'split');

  window.addEventListener('resize', () => {
    const isMobile = window.innerWidth <= 700;
    if (isMobile !== wasMobile && !userPickedView) {
      setView(isMobile ? 'edit' : 'split');
    }
    wasMobile = isMobile;
  });
})();

// ── Import / Export ─────────────────────────────────────────────────────────
document.getElementById('hdr-import-btn').addEventListener('click', () => {
  document.getElementById('hdr-more-menu').classList.remove('open');
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length || !auth.currentUser) return;
  let succeeded = 0;
  const failed  = [];
  for (const file of files) {
    try {
      const text = await file.text();
      await fsPut(crypto.randomUUID(), file.name, text, true);
      succeeded++;
    } catch (err) {
      failed.push(file.name);
    }
  }
  if (failed.length === 0) {
    showToast(`✓ Imported ${succeeded} file${succeeded === 1 ? '' : 's'}`);
  } else {
    showToast(`Imported ${succeeded}/${files.length} — failed: ${failed.join(', ')}`, 6000);
  }
});

function exportBasename() {
  return (currentTitle || 'untitled').replace(/\.(md|markdown|txt)$/i, '');
}

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`✓ Downloaded "${filename}"`);
}

function buildExportHtml() {
  const title = exportBasename().replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github.min.css">
<style>
*,*::before,*::after{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11pt;line-height:1.65;color:#1a1a1a;max-width:740px;margin:0 auto;padding:32px 28px}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .45em;font-weight:600}
h1{font-size:22pt;border-bottom:2px solid #e0e0e0;padding-bottom:.3em;margin-top:.5em}
h2{font-size:16pt;border-bottom:1px solid #e0e0e0;padding-bottom:.2em}
h3{font-size:13pt}h4{font-size:11.5pt}h5,h6{font-size:11pt}
p{margin:0 0 .75em}a{color:#0969da}
code{font-family:'SF Mono','Fira Code',Menlo,Consolas,monospace;font-size:9.5pt;background:#f6f8fa;padding:2px 6px;border-radius:4px;border:1px solid #e0e0e0}
pre{background:#f6f8fa;border:1px solid #e0e0e0;border-radius:6px;padding:14px 16px;overflow:visible;white-space:pre-wrap;word-break:break-all;margin:.75em 0}
pre code{background:none;padding:0;font-size:9pt;border:none;border-radius:0}
blockquote{border-left:4px solid #d0d7de;margin:.75em 0;padding:.1em 1em;color:#57606a}
table{border-collapse:collapse;width:100%;margin:.75em 0}
th,td{border:1px solid #d0d7de;padding:6px 14px;text-align:left}
th{background:#f6f8fa;font-weight:600}tr:nth-child(even) td{background:#fafafa}
img{max-width:100%;height:auto}hr{border:none;border-top:2px solid #e0e0e0;margin:1.5em 0}
ul,ol{padding-left:1.8em;margin:0 0 .75em}li{margin:.2em 0}
</style></head>
<body>${previewInner.innerHTML}</body></html>`;
}

function htmlToRtf(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = DOMPurify.sanitize(html);
  function escRtf(t) {
    return t.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
            .replace(/[^\x00-\x7F]/g, c => `\\u${c.charCodeAt(0)}?`);
  }
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return escRtf(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const inner = () => Array.from(node.childNodes).map(walk).join('');
    switch (tag) {
      case 'h1': return `\\pard\\sb480\\sa120\\b\\fs48 ${inner()}\\b0\\par\n`;
      case 'h2': return `\\pard\\sb360\\sa100\\b\\fs40 ${inner()}\\b0\\par\n`;
      case 'h3': return `\\pard\\sb240\\sa80\\b\\fs32 ${inner()}\\b0\\par\n`;
      case 'h4': return `\\pard\\sb200\\sa60\\b\\fs28 ${inner()}\\b0\\par\n`;
      case 'h5': case 'h6': return `\\pard\\sb160\\sa40\\b\\fs24 ${inner()}\\b0\\par\n`;
      case 'p': return `\\pard\\sb0\\sa200 ${inner()}\\par\n`;
      case 'br': return '\\line\n';
      case 'strong': case 'b': return `{\\b ${inner()}}`;
      case 'em': case 'i': return `{\\i ${inner()}}`;
      case 'u': return `{\\ul ${inner()}}`;
      case 's': case 'del': return `{\\strike ${inner()}}`;
      case 'code': {
        const inPre = node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre';
        return inPre ? inner() : `{\\f1\\fs20 ${inner()}}`;
      }
      case 'pre': return `\\pard\\sb100\\sa100\\li360\\f1\\fs20 ${inner()}\\f0\\fs24\\par\n`;
      case 'blockquote': return `\\pard\\sb100\\sa100\\li720\\ri720\\cf2\\i ${inner()}\\i0\\cf1\\par\n`;
      case 'ul': {
        return Array.from(node.children).filter(c => c.tagName.toLowerCase() === 'li')
          .map(li => `\\pard\\fi-360\\li720\\sb0\\sa80 \\bullet\\tab ${walk(li)}\\par\n`).join('');
      }
      case 'ol': {
        let n = 0;
        return Array.from(node.children).filter(c => c.tagName.toLowerCase() === 'li')
          .map(li => `\\pard\\fi-360\\li720\\sb0\\sa80 ${++n}.\\tab ${walk(li)}\\par\n`).join('');
      }
      case 'li': return inner();
      case 'a':  return inner();
      case 'hr': return `\\pard\\brdrb\\brdrs\\brdrw10\\brsp20 \\par\n`;
      case 'table': return `\\pard\\sb100\\sa100 [Table — see HTML export for full table]\\par\n`;
      case 'img': return '';
      case 'thead': case 'tbody': case 'tr': case 'th': case 'td': return inner();
      default: return inner();
    }
  }
  const body = Array.from(wrap.childNodes).map(walk).join('');
  return `{\\rtf1\\ansi\\deff0\\deflang1033\n` +
    `{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fmodern\\fcharset0 Courier New;}}\n` +
    `{\\colortbl;\\red0\\green0\\blue0;\\red0\\green102\\blue204;}\n` +
    `\\widowctrl\\hyphauto\\margl1800\\margr1800\\margt1440\\margb1440\\f0\\fs24\\cf1\n` +
    body + `}`;
}

function exportAsMd()   { if (!editor.value) { showToast('Nothing to export'); return; } triggerDownload(new Blob([editor.value], { type: 'text/markdown' }), exportBasename() + '.md'); }
function exportAsTxt()  { if (!editor.value) { showToast('Nothing to export'); return; } triggerDownload(new Blob([editor.value], { type: 'text/plain'    }), exportBasename() + '.txt'); }
function exportAsHtml() { if (!editor.value) { showToast('Nothing to export'); return; } triggerDownload(new Blob([buildExportHtml()], { type: 'text/html'  }), exportBasename() + '.html'); }
function exportAsRtf()  { if (!editor.value) { showToast('Nothing to export'); return; } triggerDownload(new Blob([htmlToRtf(previewInner.innerHTML)], { type: 'application/rtf' }), exportBasename() + '.rtf'); }

async function exportAsDocx() {
  if (!editor.value) { showToast('Nothing to export'); return; }
  if (!window.htmlDocx) {
    showToast('Loading DOCX converter…');
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js';
        // Same SRI protection as every other CDN script in index.html —
        // a compromised/altered CDN response won't execute silently.
        s.integrity   = 'sha384-TtrQp5nveof/QP1+f/OLiEHL3GuOIRyl3IfsGxu5X45VO2vHeT4HRNmQuTR3Ea3w';
        s.crossOrigin = 'anonymous';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    } catch (_) { showToast('Could not load DOCX converter'); return; }
  }
  triggerDownload(window.htmlDocx.asBlob(buildExportHtml()), exportBasename() + '.docx');
}

[['hdr-export-md-btn',   exportAsMd],
 ['hdr-export-txt-btn',  exportAsTxt],
 ['hdr-export-html-btn', exportAsHtml],
 ['hdr-export-pdf-btn',  exportAsPdf],
 ['hdr-export-docx-btn', exportAsDocx],
 ['hdr-export-rtf-btn',  exportAsRtf],
].forEach(([id, fn]) => {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('hdr-more-menu').classList.remove('open');
    fn();
  });
});

// ── PDF export ────────────────────────────────────────────────────────────────
function exportAsPdf() {
  if (!previewInner.innerHTML.trim()) { showToast('Nothing to export'); return; }
  const printWin = window.open('', '_blank', 'width=900,height=700');
  if (!printWin) { showToast('Pop-up blocked — allow pop-ups and try again'); return; }
  const html = buildExportHtml().replace('</style>', '@media print{body{padding:0}pre{white-space:pre-wrap;page-break-inside:avoid}h1,h2,h3{page-break-after:avoid}table,figure{page-break-inside:avoid}}</style>');
  printWin.document.write(html);
  printWin.document.close();
  printWin.focus();
  setTimeout(() => { printWin.print(); printWin.close(); }, 400);
}

// ── Header bar delegation ─────────────────────────────────────────────────────
document.getElementById('hdr-more-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('hdr-more-menu').classList.toggle('open');
});
document.getElementById('hdr-focus-mode').addEventListener('click', () => {
  toggleFocusMode();
  document.getElementById('hdr-more-menu').classList.remove('open');
});

// ── Theme cycle ──────────────────────────────────────────────────────────────
(function() {
  const THEMES = ['lokai', 'dark', 'light'];
  const LABELS = { lokai: 'Lokai', dark: 'Dark', light: 'Light' };
  const btn    = document.getElementById('theme-toggle-btn');
  const label  = document.getElementById('theme-label');
  const tip    = document.getElementById('theme-tip');

  function applyTheme(t) {
    document.body.classList.remove('theme-dark', 'theme-light');
    if (t === 'dark')  document.body.classList.add('theme-dark');
    if (t === 'light') document.body.classList.add('theme-light');
    label.textContent = LABELS[t];
    tip.textContent   = 'Theme: ' + LABELS[t];
    try { localStorage.setItem('md-theme', t); } catch(_) {}
  }

  let current;
  try { current = localStorage.getItem('md-theme'); } catch(_) {}
  if (!THEMES.includes(current)) current = 'lokai';
  applyTheme(current);

  btn.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    current = next;
    applyTheme(next);
  });
})();

// ── README preview (shown to logged-out visitors behind the auth overlay) ─────
async function loadReadmePreview() {
  try {
    const res = await fetch('README.md');
    if (!res.ok) return;
    editor.value = await res.text();
    renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  } catch (e) {
    // silently ignore — editor stays blank
  }
}

// ── Boot (runs after successful auth) ─────────────────────────────────────────
async function bootApp() {
  renderPreview();
  updateStats();
  updateCursor();
  updateLineNumbers();
  applyZoom();
  await loadMostRecent();

  if (new URLSearchParams(window.location.search).get('new') === '1') {
    clearTimeout(autoSaveTimer);
    currentDocIsNew = true;
    currentDocId = null;
    isDirty      = false;
    editor.value = '';
    setTitle('New Document');
    renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
    window.history.replaceState({}, '', window.location.pathname);
  }
}
