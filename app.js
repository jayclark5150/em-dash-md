// ── Firebase ──────────────────────────────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);

// C-6 (v3.29.0): localStorage can throw (blocked storage, private windows) or hold
// corrupt values. Every access goes through these helpers so the app always boots.
function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (_) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}
function lsGetJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (_) { return fallback; }
}
const db   = firebase.firestore();
const auth = firebase.auth();

// Cache reads in IndexedDB so repeat loads (e.g. reopening the doc browser,
// or relaunching the app) can paint from disk instead of waiting on a round
// trip every time. synchronizeTabs lets persistence stay enabled even with
// more than one tab of the app open at once.
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  if (err.code === 'failed-precondition') {
    console.warn('Firestore persistence unavailable: another tab has an incompatible session open.');
  } else if (err.code === 'unimplemented') {
    console.warn('Firestore persistence unavailable: this browser does not support it.');
  } else {
    console.warn('Firestore persistence failed to enable:', err);
  }
});

// ── Firestore helpers ─────────────────────────────────────────────────────────
function tsToMs(ts) {
  if (!ts) return Date.now();
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  return typeof ts === 'number' ? ts : Date.now();
}

async function fsGetAll(max, opts) {
  const getOpts = opts && opts.source ? { source: opts.source } : undefined;
  const base = () => db.collection('documents')
    .where('userId', '==', auth.currentUser.uid)
    .orderBy('updatedAt', 'desc');
  const live = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => !d.isDeleted);
  if (!max) return live(await base().get(getOpts));

  // C-2 (v3.28.0): trashed documents used to occupy slots in the window
  // because the limit applied before the isDeleted filter. Page forward until
  // `max` live documents are collected. With nothing in the Trash this is a
  // single query, exactly as before.
  const out = [];
  let last = null;
  for (let page = 0; page < 6 && out.length < max; page++) {
    const size = page === 0 ? max : Math.max(max - out.length, 50);
    let q = base().limit(size);
    if (last) q = q.startAfter(last);
    const snap = await q.get(getOpts);
    out.push(...live(snap));
    if (snap.docs.length < size) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return out.slice(0, max);
}

async function fsGet(id) {
  const snap = await db.collection('documents').doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

// C-7 (v3.29.0): `baseContent` is the body this editor last loaded or saved. An
// update runs in a transaction and is refused (error code 'edmd/conflict') when
// the stored body differs from both baseContent and the new content, i.e.
// somebody else changed it. Transactions need the server, so when the client
// is offline the plain queued update is used instead (the old behaviour).
async function fsPut(id, title, content, isNew, parentId, baseContent) {
  const now = firebase.firestore.FieldValue.serverTimestamp();
  const ref = db.collection('documents').doc(id);
  if (isNew) {
    const data = { userId: auth.currentUser.uid, title, content, createdAt: now, updatedAt: now };
    if (parentId) data.parentId = parentId;
    await ref.set(data);
    return;
  }
  if (baseContent === undefined || baseContent === null) {
    await ref.update({ title, content, updatedAt: now });
    return;
  }
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const remote = snap.data().content || '';
        if (remote !== baseContent && remote !== content) {
          const e = new Error('Document changed elsewhere');
          e.code = 'edmd/conflict';
          e.remote = { id, ...snap.data() };
          throw e;
        }
      }
      tx.update(ref, { title, content, updatedAt: now });
    });
  } catch (err) {
    if (err && (err.code === 'unavailable' || err.code === 'deadline-exceeded')) {
      await ref.update({ title, content, updatedAt: now });
      return;
    }
    throw err;
  }
}

async function fsUpdateParent(id, parentId) {
  const val = parentId || firebase.firestore.FieldValue.delete();
  await db.collection('documents').doc(id).update({ parentId: val });
}

async function fsDelete(id) {
  await db.collection('documents').doc(id).delete();
}

async function fsTrashDoc(id) {
  const now = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection('documents').doc(id).update({ isDeleted: true, deletedAt: now });
}

async function fsRestoreDoc(id) {
  await db.collection('documents').doc(id).update({
    isDeleted: firebase.firestore.FieldValue.delete(),
    deletedAt: firebase.firestore.FieldValue.delete(),
  });
}

async function fsGetTrashed() {
  // C-1 (v3.28.0): equality-only query (userId + isDeleted), so Firestore serves
  // it from the automatic single-field indexes with no composite index, and only
  // trashed documents are read. If the query is ever rejected, fall back to the
  // old full read so Trash keeps working.
  let docs;
  try {
    const snap = await db.collection('documents')
      .where('userId', '==', auth.currentUser.uid)
      .where('isDeleted', '==', true)
      .get();
    docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn('trash query failed, falling back to full read:', err);
    const snap = await db.collection('documents')
      .where('userId', '==', auth.currentUser.uid)
      .orderBy('updatedAt', 'desc')
      .get();
    docs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.isDeleted);
  }
  return docs.sort((a, b) => tsToMs(b.deletedAt) - tsToMs(a.deletedAt));
}

async function fsUpdateTags(id, tags) {
  await db.collection('documents').doc(id).update({ tags });
}

// ── Folders (v3.27.0) ─────────────────────────────────────────────────────────
// A folder is an ordinary document with type: 'folder' and empty content.
// Documents with no `type` field are plain documents, so no migration is needed.
async function fsCreateFolder(id, name, parentId) {
  const now = firebase.firestore.FieldValue.serverTimestamp();
  const data = {
    userId: auth.currentUser.uid, title: name, content: '', type: 'folder',
    createdAt: now, updatedAt: now,
  };
  if (parentId) data.parentId = parentId;
  await db.collection('documents').doc(id).set(data);
}

async function fsRename(id, title) {
  await db.collection('documents').doc(id).update({
    title, updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

// Firestore batches cap at 500 writes; stay well under.
async function fsBatchChunks(ids, fn) {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    ids.slice(i, i + 400).forEach(id => fn(batch, db.collection('documents').doc(id), id));
    await batch.commit();
  }
}

// Trash a folder together with everything inside it. Descendants are tagged
// with trashedBy so Restore / Delete permanently on the folder act on exactly
// the items that went in with it.
async function fsTrashMany(ids, rootId) {
  const now = firebase.firestore.FieldValue.serverTimestamp();
  await fsBatchChunks(ids, (batch, ref, id) => {
    const data = { isDeleted: true, deletedAt: now };
    if (id !== rootId) data.trashedBy = rootId;
    batch.update(ref, data);
  });
}

async function fsRestoreMany(ids) {
  const del = firebase.firestore.FieldValue.delete();
  await fsBatchChunks(ids, (batch, ref) => {
    batch.update(ref, { isDeleted: del, deletedAt: del, trashedBy: del });
  });
}

async function fsDeleteMany(ids) {
  await fsBatchChunks(ids, (batch, ref) => batch.delete(ref));
}

// ── Auth ──────────────────────────────────────────────────────────────────────
let authMode = 'signin';

function showAuthOverlay() {
  document.getElementById('auth-overlay').classList.remove('hidden');
  document.getElementById('signout-btn').style.display = 'none';
  document.getElementById('sidebar-user-label').textContent = 'EM-DASH MD';
  document.getElementById('sidebar-user-email').textContent = '';
  document.getElementById('sidebar-account-menu').classList.remove('open');
}

function hideAuthOverlay() {
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('signout-btn').style.display = '';
  const u = auth.currentUser;
  if (u) {
    document.getElementById('sidebar-user-label').textContent = u.email.split('@')[0];
    document.getElementById('sidebar-user-email').textContent = u.email;
  }
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

// C-9 (v3.29.0): nothing from the previous user may stay in the DOM or in the
// browser's offline cache after sign-out.
function clearPrivateUi() {
  ['doc-browser-list', 'kanban-board', 'trash-list', 'move-modal-list', 'sidebar-list'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  ['doc-browser-modal', 'trash-modal', 'move-modal', 'new-modal'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  });
  const kb = document.getElementById('kanban-panel');
  if (kb) kb.classList.add('hidden');
  _mermaidCache.clear();
}

// Terminate Firestore, wipe the IndexedDB cache, then reload so the page
// restarts with a clean client. A failure to clear (for example another tab
// still has the app open) is logged and the reload still happens.
async function purgeLocalDataAndReload() {
  try { await db.terminate(); } catch (err) { console.warn('terminate failed:', err); }
  try { await db.clearPersistence(); } catch (err) { console.warn('clearPersistence failed:', err); }
  location.reload();
}

document.getElementById('signout-btn').addEventListener('click', async () => {
  if (isDirty) await performSave(true);
  await auth.signOut();
  await purgeLocalDataAndReload();
});

// ── Sidebar account menu ──────────────────────────────────────────────────────
document.getElementById('sidebar-account-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('sidebar-account-menu').classList.toggle('open');
});
document.getElementById('sidebar-signout-item').addEventListener('click', async () => {
  document.getElementById('sidebar-account-menu').classList.remove('open');
  document.getElementById('signout-btn').click();
});
document.addEventListener('click', () => {
  document.getElementById('sidebar-account-menu').classList.remove('open');
});

// ── Delete account ────────────────────────────────────────────────────────────
async function openDeleteAccountModal() {
  if (!auth.currentUser) return;
  document.getElementById('hdr-more-menu').classList.remove('open');
  const modal       = document.getElementById('delete-account-modal');
  const confirmInput = document.getElementById('delete-account-confirm-input');
  const pwWrap       = document.getElementById('delete-account-password-wrap');
  const confirmBtn   = document.getElementById('delete-account-confirm-btn');
  const errorEl      = document.getElementById('delete-account-error');
  const countEl      = document.getElementById('delete-account-doc-count');

  confirmInput.value = '';
  document.getElementById('delete-account-password-input').value = '';
  errorEl.style.display = 'none';
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Delete My Account';

  const isPasswordUser = (auth.currentUser.providerData || []).some(p => p.providerId === 'password');
  pwWrap.style.display = isPasswordUser ? '' : 'none';

  countEl.textContent = '…';
  modal.classList.add('open');
  confirmInput.focus();

  try {
    const snap = await db.collection('documents').where('userId', '==', auth.currentUser.uid).get();
    countEl.textContent = String(snap.size);
  } catch (err) {
    countEl.textContent = 'your';
  }
}

function closeDeleteAccountModal() {
  if (deletionInProgress) return;
  document.getElementById('delete-account-modal').classList.remove('open');
}

document.getElementById('hdr-delete-account-btn').addEventListener('click', openDeleteAccountModal);
document.getElementById('delete-account-cancel').addEventListener('click', closeDeleteAccountModal);

document.getElementById('delete-account-confirm-input').addEventListener('input', (e) => {
  document.getElementById('delete-account-confirm-btn').disabled = e.target.value !== 'DELETE';
});

document.getElementById('delete-account-confirm-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDeleteAccountModal();
});

async function deleteAllUserDocs(uid) {
  // Firestore batches cap at 500 writes; loop in case the library ever exceeds that.
  while (true) {
    const snap = await db.collection('documents').where('userId', '==', uid).limit(450).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 450) return;
  }
}

