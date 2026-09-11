// ── Config ────────────────────────────────────────────────────────────────────
// Credentials are loaded from window.APP_CONFIG, which is populated by:
// 1. config.js (local development - gitignored)
// 2. Vercel build step via build-config.js (production - reads from Environment Variables)
//
// For local development: Copy config.example.js to config.js and fill in your credentials.
// For deployment: Set GOOGLE_CLIENT_ID and GOOGLE_API_KEY in Vercel Environment Variables.
//
// ⚠️ IMPORTANT: config.js is gitignored. Never commit actual credentials.

const APP_CONFIG       = window.APP_CONFIG || {};
const GOOGLE_CLIENT_ID = APP_CONFIG.GOOGLE_CLIENT_ID || '';
const GOOGLE_API_KEY   = APP_CONFIG.GOOGLE_API_KEY   || '';
// Full Drive scope: the narrow drive.file scope requires individually granting
// access to every file via the Picker, which does not scale. drive.file access
// is per-item and does not cascade from a selected folder to its existing
// children — see git history for the abandoned per-file-Picker-grant approach.
const SCOPES            = 'https://www.googleapis.com/auth/drive';
const DISCOVERY_DOC    = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const FOLDER_MIME       = 'application/vnd.google-apps.folder';
const RECENTS_KEY        = 'emdash-recents';
const RECENTS_MAX        = 8;
const DRIVE_AUTH_KEY     = 'emdash-drive-connected';
// Validate credentials are present
function validateCredentials() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_API_KEY) {
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (isDev) {
      console.warn(
        '⚠️ Google credentials not found.\n\n' +
        'For local development:\n' +
        '1. Copy config.example.js to config.js\n' +
        '2. Replace PLACEHOLDER values with actual credentials from Google Cloud Console\n' +
        '3. See CREDENTIAL_ROTATION_GUIDE.md for setup and rotation instructions\n\n' +
        'For production: Credentials are injected at deploy time from Vercel Environment Variables.'
      );
    } else {
      console.error(
        '❌ Critical Error: Google credentials not found on production.\n' +
        'This should not happen. Check that Vercel Environment Variables are configured correctly.'
      );
      // Show user-friendly error
      document.body.innerHTML =
        '<div style="padding:20px;font-family:system-ui;color:#cf222e;">' +
        '<h2>Configuration Error</h2>' +
        '<p>Google credentials are not configured. The application cannot function.</p>' +
        '<p>This is likely a deployment issue. Please contact the administrator.</p>' +
        '</div>';
    }
  }
}

// Validate on load
validateCredentials();

// ── State ─────────────────────────────────────────────────────────────────────
let driveConnected     = false;
let driveFileId        = null;
let driveFileName      = null;
let driveFileParentId  = null; // parent folder of the currently open Drive file
let currentTitle       = 'New Document';
let isDirty            = false;
let autoSaveTimer      = null;
let tokenClient        = null;
let driveRootFolderId  = null; // 'root' when connected, null when signed out

// ── DOM refs ──────────────────────────────────────────────────────────────────
const editor         = document.getElementById('editor');
const previewInner   = document.getElementById('preview-inner');
const previewPane    = document.getElementById('preview-pane');
const lineNumbers    = document.getElementById('line-numbers');
const tbTitle        = document.getElementById('tb-title');
const titleInput     = document.getElementById('title-input');
const saveStatus     = document.getElementById('save-status');
const driveFileInfo  = document.getElementById('drive-file-info');
const toast          = document.getElementById('toast');

