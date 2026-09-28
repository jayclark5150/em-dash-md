# Regression Checklist — em-dash-md

Read this before any script or operation that writes to or deletes from the
Firestore `documents` collection. Append new checks here after every such
operation so previously-found issues stay covered on the next run.

## Firestore write/delete operations

- [ ] **Pre-flight re-scan**: re-fetch the live document set immediately
  before writing; never act on a scan from more than a few minutes earlier.
  Compare fresh counts against the counts shown to the user — halt if they
  differ.
- [ ] **Collision check on any title/field rename**: before renaming,
  simulate the full result set and detect any two *different* document IDs
  that would end up with an identical `title`. Do not silently rename into a
  collision — get an explicit decision from the user for each colliding
  group (duplicate titles, add a disambiguating suffix, or skip).
- [ ] **Scope guard**: only modify documents whose current field value
  actually matches the target pattern. Never touch a document that doesn't
  match, even if it looks "close enough."
- [ ] **Post-write verification**: after committing, re-read every modified
  document individually and confirm the field equals the expected new
  value. Report any mismatches — do not assume a batch commit succeeded
  uniformly.
- [ ] **Whole-DB sanity check**: after the operation, re-fetch the full
  collection and confirm total document count is unchanged (no accidental
  deletes/creates) and that no new title collisions were introduced by the
  operation itself.
- [ ] **Known pre-existing duplicate titles** (found 2026-09-13, unrelated
  to any rename — these never had the hash suffix in the first place):
  `20260902 Daily Diary.md`, `20260903 Daily Diary.md`,
  `20260904 Daily Diary.md`, `20260908 Daily Diary.md`,
  `20260909 Daily Diary.md`. Each pair has distinct content but no
  disambiguating title. Re-check this list is still accurate (or resolved)
  before reporting "no duplicates" in any future dedupe pass.

## Log — 2026-09-13: strip trailing hash suffix from document titles

- **Scope**: 295 total documents in `documents` collection (user
  jay@michaelson-clark.com).
- **Pattern**: trailing `" " + 32-hex-char string` immediately before the
  file extension, e.g. `"20250829 Daily Diary 3bd6e158c384814ea072d22ae8b72d76.md"`
  → `"20250829 Daily Diary.md"`.
- **Matched pattern**: 283 documents.
- **Did not match** (left untouched): 12 documents — recent diary entries
  already without the hash, `IT Governance.md`, `To-Do.md`,
  `README EM-Dash MD.md`, `Progress with EM-DASH.md`, and one
  underscore-named file (`20260830_Daily_Diary.md`).
- **Collisions found**: 23 groups / 46 documents where stripping the hash
  would produce an identical title to another document (same-day entries
  with different content). Per user decision, these 46 were **skipped** —
  hash suffix left in place.
- **Renamed**: 237 documents. Firestore `title` field only — `content`,
  `createdAt`, `updatedAt`, and `tags` untouched, so the doc browser's
  "Newest" ordering was not disturbed by this cleanup.
- **Verification**: all 237 re-read individually post-commit — 0 mismatches.
  Full collection re-fetched — 295 docs before and after (no loss), 46
  documents still carry the hash as expected.
- **Regression gate**: interactive, single run via a browser console script
  against the live signed-in session (no service account available in this
  environment). Pre-flight re-scan matched the counts shown to the user
  exactly before any write was made.

## Log — 2026-09-13: deleted 21 duplicate Daily Diary entries

- **Context**: follow-up to the hash-suffix rename above. Of the original 23
  colliding pairs (46 docs), 2 pairs (`20250901`, `20251111`) had already
  been resolved manually by the user (one doc deleted, survivor renamed)
  before this operation ran — confirmed via direct `fsGet` on the original
  IDs, which returned `permission-denied` (Firestore rule dereferences a
  null `resource` on a deleted doc — this is expected and means "gone").
  This is why the pre-flight re-scan (295→294 docs, 23→21 groups) did not
  match the numbers shown to the user in the prior turn; investigated and
  confirmed benign before proceeding, per the hard-halt gate for this risk
  tier.
- **Content check before deleting**: user reported reviewing the pairs
  manually and confirming duplicate content. Independently verified: in
  all 21 remaining pairs, content length differs by 0–51 characters out of
  700–41,000+ characters, and the only actual text difference in every pair
  is an embedded "Created: HH:MM AM" timestamp (off by ~30 minutes) — the
  narrative content is otherwise identical. This is consistent with a
  duplicate-save glitch, not two distinct diary entries.
