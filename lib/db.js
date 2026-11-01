// IndexedDB storage shared by the service worker and the dashboard (same extension origin).
//
// Store `followers` (one row per smart follower per scanned account), keyPath `id` = "<source>::<username>":
//   username, score, scanned_from, scan_time, first_seen_at, scan_count, scan_id, twitter_id, name,
//   followers_count, description, profile_image, tags, categories, subscribed_at, url, page,
//   min_score_filter, raw (the full untouched API object)
// Store `scans` (one row per account scan): source, status, min_score, filters, started_at, finished_at,
//   pages, requests, found, saved, skipped, error

const DB_NAME = 'sf-scrapper';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('followers')) {
        const s = db.createObjectStore('followers', { keyPath: 'id' });
        s.createIndex('scanned_from', 'scanned_from');
        s.createIndex('username', 'username');
        s.createIndex('score', 'score');
        s.createIndex('scan_time', 'scan_time');
      }
      if (!db.objectStoreNames.contains('scans')) {
        const s = db.createObjectStore('scans', { keyPath: 'id', autoIncrement: true });
        s.createIndex('source', 'source');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
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

/** Insert or update followers in one transaction. Keeps first_seen_at and increments scan_count. */
export async function upsertFollowers(records) {
  if (!records.length) return { inserted: 0, updated: 0 };
  const db = await openDB();
  const tx = db.transaction('followers', 'readwrite');
  const store = tx.objectStore('followers');
  let inserted = 0, updated = 0;
  for (const rec of records) {
    const g = store.get(rec.id);
    g.onsuccess = () => {
      const ex = g.result;
      if (ex) {
        rec.first_seen_at = ex.first_seen_at || ex.scan_time;
        rec.scan_count = ex.scan_id === rec.scan_id ? (ex.scan_count || 1) : (ex.scan_count || 1) + 1;
        updated++;
      } else {
        rec.first_seen_at = rec.scan_time;
        rec.scan_count = 1;
        inserted++;
      }
      store.put(rec);
    };
  }
  await done(tx);
  return { inserted, updated };
}

export async function putFollowersRaw(records) {
  const db = await openDB();
  const tx = db.transaction('followers', 'readwrite');
  const store = tx.objectStore('followers');
  for (const r of records) if (r && r.id) store.put(r);
  await done(tx);
}

export async function getAllFollowers() {
  const db = await openDB();
  return reqP(db.transaction('followers').objectStore('followers').getAll());
}

export async function countFollowers() {
  const db = await openDB();
  return reqP(db.transaction('followers').objectStore('followers').count());
}

export async function deleteFollowersBySource(source) {
  const db = await openDB();
  const tx = db.transaction('followers', 'readwrite');
  const idx = tx.objectStore('followers').index('scanned_from');
  const keys = await reqP(idx.getAllKeys(IDBKeyRange.only(source)));
  for (const k of keys) tx.objectStore('followers').delete(k);
  await done(tx);
  return keys.length;
}

export async function deleteFollowers(ids) {
  const db = await openDB();
  const tx = db.transaction('followers', 'readwrite');
  for (const id of ids) tx.objectStore('followers').delete(id);
  await done(tx);
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

/** Delete saved rows whose score is below `minScore` (optionally one source only). Returns rows removed. */
export async function purgeBelow(minScore, source = '', includeNoScore = true) {
  const db = await openDB();
  const tx = db.transaction('followers', 'readwrite');
  const store = tx.objectStore('followers');
  const req = source ? store.index('scanned_from').openCursor(IDBKeyRange.only(source)) : store.openCursor();
  let removed = 0;
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    const sc = cur.value.score;
    const noScore = sc === null || sc === undefined || !Number.isFinite(Number(sc));
    if ((noScore && includeNoScore) || (!noScore && Number(sc) < minScore)) { cur.delete(); removed++; }
    cur.continue();
  };
  await done(tx);
  return removed;
}

/** Count rows that purgeBelow would remove (preview). */
export async function countBelow(minScore, source = '', includeNoScore = true) {
  const rows = await getAllFollowers();
  return rows.filter((r) => (!source || r.scanned_from === source) &&
    ((r.score === null || r.score === undefined) ? includeNoScore : Number(r.score) < minScore)).length;
}
