/* Spread Scout local data store.
   Published data comes from data/data.js, which the refresh workflow builds.
   Each visitor's watchlist and notes are kept in their own browser (IndexedDB). */
(function (root) {
  "use strict";
  const SEED = root.SPREAD_SCOUT_DATA || {};
  const COLLECTIONS = ["issuers", "ncds", "intel", "leads", "uploads", "watchlist"];
  const DB_NAME = "spread-scout", KV = "kv", FILES = "files";
  let overlay = {};            // { collection: { id: doc | null(deleted) } }
  const subs = {};
  let idb = null, ready;

  function openIdb() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { const d = req.result; d.createObjectStore(KV); d.createObjectStore(FILES); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  function tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      if (!idb) return reject(new Error("storage unavailable"));
      const t = idb.transaction(store, mode); const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  }
  ready = (async () => {
    idb = await openIdb();
    if (idb) { try { overlay = (await tx(KV, "readonly", s => s.get("overlay"))) || {}; } catch (e) { overlay = {}; } }
    else { try { overlay = JSON.parse(localStorage.getItem("spread-scout-overlay") || "{}"); } catch (e) { overlay = {}; } }
  })();

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const copy = JSON.parse(JSON.stringify(overlay));
      if (idb) { try { await tx(KV, "readwrite", s => s.put(copy, "overlay")); return; } catch (e) {} }
      try { localStorage.setItem("spread-scout-overlay", JSON.stringify(copy)); } catch (e) {}
    }, 150);
  }
  function merged(c) {
    const out = Object.assign({}, SEED[c] || {});
    if (c !== "watchlist") return out;
    Object.entries(overlay[c] || {}).forEach(([id, d]) => { if (d === null) delete out[id]; else out[id] = d; });
    return out;
  }
  const snap = (c) => ({ docs: Object.entries(merged(c)).map(([id, x]) => ({ id, exists: true, data: () => x })) });
  function fire(c) { (subs[c] || []).forEach(cb => setTimeout(() => cb(snap(c)), 0)); }
  function write(c, id, doc) { (overlay[c] = overlay[c] || {})[id] = doc; persist(); fire(c); }

  function docRef(c, id) {
    return {
      id,
      async get() { await ready; const m = merged(c); return { id, exists: id in m, data: () => m[id] }; },
      async set(x) { await ready; write(c, id, JSON.parse(JSON.stringify(x))); },
      async update(x) { await ready; const m = merged(c); if (!(id in m)) throw { code: "invalid_argument" }; write(c, id, Object.assign({}, m[id], JSON.parse(JSON.stringify(x)))); },
      async delete() { await ready; write(c, id, null); }
    };
  }
  const db = {
    collection(c) {
      return {
        onSnapshot(cb) { (subs[c] = subs[c] || []).push(cb); ready.then(() => cb(snap(c))); return () => { subs[c] = subs[c].filter(f => f !== cb); }; },
        doc(id) { return docRef(c, id || ("d-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))); },
        async add(x) { const r = docRef(c, "d-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)); await r.set(x); return r; }
      };
    },
    doc(path) { const [c, id] = path.split("/"); return docRef(c, id); }
  };

  async function putFile(blob) {
    await ready;
    const id = "f-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await tx(FILES, "readwrite", s => s.put(blob, id));
    return id;
  }
  async function getFile(id) { await ready; return tx(FILES, "readonly", s => s.get(id)); }

  function hasLocalChanges() { return Object.values(overlay).some(m => m && Object.keys(m).length); }
  function localChangeCount() {
    const out = {}; Object.entries(overlay).forEach(([c, m]) => { const n = Object.keys(m || {}).length; if (n) out[c] = n; }); return out;
  }
  async function resetLocal() {
    await ready; overlay = {}; persist();
    if (idb) { try { await tx(FILES, "readwrite", s => s.clear()); } catch (e) {} }
    COLLECTIONS.forEach(fire);
  }
  function exportDataJs(opts) {
    const data = {};
    COLLECTIONS.forEach(c => { data[c] = merged(c); });
    if (!(opts && opts.includeWatchlist)) data.watchlist = SEED.watchlist || {};
    Object.values(data.uploads || {}).forEach(u => {
      if (u.localFileId) { u.rawPath = "data/raw/" + u.file; delete u.localFileId; }
    });
    return "/* Spread Scout data file. Generated " + new Date().toISOString() + ". Replace data/data.js in the repository with this file. */\n" +
      "window.SPREAD_SCOUT_DATA = " + JSON.stringify(data) + ";\n";
  }

  root.LocalStore = { db, ready, putFile, getFile, hasLocalChanges, localChangeCount, resetLocal, exportDataJs };
})(window);