// ── Marked setup ─────────────────────────────────────────────────────────────
if (window.marked && window.hljs) {
  marked.use({
    renderer: {
      // marked 12 calls this with positional args (code, infostring); other
      // versions pass a token object ({ text, lang }). Handle both, and never
      // pass undefined to highlight.js.
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

// Harden links in sanitized output: any anchor that opens a new tab gets
// rel="noopener noreferrer" so the target page can't reach back via window.opener.
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
// Built via DOM APIs (not string concatenation into innerHTML) so this trusted
// UI markup never has to pass through DOMPurify alongside untrusted content.
const COPY_ICON_SVG  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function addCodeCopyButtons() {
  previewInner.querySelectorAll('pre').forEach((pre) => {
    if (!pre.querySelector('code')) return; // skip raw <pre> blocks with no fenced code
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
    // Always reset to the fixed copy icon (never read back btn.innerHTML) and
    // clear any pending revert so rapid re-clicks just restart the countdown
    // instead of a stale timer stranding the button on the checkmark.
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

editor.addEventListener('input', () => {
  isDirty = true;
  renderPreview();
  updateStats();
  updateLineNumbers();
  scheduleAutoSave();
});
editor.addEventListener('click',  updateCursor);
editor.addEventListener('keyup',  updateCursor);

// ── Line numbers ──────────────────────────────────────────────────────────────
function updateLineNumbers() {
  const lines = editor.value.split('\n').length;
  lineNumbers.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join('<br>');
}

// Sync scroll between line numbers, editor, and preview pane
let scrollingEditor  = false;
let scrollingPreview = false;

editor.addEventListener('scroll', () => {
  lineNumbers.scrollTop = editor.scrollTop;
  if (scrollingPreview) return;
  scrollingEditor = true;
  const ratio = editor.scrollTop / Math.max(1, editor.scrollHeight - editor.clientHeight);
  previewPane.scrollTop = ratio * (previewPane.scrollHeight - previewPane.clientHeight);
  requestAnimationFrame(() => { scrollingEditor = false; });
});

previewPane.addEventListener('scroll', () => {
  if (scrollingEditor) return;
  scrollingPreview = true;
  const ratio = previewPane.scrollTop / Math.max(1, previewPane.scrollHeight - previewPane.clientHeight);
  editor.scrollTop = ratio * (editor.scrollHeight - editor.clientHeight);
  lineNumbers.scrollTop = editor.scrollTop;
  requestAnimationFrame(() => { scrollingPreview = false; });
});

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
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
    if (driveFileId) driveFileName = currentTitle;
  }
  titleInput.style.display = 'none';
  tbTitle.style.display = '';
}

function setTitle(name) {
  currentTitle = name;
  tbTitle.textContent = name;
}

// ── Drive status display ──────────────────────────────────────────────────────
const toolbarDriveDot = document.getElementById('toolbar-drive-dot');
const toolbarDriveTip = document.getElementById('toolbar-drive-tip');

function setDriveStatus(state, text) {
  toolbarDriveDot.className = state || '';
  if (toolbarDriveTip) toolbarDriveTip.textContent = text || 'Not connected to Drive';

  // Show/hide the header "delete current file" button based on connection
  // state and whether a file is currently open.
  const isFileOpen = driveFileId !== null;
  document.getElementById('drive-delete-btn').style.display = state === 'connected' && isFileOpen ? 'inline-flex' : 'none';
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
  clearTimeout(autoSaveTimer);
  if (!driveConnected) return;
  saveStatus.textContent = 'Unsaved…';
  autoSaveTimer = setTimeout(async () => { await performSave(true); }, 2000);
}

async function performSave(silent = false) {
  if (!isDirty) return;
  const content = editor.value;
  if (!driveConnected) {
    if (!silent) showToast('Connect Google Drive to save');
    return;
  }
  if (driveFileId) { await saveToDrive(content, silent); }
  else              { await saveNewToDrive(content, currentTitle, silent); }
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

document.getElementById('new-modal-cancel').addEventListener('click', () => {
  document.getElementById('new-modal').classList.remove('open');
});
document.getElementById('new-modal-ok').addEventListener('click', createNewDoc);
document.getElementById('new-filename').addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  createNewDoc();
  if (e.key === 'Escape') document.getElementById('new-modal').classList.remove('open');
});

function createNewDoc() {
  let name = document.getElementById('new-filename').value.trim() || 'untitled.md';
  if (!name.includes('.')) name += '.md';
  document.getElementById('new-modal').classList.remove('open');
  editor.value     = '';
  setTitle(name);
  driveFileId       = null;
  driveFileName     = null;
  driveFileParentId = null;
  isDirty           = false;
  saveStatus.textContent    = '';
  driveFileInfo.textContent = driveConnected ? '☁ Drive (new)' : '';
  updateDriveLink(null);
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
}

// ── Google Drive ──────────────────────────────────────────────────────────────
async function initGoogleApi() {
  return new Promise((resolve, reject) => {
    gapi.load('client', async () => {
      try {
        await gapi.client.init({ apiKey: GOOGLE_API_KEY, discoveryDocs: [DISCOVERY_DOC] });
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

// gapi/Google errors are nested objects; pull out something human-readable.
function gErr(e) {
  if (!e) return 'unknown error';
  return (e.result && e.result.error && e.result.error.message) ||
         e.details || e.message ||
         (typeof e === 'string' ? e : JSON.stringify(e));
}

// ── Silent re-auth on page load ───────────────────────────────────────────────
// If the user previously connected, attempt a silent token refresh so they
// don't have to click "Connect" again after a page reload.
function trySilentAuth() {
  let wasConnected = false;
  try { wasConnected = localStorage.getItem(DRIVE_AUTH_KEY) === '1'; } catch (_) {}
  if (!wasConnected) return;
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes('PLACEHOLDER') || GOOGLE_CLIENT_ID.includes('YOUR_')) return;
  if (!window.google || !google.accounts || !google.accounts.oauth2) return;

  const silentClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    prompt: '',
    callback: async (response) => {
      if (response.error) {
        try { localStorage.removeItem(DRIVE_AUTH_KEY); } catch (_) {}
        return;
      }
      try {
        await initGoogleApi();
        gapi.client.setToken({ access_token: response.access_token });
        onDriveConnected();
      } catch (e) {
        console.error('Silent Drive init failed:', e);
      }
    },
  });
  silentClient.requestAccessToken({ prompt: '' });
}

// Create the GSI token client once. This is synchronous config only — safe to
// call inside a click handler so the OAuth popup opens within the user gesture.
function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  if (!window.google || !google.accounts || !google.accounts.oauth2) return null;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: async (response) => {
      if (response.error) { setDriveStatus('error', 'Auth failed'); showToast('Google sign-in failed: ' + response.error); return; }
      try {
        await initGoogleApi();                                  // load Drive client lib now that we have a token
        gapi.client.setToken({ access_token: response.access_token });
        onDriveConnected();
      } catch (e) {
        console.error('Drive init failed:', e);
        setDriveStatus('error', 'Setup failed');
        showToast('Drive setup failed: ' + gErr(e), 5000);
      }
    },
  });
  return tokenClient;
}

async function onDriveConnected() {
  driveConnected = true;
  try { localStorage.setItem(DRIVE_AUTH_KEY, '1'); } catch (_) {}
  try { localStorage.removeItem('emdash-root-folder-id'); } catch (_) {}
  driveRootFolderId = 'root';
  setDriveStatus('connected', 'Drive connected');
  document.getElementById('hdr-drive-connect').style.display  = 'none';
  document.getElementById('hdr-drive-signout').style.display  = '';
  document.getElementById('open-drive-btn').style.display = '';
  if (!driveFileId) driveFileInfo.textContent = '☁ Drive (new)';
  renderRecents();
  showToast('✓ Connected to Google Drive');
  loadPickerApi();
}

document.getElementById('hdr-drive-connect').addEventListener('click', () => {
  document.getElementById('hdr-more-menu').classList.remove('open');
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes('PLACEHOLDER') || GOOGLE_CLIENT_ID.includes('YOUR_')) {
    showToast('⚠ Add your Google credentials in config.js first', 4000); return;
  }
  const client = ensureTokenClient();
  if (!client) {
    showToast('Google sign-in library not loaded yet — check your connection and retry', 4000); return;
  }
  // Called synchronously within the click so the browser allows the popup.
  client.requestAccessToken({ prompt: 'consent' });
});

document.getElementById('hdr-drive-signout').addEventListener('click', () => {
  document.getElementById('hdr-more-menu').classList.remove('open');
  const token = gapi.client.getToken();
  if (token) google.accounts.oauth2.revoke(token.access_token);
  gapi.client.setToken('');
  try { localStorage.removeItem(DRIVE_AUTH_KEY); } catch (_) {}
  driveConnected    = false;
  driveFileId       = null;
  driveFileName     = null;
  driveFileParentId = null;
  driveRootFolderId = null;
  setDriveStatus('', 'Not connected to Drive');
  document.getElementById('hdr-drive-connect').style.display  = '';
  document.getElementById('hdr-drive-signout').style.display  = 'none';
  document.getElementById('open-drive-btn').style.display = 'none';
  document.getElementById('recent-btn').style.display = 'none';
  driveFileInfo.textContent = '';
  updateDriveLink(null);
  showToast('Signed out of Google Drive');
});

// ── Recently opened files ─────────────────────────────────────────────────────
function getRecents() {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; } catch (_) { return []; }
}
function addToRecents(id, name, parentId) {
  let list = getRecents().filter(r => r.id !== id);
  list.unshift({ id, name, parentId });
  if (list.length > RECENTS_MAX) list = list.slice(0, RECENTS_MAX);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch (_) {}
  renderRecents();
}
function renderRecents() {
  const list = driveConnected ? getRecents() : [];
  const btn  = document.getElementById('recent-btn');
  const menu = document.getElementById('recent-menu');
  if (!btn || !menu) return;
  if (!list.length) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  menu.innerHTML = '';
  list.forEach(r => {
    const item = document.createElement('button');
    item.className = 'hdr-dd-item';
    item.textContent = r.name;
    item.title = r.name;
    item.addEventListener('click', () => {
      menu.classList.remove('open');
      if (isDirty && !confirm('You have unsaved changes. Open this file anyway?')) return;
      loadDriveFile(r.id, r.name, r.parentId);
    });
    menu.appendChild(item);
  });
}

document.getElementById('recent-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('recent-menu').classList.toggle('open');
  document.getElementById('hdr-more-menu').classList.remove('open');
});

// ── Open in Drive link ────────────────────────────────────────────────────────
function updateDriveLink(fileId) {
  const link = document.getElementById('drive-open-link');
  if (!link) return;
  if (fileId) {
    link.href = 'https://drive.google.com/file/d/' + fileId + '/view';
    link.style.display = '';
  } else {
    link.style.display = 'none';
  }
}

async function loadDriveFile(fileId, fileName, parentId) {
  try {
    setDriveStatus('saving', 'Loading…');
    const meta = await gapi.client.drive.files.get({ fileId, fields: 'id,mimeType' });
    const mimeType = meta.result.mimeType;
    if (!canOpenAsText(mimeType)) {
      setDriveStatus('connected', 'Drive connected');
      showToast('This file type cannot be opened as text (' + mimeType + ')', 4000);
      return;
    }
    let content;
    if (isGoogleDocsFile(mimeType)) {
      const res = await gapi.client.request({ path: `/drive/v3/files/${fileId}/export`, params: { mimeType: 'text/plain' } });
      content = res.body;
    } else {
      const res = await gapi.client.drive.files.get({ fileId, alt: 'media' });
      content = res.body;
    }
    editor.value       = content;
    driveFileId        = fileId;
    driveFileName      = fileName;
    driveFileParentId  = parentId || driveFileParentId || driveRootFolderId;
    setTitle(fileName);
    isDirty = false;
    saveStatus.textContent    = 'Opened from Drive';
    driveFileInfo.textContent = '☁ Google Drive';
    setDriveStatus('connected', 'Drive connected');
    renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
    addToRecents(fileId, fileName, driveFileParentId);
    updateDriveLink(fileId);
    showToast('✓ Opened ' + fileName);
  } catch (e) {
    setDriveStatus('error', 'Load failed');
    showToast('Could not open file: ' + gErr(e));
  }
}

document.getElementById('drive-delete-btn').addEventListener('click', () => {
  if (!driveFileId) { showToast('No file open'); return; }
  deleteDriveItem({ id: driveFileId, name: driveFileName, parents: [driveFileParentId] }, false);
});

async function saveToDrive(content, silent = false) {
  try {
    setDriveStatus('saving', 'Saving…');
    const boundary = '-------314159265358979323846';
    const metadata = JSON.stringify({ name: driveFileName || currentTitle, mimeType: 'text/markdown' });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--${boundary}--`;
    await gapi.client.request({ path: `/upload/drive/v3/files/${driveFileId}`, method: 'PATCH', params: { uploadType: 'multipart' }, headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` }, body });
    isDirty = false;
    saveStatus.textContent = silent ? `Saved ${new Date().toLocaleTimeString()}` : 'Saved to Drive';
    setDriveStatus('connected', 'Drive connected');
    if (!silent) showToast('✓ Saved to Google Drive');
  } catch (e) {
    setDriveStatus('error', 'Save failed');
    showToast('Drive save failed: ' + gErr(e));
  }
}