- **Keep rule**: per user decision, kept whichever document in each pair had
  more content (all differences were within a few dozen characters, so this
  was effectively a tie-breaker, not a meaningful selection).
- **Backup**: full content of all 21 deleted documents (title, content,
  createdAt, updatedAt) exported and delivered to the user before deletion
  as `deleted-duplicates-2026-09-13.json`.
- **Executed**: single Firestore batch delete (21 deletes), browser console
  against the live signed-in session.
- **Post-write verification**: re-read all 21 deleted IDs (confirmed gone)
  and all 21 kept IDs (confirmed present, correct length) individually.
  Full collection re-fetch: 294 → 273 documents (exactly -21, as expected).
  0 failures.
- **Deploy**: this same session also deployed v3.17.0 (IndexedDB persistence
  + Finder-style doc browser) to `em-dash-md.web.app` via
  `npx firebase-tools deploy`, run by the user in their own terminal.

## Log — 2026-09-13: fixed remaining title inconsistency, resolved 6 more true duplicates

- **20260830_Daily_Diary.md**: not a simple naming fix as first assumed —
  the properly-templated `20260830 Daily Diary.md` already existed and
  contained/referenced this raw one. Deleted the raw underscore-named copy
  (`f59157e1...`), kept the templated one.
- **5 pre-existing duplicate titles** (`20260902`, `20260903`, `20260904`,
  `20260908`, `20260909`): checked before applying the user's "keep
  larger" rule — a naive line-by-line diff showed 88-94% of lines
  differing, which does NOT match the pattern from the earlier 21-pair
  cleanup (where diffs were single timestamp characters). Investigated
  further: this high diff % was a diff-alignment artifact from one
  document having an inserted metadata header block (Category/Created/
  Document Type/File Type/Sync Status/Tag) that the other lacks — the
  underlying diary narrative is the same in each pair, just wrapped
  differently.
  - `902`, `904`, `908`, `909`: "larger" = the templated version, matches
    the pattern — kept larger, deleted smaller, per user rule.
  - `903`: **inverted case** — the smaller doc had the template header,
    the larger one didn't. Flagged to user; user chose to keep the
    templated (smaller) one, breaking from the literal "keep larger" rule
    for this one case.
- **Backup**: full content of all 6 deleted documents exported and
  delivered to the user before deletion.
- **Post-write verification**: all 6 deletions confirmed, all 6 kept docs
  confirmed present. Collection count: 273 → 267 (exactly -6).
- **Note for future dedupe passes on this collection**: length/line-count
  diffs alone are misleading when one copy has an inserted header block —
  always check for containment (is the shorter doc's content present
  inside the longer one) rather than assuming diff % reflects real content
  divergence.

## Log — 2026-09-13: bulk-tagged all Daily Diary entries

**OpenSpec**
- Purpose: apply the "daily diary" tag (lowercase, matching the app's tag-normalization and the existing tag on 20250826 Daily Diary.md) to every Daily Diary journal entry, for consistent filtering.
- Scope: all Firestore `documents` owned by Jay's uid whose title matches `/daily diary/i` — confirmed 261 docs, including 4 non-standard titles (a typo'd "20251111 Daily Diarymd.md", plus "(Morning Summary)", "Prompt", and "Summary" variants). Jay confirmed via AskUserQuestion: tag all 261, no exclusions.
- Inputs: existing `tags` array per doc. Outputs: `tags` with "daily diary" appended, existing tags preserved (only 1 doc had any other tags, and it was the already-tagged reference doc).
- Constraints: no other fields touched; no non-Daily-Diary docs touched; no doc creation/deletion.
- Acceptance criteria: all 261 Daily-Diary-titled docs carry "daily diary" in tags; total doc count unchanged (267); no doc ends up with an unexpected tag set.

**Audit**: confirmed only 1 of 261 already had the tag (260 to update), confirmed no doc besides that one carried any pre-existing tags (so append-vs-overwrite was a non-issue), confirmed the 4 non-standard titles were genuine diary-related files per Jay's explicit scope decision.

**QA review**: executed live via a Firestore batch `update()` (partial field write — tags only) in the browser console against the production app, signed in as Jay. Not a simulated/static review; the batch actually committed (260 writes, single batch, well under the 500-op Firestore batch limit).

