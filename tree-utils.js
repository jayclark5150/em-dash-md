// Pure helpers for folders, the sidebar tree, the context menu and the
// command palette. No DOM and no Firebase access, so they can be unit tested
// in Node (see tests/tree-utils.test.cjs). Loaded before app.js.
(function (root) {
  'use strict';

  var SEP_RE = /[\s\-_\/.]/;

  function isFolder(d) {
    return !!d && d.type === 'folder';
  }

  // Trim, collapse whitespace, drop control characters and path separators,
  // cap the length. Returns '' when nothing usable is left.
  function normalizeName(raw) {
    var s = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\/\\]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s;
  }

  function nameTaken(name, siblingNames) {
    var n = String(name).toLowerCase();
    for (var i = 0; i < siblingNames.length; i++) {
      if (String(siblingNames[i]).toLowerCase() === n) return true;
    }
    return false;
  }

  // "New Folder", "New Folder 2", "New Folder 3", ... (case-insensitive).
  function uniqueName(base, siblingNames) {
    if (!nameTaken(base, siblingNames)) return base;
    var i = 2;
    while (nameTaken(base + ' ' + i, siblingNames)) i++;
    return base + ' ' + i;
  }

  // Folders first (A to Z, case-insensitive), then everything else in the
  // order it arrived (the list is already newest-first from Firestore).
  function orderSiblings(list) {
    var folders = [];
    var rest = [];
    for (var i = 0; i < list.length; i++) {
      (isFolder(list[i]) ? folders : rest).push(list[i]);
    }
    folders.sort(function (a, b) {
      return String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase());
    });
    return folders.concat(rest);
  }

  // [rootId, ...all descendants]. Cycle-safe (a corrupt parentId loop cannot
  // hang the UI).
  function subtreeIds(rootId, docs) {
    var childrenOf = {};
    for (var i = 0; i < docs.length; i++) {
      var p = docs[i].parentId;
      if (p) (childrenOf[p] = childrenOf[p] || []).push(docs[i].id);
    }
    var out = [];
    var seen = {};
    var stack = [rootId];
    while (stack.length) {
      var id = stack.pop();
      if (seen[id]) continue;
      seen[id] = true;
      out.push(id);
      var kids = childrenOf[id] || [];
      for (var k = 0; k < kids.length; k++) stack.push(kids[k]);
    }
    return out;
  }

  // Ancestor titles of a document, root first, self excluded. Missing parents
  // and cycles end the walk.
  function ancestorTitles(id, byId) {
    var parts = [];
    var seen = {};
    var cur = byId.get(id);
    var guard = 0;
    while (cur && cur.parentId && guard++ < 50) {
      if (seen[cur.parentId]) break;
      seen[cur.parentId] = true;
      var parent = byId.get(cur.parentId);
      if (!parent) break;
      parts.unshift(String(parent.title || 'Untitled').replace(/\.md$/i, ''));
      cur = parent;
    }
    return parts;
  }

  // Fuzzy match used by the command palette. Returns -1 for no match, and a
  // higher number for a better match. Substring hits always outrank scattered
  // (subsequence) hits.
  function fuzzyScore(query, text) {
    var q = String(query == null ? '' : query).toLowerCase().trim();
    var t = String(text == null ? '' : text).toLowerCase();
    if (!q) return 0;
    if (!t) return -1;

    var idx = t.indexOf(q);
    if (idx !== -1) {
      var s = 1000 - Math.min(idx, 200) - Math.min(t.length, 300) / 10;
      if (idx === 0) s += 200;
      else if (SEP_RE.test(t.charAt(idx - 1))) s += 100;
      return s;
    }

    var toks = q.split(/\s+/).filter(Boolean);
    if (toks.length > 1) {
      var all = true;
      for (var i = 0; i < toks.length; i++) {
        if (t.indexOf(toks[i]) === -1) { all = false; break; }
      }
      if (all) return 600 - Math.min(t.length, 300) / 10;
    }

    var pos = 0;
    var last = -2;
    var run = 0;
    var score = 0;
    for (var c = 0; c < q.length; c++) {
      var ch = q.charAt(c);
      if (ch === ' ') continue;
      var found = t.indexOf(ch, pos);
      if (found === -1) return -1;
      if (found === last + 1) { run++; score += 5 + run; } else { run = 0; score += 1; }
      if (found === 0 || SEP_RE.test(t.charAt(found - 1))) score += 8;
      last = found;
      pos = found + 1;
    }
    return Math.max(1, Math.min(score, 400) - Math.min(t.length, 300) / 20);
  }

  // Score items by the best match across their searchable strings, drop
  // non-matches, sort best first (stable for equal scores), cap the length.
  // getTexts(item) returns an array of strings.
  function rank(query, items, getTexts, limit) {
    var q = String(query == null ? '' : query).trim();
    var scored = [];
    for (var i = 0; i < items.length; i++) {
      var best = -1;
      if (!q) {
        best = 0;
      } else {
        var texts = getTexts(items[i]);
        for (var j = 0; j < texts.length; j++) {
          var sc = fuzzyScore(q, texts[j]);
          if (sc > best) best = sc;
        }
      }
      if (best >= 0) scored.push({ item: items[i], score: best, order: i });
    }
    scored.sort(function (a, b) { return (b.score - a.score) || (a.order - b.order); });
    var out = scored.map(function (s) { return s.item; });
    return limit ? out.slice(0, limit) : out;
  }

  // Keep a popup of size w x h fully inside a vw x vh viewport.
  function clampMenu(x, y, w, h, vw, vh) {
    var margin = 6;
    var left = x;
    var top = y;
    if (left + w + margin > vw) left = vw - w - margin;
    if (top + h + margin > vh) top = vh - h - margin;
    return { left: Math.max(margin, left), top: Math.max(margin, top) };
  }

  root.TreeUtils = {
    isFolder: isFolder,
    normalizeName: normalizeName,
    nameTaken: nameTaken,
    uniqueName: uniqueName,
    orderSiblings: orderSiblings,
    subtreeIds: subtreeIds,
    ancestorTitles: ancestorTitles,
    fuzzyScore: fuzzyScore,
    rank: rank,
    clampMenu: clampMenu,
  };
})(typeof window !== 'undefined' ? window : globalThis);