async function saveNewToDrive(content, filename, silent = false, parentId) {
  try {
    setDriveStatus('saving', 'Saving…');
    const targetParent = parentId || driveRootFolderId;
    const boundary = '-------314159265358979323846';
    const metadata = JSON.stringify({ name: filename, mimeType: 'text/markdown', parents: [targetParent] });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--${boundary}--`;
    const res = await gapi.client.request({ path: '/upload/drive/v3/files', method: 'POST', params: { uploadType: 'multipart' }, headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` }, body });
    driveFileId       = res.result.id;
    driveFileName     = filename;
    driveFileParentId = targetParent;
    isDirty = false;
    saveStatus.textContent    = 'Saved to Drive';
    driveFileInfo.textContent = '☁ Google Drive';
    setDriveStatus('connected', 'Drive connected');
    if (!silent) showToast('✓ Saved to Google Drive');
  } catch (e) {
    setDriveStatus('error', 'Save failed');
    showToast('Drive save failed: ' + gErr(e));
  }
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
    // Empty list item — exit the list, remove prefix
    const newValue  = value.slice(0, lineStart) + '\n' + value.slice(lineStart + prefix.length);
    editor.value    = newValue;
    editor.setSelectionRange(lineStart + 1, lineStart + 1);
  } else {
    // Continue list on next line
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

// Turndown instance for HTML → Markdown on exit
let td;
function getTurndown() {
  if (!td && window.TurndownService) {
    td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  }
  return td;
}

// ── Typewriter scrolling (focus mode) ────────────────────────────────────────
function typewriterScroll() {
  if (!focusMode) return;
  // Use a temporary invisible span to find the cursor's Y position in the textarea
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
  // Render markdown into the WYSIWYG pane
  focusWysiwyg.innerHTML = (window.marked && window.DOMPurify)
    ? DOMPurify.sanitize(marked.parse(editor.value || ''))
    : editor.value;
  focusWysiwyg.focus();
}

function exitFocusMode() {
  // Convert WYSIWYG HTML back to markdown
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

// Sanitize pasted content — strip rich HTML, keep plain text only
focusWysiwyg.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, text);
});

