// SF Scrapper — scraping engine (MV3 service worker).
//
// Throughput design:
//  * One global limiter spaces requests evenly at `rpm` per minute and also enforces a 60 s sliding window,
//    so the plan limit (300/min) is never exceeded, whatever the concurrency.
//  * Many accounts are scanned in parallel and each account fetches `pageWindow` pages at once,
//    so the limiter is always saturated even with slow API responses.
//  * get_followers is sorted by score (high -> low): with a min score set, an account stops as soon as a
//    page contains a score below the threshold. Low-score pages are never paid for.
//  * 429 / rate-limit answers pause the whole engine for Retry-After and then retry the same page.
//  * The monthly quota is counted locally (and can be synced with /limits); the engine stops at the cap.
//  * State is persisted, so if Chrome kills the service worker the scan resumes where it was.

import {
  mergeSettings, parseUsernames, buildFollowersRequest, buildRequest, redactUrl,
  extractItems, extractMeta, extractApiError, normalizeFollower, scoreOf,
} from './lib/api.js';
import { upsertFollowers, addScan, putScan, purgeBelow } from './lib/db.js';

const STOP = new Error('__STOP__');
const CLAMP_SIZES = new Set([10, 15, 20, 25, 30, 40, 50, 100]);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const monthKey = () => new Date().toISOString().slice(0, 7);

let S = mergeSettings();
const st = {
  running: false,
  stopReason: '',
  jobs: [],
  log: [],
  stats: { requests: 0, ok: 0, errors: 0, retries: 0, rateLimited: 0, saved: 0, newAccounts: 0, skipped: 0, startedAt: null, finishedAt: null },
  usage: { month: monthKey(), count: 0 },
  pauseUntil: 0,
  serverRate: null,
  limits: null,
};
let engineActive = false;
let jobSeq = 0;

// ---------------------------------------------------------------- logging / persistence
function log(level, msg) {
  st.log.push({ t: nowIso(), level, msg });
  if (st.log.length > 400) st.log.splice(0, st.log.length - 400);
  if (level === 'error') console.warn('[SF]', msg); else console.log('[SF]', msg);
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 1000);
}
async function persistNow() {
  const jobs = st.jobs.map(({ inflight, ...j }) => j);
  await chrome.storage.local.set({
    engine: { running: st.running, stopReason: st.stopReason, jobs, stats: st.stats, log: st.log.slice(-200), jobSeq },
    usage: st.usage,
    limits: st.limits,
  });
}

function bumpUsage() {
  const m = monthKey();
  if (st.usage.month !== m) st.usage = { month: m, count: 0 };
  st.usage.count++;
  st.stats.requests++;
}

// ---------------------------------------------------------------- rate limiter
const limiter = {
  chain: Promise.resolve(),
  win: [],
  next: 0,
  rpmNow() { const c = Date.now() - 60000; this.win = this.win.filter((x) => x > c); return this.win.length; },
  acquire(force = false) {
    const p = this.chain.then(async () => {
      for (;;) {
        if (!force && !st.running) throw STOP;
        const now = Date.now();
        const rpm = Math.max(1, Number(S.rpm) || 1);
        this.win = this.win.filter((x) => x > now - 60000);
        let until = Math.max(this.next, st.pauseUntil);
        if (this.win.length >= rpm) until = Math.max(until, this.win[0] + 60000 + 10);
        if (until <= now) break;
        await sleep(Math.min(until - now, 500));
      }
      const t = Date.now();
      this.win.push(t);
      this.next = t + 60000 / Math.max(1, Number(S.rpm) || 1);
    });
    this.chain = p.catch(() => {});
    return p;
  },
};

