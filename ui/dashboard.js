import { send, $, fmt, esc, ago, fmtDate, usageHtml, statusLine, jobRow, JOB_HEAD } from './common.js';
import { DEFAULT_SETTINGS, parseUsernames, extractItems } from '../lib/api.js';
import { getAllFollowers, getAllScans, deleteFollowersBySource, clearAll, putFollowersRaw, putScansRaw } from '../lib/db.js';

// ------------------------------------------------------------------ tabs
const tabs = ['scan', 'db', 'history', 'settings', 'log'];
function showTab(name) {
  if (!tabs.includes(name)) name = 'scan';
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  if (name === 'db') loadDb();
  if (name === 'history') loadHistory();
  if (name === 'settings') loadSettings();
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); showTab(a.dataset.goto); }));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------------ scan tab
$('#jobsHead').innerHTML = JOB_HEAD;
const draftKey = 'sf-dash-draft';
$('#users').value = localStorage.getItem(draftKey) || '';
const updateCount = () => {
  const n = parseUsernames($('#users').value).length;
  $('#userCount').textContent = n ? `${n} unique account(s)` : '';
};
$('#users').oninput = () => { localStorage.setItem(draftKey, $('#users').value); updateCount(); };
updateCount();

$('#start').onclick = async () => {
  $('#msg').textContent = '';
  try {
    const filters = { category_id: $('#fCategory').value, tag_id: $('#fTag').value, tag_category_id: $('#fTagCat').value };
    const r = await send('start', { usernames: $('#users').value, minScore: Number($('#minScore').value) || 0, filters });
    $('#msg').textContent = `Queued ${r.added} account(s)${r.skipped ? ` · ${r.skipped} skipped (already queued/invalid)` : ''}`;
    if (r.added) { $('#users').value = ''; localStorage.removeItem(draftKey); updateCount(); }
  } catch (e) { $('#msg').textContent = '⚠ ' + e.message; }
};
$('#stop').onclick = () => send('stop');
$('#resume').onclick = () => send('resume');
$('#clearFinished').onclick = () => send('clearFinished');
$('#clearQueue').onclick = () => confirm('Cancel all queued / paused accounts?') && send('clearQueue');
$('#resetStats').onclick = (e) => { e.preventDefault(); send('resetStats'); };

function optionsHtml(list) {
  return '<option value="">— any —</option>' + list.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}${o.extra ? ' · ' + esc(o.extra) : ''} (#${esc(o.id)})</option>`).join('');
}
function toOpts(arr) {
  return arr.map((x) => ({ id: x.id ?? x.category_id ?? x.tag_id, name: x.name ?? x.title ?? x.tag ?? String(x.id), cat: x.category ?? x.tag_category ?? x.category_name ?? null }))
    .filter((x) => x.id !== undefined && x.id !== null);
}
async function applyCats(cache) {
  const cats = toOpts(cache.categories || []);
  const tags = toOpts(cache.tags || []);
  const tagCats = new Map();
  for (const t of tags) {
    const c = t.cat;
    if (c && typeof c === 'object' && (c.id ?? null) !== null) tagCats.set(String(c.id), c.name ?? String(c.id));
    t.extra = c && typeof c === 'object' ? c.name : (c ?? '');
  }
  $('#fCategory').innerHTML = optionsHtml(cats);
  $('#fTag').innerHTML = optionsHtml(tags);
  $('#fTagCat').innerHTML = optionsHtml([...tagCats].map(([id, name]) => ({ id, name })));
}
chrome.storage.local.get('catsCache').then(({ catsCache }) => catsCache && applyCats(catsCache));
$('#loadCats').onclick = async () => {
  $('#msg').textContent = 'Loading categories & tags…';
  try {
    const [c, t] = await Promise.all([send('apiGet', { endpoint: 'get_categories' }), send('apiGet', { endpoint: 'get_tags' })]);
    const cache = { categories: extractItemsLoose(c.json), tags: extractItemsLoose(t.json), at: new Date().toISOString() };
    await chrome.storage.local.set({ catsCache: cache });
    await applyCats(cache);
    $('#msg').textContent = `Loaded ${cache.categories.length} categories, ${cache.tags.length} tags`;
  } catch (e) { $('#msg').textContent = '⚠ ' + e.message; }
};
function extractItemsLoose(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  for (const k of ['categories', 'tags', 'data', 'items', 'results', 'result']) if (Array.isArray(json[k])) return json[k];
  const r = extractItems(json);
  if (r.length) return r;
  for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  return [];
}

