// In-memory stand-in for the Firebase compat SDK, used only by
// tests/e2e-folders.cjs. It implements just the calls app.js makes
// (Firestore queries / doc get-set-update-delete / batch, and Auth state).
// Not shipped: tests/ is not referenced from index.html.
(function () {
  var store = new Map();            // id -> document data
  var queries = [];                 // log of query reads, for assertions
  window.__store = store;
  window.__queries = queries;
  var writes = [];                  // log of {op,id} for assertions
  window.__writes = writes;
  window.__latency = 0;             // ms added to set/update/transaction commits
  window.__verifySent = 0;
  function later(fn) { return window.__latency ? new Promise(function (r) { setTimeout(function () { r(fn()); }, window.__latency); }) : Promise.resolve(fn()); }

  var DEL = { __del: true };
  var TS = { __ts: true };
  var clock = 1900000000000;
  function tick() { clock += 1000; return clock; }
  function mkTs(ms) { return { ms: ms, toMillis: function () { return ms; } }; }

  function applyWrite(existing, data, isSet) {
    var out = isSet ? {} : Object.assign({}, existing);
    var t = mkTs(tick());
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (v === DEL) delete out[k];
      else if (v === TS) out[k] = t;
      else out[k] = v;
    });
    return out;
  }

  (window.__SEED || []).forEach(function (d) {
    var copy = Object.assign({}, d);
    var id = copy.id; delete copy.id;
    ['createdAt', 'updatedAt', 'deletedAt'].forEach(function (k) {
      if (typeof copy[k] === 'number') copy[k] = mkTs(copy[k]);
    });
    store.set(id, copy);
  });

  function docRef(id) {
    return {
      id: id,
      get: function () {
        var d = store.get(id);
        return Promise.resolve({ exists: !!d, id: id, data: function () { return Object.assign({}, d); } });
      },
      set: function (data) { writes.push({ op: 'set', id: id }); return later(function () { store.set(id, applyWrite({}, data, true)); }); },
      update: function (data) {
        writes.push({ op: 'update', id: id });
        if (!store.has(id)) return Promise.reject(Object.assign(new Error('not-found'), { code: 'not-found' }));
        return later(function () { store.set(id, applyWrite(store.get(id), data, false)); });
      },
      delete: function () { store['delete'](id); return Promise.resolve(); },
    };
  }

  function snap(rows) {
    var docs = rows.map(function (r) {
      return { id: r[0], data: function () { return Object.assign({}, r[1]); }, ref: docRef(r[0]) };
    });
    return { docs: docs, size: docs.length, empty: docs.length === 0 };
  }

  function makeQuery(filters, order, lim, after) {
    return {
      where: function (f, op, v) { return makeQuery(filters.concat([{ f: f, op: op, v: v }]), order, lim, after); },
      orderBy: function (f, dir) { return makeQuery(filters, { f: f, dir: dir }, lim, after); },
      limit: function (n) { return makeQuery(filters, order, n, after); },
      startAfter: function (snapDoc) { return makeQuery(filters, order, lim, snapDoc.id); },
      get: function () {
        queries.push({ filters: filters, order: order, limit: lim, after: after || null });
        var rows = Array.from(store.entries()).filter(function (e) {
          return filters.every(function (x) {
            if (x.op === 'in') return x.v.indexOf(e[1][x.f]) !== -1;
            return e[1][x.f] === x.v;
          });
        });
        if (order) {
          rows = rows.filter(function (e) { return e[1][order.f] !== undefined; });
          rows.sort(function (a, b) {
            var d = a[1][order.f].toMillis() - b[1][order.f].toMillis();
            return order.dir === 'desc' ? -d : d;
          });
        }
        if (after) {
          var idx = rows.findIndex(function (e) { return e[0] === after; });
          rows = idx >= 0 ? rows.slice(idx + 1) : [];
        }
        if (lim) rows = rows.slice(0, lim);
        return Promise.resolve(snap(rows));
      },
    };
  }

  var fs = {
    enablePersistence: function () { return Promise.resolve(); },
    terminate: function () { try { sessionStorage.setItem('__terminated', '1'); } catch (e) {} return Promise.resolve(); },
    clearPersistence: function () { try { sessionStorage.setItem('__cleared', '1'); } catch (e) {} return Promise.resolve(); },
    runTransaction: function (fn) {
      var pending = [];
      var tx = {
        get: function (ref) { return ref.get(); },
        update: function (ref, data) { pending.push(function () { return ref.update(data); }); },
        set: function (ref, data) { pending.push(function () { return ref.set(data); }); },
      };
      return Promise.resolve(fn(tx)).then(function () {
        return pending.reduce(function (p, op) { return p.then(op); }, Promise.resolve());
      });
    },
    collection: function () {
      var q = makeQuery([], null, null, null);
      q.doc = docRef;
      return q;
    },
    batch: function () {
      var ops = [];
      return {
        update: function (ref, data) { ops.push(function () { return ref.update(data); }); },
        delete: function (ref) { ops.push(function () { return ref['delete'](); }); },
        set: function (ref, data) { ops.push(function () { return ref.set(data); }); },
        commit: function () {
          return ops.reduce(function (p, op) { return p.then(op); }, Promise.resolve());
        },
      };
    },
  };

  var USER = {
    uid: 'u1', email: 'jay@michaelson-clark.com',
    providerData: [{ providerId: 'google.com' }],
    'delete': function () { return Promise.resolve(); },
  };
  var cur = USER;
  function pwUser(verified) {
    return { uid: 'u1', email: 'jay@michaelson-clark.com', emailVerified: verified, providerData: [{ providerId: 'password' }],
      sendEmailVerification: function () { window.__verifySent++; return Promise.resolve(); }, 'delete': function () { return Promise.resolve(); } };
  }
  var cbs = [];
  var authInst = {
    get currentUser() { return cur; },
    onAuthStateChanged: function (cb) { cbs.push(cb); setTimeout(function () { cb(cur); }, 0); return function () {}; },
    getRedirectResult: function () { return Promise.resolve({}); },
    signOut: function () { cur = null; cbs.forEach(function (cb) { cb(null); }); return Promise.resolve(); },
    signInWithPopup: function () { cur = USER; cbs.forEach(function (cb) { cb(USER); }); return Promise.resolve(); },
    sendPasswordResetEmail: function () { return Promise.resolve(); },
  };
  window.__signIn = function () { return authInst.signInWithPopup(); };
  window.__signInPassword = function (verified) { cur = pwUser(verified); cbs.forEach(function (cb) { cb(cur); }); };

  function firestoreFn() { return fs; }
  firestoreFn.FieldValue = { serverTimestamp: function () { return TS; }, 'delete': function () { return DEL; } };
  function authFn() { return authInst; }
  authFn.EmailAuthProvider = { credential: function () { return {}; } };
  authFn.GoogleAuthProvider = function () {};

  window.firebase = { initializeApp: function () {}, firestore: firestoreFn, auth: authFn };
})();