// ---------------------------------------------------------------- toolbar icon / badge
const ICONS = (suf) => ({ 16: `icons/icon16${suf}.png`, 32: `icons/icon32${suf}.png`, 48: `icons/icon48${suf}.png`, 128: `icons/icon128${suf}.png` });
let badgeState = '';
function updateBadge() {
  const active = st.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const paused = st.jobs.some((j) => j.status === 'paused');
  const key = st.running ? `run:${active}` : paused ? 'paused' : 'idle';
  if (key === badgeState) return;
  badgeState = key;
  try {
    chrome.action.setIcon({ path: ICONS(st.running ? '-run' : '') });
    chrome.action.setBadgeBackgroundColor({ color: st.running ? '#2ea043' : '#d29922' });
    chrome.action.setBadgeText({ text: st.running ? String(active || '') || 'ON' : paused ? 'II' : '' });
    chrome.action.setTitle({ title: st.running ? `SF Scrapper: running (${active} account(s) left)` : paused ? 'SF Scrapper: paused' : 'SF Scrapper' });
  } catch { /* ignore */ }
}
setInterval(updateBadge, 1500);

// ---------------------------------------------------------------- keep-alive
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}
function stopKeepAlive() { clearInterval(keepAliveTimer); keepAliveTimer = null; }

// ---------------------------------------------------------------- job scheduling
function lastAllowedPage(j) {
  let last = Infinity;
  if (j.stopAtPage !== null && j.stopAtPage !== undefined) last = Math.min(last, j.stopAtPage);
  if (j.totalPages) last = Math.min(last, S.firstPage + j.totalPages - 1);
  if (S.maxPagesPerAccount > 0) last = Math.min(last, S.firstPage + S.maxPagesPerAccount - 1);
  return last;
}

function hasWorkLeft(j) {
  const last = lastAllowedPage(j);
  j.retryPages = j.retryPages.filter((p) => p <= last);
  return j.retryPages.length > 0 || j.nextPage <= last;
}

function canIssue(j) {
  const limit = j.pagesDone === 0 ? 1 : Math.max(1, S.pageWindow); // probe page 1 before fanning out
  return j.inflight < limit && hasWorkLeft(j);
}

function pickJob() {
  let running = 0;
  for (const j of st.jobs) if (j.status === 'running') running++;
  let best = null;
  for (const j of st.jobs) {
    if (j.status === 'running') {
      if (canIssue(j) && (!best || j.inflight < best.inflight)) best = j;
    }
  }
  if (best && best.inflight === 0) return best;
  if (running < S.parallelAccounts) {
    const q = st.jobs.find((j) => j.status === 'queued');
    if (q) {
      q.status = 'running';
      q.startedAt = q.startedAt || nowIso();
      log('info', `▶ Scanning @${q.source} (min score ${q.minScore})`);
      return q;
    }
  }
  return best;
}

function pendingWork() {
  return st.jobs.some((j) => j.status === 'queued' || (j.status === 'running' && (j.inflight > 0 || hasWorkLeft(j))));
}

function finishJobIfDone(j) {
  if (j.status !== 'running' || j.inflight > 0 || hasWorkLeft(j)) return;
  j.status = j.error ? 'error' : 'done';
  j.finishedAt = nowIso();
  log(j.error ? 'error' : 'ok',
    `${j.error ? '✖' : '✔'} @${j.source}: ${j.saved} saved (${j.newAccounts} new), ${j.skipped} below filter, ${j.pagesDone} pages, ${j.requests} requests${j.error ? ' — ' + j.error : ''}${j.stopWhy ? ' — stop: ' + j.stopWhy : ''}`);
  putScan(scanRecord(j)).catch(() => {});
}

function scanRecord(j) {
  return {
    id: j.scanId, source: j.source, status: j.status, min_score: j.minScore, filters: j.filters,
    started_at: j.startedAt, finished_at: j.finishedAt, created_at: j.createdAt,
    pages: j.pagesDone, requests: j.requests, found: j.found, saved: j.saved, new_accounts: j.newAccounts,
    skipped: j.skipped, total_reported: j.total ?? null, error: j.error || null, stop_reason: j.stopWhy || null,
  };
}

function setStop(j, page, why) {
  if (j.stopAtPage === null || j.stopAtPage === undefined || page < j.stopAtPage) {
    j.stopAtPage = page;
    j.stopWhy = why;
  }
}