let lastLogLen = -1;
async function refresh() {
  let st;
  try { st = await send('getState'); } catch (e) { $('#status').textContent = e.message; return; }
  $('#noKey').hidden = st.settings.hasKey;
  const line = statusLine(st);
  $('#status').innerHTML = line;
  $('#hdrStatus').innerHTML = line;
  $('#usage').innerHTML = usageHtml(st);
  $('#cRpm').textContent = `${fmt(st.rpmNow)} / ${fmt(st.settings.rpm)}`;
  $('#rpmBar').style.width = Math.min(100, (st.rpmNow / st.settings.rpm) * 100) + '%';
  $('#cInflight').textContent = fmt(st.inflight);
  $('#cSaved').textContent = fmt(st.stats.saved);
  $('#cNew').textContent = fmt(st.stats.newAccounts);
  $('#cSkipped').textContent = fmt(st.stats.skipped);
  $('#cReq').textContent = fmt(st.stats.requests);
  $('#cErr').textContent = `${fmt(st.stats.retries)} / ${fmt(st.stats.rateLimited)} / ${fmt(st.stats.errors)}`;
  const c = st.counts;
  $('#cJobs').textContent = `${c.running || 0} / ${(c.queued || 0) + (c.paused || 0)} / ${(c.done || 0) + (c.error || 0)}`;
  const sr = st.serverRate ? 'Server: ' + Object.entries(st.serverRate).map(([k, v]) => `${k}=${v}`).join(' · ') : '';
  const lim = st.limits ? ` · /limits checked ${ago(st.limits.at)}` : '';
  $('#serverRate').textContent = sr + lim;
  $('#jobs').innerHTML = st.jobs.map(jobRow).join('') || '<tr><td colspan="10" class="muted">No accounts queued yet.</td></tr>';
  if (st.log.length !== lastLogLen || (st.log.length && st.log[st.log.length - 1].t !== refresh.lastT)) {
    lastLogLen = st.log.length;
    refresh.lastT = st.log.length ? st.log[st.log.length - 1].t : '';
    const box = $('#log');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    box.innerHTML = st.log.map((l) => `<div class="${esc(l.level)}">${esc(new Date(l.t).toLocaleTimeString())}  ${esc(l.msg)}</div>`).join('');
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}
setInterval(refresh, 700);
refresh();

// ------------------------------------------------------------------ database tab
let all = [];
let view = [];
let page = 0;
let sortKey = 'score';
let sortDir = -1;

const ROW_COLS = [
  ['pfp', ''], ['username', 'Username'], ['name', 'Name'], ['score', 'Score', 1], ['followers_count', 'Followers', 1],
  ['scanned_from', 'Scanned from'], ['scan_time', 'Scan time'], ['first_seen_at', 'First seen'], ['scan_count', 'Scans', 1],
  ['tags', 'Tags'], ['categories', 'Categories'], ['description', 'Bio'],
];
const UNIQUE_COLS = [
  ['pfp', ''], ['username', 'Username'], ['name', 'Name'], ['score', 'Score', 1], ['followers_count', 'Followers', 1],
  ['source_count', '# Sources', 1], ['sources', 'Followed (scanned) accounts'], ['scan_time', 'Last scan'],
  ['tags', 'Tags'], ['categories', 'Categories'], ['description', 'Bio'],
];

async function loadDb() {
  $('#dbStats').textContent = 'Loading…';
  all = await getAllFollowers();
  const sources = [...new Set(all.map((r) => r.scanned_from))].sort((a, b) => a.localeCompare(b));
  const cur = $('#fSource').value;
  $('#fSource').innerHTML = '<option value="">All sources</option>' + sources.map((s) => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('');
  applyFilters();
}

function mergeUnique(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = (r.username || r.twitter_id).toLowerCase();
    let u = m.get(k);
    if (!u) {
      u = { ...r, id: k, sources: [], source_count: 0 };
      m.set(k, u);
    }
    u.sources.push(r.scanned_from);
    u.source_count = u.sources.length;
    if ((r.score ?? -1) > (u.score ?? -1)) u.score = r.score;
    if (r.scan_time > u.scan_time) { Object.assign(u, { ...r, id: k, sources: u.sources, source_count: u.source_count, score: u.score }); }
  }
  for (const u of m.values()) u.sources = u.sources.join(', ');
  return [...m.values()];
}

function applyFilters() {
  const q = $('#q').value.trim().toLowerCase();
  const src = $('#fSource').value;
  const min = $('#fMin').value === '' ? null : Number($('#fMin').value);
  const max = $('#fMax').value === '' ? null : Number($('#fMax').value);
  const unique = $('#fView').value === 'unique';
  const minSrc = Math.max(1, Number($('#fMinSrc').value) || 1);
  let rows = all;
  if (src) rows = rows.filter((r) => r.scanned_from === src);
  if (unique) rows = mergeUnique(rows).filter((r) => r.source_count >= minSrc);
  if (min !== null) rows = rows.filter((r) => (r.score ?? -Infinity) >= min);
  if (max !== null) rows = rows.filter((r) => (r.score ?? Infinity) <= max);
  if (q) rows = rows.filter((r) => `${r.username} ${r.name} ${r.description} ${r.tags} ${r.categories} ${r.sources || ''}`.toLowerCase().includes(q));
  const dir = sortDir;
  rows = [...rows].sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x === y) return 0;
    if (x === null || x === undefined || x === '') return 1;
    if (y === null || y === undefined || y === '') return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
  view = rows;
  const uniqueCount = new Set(all.map((r) => (r.username || '').toLowerCase())).size;
  const nSources = new Set(all.map((r) => r.scanned_from)).size;
  $('#dbStats').textContent = `${fmt(all.length)} rows · ${fmt(uniqueCount)} unique accounts · ${fmt(nSources)} scanned sources · showing ${fmt(view.length)}`;
  page = 0;
  renderDb();
}