// Live sync: keep editor.value up to date while editing in WYSIWYG
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

// Exit focus mode if user presses Escape or browser exits fullscreen
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && focusMode) exitFocusMode();
});

document.getElementById('focus-btn').addEventListener('click', toggleFocusMode);
document.getElementById('focus-exit-btn').addEventListener('click', exitFocusMode);

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 's') { e.preventDefault(); performSave(false); }
  if (mod && e.key === 'n') { e.preventDefault(); if (!isDirty || confirm('Discard changes?')) openNewModal(); }
  if (mod && e.key === 'o') { e.preventDefault(); driveConnected ? openPicker() : document.getElementById('hdr-drive-connect').click(); }
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
  const mainContent  = document.getElementById('main-content');
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
  // Reselect the inner content
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
  // Strip any existing heading prefix
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

// Heading dropdown
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

// Code dropdown
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

// Close dropdowns on outside click
document.addEventListener('click', () => {
  document.getElementById('fmt-heading-menu').classList.remove('open');
  document.getElementById('fmt-code-menu').classList.remove('open');
  document.getElementById('hdr-more-menu').classList.remove('open');
  document.getElementById('recent-menu').classList.remove('open');
});

// Keyboard shortcuts for formatting
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

// ── Drive file type helpers ────────────────────────────────────────────────────
function isMarkdownLikeFile(f) {
  return f.mimeType === 'text/markdown' || f.mimeType === 'text/plain' ||
         /\.(md|markdown|txt)$/i.test(f.name || '');
}