document.getElementById('delete-account-confirm-btn').addEventListener('click', async () => {
  const confirmInput = document.getElementById('delete-account-confirm-input');
  const errorEl      = document.getElementById('delete-account-error');
  const confirmBtn   = document.getElementById('delete-account-confirm-btn');
  const cancelBtn    = document.getElementById('delete-account-cancel');
  const pwInput      = document.getElementById('delete-account-password-input');

  errorEl.style.display = 'none';
  if (confirmInput.value !== 'DELETE') return;

  const user = auth.currentUser;
  if (!user) return;

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Deleting…';
  cancelBtn.disabled = true;
  deletionInProgress = true;

  const resetUI = () => {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Delete My Account';
    cancelBtn.disabled = false;
    deletionInProgress = false;
  };

  // Step 1: re-authenticate (separate catch so reauth errors don't imply data was touched)
  try {
    const isPasswordUser = (user.providerData || []).some(p => p.providerId === 'password');
    if (isPasswordUser) {
      if (!pwInput.value) throw { code: 'auth/missing-password' };
      const cred = firebase.auth.EmailAuthProvider.credential(user.email, pwInput.value);
      await user.reauthenticateWithCredential(cred);
    } else {
      await user.reauthenticateWithPopup(new firebase.auth.GoogleAuthProvider());
    }
  } catch (reauthErr) {
    const msg = {
      'auth/wrong-password':         'Incorrect password.',
      'auth/missing-password':       'Enter your password to confirm.',
      'auth/requires-recent-login':  'Please sign out, sign back in, and try again.',
      'auth/popup-closed-by-user':   'Re-authentication was cancelled.',
      'auth/network-request-failed': 'Network error — check your connection.',
    }[reauthErr.code] || 'Could not verify your identity. Please try again.';
    errorEl.textContent = msg;
    errorEl.style.display = '';
    resetUI();
    return;
  }

  // Step 2: delete documents then account
  try {
    await deleteAllUserDocs(user.uid);
    await user.delete();
    // user.delete() fires onAuthStateChanged(null), which returns the app to the sign-in screen.
    deletionInProgress = false;
    closeDeleteAccountModal();
    showToast('Account deleted');
    await purgeLocalDataAndReload();
  } catch (deleteErr) {
    errorEl.textContent = 'Could not fully delete account. It is safe to retry — any already-deleted documents will not be re-created.';
    errorEl.style.display = '';
    resetUI();
  }
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
let pendingAuthError = '';
let deletionInProgress = false;

auth.onAuthStateChanged(async (user) => {
  if (user) {
    if (!user.email || !user.email.endsWith('@michaelson-clark.com')) {
      pendingAuthError = 'Access is restricted to @michaelson-clark.com accounts.';
      await auth.signOut();
      setAuthLoading(false);
      return;
    }
    // C-13 (v3.29.0): the Firestore rules require a verified email, so an
    // unverified password account would only see permission-denied. Send the
    // verification mail and explain, instead of booting into a broken app.
    const usesPassword = (user.providerData || []).some(p => p.providerId === 'password');
    if (usesPassword && !user.emailVerified) {
      try { await user.sendEmailVerification(); } catch (_) { /* rate limited: the earlier mail still works */ }
      pendingAuthError = 'Verify your email first. We sent a link to ' + user.email + '. Open it, then sign in again.';
      await auth.signOut();
      setAuthLoading(false);
      return;
    }
    hideAuthOverlay();
    setAuthLoading(false);
    if (!appBooted) {
      appBooted = true;
      bootApp();
    }
  } else {
    showAuthOverlay();
    setAuthModeUI('signin'); // clears any existing error via setAuthError('')
    if (pendingAuthError) { setAuthError(pendingAuthError); pendingAuthError = ''; }
    clearTimeout(autoSaveTimer);
    currentDocIsNew = true;
    currentDocId = null;
    isDirty      = false;
    editor.value = '';
    setTitle('New Document');
    renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
    document.getElementById('drive-delete-btn').style.display = 'none';
    appBooted = false;
    currentParentId = null;
    currentBaseContent = undefined;
    _conflictHold = null;
    resetSidebarState();
    clearPrivateUi();
    loadReadmePreview();
  }
});

// ── State ─────────────────────────────────────────────────────────────────────
let currentDocId   = null;
let currentDocIsNew = true; // true until the doc has been written to Firestore at least once
let currentTitle   = 'New Document';
let currentParentId = null; // parentId of the currently open doc (null = root)
let isDirty        = false;
let autoSaveTimer  = null;
let previewEditing = false;
let _lpMode        = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const editor         = document.getElementById('editor');
const previewInner   = document.getElementById('preview-inner');
const previewPane    = document.getElementById('preview-pane');
const lineNumbers    = document.getElementById('line-numbers');
const tbTitle        = document.getElementById('tb-title');
const titleInput     = document.getElementById('title-input');
const toast          = document.getElementById('toast');

// ── Marked setup ─────────────────────────────────────────────────────────────
if (window.mermaid) {
  // C-8 (v3.29.0): 'strict' encodes labels and disables click handlers.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
}

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
        if (lang === 'mermaid') {
          return `<div class="mermaid-pending" data-src="${esc(text)}">${esc(text)}</div>`;
        }
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
  if (_lpMode) { lpRender(); return; }
  if (previewEditing) return;
  if (window.marked && window.DOMPurify) {
    try {
      previewInner.innerHTML = DOMPurify.sanitize(marked.parse(editor.value || ''));
      addCodeCopyButtons();
      renderMermaidDiagrams();
    } catch (e) {
      console.error('Preview render failed:', e);
    }
  }
}

let _mermaidCounter = 0;
// C-8 (v3.29.0): rendered SVG is sanitized before it touches the DOM (fail
// closed without DOMPurify) and cached by diagram source, so an unchanged
// diagram is not re-rendered on every preview refresh.
const _mermaidCache = new Map();
const MERMAID_CACHE_MAX = 50;
// v3.29.1: Mermaid builds a throwaway element from label text before its own
// cleanup runs, so a label like <img src=x onerror=...> tries to fire its inline
// handler during render (the CSP blocks it, but strict mode alone does not
// prevent it). Remove HTML tags that are not plain formatting tags with no
// attributes from the diagram text BEFORE Mermaid sees it. Arrows and
// annotations such as -->, <|--, <<interface>> are not tags and are untouched.
const MERMAID_SAFE_TAGS = new Set(['br', 'b', 'i', 'u', 's', 'em', 'strong', 'sub', 'sup', 'small']);
function sanitizeMermaidSource(src) {
  return String(src).replace(/<\s*(\/?)\s*([a-zA-Z][\w:-]*)([^<>]*)>/g, (m, _close, name, rest, offset, whole) => {
    if (offset > 0 && whole[offset - 1] === '<') return m;           // <<interface>>
    const bare = /^\s*\/?\s*$/.test(rest);
    // A space, not nothing: a label that held only a tag must not become empty (C[""] is a Mermaid syntax error).
    return (MERMAID_SAFE_TAGS.has(name.toLowerCase()) && bare) ? m : ' ';
  });
}
function sanitizeMermaidSvg(svg) {
  if (!window.DOMPurify) return '';
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject'],
  });
}
function mermaidWrap(src, svg) {
  const wrap = document.createElement('div');
  wrap.className = 'mermaid-diagram';
  wrap.dataset.src = src;
  wrap.innerHTML = svg;
  return wrap;
}
async function renderMermaidDiagrams() {
  if (!window.mermaid) return;
  const blocks = previewInner.querySelectorAll('.mermaid-pending');
  for (const block of blocks) {
    const src = block.textContent;
    if (_mermaidCache.has(src)) {
      block.replaceWith(mermaidWrap(src, _mermaidCache.get(src)));
      continue;
    }
    const id  = 'mmd-' + (++_mermaidCounter);
    try {
      const { svg } = await mermaid.render(id, sanitizeMermaidSource(src));
      const clean = sanitizeMermaidSvg(svg);
      if (!clean) throw new Error('diagram could not be sanitized');
      if (_mermaidCache.size >= MERMAID_CACHE_MAX) _mermaidCache.delete(_mermaidCache.keys().next().value);
      _mermaidCache.set(src, clean);
      block.replaceWith(mermaidWrap(src, clean));
    } catch (e) {
      block.className = 'mermaid-error';
      block.dataset.src = src;
      block.textContent = 'Diagram error: ' + (e.message || e);
    }
  }
}

