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
firebase init hosting   # public dir: .  |  single-page app: No
firebase deploy
```

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
| Firebase Hosting | Deployment |

---

## Changelog

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
