// TwitterScore API helpers: settings, URL building, response parsing, normalisation.
// Docs: https://twitterscore.gitbook.io/twitterscore/developers/api-documentation

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://twitterscore.io/api/v1',
  endpoint: 'get_followers',        // non-deprecated paginated followers list (sorted by score)
  userParam: 'username',            // docs: "You can use either username or twitter id in any query"
  pageParam: 'page',
  sizeParam: 'size',
  pageSize: 25,
  firstPage: 1,
  authMode: 'query',                // 'query' (?api_key=) | 'header' (X-API-Key) | 'both'
  extraParams: '',                  // raw query string appended to every followers request

  rpm: 295,                         // requests/min target (plan limit 300; small safety margin)
  monthlyLimit: 250000,             // plan monthly quota
  maxConcurrent: 24,                // max HTTP requests in flight
  parallelAccounts: 8,              // usernames scanned at the same time
  pageWindow: 3,                    // pages of one account fetched in parallel
  maxPagesPerAccount: 0,            // 0 = unlimited
  earlyStop: true,                  // list is sorted by score desc -> stop once a page drops below min score
  requestTimeoutMs: 30000,
  defaultMinScore: 0,
  defaultFilters: { category_id: '', tag_id: '', tag_category_id: '' },
};

export function mergeSettings(s) {
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

/** Parse a textarea of handles / URLs / @names into a de-duplicated list of usernames. */
export function parseUsernames(text) {
  const out = [];
  const seen = new Set();
  for (let tok of String(text || '').split(/[\s,;]+/)) {
    tok = tok.trim();
    if (!tok) continue;
    const m = tok.match(/(?:twitter\.com|x\.com|twitterscore\.io\/twitter)\/(?:#!\/)?@?([A-Za-z0-9_]{1,30})/i);
    if (m) tok = m[1];
    tok = tok.replace(/^@+/, '').replace(/[^A-Za-z0-9_]/g, '');
    if (!tok) continue;
    const k = tok.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(tok);
  }
  return out;
}

function applyAuth(url, headers, s) {
  if (s.authMode === 'query' || s.authMode === 'both') url.searchParams.set('api_key', s.apiKey);
  if (s.authMode === 'header' || s.authMode === 'both') headers['X-API-Key'] = s.apiKey;
}

function appendExtra(url, extra) {
  if (!extra) return;
  const qs = String(extra).replace(/^[?&]+/, '');
  for (const [k, v] of new URLSearchParams(qs)) if (k) url.searchParams.set(k, v);
}

/** Build a followers-page request. `filters` = { category_id, tag_id, tag_category_id, extraParams } */
export function buildFollowersRequest(s, source, page, filters = {}) {
  const url = new URL(`${s.baseUrl.replace(/\/+$/, '')}/${s.endpoint.replace(/^\/+/, '')}`);
  const headers = { Accept: 'application/json' };
  // A purely numeric source is treated as a twitter_id.
  const isId = /^\d{5,}$/.test(source);
  url.searchParams.set(isId ? 'twitter_id' : s.userParam, source);
  url.searchParams.set(s.pageParam, String(page));
  url.searchParams.set(s.sizeParam, String(s.pageSize));
  for (const k of ['category_id', 'tag_id', 'tag_category_id']) {
    if (filters[k] !== undefined && filters[k] !== null && String(filters[k]).trim() !== '') {
      url.searchParams.set(k, String(filters[k]).trim());
    }
  }
  appendExtra(url, s.extraParams);
  appendExtra(url, filters.extraParams);
  applyAuth(url, headers, s);
  return { url: url.toString(), headers };
}

/** Generic request for other endpoints (limits, get_categories, get_tags, get_twitter_score...). */
export function buildRequest(s, endpoint, params = {}) {
  const url = new URL(`${s.baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`);
  const headers = { Accept: 'application/json' };
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  applyAuth(url, headers, s);
  return { url: url.toString(), headers };
}

export function redactUrl(u) {
  return String(u).replace(/(api_key=)[^&]+/i, '$1***');
}

const LIST_KEYS = ['followers', 'top_followers', 'data', 'items', 'results', 'result', 'accounts', 'users', 'list', 'rows'];

function looksLikeAccount(o) {
  return o && typeof o === 'object' && !Array.isArray(o) &&
    ('username' in o || 'screen_name' in o || 'twitter_id' in o || 'twitter_score' in o || 'score' in o);
}

/** Find the array of follower objects anywhere reasonable in the response. */
export function extractItems(json, depth = 0) {
  if (!json || depth > 3) return [];
  if (Array.isArray(json)) return json.filter((x) => x && typeof x === 'object');
  if (typeof json !== 'object') return [];
  for (const k of LIST_KEYS) {
    const v = json[k];
    if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object');
  }
  for (const k of LIST_KEYS) {
    const v = json[k];
    if (v && typeof v === 'object') {
      const r = extractItems(v, depth + 1);
      if (r.length) return r;
    }
  }
  // Fallback: first array of account-like objects.
  for (const v of Object.values(json)) {
    if (Array.isArray(v) && v.some(looksLikeAccount)) return v.filter((x) => x && typeof x === 'object');
  }
  return [];
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickDeep(json, keys, depth = 0) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || depth > 2) return undefined;
  for (const k of keys) if (json[k] !== undefined && json[k] !== null) return json[k];
  for (const v of Object.values(json)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r = pickDeep(v, keys, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/** Pagination metadata if the API provides it. */
export function extractMeta(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const total = num(pickDeep(json, ['total', 'total_count', 'totalCount', 'count_total', 'followers_total', 'total_followers']));
  const totalPages = num(pickDeep(json, ['total_pages', 'totalPages', 'pages_count', 'page_count', 'last_page', 'num_pages']));
  let hasNext = pickDeep(json, ['has_next', 'hasNext', 'has_more', 'hasMore', 'next_page', 'next']);
  if (hasNext !== undefined && typeof hasNext !== 'boolean') hasNext = hasNext !== null && hasNext !== '' && hasNext !== 0;
  return { total, totalPages, hasNext };
}

/** Detect an API-level error inside a 200 response. */
export function extractApiError(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json.success === false || json.status === 'error' || json.ok === false) {
    return String(json.error || json.message || json.detail || json.msg || 'API returned success=false');
  }
  if (json.error && !extractItems(json).length) return String(typeof json.error === 'string' ? json.error : JSON.stringify(json.error));
  return null;
}

const pick = (o, keys) => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

function namesOf(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x.name ?? x.title ?? x.tag ?? x.id) : x)).filter((x) => x !== undefined && x !== null).join(', ');
  if (typeof v === 'object') return v.name ?? JSON.stringify(v);
  return String(v);
}

export function scoreOf(item) {
  const u = item.user && typeof item.user === 'object' ? item.user : null;
  return num(pick(item, ['twitter_score', 'score', 'twitterScore', 'ts', 'tw_score'])) ?? num(pick(u, ['twitter_score', 'score']));
}

/** Map one API follower object into a database record. Every original field is kept in `raw`. */
export function normalizeFollower(item, ctx) {
  const u = item.user && typeof item.user === 'object' ? item.user : {};
  const username = String(pick(item, ['username', 'screen_name', 'twitter_username', 'handle', 'user_name', 'login']) ??
    pick(u, ['username', 'screen_name']) ?? '').replace(/^@/, '');
  const twitterId = pick(item, ['twitter_id', 'id_str', 'user_id', 'id']) ?? pick(u, ['twitter_id', 'id']);
  const key = (username || String(twitterId || '')).toLowerCase();
  return {
    id: key,                     // one row per account — merged across scanned sources
    username,
    score: scoreOf(item),
    scanned_from: ctx.source,
    sources: [ctx.source],
    scan_time: ctx.scanTime,
    scan_id: ctx.scanId,
    twitter_id: twitterId !== undefined ? String(twitterId) : '',
    name: pick(item, ['name', 'display_name', 'full_name']) ?? pick(u, ['name']) ?? '',
    followers_count: num(pick(item, ['followers_count', 'followers', 'followersCount']) ?? pick(u, ['followers_count'])),
    description: pick(item, ['description', 'bio']) ?? pick(u, ['description']) ?? '',
    profile_image: pick(item, ['profile_image', 'profile_image_url', 'profile_image_url_https', 'pfp', 'avatar', 'image']) ?? pick(u, ['profile_image', 'profile_image_url']) ?? '',
    tags: namesOf(pick(item, ['tags', 'tag'])),
    categories: namesOf(pick(item, ['categories', 'category'])),
    subscribed_at: pick(item, ['subscribed_at', 'followed_at', 'created_at']) ?? '',
    url: username ? `https://x.com/${username}` : '',
    page: ctx.page,
    min_score_filter: ctx.minScore,
    raw: item,
  };
}