// ── Copy-to-clipboard button on fenced code blocks ────────────────────────────
const COPY_ICON_SVG  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function addCodeCopyButtons() {
  previewInner.querySelectorAll('pre').forEach((pre) => {
    if (!pre.querySelector('code')) return;
    if (pre.closest('.code-block')) return; // already wrapped
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    wrap.contentEditable = 'false';
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

// ── Live Preview — Typora-style block editing ─────────────────────────────────
function lpRender() {
  if (!window.marked || !window.DOMPurify) return;
  if (previewInner.querySelector('.lp-active')) return;

  const md = editor.value || '';
  let tokens;
  try { tokens = marked.lexer(md); } catch (e) { return; }

  const blocks = tokens.filter(t => t.type !== 'space');

  // Fall back to regular rendering for very large documents
  if (blocks.length > 60) {
    previewInner.innerHTML = DOMPurify.sanitize(marked.parse(md));
    addCodeCopyButtons();
    renderMermaidDiagrams();
    return;
  }

  previewInner.innerHTML = '';

  if (!blocks.length) {
    const ph = document.createElement('p');
    ph.className = 'lp-placeholder';
    ph.textContent = 'Start writing…';
    previewInner.appendChild(ph);
    ph.addEventListener('click', () => {
      ph.remove();
      lpNewBlock(null);
    });
    return;
  }

  blocks.forEach((token) => {
    const div = document.createElement('div');
    div.className = 'lp-block';
    div.dataset.md = token.raw.trim();
    try {
      div.innerHTML = DOMPurify.sanitize(marked.parse(token.raw));
    } catch (e) {
      div.textContent = token.raw;
    }
    div.onclick = () => lpActivate(div);
    previewInner.appendChild(div);
  });

  addCodeCopyButtons();
  renderMermaidDiagrams();
}

function lpActivate(blockEl) {
  if (blockEl.classList.contains('lp-active')) return;

  const current = previewInner.querySelector('.lp-active');
  if (current) {
    const ta = current.querySelector('textarea.lp-edit-ta');
    if (ta) lpDeactivate(current, ta);
  }

  const rawMd = (blockEl.dataset.md || '').trim();
  blockEl.classList.add('lp-active');
  blockEl.innerHTML = '';

  const ta = document.createElement('textarea');
  ta.className = 'lp-edit-ta';
  ta.value = rawMd;
  blockEl.appendChild(ta);

  requestAnimationFrame(() => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  });

  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    blockEl.dataset.md = ta.value;
    lpSyncToEditor();
    clearTimeout(ta._lpTimer);
    ta._lpTimer = setTimeout(() => lpLiveRender(blockEl, ta), 600);
  });

  ta.addEventListener('keydown', (e) => {
    clearTimeout(ta._lpTimer);
    if (e.key === 'Escape') { e.preventDefault(); ta.blur(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !ta.value.includes('\n')) {
      e.preventDefault();
      blockEl.dataset.md = ta.value;
      lpSyncToEditor();
      ta.blur();
      lpFocusNext(blockEl);
    }
  });

  ta.addEventListener('blur', () => {
    clearTimeout(ta._lpTimer);
    if (ta._lpLiveRendered) return;
    lpDeactivate(blockEl, ta);
  });
}

function lpDeactivate(blockEl, ta) {
  const newMd = ta.value.trim();
  blockEl.dataset.md = newMd;
  blockEl.classList.remove('lp-active');

  if (!newMd) {
    blockEl.remove();
    lpSyncToEditor();
    return;
  }

  try {
    blockEl.innerHTML = DOMPurify.sanitize(marked.parse(newMd));
  } catch (e) {
    blockEl.textContent = newMd;
  }
  blockEl.onclick = () => lpActivate(blockEl);

  // Scope post-render helpers to this block only to avoid re-wrapping
  // pre elements in other blocks that were already processed by lpRender().
  blockEl.querySelectorAll('pre').forEach((pre) => {
    if (!pre.querySelector('code') || pre.closest('.code-block')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    wrap.contentEditable = 'false';
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

  lpSyncToEditor();
}

function lpLiveRender(blockEl, ta) {
  ta._lpLiveRendered = true;
  const md = ta.value.trim();
  blockEl.dataset.md = md;
  blockEl.classList.remove('lp-active');

  if (!md) {
    blockEl.remove();
    lpSyncToEditor();
    return;
  }

  try {
    blockEl.innerHTML = DOMPurify.sanitize(marked.parse(md));
  } catch (e) {
    blockEl.textContent = md;
  }
  blockEl.onclick = () => lpActivate(blockEl);

  blockEl.querySelectorAll('pre').forEach((pre) => {
    if (!pre.querySelector('code') || pre.closest('.code-block')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    wrap.contentEditable = 'false';
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

function lpFocusNext(blockEl) {
  const next = blockEl.nextElementSibling;
  if (next && next.classList.contains('lp-block')) {
    lpActivate(next);
  } else {
    lpNewBlock(blockEl);
  }
}

function lpNewBlock(afterEl) {
  const newBlock = document.createElement('div');
  newBlock.className = 'lp-block';
  newBlock.dataset.md = '';
  newBlock.onclick = () => lpActivate(newBlock);
  if (afterEl) {
    afterEl.after(newBlock);
  } else {
    previewInner.appendChild(newBlock);
  }
  lpActivate(newBlock);
}

function lpSyncToEditor() {
  const blocks = previewInner.querySelectorAll('.lp-block');
  const parts = [];
  blocks.forEach(b => {
    const md = (b.dataset.md || '').trim();
    if (md) parts.push(md);
  });
  const newMd = parts.join('\n\n') + (parts.length ? '\n' : '');
  if (newMd !== editor.value) {
    editor.value = newMd;
    isDirty = true;
    scheduleAutoSave();
    updateStats();
    updateLineNumbers();
  }
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
let wordGoal = 0;
try { wordGoal = parseInt(localStorage.getItem('md-word-goal') || '0', 10) || 0; } catch(_) {}

function updateStats() {
  const text  = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const wc    = document.getElementById('word-count');
  if (wordGoal > 0) {
    wc.textContent = `${words} / ${wordGoal} words`;
    wc.classList.toggle('goal-met', words >= wordGoal);
  } else {
    wc.textContent = `Words: ${words}`;
    wc.classList.remove('goal-met');
  }
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
function showToast(msg, duration = 2500, action = null) {
  toast.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  toast.appendChild(span);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.fn();
      clearTimeout(toastTimer);
      toast.classList.remove('show');
    });
    toast.appendChild(btn);
  }
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
function startRename() {
  titleInput.value = currentTitle;
  tbTitle.style.display = 'none';
  titleInput.style.display = 'inline-block';
  titleInput.focus();
  titleInput.select();
}

tbTitle.addEventListener('click', startRename);

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

// Saves run one at a time. Two overlapping saves of a brand-new document used to
// both call set() and the second overwrote createdAt and any field written in
// between; queued, the second one is an update.
let _saveChain = Promise.resolve();
let _conflictHold = null;   // { id, remote } while a save is paused by a conflict
let currentBaseContent;     // body last loaded or saved for the open document

function performSave(silent = false) {
  const run = () => doSave(silent);
  _saveChain = _saveChain.then(run, run);
  return _saveChain;
}

function handleSaveConflict(id, remote, silent) {
  _conflictHold = { id, remote };
  showSaveStatus('Conflict');
  const loadTheirs = () => { _conflictHold = null; applyDoc(remote); };
  if (!silent) {
    const overwrite = confirm(
      'This document was changed somewhere else since you opened it.\n\n' +
      'OK: overwrite it with what is in this editor.\n' +
      'Cancel: keep your text here, unsaved.');
    if (overwrite) {
      _conflictHold = null;
      currentBaseContent = remote.content || '';
      performSave(false);
      return;
    }
  }
  showToast('Changed on another device. Saving is paused for this document.', 12000, { label: 'Load their version', fn: loadTheirs });
}

async function doSave(silent = false) {
  if (!auth.currentUser) return;
  if (silent && _conflictHold && _conflictHold.id === currentDocId) return;
  const content = editor.value;
  const title   = currentTitle || 'Untitled';
  showSaveStatus('Saving…');
  try {
    if (!currentDocId) { currentDocId = crypto.randomUUID(); currentDocIsNew = true; }
    const savedId = currentDocId, savedParent = currentParentId;
    await fsPut(savedId, title, content, currentDocIsNew, savedParent, currentBaseContent);
    currentDocIsNew = false;
    currentBaseContent = content;
    // C-7 (partial): only clear dirty if nothing was typed while the save ran.
    if (editor.value === content) isDirty = false;
    showSaveStatus('Saved');
    // C-1 (v3.28.0): update the sidebar locally instead of re-reading 300 documents.
    syncSidebarAfterSave(savedId, title, content, savedParent);
  } catch (err) {
    if (err && err.code === 'edmd/conflict') { handleSaveConflict(err.remote.id, err.remote, silent); return; }
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
  currentParentId = null;
  isDirty      = false;
  editor.value = '';
  let name = document.getElementById('new-filename').value.trim() || 'untitled.md';
  if (!name.includes('.')) name += '.md';
  setTitle(name);
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  document.getElementById('drive-delete-btn').style.display = 'none';
  closeNewModal();
  updateSidebarActive();
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
  document.getElementById('doc-browser-tag-filter').value = '';

  // Stale-while-revalidate: kick off the server fetch immediately so it runs
  // in parallel with the cache paint, then swap in the fresh result once ready.
  const serverFetch = fsGetAll(300);
  const paintedFromCache = await renderDocBrowserList('', { source: 'cache' });
  await renderDocBrowserList('', { skipLoadingState: paintedFromCache, prefetched: serverFetch });

  document.getElementById('doc-browser-search').focus();
}

function closeDocBrowser() {
  document.getElementById('doc-browser-modal').classList.remove('open');
}

// Finder-style column sort: { field: 'name' | 'words' | 'modified', dir: 'asc' | 'desc' }
let docBrowserSort = { field: 'modified', dir: 'desc' };
let _docBrowserRenderGen = 0;

function wordCount(d) {
  const content = (d.content || '').trim();
  return content ? content.split(/\s+/).length : 0;
}

function sortDocs(docs, sort) {
  const { field, dir } = sort;
  const sign = dir === 'asc' ? 1 : -1;
  // Pre-compute keys once per doc so tsToMs/wordCount are never called inside
  // the comparator (tsToMs returns Date.now() for null, giving an unstable key
  // if called repeatedly; wordCount does a full string split on every call).
  const keyed = docs.map(d => ({
    d,
    k: field === 'name'  ? (d.title || '') :
       field === 'words' ? wordCount(d) :
       tsToMs(d.updatedAt)
  }));
  keyed.sort((a, b) => {
    const cmp = typeof a.k === 'string' ? a.k.localeCompare(b.k) : a.k - b.k;
    return cmp * sign;
  });
  return keyed.map(({ d }) => d);
}

function updateDocBrowserSortHeader() {
  document.querySelectorAll('#doc-browser-modal .file-col-sortable').forEach(el => {
    const isActive = el.dataset.field === docBrowserSort.field;
    el.classList.toggle('active', isActive);
    const arrow = el.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = isActive ? (docBrowserSort.dir === 'asc' ? '▲' : '▼') : '';
  });
}

const EDIT_SVG = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

// Returns safe HTML snippet (with <mark>) for a query match inside content.
function getSnippet(content, query) {
  const lower = content.toLowerCase();
  const q     = query.toLowerCase();
  const idx   = lower.indexOf(q);
  if (idx === -1) return null;
  const PAD    = 60;
  const start  = Math.max(0, idx - PAD);
  const end    = Math.min(content.length, idx + q.length + PAD);
  const before = content.slice(start, idx).replace(/[\r\n]+/g, ' ');
  const match  = content.slice(idx, idx + q.length);
  const after  = content.slice(idx + q.length, end).replace(/[\r\n]+/g, ' ');
  return (start > 0 ? '…' : '') + esc(before) + '<mark>' + esc(match) + '</mark>' + esc(after) + (end < content.length ? '…' : '');
}

async function renderDocBrowserList(query, opts) {
  const gen = ++_docBrowserRenderGen;
  const list = document.getElementById('doc-browser-list');
  const fromCacheOnly = opts && opts.source === 'cache';
  if (!fromCacheOnly && !(opts && opts.skipLoadingState)) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">Loading…</div>';
  }
  let docs;
  try {
    // Soft cap so the doc browser can't blow up on read cost/bandwidth as
    // the library grows; a real fix would split out a lightweight metadata
    // collection instead of always fetching full content.
    docs = opts && opts.prefetched
      ? await opts.prefetched
      : await fsGetAll(300, fromCacheOnly ? { source: 'cache' } : undefined);
  } catch (err) {
    if (fromCacheOnly) return false; // nothing cached yet — server fetch will do first paint
    if (gen !== _docBrowserRenderGen) return false; // a newer render supersedes this one
    // Preserve a cache-painted list rather than replacing it with an error
    if (list.querySelector('.file-item')) {
      showToast('Could not refresh — showing cached list');
    } else {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">Error loading documents</div>';
    }
    console.error('renderDocBrowserList:', err);
    return false;
  }
  if (fromCacheOnly && docs.length === 0) return false; // empty cache — let the server response do the first paint
  if (gen !== _docBrowserRenderGen) return false; // search/sort changed while fetching

  // Rebuild tag filter options, preserving current selection
  const allTags = [...new Set(docs.flatMap(d => d.tags || []))].sort();
  const tagFilter = document.getElementById('doc-browser-tag-filter');
  const prevTag = tagFilter.value;
  tagFilter.innerHTML = '<option value="">All tags</option>' +
    allTags.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  if (allTags.includes(prevTag)) tagFilter.value = prevTag;

  const total = docs.length;

  if (query) {
    const q = query.toLowerCase();
    docs = docs.filter(d =>
      (d.title || '').toLowerCase().includes(q) ||
      (d.content || '').toLowerCase().includes(q) ||
      (d.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }

  const selectedTag = tagFilter.value;
  if (selectedTag) {
    docs = docs.filter(d => (d.tags || []).includes(selectedTag));
  }

  docs = sortDocs(docs, docBrowserSort);
  updateDocBrowserSortHeader();

  const countEl = document.getElementById('doc-browser-count');
  if ((query || selectedTag) && docs.length !== total) {
    countEl.textContent = `${docs.length} of ${total} document${total !== 1 ? 's' : ''}`;
  } else {
    countEl.textContent = `${total} document${total !== 1 ? 's' : ''}`;
  }

  if (!docs.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">' +
      (query || selectedTag ? 'No matching documents' : 'No saved documents yet') + '</div>';
    return true;
  }

  const fmtDate = ts => new Date(tsToMs(ts)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  const activeQuery = (query || '').toLowerCase().trim();

  list.innerHTML = docs.map(d => {
    const modDate     = fmtDate(d.updatedAt);
    const createdDate = d.createdAt ? fmtDate(d.createdAt) : null;
    const words       = wordCount(d);
    const extMatch    = (d.title || '').match(/\.([a-z0-9]+)$/i);
    const docType     = d.type === 'folder' ? 'DIR' : (extMatch ? extMatch[1].toUpperCase().slice(0, 4) : 'MD');
    const tags        = d.tags || [];
    const tagHtml     = tags.map(t => `<span class="file-tag">${esc(t)}</span>`).join('');
    const modifiedTitle = createdDate && createdDate !== modDate ? ` title="Created ${esc(createdDate)}"` : '';

    // Show a content snippet only when the query matched in body (not title/tag)
    let snippetHtml = '';
    if (activeQuery) {
      const titleHit = (d.title || '').toLowerCase().includes(activeQuery);
      const tagHit   = tags.some(t => t.toLowerCase().includes(activeQuery));
      if (!titleHit && !tagHit) {
        const s = getSnippet(d.content || '', activeQuery);
        if (s) snippetHtml = `<span class="file-snippet">${s}</span>`;
      }
    }

    return `<div class="file-item" data-id="${esc(d.id)}" data-tags="${esc(JSON.stringify(tags))}">
      <div class="file-col-name">
        <div class="file-name-row">
          <div class="file-type-badge">${esc(docType)}</div>
          <span class="file-name" title="${esc(d.title || 'Untitled')}">${esc(d.title || 'Untitled')}</span>
        </div>
        ${snippetHtml}
      </div>
      <div class="file-col-tags">
        <div class="file-tags-wrap">
          ${tagHtml}<button class="file-tag-btn" data-id="${esc(d.id)}" title="Edit tags">${tags.length ? EDIT_SVG : '+ tag'}</button>
        </div>
      </div>
      <div class="file-col-words">${d.type === 'folder' ? '' : words.toLocaleString()}</div>
      <div class="file-col-modified"${modifiedTitle}>${esc(modDate)}</div>
    </div>`;
  }).join('');

  const docMap = new Map(docs.map(d => [d.id, d]));
  list.querySelectorAll('.file-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.file-tag-btn, .file-tag-input')) return;
      if (kanbanPickTarget) { loadDoc(el.dataset.id); return; }
      const doc = docMap.get(el.dataset.id);
      // Folders never replace the editor, so no unsaved-changes prompt for them.
      if (!(doc && doc.type === 'folder') && isDirty && !confirm('You have unsaved changes. Open this document anyway?')) return;
      if (doc) applyDoc(doc); else loadDoc(el.dataset.id);
    });
  });

  list.querySelectorAll('.file-tag-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = btn.closest('.file-item');
      const wrap = item.querySelector('.file-tags-wrap');
      const docId = btn.dataset.id;
      let currentTags;
      try { currentTags = JSON.parse(item.dataset.tags || '[]'); } catch (_) { currentTags = []; }

      wrap.innerHTML = `<input class="file-tag-input" value="${esc(currentTags.join(', '))}" placeholder="tag1, tag2…">`;
      const input = wrap.querySelector('.file-tag-input');
      input.focus();
      if (currentTags.length) input.select();

      let done = false;
      let cancelled = false;

      const save = async () => {
        if (done) return;
        done = true;
        const tags = input.value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        try { await fsUpdateTags(docId, tags); } catch (err) { showToast('Tag update failed'); console.error(err); }
        renderDocBrowserList(document.getElementById('doc-browser-search').value, { skipLoadingState: true });
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); save(); }
        if (e.key === 'Escape') { cancelled = true; e.stopPropagation(); renderDocBrowserList(document.getElementById('doc-browser-search').value, { skipLoadingState: true }); }
      });
      input.addEventListener('blur', () => { if (!cancelled) setTimeout(save, 100); });
    });
  });

  return true;
}

function applyDoc(doc) {
  // A folder has no body: reveal it in the sidebar instead of opening it.
  if (doc && doc.type === 'folder') { closeDocBrowser(); revealInSidebar(doc.id); return; }
  clearTimeout(autoSaveTimer);
  currentDocId = doc.id;
  currentDocIsNew = false;
  currentParentId = doc.parentId || null;
  editor.value = doc.content || '';
  currentBaseContent = doc.content || '';
  _conflictHold = null;
  setTitle(doc.title || 'Untitled');
  isDirty = false;
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  document.getElementById('drive-delete-btn').style.display = 'inline-flex';
  closeDocBrowser();
  updateSidebarActive();
  // On mobile, close sidebar after opening a doc
  if (window.innerWidth <= 600) closeSidebar();
  editor.focus();
}

async function loadDoc(id) {
  const knownDoc = _sidebarDocs.find(d => d.id === id);
  if (knownDoc && knownDoc.type === 'folder') {
    if (kanbanPickTarget) { showToast("Folders can't be added to the board"); return; }
    closeDocBrowser();
    revealInSidebar(id);
    return;
  }
  // When the doc browser is being used as a Kanban picker, assign the doc to
  // the chosen column instead of opening it. (Formerly a separate wrapper that
  // redeclared loadDoc; hoisting made it call itself forever. Fixed v3.21.1.)
  if (kanbanPickTarget) {
    const status = kanbanPickTarget;
    kanbanPickTarget = null;
    closeDocBrowser();
    await fsUpdateKanbanStatus(id, status);
    renderKanban();
    return;
  }
  if (isDirty && !confirm('You have unsaved changes. Open this document anyway?')) return;
  const doc = await fsGet(id);
  if (!doc) { showToast('Document not found'); return; }
  applyDoc(doc);
}