// ---------------------------------------------------------------- engine
async function runEngine() {
  if (engineActive) return;
  engineActive = true;
  st.running = true;
  st.stopReason = '';
  st.stats.startedAt = st.stats.startedAt || nowIso();
  st.stats.finishedAt = null;
  startKeepAlive();
  schedulePersist();
  updateBadge();
  log('info', `Engine started — ${S.rpm} req/min, ${S.maxConcurrent} concurrent, ${S.parallelAccounts} accounts × ${S.pageWindow} pages`);
  try {
    const n = Math.max(1, Number(S.maxConcurrent) || 1);
    await Promise.all(Array.from({ length: n }, () => worker()));
  } finally {
    engineActive = false;
    const wasStopped = !st.running;
    st.running = false;
    for (const j of st.jobs) {
      if (j.status === 'running') {
        j.retryPages.push(...j.inflightPages);
        j.inflightPages = [];
        j.inflight = 0;
        if (hasWorkLeft(j)) j.status = 'paused'; else finishJobIfDone(j);
      }
    }
    st.stats.finishedAt = nowIso();
    stopKeepAlive();
    updateBadge();
    log(wasStopped && st.stopReason ? 'warn' : 'ok', wasStopped && st.stopReason ? `■ Engine stopped: ${st.stopReason}` : '■ All scans finished');
    await persistNow();
  }
}

function stopAll(reason) {
  if (!st.running) return;
  st.stopReason = reason;
  st.running = false;
  log('warn', `Stopping: ${reason}`);
}

async function worker() {
  while (st.running) {
    const job = pickJob();
    if (!job) {
      if (!pendingWork()) return;
      await sleep(60);
      continue;
    }
    const page = job.retryPages.length ? job.retryPages.shift() : job.nextPage++;
    job.inflight++;
    job.inflightPages.push(page);
    try {
      await fetchPage(job, page);
    } catch (e) {
      if (e === STOP) {
        job.retryPages.push(page);
      } else {
        job.failedPages.push(page);
        st.stats.errors++;
        log('error', `@${job.source} page ${page} failed: ${e.message}`);
        if (job.pagesDone === 0 && job.failedPages.length >= 2) { job.error = e.message; setStop(job, 0, 'error'); }
      }
    } finally {
      job.inflight--;
      const i = job.inflightPages.indexOf(page);
      if (i >= 0) job.inflightPages.splice(i, 1);
      if (st.running) finishJobIfDone(job);
      schedulePersist();
    }
  }
}

function retryAfterMs(res) {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return Math.max(1000, n * 1000);
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.max(1000, d - Date.now());
  }
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) return Math.max(1000, n > 1e9 ? n * 1000 - Date.now() : n * 1000);
  }
  return null;
}

function readRateHeaders(res) {
  const h = {};
  for (const [k, v] of res.headers) if (/ratelimit|quota|remaining/i.test(k)) h[k] = v;
  if (Object.keys(h).length) st.serverRate = h;
}

const short = (t) => String(t ?? '').replace(/\s+/g, ' ').slice(0, 200);

