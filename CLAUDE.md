# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EM-Dash MD is a cloud-first Markdown editor — plain HTML/CSS/JavaScript with no build step, no framework, and no package manager. The entire application is three files: `index.html`, `app.js`, and `styles.css`.

## Local development

There is no build step. Serve the directory with any static server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Before running locally, create `firebase-config.js` from the example:

```bash
cp firebase-config.example.js firebase-config.js
# then fill in your Firebase project values
```

`firebase-config.js` is gitignored and must never be committed.

## Deployment

```bash
npm install -g firebase-tools
firebase login
firebase deploy        # deploys to Firebase Hosting
```

## Architecture

**All application logic lives in `app.js`** — there is no module system. The file is organized in named sections separated by `// ── Section name ──` comments. Key sections:

- **Firestore helpers** (`fsGetAll`, `fsGet`, `fsPut`, `fsDelete`) — all Firestore I/O. `fsGetAll` takes an optional `max` limit; the doc browser uses 300 to cap read costs.
- **Auth state gate** — `auth.onAuthStateChanged` is the single entry point; it calls `bootApp()` on first sign-in. Auth overlay covers the app until signed in; signed-out state shows a README preview.
- **State** — four module-level vars track editor state: `currentDocId`, `currentDocIsNew`, `currentTitle`, `isDirty`.
- **Render pipeline** — `scheduleRender()` debounces to one `requestAnimationFrame` per burst; it calls `renderPreview()` (marked → DOMPurify → innerHTML), `updateStats()`, and `updateLineNumbers()`.
- **Toast** — `showToast(msg, duration, action)` accepts an optional `action: { label, fn }` to render a clickable button inside the toast. When an action is present, the toast uses `pointer-events: auto`.
- **Auto-save** — 2-second debounce via `scheduleAutoSave()` / `performSave()`. `currentDocIsNew` tracks whether to call `ref.set()` (create) or `ref.update()`.
- **Focus mode** — full-screen WYSIWYG using a `contenteditable` div (`#focus-wysiwyg`). On exit, Turndown converts the HTML back to Markdown and diffs against `editor.value` before writing.
- **Delete/undo** — `deleteCurrentDoc()` clears the UI immediately, then uses a 5-second `setTimeout` before calling `fsDelete`. A `showToast` action button sets a closed-over `undone` flag to cancel the delete. Each deletion is independent; no shared timer variable.
- **Service worker** (`sw.js`) — caches static assets and CDN libs. Cache name is `em-dash-md-v2`; bump this constant when deploying breaking changes to force old caches to clear.

## Firestore data model

Single collection: `documents`

| Field | Type | Notes |
|-------|------|-------|
| `userId` | string | Firebase Auth UID — all queries filter on this |
| `title` | string | Includes `.md` extension |
| `content` | string | Raw Markdown |
| `createdAt` | Timestamp | Server timestamp, set on create only |
| `updatedAt` | Timestamp | Server timestamp, updated on every save |

Required composite index: `userId` ASC + `updatedAt` DESC (needed for `fsGetAll`).

Security rules in `firestore.rules` enforce that only the document owner can read/write their own documents.

## Content Security Policy

`index.html` has a strict CSP. Any new CDN script or stylesheet must be:
1. Added to the appropriate `script-src` or `style-src` directive in the `<meta http-equiv="Content-Security-Policy">` tag
2. Loaded with `integrity` (SRI hash) and `crossorigin="anonymous"` attributes

Firebase SDK scripts from `gstatic.com` are excluded from SRI (Google doesn't publish hashes for them).

## Themes

Three themes cycle via the toolbar button: `lokai` (default — dark editor, white chrome), `dark`, `light`. Theme is persisted in `localStorage` under the key `md-theme`. CSS classes `theme-dark` and `theme-light` are toggled on `document.body`; no class means Lokai.