async function loadMostRecent() {
  try {
    // Only need the single newest doc here — no reason to pull every
    // document's full content just to find it.
    // A few extra rows so a freshly created or renamed folder (which sorts
    // newest) is skipped: folders are never opened in the editor.
    const docs = (await fsGetAll(10)).filter(d => d.type !== 'folder');
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

// ── Duplicate ─────────────────────────────────────────────────────────────────
async function duplicateCurrentDoc() {
  if (!auth.currentUser) return;
  const newId    = crypto.randomUUID();
  const base     = (currentTitle || 'untitled').replace(/\.(md|txt)$/i, '');
  const newTitle = base + ' copy.md';
  const content  = editor.value;
  try {
    await fsPut(newId, newTitle, content, true);
    currentDocId    = newId;
    currentDocIsNew = false;
    currentBaseContent = content;
    _conflictHold   = null;
    isDirty         = false;
    setTitle(newTitle);
    document.getElementById('drive-delete-btn').style.display = 'inline-flex';
    showToast(`Duplicated as "${newTitle}"`);
  } catch (err) {
    showToast('Duplicate failed');
    console.error('duplicateCurrentDoc:', err);
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function deleteCurrentDoc() {
  if (!currentDocId) return;

  const deletedId       = currentDocId;
  const deletedTitle    = currentTitle;
  const deletedContent  = editor.value;
  const deletedParentId = currentParentId;

  clearTimeout(autoSaveTimer);
  currentDocId    = null;
  currentDocIsNew = true;
  currentParentId = null;
  isDirty         = false;
  editor.value    = '';
  setTitle('New Document');
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  document.getElementById('drive-delete-btn').style.display = 'none';

  let undone = false;
  showToast(`"${deletedTitle}" moved to Trash`, 5000, {
    label: 'Undo',
    fn: () => {
      undone          = true;
      currentDocId    = deletedId;
      currentDocIsNew = false;
      currentBaseContent = deletedContent;
      _conflictHold   = null;
      currentParentId = deletedParentId;
      isDirty         = false;
      editor.value    = deletedContent;
      setTitle(deletedTitle);
      renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
      document.getElementById('drive-delete-btn').style.display = 'inline-flex';
    }
  });

  // Optimistically remove from sidebar immediately; restore on undo
  _sidebarDocs = _sidebarDocs.filter(d => d.id !== deletedId);
  renderSidebarList(_sidebarDocs, _sidebarFilter);
  updateSidebarActive();

  setTimeout(async () => {
    if (undone) {
      // Undo fired — re-add to sidebar
      refreshSidebarList();
      updateSidebarActive();
      return;
    }
    try {
      await fsTrashDoc(deletedId);
    } catch (err) {
      showToast('Delete failed');
      console.error('deleteCurrentDoc:', err);
    }
  }, 5000);
}

document.getElementById('drive-delete-btn').addEventListener('click', deleteCurrentDoc);

// ── Search box clear (x) buttons ──────────────────────────────────────────────
// Empties the box, fires the normal input event so the list re-filters, and
// keeps the cursor in the box. mousedown is cancelled so the box never loses focus.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest && e.target.closest('.search-clear')) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.search-clear');
  if (!btn) return;
  const input = btn.parentElement && btn.parentElement.querySelector('input');
  if (!input) return;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
});

// ── Doc browser event wiring ──────────────────────────────────────────────────
document.getElementById('open-btn').addEventListener('click', openDocBrowser);
document.getElementById('recent-btn').addEventListener('click', openDocBrowser);
document.getElementById('doc-browser-cancel').addEventListener('click', closeDocBrowser);
document.getElementById('doc-browser-search').addEventListener('input', (e) => {
  renderDocBrowserList(e.target.value);
});
document.querySelectorAll('#doc-browser-modal .file-col-sortable').forEach(el => {
  el.addEventListener('click', () => {
    const field = el.dataset.field;
    if (docBrowserSort.field === field) {
      docBrowserSort.dir = docBrowserSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      docBrowserSort.field = field;
      docBrowserSort.dir = field === 'name' ? 'asc' : 'desc';
    }
    renderDocBrowserList(document.getElementById('doc-browser-search').value);
  });
});
document.getElementById('doc-browser-tag-filter').addEventListener('change', () => {
  renderDocBrowserList(document.getElementById('doc-browser-search').value);
});
document.getElementById('doc-browser-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('doc-browser-modal')) closeDocBrowser();
});

// Resize grip
(function () {
  const modal = document.querySelector('#doc-browser-modal .modal');
  const grip  = document.getElementById('doc-browser-resize-grip');

  const saved = lsGetJson('doc-browser-size', null);
  if (saved && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
    modal.style.width    = saved.w + 'px';
    modal.style.height   = saved.h + 'px';
    modal.style.maxWidth  = 'none';
    modal.style.maxHeight = 'none';
  }

  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = modal.offsetWidth, startH = modal.offsetHeight;

    function onMove(e) {
      const w = Math.max(480, Math.min(window.innerWidth  - 40, startW + e.clientX - startX));
      const h = Math.max(320, Math.min(window.innerHeight - 40, startH + e.clientY - startY));
      modal.style.width     = w + 'px';
      modal.style.height    = h + 'px';
      modal.style.maxWidth  = 'none';
      modal.style.maxHeight = 'none';
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      lsSet('doc-browser-size', JSON.stringify({ w: modal.offsetWidth, h: modal.offsetHeight }));
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}());

// ── Trash ─────────────────────────────────────────────────────────────────────
async function openTrashModal() {
  document.getElementById('trash-modal').classList.add('open');
  await renderTrashList();
}

function closeTrashModal() {
  document.getElementById('trash-modal').classList.remove('open');
}

async function renderTrashList() {
  const list = document.getElementById('trash-list');
  list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">Loading…</div>';
  let docs;
  try {
    docs = await fsGetTrashed();
  } catch (err) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">Error loading trash</div>';
    console.error('renderTrashList:', err);
    return;
  }

  // Items that went to Trash inside a folder are listed under that folder.
  const trashedIdSet = new Set(docs.map(d => d.id));
  const nestedCount = new Map();
  docs.forEach(d => {
    if (d.trashedBy && trashedIdSet.has(d.trashedBy)) {
      nestedCount.set(d.trashedBy, (nestedCount.get(d.trashedBy) || 0) + 1);
    }
  });
  const visibleDocs = docs.filter(d => !(d.trashedBy && trashedIdSet.has(d.trashedBy)));
  const treeIdsFor = (rootId) => [rootId, ...docs.filter(x => x.trashedBy === rootId).map(x => x.id)];

  const countEl = document.getElementById('trash-count');
  countEl.textContent = `${visibleDocs.length} deleted item${visibleDocs.length !== 1 ? 's' : ''}`;

  const emptyBtn = document.getElementById('trash-empty-btn');
  emptyBtn.style.display = docs.length ? 'inline-flex' : 'none';

  if (!docs.length) {
    list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text2)">Trash is empty</div>';
    return;
  }

  const fmtDate = ts => ts
    ? new Date(tsToMs(ts)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  list.innerHTML = visibleDocs.map(d => `
    <div class="trash-item" data-id="${esc(d.id)}">
      <span class="trash-item-name" title="${esc(d.title || 'Untitled')}">${d.type === 'folder' ? ICON_FOLDER + ' ' : ''}${esc((d.title || 'Untitled').replace(/\.md$/i, ''))}${nestedCount.get(d.id) ? `<span class="trash-item-count">+${nestedCount.get(d.id)} item${nestedCount.get(d.id) !== 1 ? 's' : ''}</span>` : ''}</span>
      <span class="trash-item-date">Deleted ${esc(fmtDate(d.deletedAt))}</span>
      <span class="trash-item-actions">
        <button class="trash-restore-btn btn btn-secondary" data-id="${esc(d.id)}">Restore</button>
        <button class="trash-delete-btn btn btn-secondary hdr-danger" data-id="${esc(d.id)}">Delete permanently</button>
      </span>
    </div>`).join('');

  list.querySelectorAll('.trash-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const restoreIds = treeIdsFor(btn.dataset.id);
        if (restoreIds.length > 1) await fsRestoreMany(restoreIds);
        else await fsRestoreDoc(btn.dataset.id);
        await refreshSidebarList();
        await renderTrashList();
        showToast('Document restored');
      } catch (err) {
        showToast('Restore failed');
        console.error('restore:', err);
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll('.trash-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const deleteIds = treeIdsFor(btn.dataset.id);
        if (deleteIds.length > 1) {
          if (!confirm(`Permanently delete this folder and its ${deleteIds.length - 1} item${deleteIds.length - 1 !== 1 ? 's' : ''}? This cannot be undone.`)) {
            btn.disabled = false;
            return;
          }
          await fsDeleteMany(deleteIds);
        } else {
          await fsDelete(btn.dataset.id);
        }
        await renderTrashList();
      } catch (err) {
        showToast('Delete failed');
        console.error('permanent delete:', err);
        btn.disabled = false;
      }
    });
  });
}

document.getElementById('trash-empty-btn').addEventListener('click', async () => {
  if (!confirm('Permanently delete all items in Trash? This cannot be undone.')) return;
  const list = document.getElementById('trash-list');
  list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">Emptying…</div>';
  try {
    const docs = await fsGetTrashed();
    await Promise.all(docs.map(d => fsDelete(d.id)));
    await renderTrashList();
    showToast('Trash emptied');
  } catch (err) {
    showToast('Empty trash failed');
    console.error('emptyTrash:', err);
    await renderTrashList();
  }
});

document.getElementById('trash-cancel').addEventListener('click', closeTrashModal);
document.getElementById('trash-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('trash-modal')) closeTrashModal();
});

// ── Kanban ────────────────────────────────────────────────────────────────────
async function fsUpdateKanbanStatus(id, status) {
  await db.collection('documents').doc(id).update({ kanbanStatus: status || null });
}

const KANBAN_COLS = [
  { id: 'todo',        label: 'To Do' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'done',        label: 'Done' },
];

let kanbanPickTarget = null; // column status to assign when doc browser used as picker

function openKanban() {
  document.getElementById('kanban-panel').classList.remove('hidden');
  renderKanban();
}

function closeKanban() {
  document.getElementById('kanban-panel').classList.add('hidden');
  kanbanPickTarget = null;
}

async function renderKanban() {
  const board = document.getElementById('kanban-board');
  board.innerHTML = '<div style="color:var(--text2);padding:20px">Loading…</div>';

  // C-1 (v3.28.0): read only documents that are on the board (an `in` filter on
  // one field plus the userId equality needs no composite index). Fall back to
  // the old full read if the query is rejected.
  let docs;
  try {
    const snap = await db.collection('documents')
      .where('userId', '==', auth.currentUser.uid)
      .where('kanbanStatus', 'in', KANBAN_COLS.map(c => c.id))
      .get();
    docs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => !d.isDeleted);
  } catch (err) {
    console.warn('kanban query failed, falling back to full read:', err);
    docs = await fsGetAll(2500);
  }
  const byStatus = {};
  KANBAN_COLS.forEach(c => { byStatus[c.id] = []; });
  docs.forEach(d => {
    if (d.kanbanStatus && byStatus[d.kanbanStatus]) byStatus[d.kanbanStatus].push(d);
  });

  board.innerHTML = KANBAN_COLS.map(col => {
    const cards = byStatus[col.id];
    const cardsHtml = cards.length
      ? cards.map(d => {
          const tags = (d.tags || []).slice(0, 3).map(t => `<span class="kb-card-tag">${esc(t)}</span>`).join('');
          const words = wordCount(d);
          const title = (d.title || 'Untitled').replace(/\.md$/i, '');
          return `<div class="kb-card" draggable="true" data-id="${esc(d.id)}" data-status="${esc(col.id)}">
            <div class="kb-card-title">${esc(title)}</div>
            <div class="kb-card-meta">
              <span class="kb-card-words">${words.toLocaleString()} words</span>
              ${tags}
            </div>
            <button class="kb-card-remove" data-id="${esc(d.id)}" title="Remove from board">×</button>
          </div>`;
        }).join('')
      : `<div class="kb-empty">No cards</div>`;

    return `<div class="kb-col">
      <div class="kb-col-header">
        <span class="kb-col-title">${esc(col.label)}</span>
        <span class="kb-col-count">${cards.length}</span>
      </div>
      <div class="kb-col-cards" data-status="${esc(col.id)}">${cardsHtml}</div>
      <button class="kb-add-btn" data-status="${esc(col.id)}">+ Add card</button>
    </div>`;
  }).join('');

  // Drag-and-drop
  board.querySelectorAll('.kb-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    card.addEventListener('click', e => {
      if (e.target.closest('.kb-card-remove')) return;
      const doc = docs.find(d => d.id === card.dataset.id);
      if (doc) { if (isDirty && !confirm('You have unsaved changes. Open this document anyway?')) return; applyDoc(doc); closeKanban(); }
      else loadDoc(card.dataset.id).then(closeKanban);
    });
  });

  board.querySelectorAll('.kb-card-remove').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await fsUpdateKanbanStatus(btn.dataset.id, null);
      renderKanban();
    });
  });

  board.querySelectorAll('.kb-col-cards').forEach(zone => {
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const newStatus = zone.dataset.status;
      await fsUpdateKanbanStatus(id, newStatus);
      renderKanban();
    });
  });

  board.querySelectorAll('.kb-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      kanbanPickTarget = btn.dataset.status;
      openDocBrowser();
    });
  });
}


document.getElementById('kanban-btn').addEventListener('click', openKanban);
document.getElementById('kanban-close-btn').addEventListener('click', closeKanban);

