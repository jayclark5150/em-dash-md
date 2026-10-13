# EM-Dash MD

A cloud-first Markdown editor that lives in your browser. Sign in once and your documents follow you everywhere — stored securely in Firestore, never on your device.

**[Launch App →](https://em-dash-md.web.app)**

---

## Features

- **Secure sign-in** — Google account or email/password
- **Cloud storage** — Documents stored in Firestore, scoped to your account
- **Split view** — Markdown editor on the left, live rendered preview on the right
- **Auto-save** — Changes save automatically 2 seconds after you stop typing
- **Focus mode** — Distraction-free full-screen WYSIWYG writing (F11)
- **Find & Replace** — With match navigation and replace-all
- **Export** — Download as MD, TXT, HTML, PDF, DOCX, or RTF
- **Import** — Upload local `.md` or `.txt` files directly into your cloud library
- **Syntax highlighting** — Fenced code blocks with language detection
- **Themes** — Lokai (dark editor / white chrome), Dark, Light
- **Installable** — Works as a PWA on desktop, iPhone, and iPad
- **Preview zoom** — Scale the preview pane independently of the editor
- **Document tags** — Tag documents and filter your library by tag; tags are stored in Firestore alongside the document
- **Sidebar navigation** — persistent left panel showing your document list with search, new-document button, and browse-all link; collapsible via toolbar button or Ctrl/Cmd+\
- **Nested pages** — documents can be organized into a hierarchy; create child pages from the sidebar context menu and drag to rearrange
- **Trash bin** — deleted documents move to Trash and can be restored or permanently deleted; accessible via the sidebar footer
- **Full-text search** — the document browser searches inside document content and shows a highlighted snippet when the match is in the body rather than the title or tags
- **Table insert** — toolbar button inserts a Markdown table; the dropdown arrow opens a 5×5 grid picker to choose the exact dimensions
- **Mermaid diagrams** — fenced code blocks tagged ` ```mermaid ` render as live diagrams in the preview pane
- **Folders**: create folders in the sidebar and put documents or other folders inside; a new folder opens in rename mode, and folders sort first
- **Right-click menu**: right-click (or long-press on touch) a sidebar item for Rename, Move to, Duplicate, New sub-page or folder, and Move to Trash; right-click empty space for New document or New folder
- **Command palette**: Ctrl/Cmd+K opens a fuzzy finder for commands and documents; start with `>` to search commands only
- **Delete My Account** — permanently delete your account and all documents from within the app, after typed confirmation and re-authentication

---

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Save | Ctrl/Cmd+S |
| New document | Ctrl/Cmd+N |
| Open document | Ctrl/Cmd+O |
| Find & Replace | Ctrl/Cmd+F |
| Focus Mode | F11 or Ctrl/Cmd+Shift+F |
| Bold | Ctrl/Cmd+B |
| Italic | Ctrl/Cmd+I |
| Zoom in / out | Ctrl/Cmd+= / Ctrl/Cmd+- |
| Reset zoom | Ctrl/Cmd+0 |
| Toggle sidebar | Ctrl/Cmd+\ |
| Command palette | Ctrl/Cmd+K |

---

## Self-Hosting

To run your own instance against your own Firebase project:

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a project
2. **Authentication → Sign-in method** → enable **Email/Password** and **Google**
3. **Firestore Database** → Create database → production mode
4. **Firestore → Indexes** → add a composite index:
   - Collection: `documents`
   - Fields: `userId` Ascending, `updatedAt` Descending
5. **Firestore → Rules** → paste the contents of `firestore.rules`
6. **Project Settings → Your apps** → register a Web app → copy the config object

### 2. Add your config

Copy `firebase-config.example.js` to `firebase-config.js` and fill in your values:

```js
const FIREBASE_CONFIG = {
  apiKey:            "AIza...",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "000000000000",
  appId:             "1:000000000000:web:abc123"
};
```

`firebase-config.js` is gitignored and never committed.

### 3. Deploy

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

The repo already contains `firebase.json` and `.firebaserc`, so do not run `firebase init hosting` (it can overwrite them). Edit `.firebaserc` to point at your own project instead.

Hosting serves the project root (`"public": "."`), so everything not listed in the `ignore` array of `firebase.json` is public. The list already excludes tests, scripts, patches, `package*.json`, `buildme.sh`, Firestore files and key files. If you add a new file or folder that must stay private, add it to that list. `npm run test:unit` fails if the key entries are removed. After a deploy, the file count it prints should match what you expect to serve (25 at v3.29.1).

---

## Testing

```bash
npm install
npx playwright install chromium   # once, for the browser tests
npm test                          # syntax check, unit, round-trip and browser tests
```

The browser tests (`tests/e2e-*.cjs`) run the real app in headless Chromium against an in-memory Firebase stub, so they never touch your Firestore data. `npm run test:unit` runs only the fast tests.

---

## Security

- Documents are scoped to each user's UID — Firestore rules block cross-user access server-side
- Content Security Policy restricts all resource origins
- Markdown preview is sanitized with DOMPurify before rendering
- `firebase-config.js` is gitignored and never touches the repository

---

## Tech Stack

Plain HTML, CSS, and JavaScript — no build step, no framework.

| Library | Purpose |
|---------|---------|
| Firebase Auth (compat v9) | Authentication |
| Cloud Firestore (compat v9) | Document storage |
| [Marked](https://marked.js.org) | Markdown → HTML |
| [highlight.js](https://highlightjs.org) | Syntax highlighting |
| [DOMPurify](https://github.com/cure53/DOMPurify) | XSS sanitization |
| [Turndown](https://github.com/mixmark-io/turndown) | HTML → Markdown (focus mode exit) |
| [Mermaid](https://mermaid.js.org) | Diagram rendering |
| Firebase Hosting | Deployment |

---

## Changelog

### v3.30.0
- **New**: the search boxes in the sidebar and in Open Document have an ✕ button that clears the text and restores the full list

### v3.29.1
- **Security**: risky HTML in diagram labels is removed before the diagram library sees it (the browser security policy was already blocking it)
- **Security**: hosting no longer serves `tests/`, `buildme.sh` or `_to_delete/`; a test guards the ignore list
- **Cleanup**: the retired MCP server, its Dockerfile and the `firebase-admin` dependency were removed from the repository

### v3.29.0
- **Fix**: storage access can no longer stop the app from starting (blocked or corrupt browser storage is ignored)
- **Fix**: saves are queued one at a time, a save no longer marks text typed during it as saved, and saving over a version changed on another device asks first
- **Security**: diagrams are rendered in strict mode, sanitized and cached
- **Security**: signing out or deleting the account clears the offline cache and every list on screen, then reloads
- **Fix**: HTML, PDF and Word exports no longer contain copy buttons, and RTF export keeps tables
- **Fix**: list continuation, Replace All and leaving Focus Mode keep Ctrl+Z history
- **Fix**: email and password sign-up sends a verification email and explains the next step
- **Offline**: Firebase and diagram libraries are cached, and app files are always revalidated

### v3.28.0
- **Fix (cost)**: saving no longer re-reads 300 documents; the sidebar is updated from memory. Trash and Kanban read only the documents they show
- **Fix**: trashed documents no longer use up slots in the 300-document sidebar window, and a page whose parent is outside the window keeps its place in the tree
- **Fix**: edits made in Focus Mode and with Replace All are now auto-saved
- **Fix**: signing out and back in no longer doubles sidebar and mobile handlers

### v3.27.0
- **Folders**: real folders in the sidebar (stored as documents with `type: folder`, so no migration or rules change). Move to Trash takes the folder and everything inside it; Restore and Delete permanently from Trash act on the whole folder
- **Right-click context menu**: sidebar items and empty sidebar space, with keyboard navigation and touch long-press
- **Command palette**: Ctrl/Cmd+K, fuzzy search across commands and documents
- **Fix**: a new document no longer inherits the previously open document's parent page
### v3.26.0
- **Sidebar sort toggle** — switch between **Groups** (hierarchical tree) and **Name** (flat A–Z list) using the toggle below the search box; preference persists across sessions

### v3.25.0
- **Resizable sidebar** — drag the handle between the sidebar and editor to set any width you like; the chosen width persists across sessions; double-click the handle to reset to the default

### v3.24.0
- **Mermaid diagrams** — fenced code blocks tagged ` ```mermaid ` render as live flowcharts, sequence diagrams, Gantt charts, and more in the preview pane
- **Table insert** — new toolbar split-button inserts a default Markdown table; the dropdown arrow opens a 5×5 hover grid to pick exact dimensions
- **Full-text search** — document browser now searches inside document content; matching body text shows a highlighted snippet beneath the title
- **Trash bin** — deleted documents are soft-deleted and moved to Trash (sidebar footer icon); restore individual documents or empty the trash permanently

### v3.23.0
- **Nested pages** — documents can be organized into a parent/child hierarchy from the sidebar; drag to rearrange, and expand/collapse subtrees

### v3.22.0
- **Sidebar navigation** — persistent left panel (Notion/Anytype-style) shows your recent documents, a search field, a new-document button, and a "Browse all" link to the full document browser; collapses inline on desktop or slides in as an overlay on mobile; state persists across sessions

### v3.19.2
- **Resizable document browser** — drag the grip in the bottom-right corner of the Open Document window to resize it; the chosen size is remembered across sessions

### v3.19.0
- **Domain restriction** — access is now limited to `@michaelson-clark.com` accounts; unauthorized users are signed out immediately with a clear message, and Firestore rules enforce the same check at the database level (requires email verification)

### v3.18.0
- **Delete My Account** — new danger-zone option in the ellipsis menu; requires typing "DELETE" and re-authenticating (password re-entry, or a Google re-auth popup) before permanently deleting all documents and the account itself

### v3.17.0
- **Local caching** — Firestore reads are now cached in IndexedDB (`enablePersistence`); the Open Document browser paints instantly from the local cache and refreshes from the server in the background (stale-while-revalidate) instead of waiting on a round trip every time it opens
- **Document browser redesigned** — replaced the card layout with a compact, Finder-style list: click the Name / Words / Date Modified column headers to sort (ascending/descending), tags now sit inline next to the title and their edit control appears on hover
- Browser modal widened to 760px for the new column layout; the old Newest/Oldest/A-Z/Z-A sort dropdown and the 2-line content preview were removed in favor of the sortable columns
- Service worker cache bumped to `em-dash-md-v3` so installed/PWA users pick up this update instead of serving a stale cached copy

### v3.16.0
- **Enriched document browser** — each entry now shows a file-type badge (MD, TXT, etc.), word count, date created, date modified, and a 2-line content preview with markdown syntax stripped
- **Tags** — add comma-separated tags to any document directly in the browser; tags are stored in Firestore and persist across sessions
- **Tag filter** — filter the document list by tag using the new dropdown next to the search box; search also matches tag text
- Browser modal widened to 640 px to accommodate the richer layout

### v3.15.5
- Word goal: click the word count in the status bar to set a target; turns accent color when met; persists across sessions

### v3.15.4
- Document browser now shows a count in the footer ("N documents", or "N of M" when searching)

### v3.15.3
- Document browser sort: Newest, Oldest, A-Z, Z-A controls added next to the search box

### v3.15.2
- Rename and Duplicate added to the ellipsis menu

### v3.15.1
- Trash/undo: deleting a document now shows a 5-second undo toast instead of a confirmation dialog

### v3.15.0
- Initial public release

---

## License

MIT
