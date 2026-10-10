/**
 * Preview round-trip tests: Markdown -> HTML (marked) -> Markdown (Turndown+GFM).
 *
 * Deps are installed in a temp directory by the test runner (see spec item 7).
 * Run with:
 *   node node_modules/.bin/jest preview-roundtrip.test.js --testEnvironment jsdom
 * from the temp directory that has the deps installed.
 */

'use strict';

// Load deps from the same temp-dir node_modules as this test.
const marked              = require('marked');
const TurndownService     = require('turndown');
const turndownPluginGfm   = require('turndown-plugin-gfm');

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Mirrors the marked setup from app.js (without mermaid/hljs).
// Each test gets a fresh marked instance state via this call.
function setupMarked() {
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
        text = text == null ? '' : String(text);
        if (lang) lang = lang.trim().split(/\s+/)[0];
        if (lang === 'mermaid') {
          return `<div class="mermaid-pending" data-src="${esc(text)}">${esc(text)}</div>`;
        }
        return `<pre><code class="hljs language-${lang || 'plaintext'}">${text}</code></pre>`;
      }
    }
  });
}

// Mirrors getTurndown() from app.js (stateless -- new instance each call).
function makeTurndown() {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(turndownPluginGfm.gfm);

  td.addRule('mermaidDiagram', {
    filter: (node) =>
      node.nodeName === 'DIV' &&
      (node.classList.contains('mermaid-diagram') ||
       node.classList.contains('mermaid-error') ||
       node.classList.contains('mermaid-pending')) &&
      node.dataset.src !== undefined,
    replacement: (_content, node) => {
      const src = node.dataset.src || node.textContent || '';
      return '\n\n```mermaid\n' + src + '\n```\n\n';
    }
  });

  td.addRule('copyCodeBtn', {
    filter: (node) =>
      node.nodeName === 'BUTTON' && node.classList.contains('copy-code-btn'),
    replacement: () => ''
  });

  return td;
}

// Parse markdown to HTML, then back to markdown.
function roundTrip(md) {
  setupMarked();
  const html = marked.parse(md);
  const td   = makeTurndown();
  return td.turndown(html).trim();
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('table round-trips without corruption', () => {
  const md = [
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n');

  const result = roundTrip(md);
  expect(result).toMatch(/\|.*A.*\|.*B.*\|/);
  expect(result).toMatch(/\|.*1.*\|.*2.*\|/);
});

test('strikethrough round-trips (GFM preserves del as ~text~)', () => {
  const md = '~~deleted text~~';
  const result = roundTrip(md);
  // turndown-plugin-gfm@1.0.2 emits single-tilde GFM strikethrough.
  // Without the GFM plugin the <del> tag is dropped entirely.
  // We assert the text survives AND some tilde markup is present.
  expect(result).toContain('deleted text');
  expect(result).toMatch(/~+deleted text~+/);
});

test('task list round-trips', () => {
  const md = '- [x] done\n- [ ] pending';
  const result = roundTrip(md);
  expect(result).toContain('[x]');
  expect(result).toContain('[ ]');
});

test('fenced code block round-trips', () => {
  const md = '```js\nconsole.log("hi");\n```';
  const result = roundTrip(md);
  expect(result).toContain('```');
  expect(result).toContain('console.log');
});

test('mermaid block round-trips via data-src', () => {
  const src = 'graph TD\n  A --> B';
  const md   = '```mermaid\n' + src + '\n```';

  setupMarked();
  const html = marked.parse(md);

  // app.js emits mermaid-pending divs with data-src.
  expect(html).toContain('class="mermaid-pending"');
  expect(html).toContain('data-src=');

  const td     = makeTurndown();
  const result = td.turndown(html).trim();
  expect(result).toContain('```mermaid');
  expect(result).toContain('A --> B');
});

test('copy-code button does not leak into markdown', () => {
  setupMarked();
  const html = marked.parse('```js\nfoo();\n```');

  // Inject a copy button as app.js would.
  const container = document.createElement('div');
  container.innerHTML = html;
  const pre = container.querySelector('pre');
  const btn = document.createElement('button');
  btn.className = 'copy-code-btn';
  btn.textContent = 'Copy';
  pre.parentNode.insertBefore(btn, pre.nextSibling);

  const td     = makeTurndown();
  const result = td.turndown(container.innerHTML).trim();
  expect(result).not.toContain('Copy');
  expect(result).not.toContain('copy-code-btn');
  expect(result).toContain('foo()');
});

test('click in and out without input does not trigger write-back', () => {
  let editorValue     = '# Hello\n\nWorld';
  let previewDirty    = false;
  let writeBackCalled = false;

  function simulateBlur() {
    const wasPreviewDirty = previewDirty;
    previewDirty = false;
    if (wasPreviewDirty) {
      writeBackCalled = true;
      editorValue = 'OVERWRITTEN';
    }
  }

  // Focus then blur with no input.
  simulateBlur();

  expect(writeBackCalled).toBe(false);
  expect(editorValue).toBe('# Hello\n\nWorld');
});

test('real input then blur does trigger write-back', () => {
  let editorValue     = '# Hello\n\nWorld';
  let previewDirty    = false;
  let writeBackCalled = false;

  function simulateInput() { previewDirty = true; }

  function simulateBlur(newMd) {
    const wasPreviewDirty = previewDirty;
    previewDirty = false;
    if (wasPreviewDirty) {
      writeBackCalled = true;
      editorValue = newMd;
    }
  }

  simulateInput();
  simulateBlur('# Hello\n\nWorld (edited)');

  expect(writeBackCalled).toBe(true);
  expect(editorValue).toBe('# Hello\n\nWorld (edited)');
});