// C-11 (v3.29.0): assigning editor.value wipes the textarea's undo stack.
// Programmatic edits go through execCommand('insertText') so Ctrl+Z still works,
// with a plain assignment (plus an input event) as the fallback.
function replaceEditorRange(from, to, text) {
  editor.focus();
  editor.setSelectionRange(from, to);
  const before = editor.value;
  const expected = before.slice(0, from) + text + before.slice(to);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (_) {}
  if (!ok || editor.value !== expected) {
    editor.value = expected;
    const pos = from + text.length;
    editor.setSelectionRange(pos, pos);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
function replaceEditorText(text) {
  if (editor.value === text) return;
  replaceEditorRange(0, editor.value.length, text);
}

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
    replaceEditorRange(lineStart, lineStart + prefix.length, '\n');
  } else {
    let newPrefix;
    if (ordered) {
      newPrefix = ordered[1] + (parseInt(ordered[2], 10) + 1) + '. ';
    } else {
      newPrefix = unordered[1] + unordered[2] + ' ';
    }
    replaceEditorRange(start, start, '\n' + newPrefix);
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
  scheduleAutoSave(); // C-3 (v3.28.0): do not rely on execCommand firing input
  runFind();
}
function doReplaceAll() {
  const q = findInput.value;
  if (!q) return;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const count = (editor.value.match(re) || []).length;
  replaceEditorText(editor.value.replace(re, () => replaceInput.value));
  isDirty = true; renderPreview(); updateStats(); updateLineNumbers();
  if (count) scheduleAutoSave(); // C-3 (v3.28.0): assigning .value fires no input event
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
    if (window.turndownPluginGfm) td.use(window.turndownPluginGfm.gfm);
    td.addRule('mermaidDiagram', {
      filter: (node) =>
        node.nodeName === 'DIV' &&
        (node.classList.contains('mermaid-diagram') || node.classList.contains('mermaid-error') || node.classList.contains('mermaid-pending')) &&
        (node.dataset.src !== undefined),
      replacement: (_content, node) => {
        const src = node.dataset.src || node.textContent || '';
        return '\n\n```mermaid\n' + src + '\n```\n\n';
      }
    });
    td.addRule('copyCodeBtn', {
      filter: (node) => node.nodeName === 'BUTTON' && node.classList.contains('copy-code-btn'),
      replacement: () => ''
    });
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
  const md = turndown ? turndown.turndown(focusWysiwyg.innerHTML) : null;
  focusWysiwyg.innerHTML = '';
  focusMode = false;
  document.body.classList.remove('focus-mode');
  document.getElementById('focus-btn').classList.remove('active');
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  if (md !== null && md !== editor.value) {
    // C-11 (v3.29.0): the editor is visible again here, so the change keeps undo history.
    replaceEditorText(md);
    isDirty = true;
    renderPreview();
    updateStats();
    updateLineNumbers();
    scheduleAutoSave(); // C-3 (v3.28.0)
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
      const md = turndown.turndown(focusWysiwyg.innerHTML);
      if (md !== editor.value) {
        editor.value = md;
        isDirty = true;
        updateStats();
        scheduleAutoSave(); // C-3 (v3.28.0): Focus Mode edits are now auto-saved
      }
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

// ── Preview WYSIWYG editing ───────────────────────────────────────────────────
previewInner.contentEditable = 'true';
previewInner.spellcheck = true;

// Forward clicks on the pane background to the editable area.
// In LP mode, activate the last block (or create a new one).
previewPane.addEventListener('click', (e) => {
  if (e.target !== previewPane) return;
  if (_lpMode) {
    const last = previewInner.querySelector('.lp-block:last-child');
    if (last) { lpActivate(last); } else { lpNewBlock(null); }
  } else {
    previewInner.focus();
    const range = document.createRange();
    range.selectNodeContents(previewInner);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

let previewWysiwygTimer;
let previewDirty = false;

previewInner.addEventListener('focus', () => { if (!_lpMode) previewEditing = true; });

previewInner.addEventListener('blur', () => {
  if (_lpMode) return;
  previewEditing = false;
  clearTimeout(previewWysiwygTimer);
  const wasPreviewDirty = previewDirty;
  previewDirty = false;
  if (wasPreviewDirty) {
    const turndown = getTurndown();
    if (turndown) {
      const md = turndown.turndown(previewInner.innerHTML);
      if (md !== editor.value) {
        editor.value = md;
        isDirty = true;
        scheduleAutoSave();
        updateStats();
        updateLineNumbers();
      }
    }
  }
  renderPreview();
});

previewInner.addEventListener('input', () => {
  if (_lpMode) return;
  previewDirty = true;
  clearTimeout(previewWysiwygTimer);
  previewWysiwygTimer = setTimeout(() => {
    if (!previewEditing) return;
    const turndown = getTurndown();
    if (turndown) {
      editor.value = turndown.turndown(previewInner.innerHTML);
      isDirty = true;
      scheduleAutoSave();
      updateStats();
    }
  }, 600);
});

previewInner.addEventListener('paste', (e) => {
  if (_lpMode) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, text);
});

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

// Returns the LP block's textarea when one is active, otherwise the main editor.
function getActiveEditor() {
  if (_lpMode) {
    const ta = previewInner.querySelector('.lp-active textarea.lp-edit-ta');
    if (ta) return ta;
  }
  return editor;
}

// Prevent the LP textarea from losing focus when the user clicks a toolbar button.
document.getElementById('format-bar').addEventListener('mousedown', (e) => {
  if (_lpMode && previewInner.querySelector('.lp-active textarea.lp-edit-ta')) {
    e.preventDefault();
  }
});

function wrapSelection(before, after) {
  if (after === undefined) after = before;
  const target   = getActiveEditor();
  const start    = target.selectionStart;
  const end      = target.selectionEnd;
  const selected = target.value.slice(start, end);
  const newText  = before + selected + after;
  document.execCommand('insertText', false, newText);
  target.setSelectionRange(start + before.length, start + before.length + selected.length);
  target.dispatchEvent(new Event('input'));
  target.focus();
}

function prefixLines(prefix) {
  const target    = getActiveEditor();
  const start     = target.selectionStart;
  const end       = target.selectionEnd;
  const lineStart = target.value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd   = target.value.indexOf('\n', end);
  const blockEnd  = lineEnd === -1 ? target.value.length : lineEnd;
  const block     = target.value.slice(lineStart, blockEnd);
  const lines     = block.split('\n');
  const already   = lines.every(l => l.startsWith(prefix));
  const newBlock  = already
    ? lines.map(l => l.slice(prefix.length)).join('\n')
    : lines.map(l => prefix + l).join('\n');
  target.focus();
  target.setSelectionRange(lineStart, blockEnd);
  document.execCommand('insertText', false, newBlock);
  target.dispatchEvent(new Event('input'));
}

function insertHeading(level) {
  const target    = getActiveEditor();
  const hashes    = '#'.repeat(level) + ' ';
  const start     = target.selectionStart;
  const lineStart = target.value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd   = target.value.indexOf('\n', start);
  const end       = lineEnd === -1 ? target.value.length : lineEnd;
  const line      = target.value.slice(lineStart, end);
  const stripped  = line.replace(/^#{1,6}\s*/, '');
  target.focus();
  target.setSelectionRange(lineStart, end);
  document.execCommand('insertText', false, hashes + stripped);
  target.dispatchEvent(new Event('input'));
}

// ── Format bar button handlers ────────────────────────────────────────────────
document.getElementById('fmt-bold-btn').addEventListener('click',   () => wrapSelection('**'));
document.getElementById('fmt-italic-btn').addEventListener('click', () => wrapSelection('_'));
document.getElementById('fmt-strike-btn').addEventListener('click', () => wrapSelection('~~'));
document.getElementById('fmt-ul-btn').addEventListener('click',     () => prefixLines('- '));
document.getElementById('fmt-ol-btn').addEventListener('click',     () => prefixLines('1. '));
document.getElementById('fmt-quote-btn').addEventListener('click',  () => prefixLines('> '));
document.getElementById('fmt-code-btn').addEventListener('click',   () => {
  const target   = getActiveEditor();
  const selected = target.value.slice(target.selectionStart, target.selectionEnd);
  if (selected.includes('\n')) {
    wrapSelection('```\n', '\n```');
  } else {
    wrapSelection('`');
  }
});
document.getElementById('fmt-link-btn').addEventListener('click', () => {
  const target   = getActiveEditor();
  const selected = target.value.slice(target.selectionStart, target.selectionEnd);
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
function insertTable(rows, cols) {
  const target = getActiveEditor();
  const header = '| ' + Array(cols).fill('Column').join(' | ') + ' |';
  const sep    = '| ' + Array(cols).fill('---').join(' | ') + ' |';
  const row    = '| ' + Array(cols).fill('     ').join(' | ') + ' |';
  const table  = '\n' + header + '\n' + sep + '\n' + Array(rows).fill(row).join('\n') + '\n';
  const pos    = target.selectionStart;
  const before = target.value.slice(0, pos);
  const prefix = (before.length && !before.endsWith('\n')) ? '\n' : '';
  target.focus();
  document.execCommand('insertText', false, prefix + table);
  target.dispatchEvent(new Event('input'));
  target.focus();
}

// Table picker grid (5×5)
(function () {
  const COLS = 5, ROWS = 5;
  const grid  = document.getElementById('fmt-table-grid');
  const label = document.getElementById('fmt-table-label');
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'fmt-table-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.addEventListener('mouseenter', () => {
        label.textContent = `${r} × ${c} table`;
        grid.querySelectorAll('.fmt-table-cell').forEach(el =>
          el.classList.toggle('active', +el.dataset.r <= r && +el.dataset.c <= c)
        );
      });
      cell.addEventListener('click', () => {
        insertTable(r, c);
        document.getElementById('fmt-table-menu').classList.remove('open');
      });
      grid.appendChild(cell);
    }
  }
  grid.addEventListener('mouseleave', () => {
    label.textContent = 'Insert table';
    grid.querySelectorAll('.fmt-table-cell').forEach(el => el.classList.remove('active'));
  });
}());

document.getElementById('fmt-table-btn').addEventListener('click', () => insertTable(2, 3));
document.getElementById('fmt-table-dd').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('fmt-table-menu').classList.toggle('open');
  document.getElementById('fmt-heading-menu').classList.remove('open');
  document.getElementById('fmt-code-menu').classList.remove('open');
});

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
  document.getElementById('fmt-table-menu').classList.remove('open');
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
      if (_lpMode) {
        // Commit any active LP block before leaving LP mode
        const active = previewInner.querySelector('.lp-active');
        if (active) {
          const ta = active.querySelector('textarea.lp-edit-ta');
          if (ta) { active.dataset.md = ta.value; lpSyncToEditor(); }
        }
        _lpMode = false;
        previewEditing = false; // force renderPreview to run fully
        previewInner.contentEditable = 'true';
        renderPreview();
      }
    } else if (mode === 'preview') {
      btnPreview.classList.add('active');
      editorPane.style.display = 'none';
      divider.style.display   = 'none';
      if (!_lpMode) {
        // Kill any pending WYSIWYG Turndown timer before entering LP mode so it
        // cannot fire on LP block HTML and corrupt editor.value with escaped syntax.
        clearTimeout(previewWysiwygTimer);
        previewEditing = false;
        previewDirty   = false;
        _lpMode = true;
        previewInner.contentEditable = 'false';
        lpRender();
      }
    } else {
      btnSplit.classList.add('active');
      editorPane.style.display  = '';
      previewWrap.style.display = '';
      divider.style.display     = '';
      if (_lpMode) {
        const active = previewInner.querySelector('.lp-active');
        if (active) {
          const ta = active.querySelector('textarea.lp-edit-ta');
          if (ta) { active.dataset.md = ta.value; lpSyncToEditor(); }
        }
        _lpMode = false;
        previewEditing = false; // force renderPreview to run fully
        previewInner.contentEditable = 'true';
        renderPreview();
      }
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

// C-10 (v3.29.0): the live preview carries UI chrome (copy buttons, code-block
// wrappers, editing flags). Exports use a cleaned clone instead.
function exportBodyHtml() {
  const c = previewInner.cloneNode(true);
  c.querySelectorAll('.copy-code-btn').forEach(b => b.remove());
  c.querySelectorAll('.code-block').forEach(w => w.replaceWith(...w.childNodes));
  c.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
  // In LP mode, unwrap .lp-block divs and drop any editing textarea
  c.querySelectorAll('.lp-block').forEach(b => {
    b.querySelectorAll('textarea.lp-edit-ta').forEach(ta => {
      const rendered = document.createElement('div');
      try { rendered.innerHTML = DOMPurify.sanitize(marked.parse(ta.value || '')); } catch (e) { rendered.textContent = ta.value; }
      ta.replaceWith(...rendered.childNodes);
    });
    b.replaceWith(...b.childNodes);
  });
  c.querySelectorAll('.lp-placeholder').forEach(p => p.remove());
  return c.innerHTML;
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
<body>${exportBodyHtml()}</body></html>`;
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
      case 'table': {
        // Real RTF table: one \trowd row per <tr>, equal-width bordered cells.
        const rows = Array.from(node.querySelectorAll('tr'));
        const total = 8640;
        let out = '';
        rows.forEach((tr) => {
          const cells = Array.from(tr.children).filter(c => /^(td|th)$/i.test(c.tagName));
          if (!cells.length) return;
          const w = Math.floor(total / cells.length);
          const b = '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10';
          out += '\\trowd\\trgaph108' + cells.map((_, i) => b + `\\cellx${w * (i + 1)}`).join('') + '\n';
          out += cells.map((c) => {
            const body = walk(c);
            return `\\pard\\intbl ${c.tagName.toLowerCase() === 'th' ? `{\\b ${body}}` : body}\\cell`;
          }).join('') + '\\row\n';
        });
        return out + '\\pard\\sb0\\sa120\\par\n';
      }
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
function exportAsRtf()  { if (!editor.value) { showToast('Nothing to export'); return; } triggerDownload(new Blob([htmlToRtf(exportBodyHtml())], { type: 'application/rtf' }), exportBasename() + '.rtf'); }

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
document.getElementById('hdr-rename-btn').addEventListener('click', () => {
  document.getElementById('hdr-more-menu').classList.remove('open');
  startRename();
});

document.getElementById('hdr-duplicate-btn').addEventListener('click', () => {
  document.getElementById('hdr-more-menu').classList.remove('open');
  duplicateCurrentDoc();
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

// ── Word goal popover ─────────────────────────────────────────────────────────
(function () {
  const wordCountEl = document.getElementById('word-count');
  const popover     = document.getElementById('goal-popover');
  const input       = document.getElementById('goal-input');

  wordCountEl.addEventListener('click', () => {
    const rect = wordCountEl.getBoundingClientRect();
    popover.style.left   = rect.left + 'px';
    popover.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    popover.classList.add('open');
    input.value = wordGoal || '';
    input.focus();
    input.select();
  });

  function applyGoal() {
    const v = parseInt(input.value, 10);
    wordGoal = (v > 0) ? v : 0;
    try { localStorage.setItem('md-word-goal', wordGoal); } catch(_) {}
    popover.classList.remove('open');
    updateStats();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  applyGoal();
    if (e.key === 'Escape') popover.classList.remove('open');
  });

  document.getElementById('goal-clear-btn').addEventListener('click', () => {
    input.value = '';
    applyGoal();
  });

  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && e.target !== wordCountEl) {
      popover.classList.remove('open');
    }
  });
})();

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
    currentParentId = null;
    isDirty      = false;
    editor.value = '';
    setTitle('New Document');
    renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
    window.history.replaceState({}, '', window.location.pathname);
  }

  initializeMobileUI();
  initSidebar();
}

// ── Mobile UI Improvements ────────────────────────────────────────────────────
let mobileMode = 'editor'; // 'editor' or 'preview'
let _mobileUiWired = false;

function initializeMobileUI() {
  // Only apply mobile UI on screens <= 768px
  if (window.innerWidth > 768) return;

  const toggleBtn = document.getElementById('editor-preview-toggle');
  if (!toggleBtn) return;

  // Load saved preference from localStorage
  const saved = lsGet('mobile-view-mode');
  if (saved === 'editor' || saved === 'preview') mobileMode = saved;

  // Set initial state
  updateMobileViewMode();

  // C-5 (v3.28.0): bootApp() runs again after every sign-in; wire listeners once.
  if (_mobileUiWired) return;
  _mobileUiWired = true;

  // Handle toggle button clicks
  toggleBtn.addEventListener('click', () => {
    mobileMode = mobileMode === 'editor' ? 'preview' : 'editor';
    lsSet('mobile-view-mode', mobileMode);
    updateMobileViewMode();
  });

  // Handle keyboard visibility using visualViewport API
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleKeyboardVisibility);
  }
}

function updateMobileViewMode() {
  const body = document.body;
  body.classList.remove('mobile-editor-only', 'mobile-preview-only');

  if (mobileMode === 'editor') {
    body.classList.add('mobile-editor-only');
  } else {
    body.classList.add('mobile-preview-only');
  }

  // Force re-render to ensure content is visible
  scheduleRender();
}

function handleKeyboardVisibility() {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const windowHeight = window.innerHeight;
  const viewportHeight = viewport.height;
  const keyboardHeight = windowHeight - viewportHeight;

  // If keyboard is visible (height difference > 50px), add class
  if (keyboardHeight > 50) {
    document.body.classList.add('keyboard-visible');
  } else {
    document.body.classList.remove('keyboard-visible');
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
let _sidebarDocs = [];        // cached doc list for the sidebar
let _sidebarFilter = '';      // current search filter text
let _sidebarSort = ['groups', 'name'].includes(lsGet('sidebar-sort')) ? lsGet('sidebar-sort') : 'groups'; // 'groups' | 'name'
let _sidebarExpanded = new Set((() => { const v = lsGetJson('sidebar-expanded', []); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; })());

function _saveExpandedState() {
  lsSet('sidebar-expanded', JSON.stringify([..._sidebarExpanded]));
}

// Build a tree from a flat doc list. Docs missing from the id map (orphans) are
// promoted to root so they don't silently disappear after a parent is deleted.
function buildDocTree(docs) {
  const byId = new Map(docs.map(d => [d.id, d]));
  const childrenOf = new Map(); // parentId -> [doc, ...]
  const roots = [];

  for (const doc of docs) {
    const pid = doc.parentId && byId.has(doc.parentId) ? doc.parentId : null;
    if (!pid) {
      roots.push(doc);
    } else {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(doc);
    }
  }
  return { roots, byId, childrenOf };
}

function getDescendantIds(id, childrenOf) {
  const ids = new Set();
  const visit = (cid) => {
    ids.add(cid);
    for (const child of (childrenOf.get(cid) || [])) visit(child.id);
  };
  visit(id);
  return ids;
}

// SVG icons
const ICON_DOC  = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H4z"/><path d="M4.5 5h7a.5.5 0 0 0 0-1h-7a.5.5 0 0 0 0 1zm0 3h7a.5.5 0 0 0 0-1h-7a.5.5 0 0 0 0 1zm0 3h5a.5.5 0 0 0 0-1h-5a.5.5 0 0 0 0 1z"/></svg>`;
const ICON_FOLDER = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.17a1.5 1.5 0 0 1 1.06.44L7.3 3H13.5A1.5 1.5 0 0 1 15 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 11.5v-8z"/></svg>`;
const ICON_PLUS = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/></svg>`;
const ICON_MOVE = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.646.146a.5.5 0 0 1 .708 0l2 2a.5.5 0 0 1-.708.708L8.5 1.707V5.5a.5.5 0 0 1-1 0V1.707L6.354 2.854a.5.5 0 1 1-.708-.708l2-2zm-2 13.708a.5.5 0 0 1 .708-.708L7.5 14.293V10.5a.5.5 0 0 1 1 0v3.793l1.646-1.647a.5.5 0 0 1 .708.708l-2 2a.5.5 0 0 1-.708 0l-2-2z"/></svg>`;

function sidebarPreview(doc) {
  if (TreeUtils.isFolder(doc)) return '';
  const raw = doc.content || '';
  if (!raw.trim()) return '';
  const titleBase = (doc.title || '').replace(/\.md$/i, '').trim().toLowerCase();
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  // Skip the first line if it's just the document title as a heading
  let start = 0;
  if (lines[0] && lines[0].replace(/^#{1,6}\s+/, '').trim().toLowerCase() === titleBase) start = 1;
  const text = lines.slice(start).join('\n')
    .replace(/^```[\s\S]*?```/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[(.+?)\]\(.*?\)/g, '$1')
    .replace(/[*_]{1,2}(.+?)[*_]{1,2}/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 100);
}

function renderSidebarNode(doc, childrenOf, depth) {
  const isFolderNode = TreeUtils.isFolder(doc);
  const children = TreeUtils.orderSiblings(childrenOf.get(doc.id) || []);
  const hasChildren = children.length > 0;
  const isExpanded = _sidebarExpanded.has(doc.id);
  const isActive = doc.id === currentDocId;
  const title = (doc.title || 'Untitled').replace(/\.md$/i, '');
  const indent = depth * 14; // px per level
  const id = esc(doc.id);

  const chevron = (hasChildren || isFolderNode)
    ? `<button class="sb-chevron${isExpanded ? ' expanded' : ''}" data-id="${id}" tabindex="-1" title="Expand/collapse">
        <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/></svg>
      </button>`
    : `<span class="sb-chevron-placeholder"></span>`;

  let childrenHtml = '';
  if (hasChildren) {
    childrenHtml = `<div class="sb-children${isExpanded ? '' : ' sb-hidden'}" data-parent="${id}">${
      children.map(c => renderSidebarNode(c, childrenOf, depth + 1)).join('')
    }</div>`;
  } else if (isFolderNode) {
    childrenHtml = `<div class="sb-children${isExpanded ? '' : ' sb-hidden'}" data-parent="${id}"><div class="sb-empty-folder" style="padding-left:${8 + indent + 38}px">Empty</div></div>`;
  }

  return `<div class="sb-node" data-node="${id}">
    <div class="sidebar-item${isActive ? ' active' : ''}" data-id="${id}" data-type="${isFolderNode ? 'folder' : 'doc'}" style="padding-left:${8 + indent}px" title="${esc(doc.title || '')}">
      ${chevron}
      <span class="sb-icon">${isFolderNode ? ICON_FOLDER : ICON_DOC}</span>
      <span class="sb-item-body">
        <span class="sidebar-item-title">${esc(title)}</span>${!isFolderNode ? (() => { const p = sidebarPreview(doc); return p ? `<span class="sb-preview">${esc(p)}</span>` : ''; })() : ''}
      </span>
      <span class="sb-actions">
        <button class="sb-action-btn sb-add-child" data-id="${id}" title="${isFolderNode ? 'New document in folder' : 'Add sub-page'}">${ICON_PLUS}</button>
        <button class="sb-action-btn sb-move" data-id="${id}" title="Move">${ICON_MOVE}</button>
      </span>
    </div>
    ${childrenHtml}
  </div>`;
}

// One row of the flat lists (search results and Name sort).
function renderSidebarFlatItem(d) {
  const folderItem = TreeUtils.isFolder(d);
  const title = (d.title || 'Untitled').replace(/\.md$/i, '');
  const isActive = d.id === currentDocId;
  return `<div class="sidebar-item${isActive ? ' active' : ''}" data-id="${esc(d.id)}" data-type="${folderItem ? 'folder' : 'doc'}" style="padding-left:8px" title="${esc(d.title || '')}">
    <span class="sb-chevron-placeholder"></span>
    <span class="sb-icon">${folderItem ? ICON_FOLDER : ICON_DOC}</span>
    <span class="sb-item-body">
      <span class="sidebar-item-title">${esc(title)}</span>${!folderItem ? (() => { const p = sidebarPreview(d); return p ? `<span class="sb-preview">${esc(p)}</span>` : ''; })() : ''}
    </span>
  </div>`;
}

function wireSidebarFlatClicks(list) {
  list.querySelectorAll('.sidebar-item').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.type === 'folder') revealInSidebar(el.dataset.id);
      else loadDoc(el.dataset.id);
    });
  });
}

