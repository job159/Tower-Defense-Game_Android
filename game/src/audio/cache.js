// IndexedDB cache for rendered PCM (Int16) so later launches skip synthesis. Every call is guarded:
// private mode, quota errors, blocked upgrades or a missing IndexedDB simply mean "no cache".
const DB = 'neonbastion-audio';
const STORE = 'pcm';

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export class AudioCache {
  constructor(version) {
    this.version = version;
    this.db = null;
    this.writes = Promise.resolve();
    this.bytesWritten = 0;
  }

  async open(timeoutMs = 2500) {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return false;
      const db = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('idb timeout')), timeoutMs);
        let r;
        try { r = indexedDB.open(DB, 1); } catch (e) { clearTimeout(t); rej(e); return; }
        r.onupgradeneeded = () => { try { r.result.createObjectStore(STORE); } catch (e) { /* exists */ } };
        r.onsuccess = () => { clearTimeout(t); res(r.result); };
        r.onerror = () => { clearTimeout(t); rej(r.error); };
        r.onblocked = () => { clearTimeout(t); rej(new Error('idb blocked')); };
      });
      this.db = db;
      db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } this.db = null; };
      // drop entries from other engine versions (best effort, in the background)
      const meta = await this.get('__version__', true);
      if (meta !== this.version) {
        await this.clear();
        await this.put('__version__', this.version, true);
      }
      return true;
    } catch (e) {
      this.db = null;
      return false;
    }
  }

  key(k, raw) { return raw ? k : `${this.version}|${k}`; }

  async get(k, raw = false) {
    if (!this.db) return null;
    try {
      const tx = this.db.transaction(STORE, 'readonly');
      const v = await req(tx.objectStore(STORE).get(this.key(k, raw)));
      return v === undefined ? null : v;
    } catch (e) { return null; }
  }

  // Writes are serialized so large records never pile up in memory at once.
  put(k, v, raw = false) {
    if (!this.db) return Promise.resolve(false);
    this.writes = this.writes.then(() => new Promise((res) => {
      try {
        const tx = this.db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(v, this.key(k, raw));
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
        tx.onabort = () => res(false);
      } catch (e) { res(false); }
    }));
    return this.writes;
  }

  async clear() {
    if (!this.db) return;
    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
    } catch (e) { /* ignore */ }
  }
}