async function fetchPage(job, page) {
  const { url, headers } = buildFollowersRequest(S, job.source, page, job.filters);
  let attempt = 0;
  for (;;) {
    await limiter.acquire();
    if (page > lastAllowedPage(job)) return; // became unnecessary while waiting — no request spent
    if (st.usage.month === monthKey() && st.usage.count >= S.monthlyLimit) {
      stopAll(`Monthly quota reached (${st.usage.count}/${S.monthlyLimit})`);
      throw STOP;
    }
    bumpUsage();
    job.requests++;
    let res, text;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(S.requestTimeoutMs) });
      text = await res.text();
    } catch (e) {
      if (++attempt <= 4) {
        st.stats.retries++;
        log('warn', `@${job.source} p${page}: network error (${e.message}), retry ${attempt}`);
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw new Error(`network: ${e.message}`);
    }
    readRateHeaders(res);
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    const apiErr = json ? extractApiError(json) : null;

    if (res.status === 429 || (apiErr && /rate.?limit|too many requests|per minute/i.test(apiErr))) {
      st.stats.rateLimited++;
      const wait = retryAfterMs(res) ?? 15000;
      st.pauseUntil = Math.max(st.pauseUntil, Date.now() + wait);
      log('warn', `Rate limited (429) — pausing ${Math.round(wait / 1000)}s`);
      if (++attempt <= 15) continue;
      throw new Error('rate limited repeatedly');
    }
    if (res.status === 401 || res.status === 403 || (apiErr && /api.?key|unauthori[sz]ed|forbidden|invalid key|not authenticated/i.test(apiErr))) {
      const msg = apiErr || short(text);
      if (/quota|exceed|month|limit/i.test(msg)) stopAll(`Quota exhausted: ${msg}`);
      else stopAll(`API key rejected (HTTP ${res.status}): ${msg}`);
      throw STOP;
    }
    if (apiErr && /quota|exceeded|monthly|no requests left|limit reached/i.test(apiErr)) {
      stopAll(`Quota exhausted: ${apiErr}`);
      throw STOP;
    }
    if (res.status >= 500) {
      if (++attempt <= 4) {
        st.stats.retries++;
        log('warn', `@${job.source} p${page}: HTTP ${res.status}, retry ${attempt}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${short(text)}`);
    }
    if (!res.ok || apiErr) {
      // 400/404/422 or success=false: on page 1 the account is unknown/unsupported; later pages = out of range.
      if (page <= S.firstPage && job.pagesDone === 0) job.error = `HTTP ${res.status}: ${apiErr || short(text)}`;
      setStop(job, page - 1, apiErr ? `API: ${short(apiErr)}` : `HTTP ${res.status}`);
      return;
    }
    if (!json) throw new Error(`invalid JSON: ${short(text)}`);
    await handlePage(job, page, json);
    return;
  }
}

async function handlePage(job, page, json) {
  const items = extractItems(json);
  const meta = extractMeta(json);
  job.pagesDone++;
  st.stats.ok++;
  if (meta.total !== null && meta.total !== undefined) job.total = meta.total;
  if (meta.totalPages && meta.totalPages > 0) job.totalPages = meta.totalPages;

  if (!items.length) {
    setStop(job, page - 1, 'end of list');
  } else {
    const n = items.length;
    const moreSignalled = meta.hasNext === true || (job.totalPages && page < S.firstPage + job.totalPages - 1);
    if (!job.effSize) {
      // First page tells us the real page size (the API may cap `size`).
      job.effSize = n;
      if (n < S.pageSize && !moreSignalled && !CLAMP_SIZES.has(n)) setStop(job, page, 'last page');
    } else if (n < job.effSize && !moreSignalled) {
      setStop(job, page, 'last page');
    }
    if (meta.hasNext === false) setStop(job, page, 'last page');
    if (S.earlyStop && job.minScore > 0) {
      const scores = items.map(scoreOf).filter((x) => x !== null);
      if (scores.length && Math.min(...scores) < job.minScore) setStop(job, page, `scores below ${job.minScore}`);
    }
  }

  const scanTime = nowIso();
  const recs = [];
  let skipped = 0;
  for (const it of items) {
    const sc = scoreOf(it);
    if (job.minScore > 0 && (sc === null || sc < job.minScore)) { skipped++; continue; }
    const r = normalizeFollower(it, { source: job.source, scanTime, scanId: job.scanId, page, minScore: job.minScore });
    if (!r.username && !r.twitter_id) { skipped++; continue; }
    recs.push(r);
  }
  job.found += items.length;
  job.skipped += skipped;
  st.stats.skipped += skipped;
  if (recs.length) {
    const { inserted } = await upsertFollowers(recs);
    job.saved += recs.length;
    job.newAccounts += inserted;
    st.stats.saved += recs.length;
    st.stats.newAccounts += inserted;
  }
}