function renderSidebarTree(docs, filter) {
  const list = document.getElementById('sidebar-list');
  if (!list) return;

  const q = (filter || '').toLowerCase().trim();

  // When filtering, show a flat list of matches (easier to scan)
  if (q) {
    const filtered = docs.filter(d =>
      (d.title || '').toLowerCase().includes(q) || (d.content || '').toLowerCase().includes(q)
    );
    if (!filtered.length) {
      list.innerHTML = `<div class="sidebar-empty">No results</div>`;
      return;
    }
    list.innerHTML = filtered.map(renderSidebarFlatItem).join('');
    wireSidebarFlatClicks(list);
    return;
  }

  if (_sidebarSort === 'name') {
    if (!docs.length) {
      list.innerHTML = `<div class="sidebar-empty">No documents yet</div>`;
      return;
    }
    const sorted = [...docs].sort((a, b) =>
      (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())
    );
    list.innerHTML = sorted.map(renderSidebarFlatItem).join('');
    wireSidebarFlatClicks(list);
    return;
  }

  const { roots, childrenOf } = buildDocTree(docs);
  if (!roots.length && !docs.length) {
    list.innerHTML = `<div class="sidebar-empty">No documents yet</div>`;
    return;
  }

  list.innerHTML = TreeUtils.orderSiblings(roots).map(d => renderSidebarNode(d, childrenOf, 0)).join('');

  // Wire up clicks
  list.querySelectorAll('.sidebar-item').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't open doc if a button inside was clicked
      if (e.target.closest('.sb-action-btn, .sb-chevron, .sb-rename-input')) return;
      if (el.dataset.type === 'folder') { toggleFolder(el.dataset.id); return; }
      loadDoc(el.dataset.id);
    });
  });

  list.querySelectorAll('.sb-chevron').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFolder(btn.dataset.id);
    });
  });

  list.querySelectorAll('.sb-add-child').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      addSubPage(btn.dataset.id);
    });
  });

  list.querySelectorAll('.sb-move').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMoveModal(btn.dataset.id);
    });
  });
}

// Alias used by legacy callers that pass docs+filter
function renderSidebarList(docs, filter) {
  renderSidebarTree(docs, filter);
}

function updateSidebarActive() {
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === currentDocId);
  });
}

// C-2 (v3.28.0): the 300-document window can leave a document's parent outside
// it, which would promote the child to the root. Fetch the missing ancestors
// (a handful of single-document reads, bounded) so the tree keeps its shape.
// Skipped for the cache-only paint, which must never touch the network.
async function fillMissingAncestors(docs) {
  const have = new Set(docs.map(d => d.id));
  let budget = 40;
  for (let pass = 0; pass < 8 && budget > 0; pass++) {
    const missing = [...new Set(docs.map(d => d.parentId).filter(p => p && !have.has(p)))].slice(0, budget);
    if (!missing.length) break;
    budget -= missing.length;
    const got = await Promise.all(missing.map(id => fsGet(id).catch(() => null)));
    missing.forEach((id, i) => {
      have.add(id); // also marks absent parents so the loop terminates
      const d = got[i];
      if (d && !d.isDeleted && d.userId === auth.currentUser.uid) docs.push(d);
    });
  }
  return docs;
}

async function loadSidebarDocs(opts) {
  const docs = await fsGetAll(300, opts);
  if (opts && opts.source === 'cache') return docs;
  return fillMissingAncestors(docs);
}

async function refreshSidebarList() {
  if (!auth.currentUser) return;
  try {
    _sidebarDocs = await loadSidebarDocs();
    renderSidebarTree(_sidebarDocs, _sidebarFilter);
  } catch (err) {
    console.warn('sidebar refresh failed:', err);
  }
}

// C-1 (v3.28.0): after a save, patch the cached sidebar window in place. The
// saved document moves to the front (it is now the most recently updated) and
// the tree is re-rendered from memory. Zero Firestore reads.
function syncSidebarAfterSave(id, title, content, parentId) {
  if (!auth.currentUser) return;
  const ts = { toMillis: () => Date.now() };
  const i = _sidebarDocs.findIndex(d => d.id === id);
  if (i >= 0) {
    const prev = _sidebarDocs[i];
    _sidebarDocs.splice(i, 1);
    _sidebarDocs.unshift({ ...prev, title, content, updatedAt: ts });
  } else {
    const fresh = { id, userId: auth.currentUser.uid, title, content, createdAt: ts, updatedAt: ts };
    if (parentId) fresh.parentId = parentId;
    _sidebarDocs.unshift(fresh);
  }
  // Do not rebuild the tree under an inline rename box.
  if (document.querySelector('#sidebar-list .sb-rename-input')) return;
  renderSidebarTree(_sidebarDocs, _sidebarFilter);
}

// Add a new sub-page under parentId
async function addSubPage(parentId) {
  if (isDirty && !confirm('You have unsaved changes. Create a sub-page anyway?')) return;
  const parentDoc = _sidebarDocs.find(d => d.id === parentId);
  const parentTitle = parentDoc ? (parentDoc.title || 'Untitled').replace(/\.md$/i, '') : 'parent';

  clearTimeout(autoSaveTimer);
  const newId = crypto.randomUUID();
  currentDocId = newId;
  currentDocIsNew = true;
  currentParentId = parentId;
  isDirty = false;
  editor.value = '';
  setTitle('New Document');
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  document.getElementById('drive-delete-btn').style.display = 'inline-flex';

  // Expand the parent in sidebar
  _sidebarExpanded.add(parentId);
  _saveExpandedState();
  updateSidebarActive();
  if (window.innerWidth <= 600) closeSidebar();
  editor.focus();
}

// Move page modal
let _moveTargetId = null;

function openMoveModal(docId) {
  _moveTargetId = docId;
  const modal = document.getElementById('move-modal');
  const list  = document.getElementById('move-modal-list');
  if (!modal || !list) return;

  const { childrenOf } = buildDocTree(_sidebarDocs);
  const excluded = getDescendantIds(docId, childrenOf); // self + descendants
  const movingDoc = _sidebarDocs.find(d => d.id === docId);
  const movingTitle = movingDoc ? (movingDoc.title || 'Untitled').replace(/\.md$/i, '') : 'this page';

  document.getElementById('move-modal-title').textContent = `Move "${movingTitle}" to…`;

  const candidates = TreeUtils.orderSiblings(_sidebarDocs.filter(d => !excluded.has(d.id)));
  const byIdForPath = new Map(_sidebarDocs.map(d => [d.id, d]));
  list.innerHTML = `
    <div class="move-option${!movingDoc?.parentId ? ' move-option-current' : ''}" data-pid="">
      <span class="move-option-icon">⬛</span> Root level
    </div>
    ${candidates.map(d => {
      const isCurrent = d.id === movingDoc?.parentId;
      const title = (d.title || 'Untitled').replace(/\.md$/i, '');
      const path = TreeUtils.ancestorTitles(d.id, byIdForPath).join(' / ');
      return `<div class="move-option${isCurrent ? ' move-option-current' : ''}" data-pid="${esc(d.id)}">
        <span class="move-option-icon">${TreeUtils.isFolder(d) ? ICON_FOLDER : ICON_DOC}</span> ${esc(title)}${path ? `<span class="move-option-path">${esc(path)}</span>` : ''}
      </div>`;
    }).join('')}`;

  list.querySelectorAll('.move-option').forEach(el => {
    el.addEventListener('click', () => {
      list.querySelectorAll('.move-option').forEach(x => x.classList.remove('move-option-selected'));
      el.classList.add('move-option-selected');
    });
  });

  modal.classList.add('open');
}