function isGoogleDocsFile(mimeType) {
  return mimeType === 'application/vnd.google-apps.document';
}

function canOpenAsText(mimeType) {
  return isMarkdownLikeFile({ mimeType }) || isGoogleDocsFile(mimeType) ||
         mimeType === 'application/octet-stream';
}

// ── Google Picker ─────────────────────────────────────────────────────────────
let pickerApiReady = false;

function loadPickerApi() {
  if (pickerApiReady || !window.gapi) return;
  gapi.load('picker', () => { pickerApiReady = true; });
}

function openPicker() {
  if (!driveConnected) { showToast('Connect Google Drive first'); return; }
  if (!pickerApiReady) {
    loadPickerApi();
    showToast('Picker loading, try again in a moment');
    return;
  }
  const token = gapi.client.getToken();
  if (!token || !token.access_token) { showToast('Not authenticated'); return; }

  const view = new google.picker.DocsView()
    .setIncludeFolders(false)
    .setSelectFolderEnabled(false)
    .setMode(google.picker.DocsViewMode.LIST);

  const picker = new google.picker.PickerBuilder()
    .addView(view)
    .addView(new google.picker.DocsView(google.picker.ViewId.RECENTLY_PICKED))
    .setOAuthToken(token.access_token)
    .setDeveloperKey(GOOGLE_API_KEY)
    .setCallback(pickerCallback)
    .setTitle('Open from Google Drive')
    .build();
  picker.setVisible(true);
}