// ---------------------------------------------------------------- commands
async function enqueue(usernames, minScore, filters) {
  const list = Array.isArray(usernames) ? parseUsernames(usernames.join('\n')) : parseUsernames(usernames);
  const ms = Math.max(0, Number(minScore) || 0);
  const added = [];
  for (const source of list) {
    const busy = st.jobs.find((j) => j.source.toLowerCase() === source.toLowerCase() && ['queued', 'running', 'paused'].includes(j.status));
    if (busy) continue;
    const job = {
      id: ++jobSeq, source, minScore: ms, filters: filters || {}, status: 'queued',
      createdAt: nowIso(), startedAt: null, finishedAt: null,
      nextPage: S.firstPage, retryPages: [], inflightPages: [], failedPages: [], inflight: 0,
      stopAtPage: null, stopWhy: '', totalPages: null, total: null, effSize: 0,
      pagesDone: 0, requests: 0, found: 0, saved: 0, newAccounts: 0, skipped: 0, error: '',
    };
    const { id: _unused, ...rec } = scanRecord(job);
    job.scanId = await addScan(rec);
    st.jobs.push(job);
    added.push(source);
  }
  if (added.length) log('info', `Queued ${added.length} account(s): ${added.slice(0, 10).map((s) => '@' + s).join(', ')}${added.length > 10 ? '…' : ''}`);
  for (const j of st.jobs) if (j.status === 'paused') j.status = 'running';
  if (!engineActive && st.jobs.some((j) => ['queued', 'running'].includes(j.status))) runEngine();
  schedulePersist();
  return { added: added.length, skipped: list.length - added.length };
}

function resume() {
  let n = 0;
  for (const j of st.jobs) if (j.status === 'paused') { j.status = 'running'; n++; }
  if (!engineActive && st.jobs.some((j) => ['queued', 'running'].includes(j.status))) runEngine();
  return n;
}

function publicState() {
  const counts = {};
  for (const j of st.jobs) counts[j.status] = (counts[j.status] || 0) + 1;
  const inflight = st.jobs.reduce((a, j) => a + (j.inflight || 0), 0);
  const order = { running: 0, paused: 1, queued: 2, error: 3, done: 4 };
  const jobs = [...st.jobs]
    .sort((a, b) => (order[a.status] - order[b.status]) || (b.id - a.id))
    .slice(0, 300)
    .map(({ retryPages, inflightPages, failedPages, filters, ...j }) => ({ ...j, failed: failedPages.length }));
  return {
    running: st.running, stopReason: st.stopReason, jobs, counts, totalJobs: st.jobs.length,
    stats: st.stats, usage: st.usage, rpmNow: limiter.rpmNow(), inflight,
    pausedFor: Math.max(0, st.pauseUntil - Date.now()), serverRate: st.serverRate, limits: st.limits,
    log: st.log.slice(-150),
    settings: { rpm: S.rpm, monthlyLimit: S.monthlyLimit, hasKey: !!S.apiKey, defaultMinScore: S.defaultMinScore },
  };
}

async function apiGet(endpoint, params) {
  if (!S.apiKey) throw new Error('Set your TwitterScore API key in Settings first');
  const { url, headers } = buildRequest(S, endpoint, params);
  await limiter.acquire(true);
  bumpUsage();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(S.requestTimeoutMs) });
  const text = await res.text();
  readRateHeaders(res);
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  schedulePersist();
  return { status: res.status, url: redactUrl(url), json, text: json ? undefined : text.slice(0, 2000) };
}