function closeMoveModal() {
  document.getElementById('move-modal')?.classList.remove('open');
  _moveTargetId = null;
}

async function confirmMove() {
  if (!_moveTargetId) return;
  const selected = document.querySelector('#move-modal-list .move-option-selected');
  if (!selected) { showToast('Select a destination first'); return; }
  const newParentId = selected.dataset.pid || null;

  try {
    await fsUpdateParent(_moveTargetId, newParentId);
    // Update local cache
    const doc = _sidebarDocs.find(d => d.id === _moveTargetId);
    if (doc) doc.parentId = newParentId || null;
    if (newParentId) _sidebarExpanded.add(newParentId);
    _saveExpandedState();
    // Update currentParentId if moving the open doc
    if (_moveTargetId === currentDocId) currentParentId = newParentId || null;
    renderSidebarTree(_sidebarDocs, _sidebarFilter);
    closeMoveModal();
    showToast('Page moved');
  } catch (err) {
    console.error('move failed:', err);
    showToast('Move failed');
  }
}

// ── Sidebar drag-to-resize ──
const SB_MIN_W = 180;
const SB_MAX_W = 560;
const SB_DEFAULT_W = 230;

function initSidebarResize(shell) {
  const handle = document.getElementById('sidebar-resizer');
  if (!handle) return;

  // Keep the sidebar from swallowing the editor on narrow windows
  const clamp = (w) => Math.round(Math.min(SB_MAX_W, Math.max(SB_MIN_W, Math.min(w, window.innerWidth * 0.6))));
  const apply = (w) => document.documentElement.style.setProperty('--sb-user-w', w + 'px');
  const save = (w) => lsSet('sidebar-width', String(w));
  const currentW = () => document.getElementById('sidebar').getBoundingClientRect().width;

  // Restore saved width
  const saved = parseInt(lsGet('sidebar-width'), 10);
  if (Number.isFinite(saved)) apply(clamp(saved));

  let startX = 0, startW = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = currentW();
    handle.setPointerCapture(e.pointerId);
    shell.classList.add('sb-resizing');
  });

  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    apply(clamp(startW + (e.clientX - startX)));
  });

  const endDrag = (e) => {
    if (!shell.classList.contains('sb-resizing')) return;
    shell.classList.remove('sb-resizing');
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    save(clamp(currentW()));
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Double-click resets to default
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--sb-user-w');
    try { localStorage.removeItem('sidebar-width'); } catch (_) {}
  });

  // Keyboard: arrow keys nudge the width (Shift = bigger steps)
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.shiftKey ? 40 : 10;
    const w = clamp(currentW() + (e.key === 'ArrowRight' ? step : -step));
    apply(w);
    save(w);
  });

  // Re-clamp if the window shrinks below the saved width
  window.addEventListener('resize', () => {
    const cur = parseInt(document.documentElement.style.getPropertyValue('--sb-user-w'), 10);
    if (Number.isFinite(cur) && clamp(cur) !== cur) apply(clamp(cur));
  });
}

// C-5 (v3.28.0): initSidebar() runs on every boot (each sign-in). Everything that
// attaches a listener now lives in wireSidebarOnce(); initSidebar() keeps only
// the per-boot work (restore state, initial load), so repeated sign-ins no
// longer double every handler.
let _sidebarWired = false;

function initSidebar() {
  // Restore collapsed state
  const savedState = lsGet('sidebar-state');
  const shell = document.getElementById('app-shell');
  if (!shell) return;

  // Default: open on desktop, closed on mobile
  if (savedState === 'closed' || (window.innerWidth <= 600 && savedState !== 'open')) {
    shell.classList.add('sidebar-collapsed');
  }

  document.querySelectorAll('.sb-sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === _sidebarSort);
  });

  if (!_sidebarWired) {
    _sidebarWired = true;
    wireSidebarOnce(shell);
  }

  // Initial doc list load (stale-while-revalidate)
  const serverFetch = loadSidebarDocs();
  loadSidebarDocs({ source: 'cache' }).then(docs => {
    _sidebarDocs = docs;
    renderSidebarTree(docs, _sidebarFilter);
  }).catch(() => {});
  serverFetch.then(docs => {
    _sidebarDocs = docs;
    renderSidebarTree(docs, _sidebarFilter);
  }).catch(err => console.warn('sidebar initial load failed:', err));
}

function wireSidebarOnce(shell) {
  initSidebarResize(shell);

  // Toggle button in header bar
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleSidebar);

  // Collapse button inside sidebar
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  if (collapseBtn) collapseBtn.addEventListener('click', closeSidebar);

  // Backdrop (mobile)
  const backdrop = document.getElementById('sidebar-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeSidebar);

  // Search
  const searchInput = document.getElementById('sidebar-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      _sidebarFilter = searchInput.value;
      renderSidebarTree(_sidebarDocs, _sidebarFilter);
    });
  }

  // Sort toggle
  document.querySelectorAll('.sb-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _sidebarSort = btn.dataset.sort;
      lsSet('sidebar-sort', _sidebarSort);
      document.querySelectorAll('.sb-sort-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.sort === _sidebarSort)
      );
      renderSidebarTree(_sidebarDocs, _sidebarFilter);
    });
  });

  // New doc button (root-level)
  const newBtn = document.getElementById('sidebar-new-btn');
  if (newBtn) {
    newBtn.addEventListener('click', startNewRootDoc);
  }

  // Browse all button
  const browseBtn = document.getElementById('sidebar-browse-all-btn');
  if (browseBtn) browseBtn.addEventListener('click', openDocBrowser);
  const trashBtn = document.getElementById('sidebar-trash-btn');
  if (trashBtn) trashBtn.addEventListener('click', openTrashModal);

  // Move modal buttons
  document.getElementById('move-modal-cancel')?.addEventListener('click', closeMoveModal);
  document.getElementById('move-modal-ok')?.addEventListener('click', confirmMove);

  // Keyboard shortcut: Ctrl+\ to toggle sidebar
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
      e.preventDefault();
      toggleSidebar();
    }
  });
}

function isSidebarCollapsed() {
  const shell = document.getElementById('app-shell');
  return shell ? shell.classList.contains('sidebar-collapsed') : false;
}

function openSidebar() {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  if (window.innerWidth <= 600) {
    shell.classList.add('sidebar-open');
    shell.classList.remove('sidebar-collapsed');
  } else {
    shell.classList.remove('sidebar-collapsed');
  }
  lsSet('sidebar-state', 'open');
}

function closeSidebar() {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  if (window.innerWidth <= 600) {
    shell.classList.remove('sidebar-open');
  } else {
    shell.classList.add('sidebar-collapsed');
  }
  lsSet('sidebar-state', 'closed');
}

function toggleSidebar() {
  if (isSidebarCollapsed()) openSidebar();
  else closeSidebar();
}

// ── Folders, context menu and command palette (v3.27.0) ───────────────────────
// Pure helpers live in tree-utils.js (window.TreeUtils) so they can be unit
// tested. Everything here touches the DOM or Firestore.

// Reset the editor to an empty, unsaved document. Always clears currentParentId
// unless a parent is given, so a new document never inherits the previous
// document's parent by accident.
function startBlankDoc(parentId) {
  clearTimeout(autoSaveTimer);
  currentDocIsNew = true;
  currentDocId = null;
  currentParentId = parentId || null;
  isDirty = false;
  editor.value = '';
  setTitle('New Document');
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  document.getElementById('drive-delete-btn').style.display = 'none';
  updateSidebarActive();
}

function startNewRootDoc() {
  if (isDirty && !confirm('You have unsaved changes. Create a new document anyway?')) return;
  startBlankDoc(null);
  editor.focus();
  if (window.innerWidth <= 600) closeSidebar();
}

// Called on sign-out so the next account never sees the previous account's
// titles in the sidebar, the context menu or the palette.
function resetSidebarState() {
  _sidebarDocs = [];
  _sidebarFilter = '';
  const list = document.getElementById('sidebar-list');
  if (list) list.innerHTML = '';
  const search = document.getElementById('sidebar-search');
  if (search) search.value = '';
  closeContextMenu();
  closePalette(false);
}

function toggleFolder(id) {
  if (_sidebarExpanded.has(id)) _sidebarExpanded.delete(id);
  else _sidebarExpanded.add(id);
  _saveExpandedState();
  renderSidebarTree(_sidebarDocs, _sidebarFilter);
}