function renderDb() {
  const unique = $('#fView').value === 'unique';
  const cols = unique ? UNIQUE_COLS : ROW_COLS;
  $('#dbHead').innerHTML = '<tr>' + cols.map(([k, label, n]) =>
    `<th class="${k === 'pfp' ? '' : 'sort'} ${n ? 'num' : ''}" data-k="${k}">${esc(label)}${sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
  document.querySelectorAll('#dbHead th.sort').forEach((th) => (th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = ['score', 'followers_count', 'source_count', 'scan_count', 'scan_time', 'first_seen_at'].includes(k) ? -1 : 1; }
    applyFilters();
  }));
  const per = Number($('#perPage').value);
  const pages = Math.max(1, Math.ceil(view.length / per));
  page = Math.min(page, pages - 1);
  const slice = view.slice(page * per, page * per + per);
  $('#dbBody').innerHTML = slice.map((r) => '<tr>' + cols.map(([k, , n]) => {
    const v = r[k];
    if (k === 'pfp') return `<td>${r.profile_image ? `<img class="pfp" loading="lazy" referrerpolicy="no-referrer" src="${esc(r.profile_image)}">` : ''}</td>`;
    if (k === 'username') return `<td><a href="https://x.com/${esc(r.username)}" target="_blank">@${esc(r.username)}</a></td>`;
    if (k === 'score') return `<td class="num score">${fmt(v)}</td>`;
    if (k === 'scanned_from') return `<td><a href="https://x.com/${esc(v)}" target="_blank">@${esc(v)}</a></td>`;
    if (k === 'scan_time' || k === 'first_seen_at') return `<td class="small" title="${esc(v)}">${esc(fmtDate(v))}</td>`;
    if (k === 'description') return `<td class="desc">${esc(String(v || '').slice(0, 200))}</td>`;
    return `<td class="${n ? 'num' : ''} ${k === 'tags' || k === 'categories' || k === 'sources' ? 'small' : ''}">${n ? fmt(v) : esc(v)}</td>`;
  }).join('') + '</tr>').join('') || `<tr><td colspan="${cols.length}" class="muted">No records.</td></tr>`;
  $('#pageInfo').textContent = `Page ${page + 1} / ${pages}`;
}

['#q', '#fMin', '#fMax', '#fMinSrc'].forEach((s) => ($(s).oninput = debounce(applyFilters, 200)));
['#fSource', '#fView'].forEach((s) => ($(s).onchange = applyFilters));
$('#perPage').onchange = renderDb;
$('#prev').onclick = () => { if (page > 0) { page--; renderDb(); } };
$('#next').onclick = () => { page++; renderDb(); };
$('#dbRefresh').onclick = loadDb;

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') v = JSON.stringify(v);
  v = String(v);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function toCsv(rows, unique) {
  const base = unique
    ? ['username', 'name', 'score', 'followers_count', 'source_count', 'sources', 'scan_time', 'twitter_id', 'tags', 'categories', 'description', 'profile_image', 'url']
    : ['username', 'name', 'score', 'scanned_from', 'scan_time', 'first_seen_at', 'scan_count', 'twitter_id', 'followers_count', 'subscribed_at', 'tags', 'categories', 'description', 'profile_image', 'url', 'scan_id', 'min_score_filter', 'page'];
  const rawKeys = new Set();
  for (const r of rows) if (r.raw) for (const k of Object.keys(r.raw)) rawKeys.add(k);
  const extra = [...rawKeys].sort();
  const header = [...base, ...extra.map((k) => 'api_' + k)];
  const lines = [header.join(',')];
  for (const r of rows) lines.push([...base.map((k) => csvCell(r[k])), ...extra.map((k) => csvCell(r.raw ? r.raw[k] : ''))].join(','));
  return '﻿' + lines.join('\r\n');
}
$('#expCsv').onclick = () => download(`smart-followers-${stamp()}.csv`, toCsv(view, $('#fView').value === 'unique'), 'text/csv;charset=utf-8');
$('#expJson').onclick = async () => {
  const unique = $('#fView').value === 'unique';
  const payload = unique ? { type: 'sf-unique', exported_at: new Date().toISOString(), accounts: view }
    : { type: 'sf-backup', exported_at: new Date().toISOString(), followers: view, scans: await getAllScans() };
  download(`smart-followers-${stamp()}.json`, JSON.stringify(payload, null, 1), 'application/json');
};
$('#impJson').onclick = () => $('#impFile').click();
$('#impFile').onchange = async () => {
  const f = $('#impFile').files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const followers = Array.isArray(data) ? data : data.followers || [];
    await putFollowersRaw(followers.filter((r) => r && r.id && r.scanned_from));
    if (Array.isArray(data.scans)) await putScansRaw(data.scans);
    alert(`Imported ${followers.length} rows`);
    loadDb();
  } catch (e) { alert('Import failed: ' + e.message); }
  $('#impFile').value = '';
};
$('#delSource').onclick = async () => {
  const s = $('#fSource').value;
  if (!s) return alert('Select a source in the "Scanned from" filter first.');
  if (!confirm(`Delete all followers scanned from @${s}?`)) return;
  const n = await deleteFollowersBySource(s);
  alert(`Deleted ${n} rows`);
  $('#fSource').value = '';
  loadDb();
};
$('#clearDb').onclick = async () => {
  if (!confirm('Delete the ENTIRE smart-follower database and scan history? Export first if you need it.')) return;
  await clearAll();
  loadDb();
};

// ------------------------------------------------------------------ history tab
let histRows = [];
async function loadHistory() {
  histRows = (await getAllScans()).sort((a, b) => b.id - a.id);
  $('#hist').innerHTML = histRows.map((s) => `<tr>
    <td>${s.id}</td><td><a href="https://x.com/${esc(s.source)}" target="_blank">@${esc(s.source)}</a></td>
    <td><span class="badge ${esc(s.status)}">${esc(s.status)}</span></td><td class="num">${fmt(s.min_score)}</td>
    <td class="small">${esc(fmtDate(s.started_at || s.created_at))}</td><td class="small">${esc(fmtDate(s.finished_at))}</td>
    <td class="num">${fmt(s.pages)}</td><td class="num">${fmt(s.requests)}</td><td class="num">${fmt(s.found)}</td>
    <td class="num"><b>${fmt(s.saved)}</b></td><td class="num">${fmt(s.new_accounts)}</td><td class="num">${fmt(s.skipped)}</td>
    <td class="small muted">${esc(s.error || s.stop_reason || '')}</td></tr>`).join('') || '<tr><td colspan="13" class="muted">No scans yet.</td></tr>';
}
$('#histRefresh').onclick = loadHistory;
$('#histCsv').onclick = () => {
  const cols = ['id', 'source', 'status', 'min_score', 'created_at', 'started_at', 'finished_at', 'pages', 'requests', 'found', 'saved', 'new_accounts', 'skipped', 'total_reported', 'error', 'stop_reason', 'filters'];
  download(`scan-history-${stamp()}.csv`, '﻿' + [cols.join(','), ...histRows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n'), 'text/csv;charset=utf-8');
};

// ------------------------------------------------------------------ settings tab
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
async function loadSettings() {
  const s = await send('getSettings');
  for (const k of SETTING_KEYS) {
    const el = $('#s_' + k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
  }
}
function readSettings() {
  const out = {};
  for (const k of SETTING_KEYS) {
    const el = $('#s_' + k);
    if (!el) continue;
    out[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
  }
  return out;
}
$('#saveSettings').onclick = async () => {
  try {
    await send('saveSettings', { settings: readSettings() });
    $('#setMsg').textContent = 'Saved ✓';
    const s = await send('getSettings');
    $('#minScore').value = s.defaultMinScore || 0;
    setTimeout(() => ($('#setMsg').textContent = ''), 2000);
  } catch (e) { $('#setMsg').textContent = '⚠ ' + e.message; }
};
$('#resetSettings').onclick = async () => {
  if (!confirm('Reset all settings except the API key?')) return;
  const cur = await send('getSettings');
  await send('saveSettings', { settings: { ...DEFAULT_SETTINGS, apiKey: cur.apiKey } });
  loadSettings();
};
$('#testApi').onclick = async () => {
  $('#toolOut').textContent = 'Requesting…';
  try {
    await send('saveSettings', { settings: readSettings() });
    const r = await send('testApi', { username: $('#testUser').value || 'VitalikButerin' });
    $('#toolOut').textContent = `HTTP ${r.status}  ${r.url}\nParsed followers on page: ${r.itemCount}\nPagination meta: ${JSON.stringify(r.meta)}\nAPI error: ${r.apiError || 'none'}\n\nFirst follower as it will be stored:\n${JSON.stringify(r.sample, null, 2)}\n\nRaw response:\n${typeof r.raw === 'string' ? r.raw : JSON.stringify(r.raw, null, 2).slice(0, 20000)}`;
  } catch (e) { $('#toolOut').textContent = '⚠ ' + e.message; }
};
$('#checkLimits').onclick = async () => {
  $('#toolOut').textContent = 'Requesting /limits…';
  try {
    const r = await send('checkLimits');
    $('#toolOut').textContent = `HTTP ${r.status}\n${typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)}\n\nTip: if this shows requests used this month, copy it into "Correct local monthly counter" so the engine's quota guard matches the server.`;
  } catch (e) { $('#toolOut').textContent = '⚠ ' + e.message; }
};
$('#setUsage').onclick = async () => {
  const u = await send('setUsage', { count: Number($('#usageFix').value) || 0 });
  $('#toolOut').textContent = `Local counter set to ${fmt(u.count)} for ${u.month}`;
};

// ------------------------------------------------------------------ init
send('getSettings').then((s) => { $('#minScore').value = s.defaultMinScore || 0; }).catch(() => {});
showTab(location.hash.slice(1) || 'scan');