**Regression gate**: hard-halt gate run immediately before commit — re-scanned fresh and required totalDocs==267, Daily-Diary-titled==261, docs-missing-tag==260 to match the numbers audited above before allowing the batch to proceed. Gate passed (High Risk / data-altering op per Jay's standing risk classification → hard-halt mode, no preview/no-change fallback used since scope was already explicitly confirmed with Jay).

**Post-write verification**: re-queried fresh after commit — 0 docs still missing the tag, doc count still 267, no doc picked up an unexpected extra tag.

**Result**: 260 documents updated, 1 already correct. No rollback needed.

## Log — 2026-09-13: added "Delete My Account" feature (v3.18.0)

**OpenSpec**
- Purpose: give Jay a way to permanently delete his account and all documents from within the app.
- Scope: new UI (menu item + confirmation modal) in index.html, new logic in app.js, one new CSS class (`.btn-danger`) in styles.css. No changes to existing features/flows.
- Inputs: typed confirmation phrase ("DELETE"), re-authentication (password re-entry for email/password accounts, Google popup re-auth for Google accounts).
- Outputs: all Firestore `documents` owned by the user's uid deleted, then the Firebase Auth user deleted; app returns to the sign-in screen.
- Assumptions: "Delete My Account" = irreversibly delete both the documents and the Auth account (the standard meaning of the phrase) — not asked separately since unambiguous.
- Constraints: must require fresh reauthentication (Firebase's `deleteUser()` throws `auth/requires-recent-login` otherwise); must require explicit typed confirmation, not just a click, given irreversibility; must not be reachable from the main toolbar (buried in the ellipsis menu, danger-styled); must support both auth providers the app offers (password, Google); must delete Firestore data before deleting the Auth account (so a mid-failure leaves a recoverable "signed in, no docs" state rather than an orphaned "docs exist, no login" state).
- Acceptance criteria: modal shows live document count; Delete button stays disabled until the input exactly equals "DELETE"; reauth happens immediately before deletion; on success, all owned docs are gone and the account no longer exists; on any failure, a specific error is shown and no partial silent state occurs; Cancel/Escape makes no changes.

**Audit**: reviewed against every acceptance criterion above — confirmed doc-count fetch, disabled-until-exact-match confirm button, per-provider reauth branch, delete-Firestore-then-delete-Auth ordering, chunked batch delete (450-doc pages, under Firestore's 500-write batch cap, loops for libraries beyond that), and a full error map (wrong password, missing password, requires-recent-login, popup closed, network failure, generic fallback) with the confirm button re-enabled on failure so the user isn't stuck.

**QA review**: I do NOT have execution access to the live app for this feature — the code changes are on disk in the connected folder but have not been deployed to em-dash-md.web.app yet, and the browser pane can't load local files, so I could not click through the actual flow. What I did instead, statically:
- `node --check app.js` — passed, no syntax errors.
- Verified every new element ID referenced in app.js exists exactly once in index.html, and that no ID collides with an existing one (113 total IDs, all unique).
- Verified the new modal reuses the existing `.modal-backdrop` / `.modal-backdrop.open` CSS toggle, so it will show/hide the same way every other modal in the app already does.
- Traced the reauth branches against the two providers actually enabled in this app (`password`, `google.com`) per the existing sign-in code.
No regression baseline exists for a brand-new feature, so there's nothing to compare a metric against; the static checks above are the full pre-deploy review. **Real verification still requires Jay to deploy and click through it once** (sign-in as a password user, confirm the modal blocks until "DELETE" is typed and a wrong password is rejected with a clear error, then a real test-account run through to confirm deletion actually clears Firestore + Auth).

**Regression gate (built into the feature itself, since this is a script capable of deleting data)**: the modal will not enable the delete action until (1) the exact phrase "DELETE" is typed and (2) reauthentication succeeds — functioning as the halt/proceed gate for this destructive action. High Risk hard-halt mode: no preview/no-change fallback, deletion either proceeds fully informed or not at all.

**Deploy status**: NOT yet deployed. Files changed: index.html, app.js, styles.css, sw.js (cache bump v3→v4), README.md (changelog + feature bullet). Jay needs to run `firebase deploy` from `~/Documents/em-dash-md` to ship this, per the standing preference that I not hold deploy credentials.

**Residual risk**: this has not been tested end-to-end against live Firebase Auth (only statically reviewed). Recommend Jay do one real test run (ideally with a throwaway test account, not his main one) before trusting the flow against real data.

## Checks: Claude modal / network access (added 2026-09-22)

- [ ] **CSP covers every outbound host**: every `https://` host that any
  shipped JS file calls with `fetch()` must appear in `connect-src` in
  `index.html`. A missing host fails silently as "Failed to fetch" in the
  UI. Check: extract hosts from `claudeChatModal.js` (and any new network
  code) and confirm each is listed.
- [ ] **Browser-direct Anthropic calls carry the opt-in header**: any
  `fetch` to `api.anthropic.com` from the browser must send
  `anthropic-dangerous-direct-browser-access: true`, or the CORS preflight
  fails. (Retire this check if the call moves server-side.)
- [ ] **Model string is current**: the `model` in `claudeChatModal.js` must
  be a currently available model, not a retired one
  (`claude-3-5-sonnet-20241022` was retired and must not reappear).
- [ ] **Service worker cache bumped on any same-origin JS/CSS change**:
  `sw.js` serves same-origin assets cache-first, so changed JS never
  reaches existing browsers unless `CACHE` is incremented.
- [ ] **`node --check` on every changed JS file** before deploy.
- [x] **RESOLVED v3.21.1 (was OPEN BUG, found 2026-09-22)**: `app.js` declares
  `async function loadDoc` twice (lines ~930 and ~1199, from v3.20.0
  Kanban). Function hoisting makes `_origLoadDoc` point at the wrapper
  itself, so any non-Kanban `loadDoc()` call recurses infinitely.
  `node --check app.js` fails on this. Fix before next app.js release,
  then confirm `node --check app.js` passes.

## Log: 2026-09-22: Claude modal "Failed to fetch" fixes (v1.1.1)

**OpenSpec**
- Purpose: stop the Ask Claude modal failing with "Failed to fetch"
  (reported from Edge at work).
- Scope: fix 1, add `https://api.anthropic.com` and the Cloud Run MCP host
  to CSP `connect-src`; fix 2, add the
  `anthropic-dangerous-direct-browser-access` header; fix 3, replace the
  retired `claude-3-5-sonnet-20241022` with `claude-sonnet-5`; plus bump
  `sw.js` cache v4 to v5 so the changed JS reaches existing browsers.
  Out of scope: server-side proxy, API key storage, MCP auth, `open`
  keyword routing, work network filtering.
- Risk tier: High (CSP is a security control). CAB review required.
- Constraints: minimal line edits only; no other CSP directive changes;
  no wildcard hosts added.
- Acceptance criteria: CSP allows exactly the two hosts the modal calls;
  request carries the header and new model; syntax checks pass on changed
  files; cache name changed.

**Audit (full, High Risk)**: diff is 3 files, 5 lines. CSP adds two exact
hosts, no wildcards; all other directives byte-identical. Header and model
edits confined to `callClaudeAPI`. MCP fetch path unchanged. Security
note: widening `connect-src` expands where page script may send data;
both hosts are first-party to this app, but the API key remains exposed in
`localStorage` (pre-existing, accepted residual risk until the server-side
proxy work).

**QA**: executed in Node with a stubbed `fetch`: URL, all headers, model,
reply parsing and history all verified; every host in
`claudeChatModal.js` confirmed present in `connect-src`. `node --check`
passed for claudeChatModal.js, claude-integration.js, sw.js. NOT run
against the live Anthropic API or in a real browser (no key or browser
available in the build environment). Live verification: deploy, hard
refresh Edge, send a test message, confirm no CSP or CORS error in F12
Console.

**Regression gate**: not applicable (web app change, not an unattended
script). Checks above added so this class of failure is re-tested.

**Deploy status**: NOT deployed. Deployed site could not be fetched from
the build environment to compare against the repo; the repo `index.html`
lacks the Claude script tags, so Jay's local copy likely has uncommitted
changes. Patch is line-scoped to apply on top.

## Log: 2026-09-22: incident follow-up and reply-parsing fix (v1.1.2)

**Security incident (same day, High Risk)**
- `firebase.json` published the whole project folder (`"public": "."`).
  Confirmed public via HTTP 200: `em-dash-md-firebase-adminsdk-fbsvc-a6d5396cc9.json`
  and `service-account-key.json` (the same admin key, key id prefix
  `a6d5396cc9`). The `Claude outputs/` diary backups
  (`deleted-duplicates-2026-09-13.json`, `deleted-6-docs-2026-09-13.json`)
  were also published and were likely public in earlier deploys too.
- Containment: key deleted in Google Cloud IAM; key files moved to
  `~/.secrets/`; hosting ignore list expanded; redeployed; exposed paths
  verified 404.
- Side effect: the Cloud Run MCP server image bakes in that key, so it can
  no longer reach Firestore. Leave it that way until the auth fix below.
- An Anthropic key was also pasted into chat and the browser console
  history; Jay rotated it.
- Hidden folders were also published: `**/.*` skips hidden files but not
  files inside hidden folders. Confirmed HTTP 200 for `.git/HEAD` and
  `.claude/settings.local.json`. Assessed: the GitHub repo is already
  public and a full-history scan (29 commits) found no private keys or
  Anthropic/OpenAI keys; unpushed local commits contain no secrets; the
  settings file holds only permission rules (reveals username and path).
  Fixed with `**/.*/**` plus explicit `.git/**`, `.claude/**`,
  `.firebase/**`. Deploy dropped from 258 files to 27 (app files only).

**New checks**
- [ ] **Hosting exposure check after every deploy**: the deploy log's
  "found N files" must equal the number of real app files (27 as of
  v3.21.1). Any jump means something leaked in. Curl any new non-app file
  at the live site and confirm 404.
  Any `*.json` other than `manifest.json` returning 200 is a failure.
- [ ] **No key files in the repo folder**: `ls *key*.json *adminsdk*.json`
  must return nothing. Keys live in `~/.secrets/` or Secret Manager.
- [ ] **Reply parsing**: the modal must never render "undefined". It joins
  all `type: "text"` content blocks and shows a stop_reason message if
  there are none.
- [ ] **API errors show Anthropic's message**, not just the status code.
- [ ] **OPEN (High Risk, needs CAB)**: MCP server (`http-wrapper.js` +
  `server.js`) has no authentication and takes `userId` from the request
  body while running as Firebase admin. Must verify a Firebase ID token,
  derive `userId` from it, restrict CORS to `https://em-dash-md.web.app`,
  and run on the Cloud Run service identity with no key file. Do NOT add
  CORS alone; that would expose the unauthenticated server to any site.
- [x] **RESOLVED v3.21.1**: `app.js` duplicate `loadDoc` recursion (see
  log below).

**Reply-parsing fix (scoped re-audit: only `callClaudeAPI` and `sw.js`)**
- OpenSpec: replace `data.content[0].text` with a join of all text blocks;
  surface the API error message; pop the unanswered user turn on error;
  bump `sw.js` cache v5 to v6.
- QA: executed in Node against six stubbed responses (text only, thinking
  then text, two text blocks, no text, JSON error, non-JSON error). All
  passed. `node --check` passed. Not yet verified in a live browser.

## Log: 2026-09-22: fixed loadDoc infinite recursion (v3.21.1)

**OpenSpec**
- Purpose: stop `loadDoc` calling itself forever, which broke opening the
  most recent doc on startup and opening any uncached doc from the doc
  browser or Kanban board.
- Cause: v3.20.0 added a second `async function loadDoc` as a Kanban-picker
  wrapper. Function hoisting made `_origLoadDoc` point at the wrapper
  itself, so any call outside Kanban-pick mode recursed until
  `RangeError: Maximum call stack size exceeded`.
- Change: moved the Kanban-picker branch to the top of the original
  `loadDoc`, deleted the wrapper and `_origLoadDoc`. Kanban check still runs
  before the unsaved-changes prompt, as before. `sw.js` cache v6 to v7;
  status bar label v3.21.1.
- Risk tier: Medium (touches the document-loading data path), so full
  re-audit of `loadDoc` and all three callers.
- Acceptance: `node --check app.js` passes; every `loadDoc` path behaves
  as intended; `loadMostRecent` opens the newest doc.

**Audit (full, data-path change)**: callers at app.js doc browser (cached
and uncached branches), Kanban card open, and `loadMostRecent` all resolve
`loadDoc` by name at call time, so all now reach the single fixed function.
`kanbanPickTarget` is a `let` declared later in the file but is only read
at call time, after the script has finished loading, so no TDZ error.

**QA**: executed. Reproduced the old code's exact live error
(`RangeError: Maximum call stack size exceeded`) as the baseline, then ran
the real fixed `loadDoc` and `loadMostRecent` from app.js against stubs in
8 cases (normal open, Kanban assign, Kanban target clears, dirty+cancel,
dirty+OK, missing doc, newest doc on startup, empty library). 8/8 passed.
`node --check app.js` passes (it failed before this fix). Not yet clicked
through in a live browser.

**Regression gate**: not applicable (web app, not an unattended script).

**Checks added**
- [ ] `node --check app.js` must pass before every deploy; a duplicate
  top-level function declaration is a hard stop.
- [ ] No function in app.js may be declared twice
  (`grep -c "function loadDoc(" app.js` must be 1; apply the same idea to
  any future wrapper). Wrap by extending the original function, never by
  redeclaring it.
- [ ] Manual smoke test after deploy: reload the app and confirm the most
  recent doc opens with no console error; open an uncached doc from the
  doc browser; assign a doc to a Kanban column via the picker.

## Mobile UI Improvements (2026-09-24)

**Purpose**: Make em-dash-md genuinely mobile-friendly on phones (<=768px).

**Changes**:
- Added editor/preview toggle button for mobile (hidden on desktop)
- Increased Focus Mode exit button to 56px on mobile for easier tapping
- Added visualViewport API keyboard detection to prevent layout shift
- Added localStorage persistence for editor/preview mode preference
- Added CSS classes for mobile-editor-only and mobile-preview-only modes

**Regression gate**: Mobile features only; desktop unchanged.

**Checks added**
- [ ] Desktop (>768px): editor/preview toggle button must be hidden; Focus Mode exit stays as-is; all desktop features work unchanged
- [ ] Mobile (<768px): editor/preview toggle visible in header; clicking cycles between editor-only and preview-only views
- [ ] Mobile view preference persists across page reload (localStorage)
- [ ] Focus Mode exit button is 56px×56px and circular on mobile
- [ ] On-screen keyboard appearance doesn't push header off-screen (visualViewport test)
- [ ] All tap targets ≥44px on mobile
- [ ] No console errors on mobile browsers (Chrome DevTools device emulation)


---

## v3.22.0 — Left sidebar navigation

**Purpose**: Add persistent left-side document navigation sidebar (Anytype/Notion-style).

**Changes**:
- `index.html`: added `#app-shell` (flex-row wrapper), `#sidebar` with inner sections, `#sidebar-backdrop` (mobile overlay), `#app-content` column wrapper, `#sidebar-toggle-btn` in header
- `styles.css`: full sidebar CSS for all three themes (Lokai/dark/light) and mobile responsive layout
- `app.js`: `initSidebar()`, `renderSidebarList()`, `updateSidebarActive()`, `refreshSidebarList()`, open/close/toggle logic, `Ctrl+\` shortcut, wired into `bootApp()`, `applyDoc()`, `performSave()`, `deleteCurrentDoc()`, `createNewDoc()`
- `sw.js`: cache bumped from v7 to v8

**Regression gate**: none (UI-only change, no Firestore writes).

**Checks added**
- [ ] Sidebar renders on first load with document list populated
- [ ] Active document is highlighted in sidebar on load and after switching docs
- [ ] Sidebar toggle button (header) opens/closes sidebar; state persists in localStorage across reload
- [ ] `Ctrl+\` (Cmd+\ on Mac) toggles sidebar
- [ ] Collapse button inside sidebar closes it
- [ ] Search input filters document list in real-time
- [ ] "New document" button in sidebar creates new doc correctly
- [ ] "Browse all documents" button opens the existing doc-browser modal
- [ ] Clicking a sidebar item opens that document
- [ ] After saving a doc, sidebar list refreshes and shows updated title
- [ ] After deleting a doc, it disappears from sidebar immediately; undo restores it
- [ ] All three themes (Lokai, dark, light) render sidebar correctly
- [ ] Mobile (<600px): sidebar starts closed; toggle opens it as overlay with backdrop; tapping backdrop closes it; opening a doc closes sidebar
- [ ] Desktop (>600px): sidebar collapses inline (pushes content right); no overlay
- [ ] No layout regression: header, editor, preview, statusbar, focus mode all unaffected
- [ ] No console errors on load
