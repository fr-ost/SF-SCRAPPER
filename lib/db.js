// IndexedDB storage shared by the service worker and the dashboard (same extension origin).
//
// Store `followers`: ONE row per smart account (no duplicates). keyPath `id` = lower-case username
// (or twitter_id when no username). Finding the same account again merges into the existing row:
//   username, name, score (latest), followers_count, description, profile_image, tags, categories,
//   scan_time      — last time they were scraped,   first_seen_at — first time they were stored
//   scan_count     — how many scans have seen them, scan_id / page / min_score_filter — from the latest scan
//   raw            — the full untouched API object from the latest scan
// Store `scans`: one row per account scan (source, status, min score, timings, counts, errors).

const DB_NAME = 'sf-scrapper';
const DB_VERSION = 3;
let dbPromise = null;

export const keyOf = (r) => String(r.username || r.twitter_id || '').replace(/^@/, '').toLowerCase();

// Fields from older versions that are no longer stored.
const DROPPED = ['scanned_from', 'sources', 'source_count'];
function strip(r) {
  for (const k of DROPPED) delete r[k];
  return r;
}

const empty = (v) => v === undefined || v === null || v === '';

/** Merge an incoming record into an existing one (either may be undefined). Pure function. */
export function mergeRecord(ex, rec) {
  const id = keyOf(rec.username || rec.twitter_id ? rec : ex || rec);
  if (!ex) {
    return strip({ ...rec, id, first_seen_at: rec.first_seen_at || rec.scan_time, scan_count: rec.scan_count || 1 });
  }
  const recNewer = String(rec.scan_time || '') >= String(ex.scan_time || '');
  const [newer, older] = recNewer ? [rec, ex] : [ex, rec];
  const out = { ...older };
  for (const [k, v] of Object.entries(newer)) if (!empty(v)) out[k] = v;
  out.id = id;
  const firsts = [ex.first_seen_at || ex.scan_time, rec.first_seen_at || rec.scan_time].filter(Boolean).sort();
  out.first_seen_at = firsts[0] || out.scan_time;
  const sameScan = rec.scan_id !== undefined && rec.scan_id === ex.scan_id;
  out.scan_count = sameScan ? (ex.scan_count || 1) : (ex.scan_count || 1) + (rec.scan_count || 1);
  return strip(out);
}

/** Collapse a list of records so each account appears once. */
export function dedupeList(records) {
  const m = new Map();
  for (const r of records) {
    const k = keyOf(r);
    if (!k) continue;
    m.set(k, mergeRecord(m.get(k), r));
  }
  return m;
}

function createFollowersStore(db) {
  const s = db.createObjectStore('followers', { keyPath: 'id' });
  s.createIndex('username', 'username');
  s.createIndex('score', 'score');
  s.createIndex('scan_time', 'scan_time');
  return s;
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains('scans')) {
        const s = db.createObjectStore('scans', { keyPath: 'id', autoIncrement: true });
        s.createIndex('source', 'source');
      }
      if (!db.objectStoreNames.contains('followers')) {
        createFollowersStore(db);
      } else if (ev.oldVersion < 3) {
        // v1 stored one row per (source, follower); v2 kept a list of sources per row.
        // Merge to one row per follower and drop the source fields.
        const getAll = tx.objectStore('followers').getAll();
        getAll.onsuccess = () => {
          const merged = dedupeList(getAll.result || []);
          db.deleteObjectStore('followers');
          const s = createFollowersStore(db);
          for (const r of merged.values()) s.put(r);
        };
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('[SF] DB upgrade blocked: close other dashboard tabs');
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function reqP(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

/** Insert or merge followers (one row per account). Returns { inserted, updated }. */
export async function upsertFollowers(records) {
  const batch = dedupeList(records);
  if (!batch.size) return { inserted: 0, updated: 0 };
  const db = await openDB();
  const tx = db.transaction('followers', 'readwrite');
  const store = tx.objectStore('followers');
  let inserted = 0, updated = 0;
  for (const [id, rec] of batch) {
    const g = store.get(id);
    g.onsuccess = () => {
      if (g.result) updated++; else inserted++;
      store.put(mergeRecord(g.result, rec));
    };
  }
  await done(tx);
  return { inserted, updated };
}

/** Rewrite the whole store so every account appears exactly once. Returns number of duplicate rows removed. */
export async function removeDuplicates() {
  const all = await getAllFollowers();
  const merged = dedupeList(all);
  const db = await openDB();
  const tx = db.transaction('followers', 'readwrite');
  const store = tx.objectStore('followers');
  store.clear();
  for (const r of merged.values()) store.put(r);
  await done(tx);
  return all.length - merged.size;
}

export async function getAllFollowers() {
  const db = await openDB();
  return reqP(db.transaction('followers').objectStore('followers').getAll());
}

export async function countFollowers() {
  const db = await openDB();
  return reqP(db.transaction('followers').objectStore('followers').count());
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['followers', 'scans'], 'readwrite');
  tx.objectStore('followers').clear();
  tx.objectStore('scans').clear();
  await done(tx);
}

export async function addScan(scan) {
  const db = await openDB();
  const tx = db.transaction('scans', 'readwrite');
  const id = await reqP(tx.objectStore('scans').add(scan));
  await done(tx);
  return id;
}

export async function putScan(scan) {
  const db = await openDB();
  const tx = db.transaction('scans', 'readwrite');
  tx.objectStore('scans').put(scan);
  await done(tx);
}

export async function getAllScans() {
  const db = await openDB();
  return reqP(db.transaction('scans').objectStore('scans').getAll());
}

export async function putScansRaw(scans) {
  const db = await openDB();
  const tx = db.transaction('scans', 'readwrite');
  for (const s of scans) if (s && s.id !== undefined) tx.objectStore('scans').put(s);
  await done(tx);
}

const isBelow = (r, minScore, includeNoScore) => {
  const sc = r.score;
  const noScore = sc === null || sc === undefined || sc === '' || !Number.isFinite(Number(sc));
  return noScore ? includeNoScore : Number(sc) < minScore;
};

/** Delete saved accounts whose score is below `minScore`. Returns rows removed. */
export async function purgeBelow(minScore, includeNoScore = true) {
  const db = await openDB();
  const tx = db.transaction('followers', 'readwrite');
  const req = tx.objectStore('followers').openCursor();
  let removed = 0;
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    if (isBelow(cur.value, minScore, includeNoScore)) { cur.delete(); removed++; }
    cur.continue();
  };
  await done(tx);
  return removed;
}

/** Count rows that purgeBelow would remove (preview). */
export async function countBelow(minScore, includeNoScore = true) {
  const rows = await getAllFollowers();
  return rows.filter((r) => isBelow(r, minScore, includeNoScore)).length;
}