const handlers = {
  getState: async () => publicState(),
  getSettings: async () => S,
  saveSettings: async ({ settings }) => {
    S = mergeSettings({ ...S, ...settings });
    for (const k of ['pageSize', 'firstPage', 'rpm', 'monthlyLimit', 'maxConcurrent', 'parallelAccounts', 'pageWindow', 'maxPagesPerAccount', 'requestTimeoutMs', 'defaultMinScore']) {
      S[k] = Math.max(k === 'firstPage' || k === 'maxPagesPerAccount' || k === 'defaultMinScore' ? 0 : 1, Number(S[k]) || 0);
    }
    S.earlyStop = !!S.earlyStop;
    const df = S.defaultFilters || {};
    S.defaultFilters = { category_id: String(df.category_id ?? ''), tag_id: String(df.tag_id ?? ''), tag_category_id: String(df.tag_category_id ?? '') };
    await chrome.storage.local.set({ settings: S });
    return S;
  },
  start: async ({ usernames, minScore, filters }) => {
    if (!S.apiKey) throw new Error('Set your TwitterScore API key in Settings first');
    return enqueue(usernames, minScore, filters);
  },
  stop: async () => { stopAll('stopped by user'); return true; },
  resume: async () => resume(),
  clearFinished: async () => { st.jobs = st.jobs.filter((j) => !['done', 'error'].includes(j.status)); schedulePersist(); return true; },
  clearQueue: async () => {
    st.jobs = st.jobs.filter((j) => j.status !== 'queued' && j.status !== 'paused');
    for (const j of st.jobs) if (j.status === 'running') setStop(j, j.nextPage - 1, 'cancelled');
    schedulePersist();
    return true;
  },
  resetStats: async () => {
    st.stats = { requests: 0, ok: 0, errors: 0, retries: 0, rateLimited: 0, saved: 0, newAccounts: 0, skipped: 0, startedAt: null, finishedAt: null };
    st.log = [];
    schedulePersist();
    return true;
  },
  setUsage: async ({ count }) => { st.usage = { month: monthKey(), count: Math.max(0, Number(count) || 0) }; schedulePersist(); return st.usage; },
  testApi: async ({ username }) => {
    if (!S.apiKey) throw new Error('Set your TwitterScore API key in Settings first');
    const src = parseUsernames(username)[0];
    if (!src) throw new Error('Enter a username');
    const { url, headers } = buildFollowersRequest(S, src, S.firstPage, {});
    await limiter.acquire(true);
    bumpUsage();
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(S.requestTimeoutMs) });
    const text = await res.text();
    readRateHeaders(res);
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    const items = json ? extractItems(json) : [];
    schedulePersist();
    return {
      status: res.status, url: redactUrl(url), meta: json ? extractMeta(json) : {}, apiError: json ? extractApiError(json) : null,
      itemCount: items.length,
      sample: items[0] ? normalizeFollower(items[0], { source: src, scanTime: nowIso(), scanId: 0, page: S.firstPage, minScore: 0 }) : null,
      raw: json ?? text.slice(0, 4000),
    };
  },
  checkLimits: async () => {
    const r = await apiGet('limits', {});
    st.limits = { at: nowIso(), status: r.status, data: r.json ?? r.text };
    schedulePersist();
    return st.limits;
  },
  apiGet: async ({ endpoint, params }) => apiGet(endpoint, params),
  purgeBelow: async ({ minScore, source, includeNoScore }) => {
    const n = await purgeBelow(Number(minScore) || 0, source || '', includeNoScore !== false);
    log('ok', `🧹 Removed ${n} saved account(s) with score below ${minScore}${source ? ' from @' + source : ''}`);
    schedulePersist();
    return n;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg && msg.type];
  if (!h) return false;
  ready
    .then(() => h(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true;
});

// ---------------------------------------------------------------- startup / resume
async function init() {
  const { settings, engine, usage, limits } = await chrome.storage.local.get(['settings', 'engine', 'usage', 'limits']);
  S = mergeSettings(settings);
  if (usage) st.usage = usage;
  if (st.usage.month !== monthKey()) st.usage = { month: monthKey(), count: 0 };
  if (limits) st.limits = limits;
  if (engine) {
    jobSeq = engine.jobSeq || 0;
    st.stats = { ...st.stats, ...(engine.stats || {}) };
    st.log = engine.log || [];
    st.stopReason = engine.stopReason || '';
    st.jobs = (engine.jobs || []).map((j) => ({
      ...j,
      inflight: 0,
      retryPages: [...(j.retryPages || []), ...(j.inflightPages || [])],
      inflightPages: [],
      failedPages: j.failedPages || [],
    }));
    if (engine.running && st.jobs.some((j) => ['queued', 'running'].includes(j.status))) {
      log('info', 'Service worker restarted — resuming scan');
      setTimeout(runEngine, 0);
    } else {
      for (const j of st.jobs) if (j.status === 'running') j.status = 'paused';
    }
  }
}
const ready = init().catch((e) => console.error('init failed', e)).finally(updateBadge);

chrome.alarms.create('sf-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'sf-heartbeat') return;
  await ready;
  const { engine } = await chrome.storage.local.get('engine');
  if (engine && engine.running && !engineActive && st.jobs.some((j) => ['queued', 'running'].includes(j.status))) runEngine();
});

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#settings') });
});