function pickerCallback(data) {
  if (data[google.picker.Response.ACTION] !== google.picker.Action.PICKED) return;
  const doc = data[google.picker.Response.DOCUMENTS][0];
  if (!doc) return;
  if (isDirty && !confirm('You have unsaved changes. Open this file anyway?')) return;
  const parentId = (doc.parentId) || driveRootFolderId;
  loadDriveFile(doc.id, doc.name, parentId);
}

document.getElementById('open-drive-btn').addEventListener('click', () => {
  if (!driveConnected) {
    showToast('Connect Google Drive first');
    return;
  }
  openPicker();
});

// ── Delete ────────────────────────────────────────────────────────────────────
async function deleteDriveItem(node, isFolder) {
  const label = isFolder ? `"${node.name}" and everything inside it` : `"${node.name}"`;
  if (!confirm(`Delete ${label} from Google Drive? This cannot be undone.`)) return;
  try {
    await gapi.client.drive.files.delete({ fileId: node.id });
    if (!isFolder && driveFileId === node.id) {
      driveFileId = null; driveFileName = null; driveFileParentId = null;
      currentTitle = 'New Document';
      editor.value = ''; isDirty = false;
      setTitle('New Document');
      driveFileInfo.textContent = '';
      saveStatus.textContent = '';
      renderPreview(); updateStats(); updateLineNumbers();
    }
    showToast('✓ Deleted');
  } catch (e) {
    showToast('Delete failed: ' + gErr(e));
  }
}