// Expand every ancestor of a document or folder, leave search / Name sort so
// the tree is visible, open the sidebar if it is collapsed, and scroll to it.
function revealInSidebar(id) {
  const byId = new Map(_sidebarDocs.map(d => [d.id, d]));
  const target = byId.get(id);
  let cur = target;
  let guard = 0;
  while (cur && cur.parentId && guard++ < 50) {
    _sidebarExpanded.add(cur.parentId);
    cur = byId.get(cur.parentId);
  }
  if (target && TreeUtils.isFolder(target)) _sidebarExpanded.add(id);
  _saveExpandedState();

  _sidebarFilter = '';
  const search = document.getElementById('sidebar-search');
  if (search) search.value = '';
  if (_sidebarSort !== 'groups') {
    _sidebarSort = 'groups';
    lsSet('sidebar-sort', 'groups');
    document.querySelectorAll('.sb-sort-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.sort === 'groups')
    );
  }
  if (isSidebarCollapsed()) openSidebar();
  renderSidebarTree(_sidebarDocs, '');
  const row = document.querySelector(`#sidebar-list .sidebar-item[data-id="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// Create a folder (Finder style: it appears with a default name already in
// rename mode).
async function createFolder(parentId) {
  if (!auth.currentUser) return;
  const siblingNames = _sidebarDocs
    .filter(d => TreeUtils.isFolder(d) && (d.parentId || null) === (parentId || null))
    .map(d => d.title || '');
  const name = TreeUtils.uniqueName('New Folder', siblingNames);
  const id = crypto.randomUUID();
  try {
    await fsCreateFolder(id, name, parentId || null);
  } catch (err) {
    console.error('createFolder:', err);
    showToast('Could not create folder');
    return;
  }
  const nowMs = Date.now();
  _sidebarDocs.unshift({
    id, userId: auth.currentUser.uid, title: name, content: '', type: 'folder',
    parentId: parentId || undefined, createdAt: nowMs, updatedAt: nowMs,
  });
  if (parentId) _sidebarExpanded.add(parentId);
  revealInSidebar(id);
  startInlineRename(id);
}

// Rename in place in the sidebar. Enter or blur commits, Escape cancels.
function startInlineRename(id) {
  const doc = _sidebarDocs.find(d => d.id === id);
  const row = document.querySelector(`#sidebar-list .sidebar-item[data-id="${CSS.escape(id)}"]`);
  if (!doc || !row) return;
  const titleEl = row.querySelector('.sidebar-item-title');
  if (!titleEl) return;

  const folder = TreeUtils.isFolder(doc);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sb-rename-input';
  input.setAttribute('aria-label', folder ? 'Folder name' : 'Document name');
  input.spellcheck = false;
  input.value = folder ? (doc.title || '') : (doc.title || '').replace(/\.md$/i, '');
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const redraw = () => renderSidebarTree(_sidebarDocs, _sidebarFilter);
    if (!commit) { redraw(); return; }

    const name = TreeUtils.normalizeName(input.value);
    if (!name) { redraw(); return; }
    const newTitle = folder ? name : (/\.(md|txt)$/i.test(name) ? name : name + '.md');
    if (newTitle === doc.title) { redraw(); return; }

    if (folder) {
      const siblings = _sidebarDocs
        .filter(d => d.id !== id && TreeUtils.isFolder(d) && (d.parentId || null) === (doc.parentId || null))
        .map(d => d.title || '');
      if (TreeUtils.nameTaken(newTitle, siblings)) {
        showToast('A folder with that name already exists here');
        redraw();
        return;
      }
    }
    try {
      await fsRename(id, newTitle);
      doc.title = newTitle;
      doc.updatedAt = Date.now();
      if (id === currentDocId) setTitle(newTitle);
    } catch (err) {
      console.error('rename failed:', err);
      showToast('Rename failed');
    }
    redraw();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Move a document, or a folder with everything inside it, to Trash.
async function trashItem(id) {
  const doc = _sidebarDocs.find(d => d.id === id);
  if (!doc) return;
  const folder = TreeUtils.isFolder(doc);
  const ids = folder ? TreeUtils.subtreeIds(id, _sidebarDocs) : [id];
  const label = (doc.title || 'Untitled').replace(/\.md$/i, '');
  if (folder && ids.length > 1 &&
      !confirm(`Move "${label}" and its ${ids.length - 1} item${ids.length - 1 !== 1 ? 's' : ''} to Trash?`)) return;

  // Never lose unsaved edits to a document that is about to be trashed.
  const openInside = !!currentDocId && ids.includes(currentDocId);
  if (openInside && isDirty) {
    clearTimeout(autoSaveTimer);
    await performSave(true);
  }
  try {
    if (folder) await fsTrashMany(ids, id);
    else await fsTrashDoc(id);
  } catch (err) {
    console.error('trashItem:', err);
    showToast('Move to Trash failed');
    return;
  }
  _sidebarDocs = _sidebarDocs.filter(d => !ids.includes(d.id));
  if (openInside) startBlankDoc(null);
  renderSidebarTree(_sidebarDocs, _sidebarFilter);
  updateSidebarActive();
  showToast(`"${label}" moved to Trash`, 6000, {
    label: 'Undo',
    fn: async () => {
      try {
        if (ids.length > 1) await fsRestoreMany(ids);
        else await fsRestoreDoc(id);
        await refreshSidebarList();
      } catch (err) {
        console.error('undo trash:', err);
        showToast('Undo failed');
      }
    },
  });
}

// Duplicate any document from the sidebar (keeps parent and tags). Unlike the
// toolbar Duplicate it does not switch the editor to the copy.
async function duplicateDocById(id) {
  if (!auth.currentUser) return;
  try {
    if (id === currentDocId && isDirty) { clearTimeout(autoSaveTimer); await performSave(true); }
    const src = await fsGet(id);
    if (!src || src.type === 'folder') return;
    const newId = crypto.randomUUID();
    const base = (src.title || 'untitled').replace(/\.(md|txt)$/i, '');
    const newTitle = base + ' copy.md';
    await fsPut(newId, newTitle, src.content || '', true, src.parentId || null);
    if (Array.isArray(src.tags) && src.tags.length) await fsUpdateTags(newId, src.tags);
    const nowMs = Date.now();
    _sidebarDocs.unshift({
      id: newId, userId: auth.currentUser.uid, title: newTitle, content: src.content || '',
      parentId: src.parentId || undefined, tags: src.tags || undefined, createdAt: nowMs, updatedAt: nowMs,
    });
    renderSidebarTree(_sidebarDocs, _sidebarFilter);
    showToast(`Duplicated as "${newTitle}"`);
  } catch (err) {
    console.error('duplicateDocById:', err);
    showToast('Duplicate failed');
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────
let _ctxMenuEl = null;
let _ctxTargetRow = null;
let _ctxCleanup = null;

function closeContextMenu() {
  if (_ctxCleanup) { _ctxCleanup(); _ctxCleanup = null; }
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
  if (_ctxTargetRow) { _ctxTargetRow.classList.remove('ctx-target'); _ctxTargetRow = null; }
}

// items: [{ label, action, danger?, disabled? } | { separator: true }]
function openContextMenu(x, y, items, targetRow) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  const buttons = [];
  items.forEach((it) => {
    if (it.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (it.danger ? ' ctx-danger' : '');
    b.setAttribute('role', 'menuitem');
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', () => { closeContextMenu(); it.action(); });
    menu.appendChild(b);
    buttons.push(b);
  });
  document.body.appendChild(menu);
  const pos = TreeUtils.clampMenu(x, y, menu.offsetWidth, menu.offsetHeight, window.innerWidth, window.innerHeight);
  menu.style.left = pos.left + 'px';
  menu.style.top = pos.top + 'px';
  _ctxMenuEl = menu;
  if (targetRow) { targetRow.classList.add('ctx-target'); _ctxTargetRow = targetRow; }

  const enabled = () => buttons.filter(b => !b.disabled);
  if (enabled()[0]) enabled()[0].focus();

  const onKey = (e) => {
    const list = enabled();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeContextMenu(); }
  };
  const onDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onClose = () => closeContextMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('scroll', onClose, true);
  window.addEventListener('blur', onClose);
  window.addEventListener('resize', onClose);
  _ctxCleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('scroll', onClose, true);
    window.removeEventListener('blur', onClose);
    window.removeEventListener('resize', onClose);
  };
}

function sidebarMenuItems(id) {
  const doc = id ? _sidebarDocs.find(d => d.id === id) : null;
  if (!doc) {
    return [
      { label: 'New document', action: startNewRootDoc },
      { label: 'New folder', action: () => createFolder(null) },
    ];
  }
  if (TreeUtils.isFolder(doc)) {
    return [
      { label: _sidebarExpanded.has(id) ? 'Collapse' : 'Expand', action: () => toggleFolder(id) },
      { separator: true },
      { label: 'New document here', action: () => addSubPage(id) },
      { label: 'New subfolder', action: () => createFolder(id) },
      { separator: true },
      { label: 'Rename', action: () => startInlineRename(id) },
      { label: 'Move to…', action: () => openMoveModal(id) },
      { separator: true },
      { label: 'Move to Trash', danger: true, action: () => trashItem(id) },
    ];
  }
  return [
    { label: 'Open', action: () => loadDoc(id) },
    { separator: true },
    { label: 'New sub-page', action: () => addSubPage(id) },
    { label: 'Rename', action: () => startInlineRename(id) },
    { label: 'Move to…', action: () => openMoveModal(id) },
    { label: 'Duplicate', action: () => duplicateDocById(id) },
    { separator: true },
    { label: 'Move to Trash', danger: true, action: () => trashItem(id) },
  ];
}

(function initSidebarContextMenu() {
  const list = document.getElementById('sidebar-list');
  if (!list) return;
  const openFor = (target, x, y) => {
    const row = target.closest ? target.closest('.sidebar-item') : null;
    openContextMenu(x, y, sidebarMenuItems(row ? row.dataset.id : null), row);
  };

  list.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.sb-rename-input')) return; // keep the native menu in the rename box
    e.preventDefault();
    openFor(e.target, e.clientX, e.clientY);
  });

  // Touch long-press: iOS Safari does not fire contextmenu.
  let timer = null;
  let sx = 0;
  let sy = 0;
  let fired = false;
  const cancel = () => clearTimeout(timer);
  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    sx = e.clientX; sy = e.clientY; fired = false;
    cancel();
    const target = e.target;
    timer = setTimeout(() => { fired = true; openFor(target, sx, sy); }, 550);
  });
  list.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel();
  });
  list.addEventListener('pointerup', cancel);
  list.addEventListener('pointercancel', cancel);
  // Swallow the click that follows a long-press so it does not also open the row.
  list.addEventListener('click', (e) => {
    if (fired) { fired = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

document.getElementById('sidebar-new-folder-btn')?.addEventListener('click', () => createFolder(null));
document.getElementById('sidebar-palette-btn')?.addEventListener('click', () => openPalette());

// ── Command palette (Ctrl/Cmd+K) ──────────────────────────────────────────────
const paletteModal = document.getElementById('palette-modal');
const paletteInput = document.getElementById('palette-input');
const paletteList  = document.getElementById('palette-list');
let _paletteRows = [];          // selectable rows: { el, run }
let _paletteSel = 0;
let _paletteReturnFocus = null;

function paletteCommands() {
  const clickId = (id) => () => { const el = document.getElementById(id); if (el) el.click(); };
  const hasDoc = () => !!currentDocId;
  return [
    { label: 'New document', hint: 'Ctrl/Cmd+N', keywords: 'create file', run: clickId('new-btn') },
    { label: 'New folder', keywords: 'create directory', run: () => createFolder(null) },
    { label: 'Open document browser', hint: 'Ctrl/Cmd+O', keywords: 'browse all files library open', run: openDocBrowser },
    { label: 'Save now', hint: 'Ctrl/Cmd+S', run: () => performSave(false) },
    { label: 'Rename current document', keywords: 'title', run: startRename },
    { label: 'Duplicate current document', keywords: 'copy', run: duplicateCurrentDoc, when: hasDoc },
    { label: 'Move current document to…', keywords: 'folder parent', run: () => openMoveModal(currentDocId), when: hasDoc },
    { label: 'Move current document to Trash', keywords: 'delete remove', run: deleteCurrentDoc, when: hasDoc },
    { label: 'Open Trash', keywords: 'deleted restore', run: openTrashModal },
    { label: 'Open Kanban board', keywords: 'tasks', run: openKanban },
    { label: 'Find and replace', hint: 'Ctrl/Cmd+F', keywords: 'search', run: openFindBar },
    { label: 'Toggle sidebar', hint: 'Ctrl/Cmd+\\', run: toggleSidebar },
    { label: 'Toggle focus mode', hint: 'F11', keywords: 'distraction free', run: toggleFocusMode },
    { label: 'Switch theme', keywords: 'dark light lokai appearance', run: clickId('theme-toggle-btn') },
    { label: 'View: editor only', run: clickId('view-edit-btn') },
    { label: 'View: split', run: clickId('view-split-btn') },
    { label: 'View: preview only', run: clickId('view-preview-btn') },
    { label: 'Zoom preview in', hint: 'Ctrl/Cmd+=', run: clickId('zoom-in-btn') },
    { label: 'Zoom preview out', hint: 'Ctrl/Cmd+-', run: clickId('zoom-out-btn') },
    { label: 'Reset preview zoom', hint: 'Ctrl/Cmd+0', run: clickId('zoom-reset-btn') },
    { label: 'Import files', keywords: 'upload markdown', run: clickId('hdr-import-btn') },
    { label: 'Export as Markdown (.md)', keywords: 'download', run: exportAsMd },
    { label: 'Export as text (.txt)', keywords: 'download', run: exportAsTxt },
    { label: 'Export as HTML', keywords: 'download', run: exportAsHtml },
    { label: 'Export as PDF', keywords: 'download print', run: exportAsPdf },
    { label: 'Export as Word (.docx)', keywords: 'download', run: exportAsDocx },
    { label: 'Export as RTF', keywords: 'download', run: exportAsRtf },
    { label: 'Sign out', keywords: 'log out', run: clickId('signout-btn') },
  ].filter(c => !c.when || c.when());
}

function paletteDocs() {
  const byId = new Map(_sidebarDocs.map(d => [d.id, d]));
  return _sidebarDocs.map(d => ({
    id: d.id,
    folder: TreeUtils.isFolder(d),
    title: (d.title || 'Untitled').replace(/\.md$/i, ''),
    path: TreeUtils.ancestorTitles(d.id, byId).join(' / '),
  }));
}

function renderPalette() {
  const raw = paletteInput.value.trimStart();
  const commandsOnly = raw.startsWith('>');
  const q = (commandsOnly ? raw.slice(1) : raw).trim();
  const cmds = paletteCommands();
  const docs = commandsOnly ? [] : paletteDocs();

  const sections = [];
  if (!q) {
    if (!commandsOnly) {
      const recent = docs.filter(d => !d.folder).slice(0, 6);
      if (recent.length) sections.push({ title: 'Recent documents', items: recent, kind: 'doc' });
    }
    sections.push({ title: 'Commands', items: cmds, kind: 'cmd' });
  } else {
    const cmdHits = TreeUtils.rank(q, cmds, c => [c.label, c.keywords || ''], 12);
    const docHits = TreeUtils.rank(q, docs, d => [d.title, d.path], 12);
    const top = (items, texts) => items.length
      ? Math.max(...texts(items[0]).map(t => TreeUtils.fuzzyScore(q, t))) : -1;
    const cmdSection = cmdHits.length ? { title: 'Commands', items: cmdHits, kind: 'cmd' } : null;
    const docSection = docHits.length ? { title: 'Documents', items: docHits, kind: 'doc' } : null;
    const docsFirst = top(docHits, d => [d.title, d.path]) >= top(cmdHits, c => [c.label, c.keywords || '']);
    (docsFirst ? [docSection, cmdSection] : [cmdSection, docSection]).forEach(s => { if (s) sections.push(s); });
  }

  paletteList.textContent = '';
  _paletteRows = [];
  if (!sections.length) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = 'No matching commands or documents';
    paletteList.appendChild(empty);
    paletteInput.removeAttribute('aria-activedescendant');
    return;
  }

  sections.forEach((section) => {
    const head = document.createElement('div');
    head.className = 'palette-section';
    head.textContent = section.title;
    paletteList.appendChild(head);
    section.items.forEach((item) => {
      const idx = _paletteRows.length;
      const el = document.createElement('div');
      el.className = 'palette-item';
      el.id = 'palette-opt-' + idx;
      el.setAttribute('role', 'option');

      const icon = document.createElement('span');
      icon.className = 'palette-icon';
      let run;
      let label;
      let meta = '';
      if (section.kind === 'doc') {
        icon.innerHTML = item.folder ? ICON_FOLDER : ICON_DOC; // static, trusted SVG
        label = item.title;
        meta = item.path;
        run = () => { if (item.folder) revealInSidebar(item.id); else loadDoc(item.id); };
      } else {
        icon.textContent = '›';
        label = item.label;
        meta = item.hint || '';
        run = item.run;
      }
      const labelEl = document.createElement('span');
      labelEl.className = 'palette-label';
      labelEl.textContent = label;
      const metaEl = document.createElement('span');
      metaEl.className = 'palette-meta';
      metaEl.textContent = meta;
      el.append(icon, labelEl, metaEl);

      el.addEventListener('mousemove', () => { if (_paletteSel !== idx) setPaletteSel(idx); });
      el.addEventListener('click', () => { _paletteSel = idx; runPaletteSel(); });
      paletteList.appendChild(el);
      _paletteRows.push({ el, run });
    });
  });
  setPaletteSel(Math.min(_paletteSel, _paletteRows.length - 1));
}

function setPaletteSel(i) {
  if (!_paletteRows.length) return;
  _paletteSel = (i + _paletteRows.length) % _paletteRows.length;
  _paletteRows.forEach((r, n) => {
    r.el.classList.toggle('selected', n === _paletteSel);
    r.el.setAttribute('aria-selected', n === _paletteSel ? 'true' : 'false');
  });
  const cur = _paletteRows[_paletteSel].el;
  paletteInput.setAttribute('aria-activedescendant', cur.id);
  cur.scrollIntoView({ block: 'nearest' });
}

function runPaletteSel() {
  const row = _paletteRows[_paletteSel];
  if (!row) return;
  closePalette(false);
  row.run();
}

function openPalette() {
  if (!auth.currentUser || !paletteModal) return;
  closeContextMenu();
  _paletteReturnFocus = document.activeElement;
  paletteInput.value = '';
  _paletteSel = 0;
  renderPalette();
  paletteModal.classList.add('open');
  paletteInput.focus();
}

function closePalette(restoreFocus) {
  if (!paletteModal || !paletteModal.classList.contains('open')) return;
  paletteModal.classList.remove('open');
  if (restoreFocus && _paletteReturnFocus && document.contains(_paletteReturnFocus)) {
    _paletteReturnFocus.focus();
  }
  _paletteReturnFocus = null;
}

function togglePalette() {
  if (paletteModal && paletteModal.classList.contains('open')) closePalette(true);
  else openPalette();
}

if (paletteModal && paletteInput) {
  paletteInput.addEventListener('input', () => { _paletteSel = 0; renderPalette(); });
  paletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteSel(_paletteSel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteSel(_paletteSel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteSel(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(true); }
  });
  paletteModal.addEventListener('mousedown', (e) => { if (e.target === paletteModal) closePalette(true); });
}

// Capture phase so it works wherever focus is (editor, preview, inputs).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    togglePalette();
  }
}, true);