// ── Drive file upload (used by import) ────────────────────────────────────────
// Uploads one file to Drive without side effects (no tree refresh, no
// switching the open editor). Used directly by bulk import so a batch of N
// files doesn't steal focus N times.
async function createDriveFileRaw(name, parentId, content = '') {
  const boundary = '-------314159265358979323846';
  const metadata = JSON.stringify({ name, mimeType: 'text/markdown', parents: [parentId] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await gapi.client.request({
    path: '/upload/drive/v3/files', method: 'POST', params: { uploadType: 'multipart' },
    headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` }, body
  });
  return res.result;
}

async function createDriveFileInFolder(name, parentId, content = '') {
  const result = await createDriveFileRaw(name, parentId, content);
  await loadDriveFile(result.id, name, parentId);
  return result;
}

// ── Import / Export ─────────────────────────────────────────────────────────
// Import: pick a local .md/.txt file and upload it to Drive root.
// Export: download the currently-open file as .md.

document.getElementById('hdr-import-btn').addEventListener('click', () => {
  document.getElementById('hdr-more-menu').classList.remove('open');
  if (!driveConnected) { showToast('Connect Google Drive first'); return; }
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;
  if (!driveConnected) { showToast('Connect Google Drive first'); return; }

  // Single file: keep the original behavior (opens it in the editor after upload).
  // Multiple files: bulk-import without switching the open editor after every file.
  if (files.length === 1) {
    const file = files[0];
    try {
      const text = await file.text();
      const targetFolder = driveRootFolderId;
      await createDriveFileInFolder(file.name, targetFolder, text);
      showToast(`✓ Imported "${file.name}"`);
    } catch (err) {
      showToast('Import failed: ' + gErr(err));
    }
    return;
  }

  const targetFolder = driveRootFolderId;
  let succeeded = 0;
  const failed = [];
  for (const file of files) {
    showToast(`Importing ${succeeded + failed.length + 1}/${files.length}: "${file.name}"…`, 60000);
    try {
      const text = await file.text();
      await createDriveFileRaw(file.name, targetFolder, text);
      succeeded++;
    } catch (err) {
      failed.push(`${file.name} (${gErr(err)})`);
    }
  }

  if (failed.length === 0) {
    showToast(`✓ Imported ${succeeded} file${succeeded === 1 ? '' : 's'}`);
  } else {
    showToast(`Imported ${succeeded}/${files.length} — failed: ${failed.join(', ')}`, 8000);
    console.warn('[import] Failed files:', failed);
  }
});

function exportBasename() {
  return (driveFileName || currentTitle || 'untitled').replace(/\.(md|markdown|txt)$/i, '');
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
  function esc(t) {
    return t.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
            .replace(/[^\x00-\x7F]/g, c => `\\u${c.charCodeAt(0)}?`);
  }
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return esc(node.textContent);
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

// ── Boot ──────────────────────────────────────────────────────────────────────
renderPreview();
updateStats();
updateCursor();
updateLineNumbers();
applyZoom();
trySilentAuth();

// Launched via the "New Document" home-screen/app shortcut (manifest.json ->
// shortcuts[0].url = "/?new=1"). Reset to a blank untitled document and strip
// the query param so a later reload of this tab doesn't re-trigger it.
if (new URLSearchParams(window.location.search).get('new') === '1') {
  editor.value      = '';
  driveFileId        = null;
  driveFileName      = null;
  driveFileParentId  = null;
  isDirty            = false;
  setTitle('New Document');
  saveStatus.textContent    = '';
  driveFileInfo.textContent = driveConnected ? '☁ Drive (new)' : '';
  updateDriveLink(null);
  renderPreview(); updateStats(); updateCursor(); updateLineNumbers();
  window.history.replaceState({}, '', window.location.pathname);
}
