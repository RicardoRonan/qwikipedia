import { cleanWikipediaText } from './text-utils.js';
import { checkArticleCache, storeArticleCache, hasCacheClient } from './cache.js';

let _cacheUserId = null;
export function setCacheUserId(userId) {
  _cacheUserId = userId;
}
// wiki.js - Wikipedia API adapters following the Wikimedia rate-limit best practices
// https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits

const TIMEOUT_MS  = 10000;
const MAX_RETRIES = 2;
/** Wikimedia guideline: ≤ 3 concurrent requests. We run at 3 for the full headroom. */
const CONCURRENCY = 3;
const MIN_RETRY_AFTER_MS = 5000;
/**
 * Soft per-minute cap. Browser-origin unauthenticated bucket is 200/min; we stay
 * comfortably under so even rapid scrolling can't burst over the limit.
 *
 * IMPORTANT: we deliberately do NOT send a custom `Api-User-Agent` header.
 * Any non-safelisted request header on a cross-origin fetch triggers a CORS
 * preflight OPTIONS, which doubles our request count against Wikimedia's
 * per-IP rate limit. The browser's built-in User-Agent already puts us in the
 * "Requests made from a web browser by an unauthenticated user" 200/min bucket.
 */
const REQUESTS_PER_MINUTE_CAP = 80;

function baseUrl(lang = 'en') {
  return `https://${lang}.wikipedia.org`;
}

// Lightweight concurrency limiter (no external deps)
function makeLimiter(max) {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= max || !queue.length) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { running--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const limited = makeLimiter(CONCURRENCY);
let globalBackoffUntil = 0;

/** Sliding per-minute window to keep us well under the unauthenticated cap. */
const _requestTimestamps = [];
async function throttlePerMinute() {
  // Loop in case multiple slots need to free up (the cap can be hit by
  // concurrent callers racing through `await`s).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    while (_requestTimestamps.length && now - _requestTimestamps[0] > 60000) {
      _requestTimestamps.shift();
    }
    if (_requestTimestamps.length < REQUESTS_PER_MINUTE_CAP) {
      _requestTimestamps.push(now);
      return;
    }
    const waitMs = Math.max(100, 60000 - (now - _requestTimestamps[0]) + 50);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

function parseRetryAfterMs(value) {
  if (!value) return MIN_RETRY_AFTER_MS;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) {
    return Math.max(MIN_RETRY_AFTER_MS, asNumber * 1000);
  }
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(MIN_RETRY_AFTER_MS, asDate - Date.now());
  }
  return MIN_RETRY_AFTER_MS;
}

async function waitGlobalBackoff() {
  const remaining = globalBackoffUntil - Date.now();
  if (remaining > 0) {
    await new Promise(r => setTimeout(r, remaining));
  }
}

export function getApiBackoffRemainingMs() {
  return Math.max(0, globalBackoffUntil - Date.now());
}

/** Clear client-side backoff - e.g. after user clicks “Try again” */
export function clearApiBackoff() {
  globalBackoffUntil = 0;
}

async function fetchWithTimeout(url, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await waitGlobalBackoff();
      await throttlePerMinute();
      // No custom headers - keeps requests CORS-"simple" so browsers don't
      // send a preflight OPTIONS and double our request count.
      const res = await limited(() => fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
      }));
      clearTimeout(timer);

      // Success clears stuck backoff so the app can recover after a cool-down.
      if (res.ok && res.status < 400) globalBackoffUntil = 0;

      if (res.status === 429 || res.status === 503) {
        const retryAfter = res.headers.get('Retry-After');
        // Respect server-provided Retry-After exactly (capped at 30s); don't compound per attempt.
        const wait = Math.min(parseRetryAfterMs(retryAfter), 30000);
        globalBackoffUntil = Math.max(globalBackoffUntil, Date.now() + wait);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

// Normalize a raw REST summary response into our card model
function normalizeSummary(raw, lang = 'en') {
  return {
    title: cleanWikipediaText(raw.title || ''),
    displayTitle: cleanWikipediaText(raw.displaytitle || raw.title || ''),
    extract: cleanWikipediaText(raw.extract || ''),
    image: raw.thumbnail?.source || null,
    url: raw.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(raw.title)}`,
    categories: [],   // populated by fetchCategoriesBatch
    lang,
  };
}

// Normalize a raw Action API `query.pages` entry into our card model.
function normalizeActionPage(page, lang = 'en') {
  const title = cleanWikipediaText(page.title || '');
  return {
    title,
    displayTitle: title,
    extract: cleanWikipediaText(page.extract || ''),
    image: page.thumbnail?.source || null,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    categories: (page.categories || []).map(c =>
      String(c.title || '').replace(/^Category:/i, '').toLowerCase()
    ).filter(Boolean),
    lang,
    coordinates: page.coordinates?.[0]
      ? { lat: page.coordinates[0].lat, lon: page.coordinates[0].lon }
      : null,
    qid: page.pageprops?.wikibase_item || null,
    isDisambiguation: page.pageprops?.disambiguation !== undefined,
  };
}

const ACTION_PROPS =
  'prop=extracts%7Cpageimages%7Ccategories%7Ccoordinates%7Cpageprops' +
  '&exintro=1&explaintext=1&exlimit=max' +
  '&piprop=thumbnail&pithumbsize=400&pilimit=max' +
  '&cllimit=20&clshow=!hidden' +
  '&coprop=type%7Cdim%7Cglobe%7Cname&coprimary=primary' +
  '&ppprop=wikibase_item%7Cdisambiguation';

/**
 * Fetch full article data (extract + thumbnail + categories) for up to 50 titles
 * in a SINGLE Action API request. Replaces the old per-title REST summary loop
 * plus the separate categories request.
 */
export async function fetchArticlesBatch(titles, lang = 'en') {
  if (!titles?.length) return [];
  const out = [];
  // Action API `titles` limit is 50 per request.
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const joined = chunk.map(encodeURIComponent).join('%7C');
    const url = `${baseUrl(lang)}/w/api.php?action=query&format=json&origin=*&redirects=1&titles=${joined}&${ACTION_PROPS}`;
    const data = await fetchWithTimeout(url);
    const pages = data?.query?.pages || {};
    for (const page of Object.values(pages)) {
      if (page.missing !== undefined) continue;
      const article = normalizeActionPage(page, lang);
      if (article.title) {
        rememberArticle(article, lang);
        out.push(article);
      }
    }
  }
  return out;
}

/**
 * Fetch N random articles with extract + thumbnail + categories in ONE request
 * (Xikipedia-style bulk fill). Falls back to list=random + fetchArticlesBatch.
 */
export async function fetchRandomArticles(count = 20, lang = 'en') {
  const n = Math.min(Math.max(1, count), 20);
  try {
    const url = `${baseUrl(lang)}/w/api.php?action=query&format=json&origin=*&generator=random&grnnamespace=0&grnlimit=${n}&${ACTION_PROPS}`;
    const data = await fetchWithTimeout(url);
    const pages = data?.query?.pages || {};
    const out = Object.values(pages)
      .map(p => normalizeActionPage(p, lang))
      .filter(a => a.title);
    if (out.length) {
      out.forEach(a => rememberArticle(a, lang));
      return out;
    }
  } catch { /* fall through */ }
  const titles = await fetchRandomTitles(n, lang).catch(() => []);
  return fetchArticlesBatch(titles, lang).catch(() => []);
}

/** Local LRU of raw REST `/page/summary` JSON - inspired by bundled-data demos; cuts repeat/article traffic. */
const SUMMARY_DISK_KEY = 'sw_rest_summary_v1';
const SUMMARY_DISK_MAX_ENTRIES = 140;
const SUMMARY_DISK_TTL_MS = 8 * 24 * 60 * 60 * 1000;

function diskSummaryKey(lang, title) {
  return `${lang}\u0001${title}`;
}

function readSummaryDisk() {
  try {
    const raw = localStorage.getItem(SUMMARY_DISK_KEY);
    if (!raw) return { order: [], entries: {} };
    const o = JSON.parse(raw);
    return { order: o.order || [], entries: o.entries || {} };
  } catch {
    return { order: [], entries: {} };
  }
}

function writeSummaryDisk(bundle) {
  try {
    localStorage.setItem(SUMMARY_DISK_KEY, JSON.stringify(bundle));
  } catch {
    // Quota exceeded, shrink the cache and try once more
    while (bundle.order.length > 40) {
      const drop = bundle.order.shift();
      if (drop) delete bundle.entries[drop];
    }
    try {
      localStorage.setItem(SUMMARY_DISK_KEY, JSON.stringify(bundle));
    } catch { /* still over quota, give up */ }
  }
}

function getPersistedSummaryJson(lang, title) {
  const k = diskSummaryKey(lang, title);
  const bundle = readSummaryDisk();
  const ent = bundle.entries[k];
  if (!ent) return null;
  if (Date.now() - ent.ts > SUMMARY_DISK_TTL_MS) {
    bundle.order = bundle.order.filter(key => key !== k);
    delete bundle.entries[k];
    writeSummaryDisk(bundle);
    return null;
  }
  return ent.json;
}

/** Returns up to `limit` cached normalized articles for a language - used during rate-limit fallback. */
export function getCachedArticles(lang = 'en', limit = 12) {
  const bundle = readSummaryDisk();
  // Most-recently-added first (order is push-on-insert)
  const keys = bundle.order.slice().reverse();
  const out = [];
  for (const k of keys) {
    if (!k.startsWith(`${lang}\u0001`)) continue;
    const ent = bundle.entries[k];
    if (!ent) continue;
    if (Date.now() - ent.ts > SUMMARY_DISK_TTL_MS) continue;
    out.push(normalizeSummary(ent.json, lang));
    if (out.length >= limit) break;
  }
  return out;
}

function setPersistedSummaryJson(lang, title, json) {
  const k = diskSummaryKey(lang, title);
  const bundle = readSummaryDisk();
  if (bundle.entries[k]) {
    bundle.entries[k] = { ts: Date.now(), json };
    writeSummaryDisk(bundle);
    return;
  }
  while (bundle.order.length >= SUMMARY_DISK_MAX_ENTRIES) {
    const drop = bundle.order.shift();
    if (drop) delete bundle.entries[drop];
  }
  bundle.entries[k] = { ts: Date.now(), json };
  bundle.order.push(k);
  writeSummaryDisk(bundle);
}

// Fetch a single article summary by title
export async function fetchSummary(title, lang = 'en') {
  const hit = getPersistedSummaryJson(lang, title);
  if (hit) {
    const article = normalizeSummary(hit, lang);
    dispatchToBackgroundCache(article, lang);
    return article;
  }
  const url = `${baseUrl(lang)}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const data = await fetchWithTimeout(url);
  setPersistedSummaryJson(lang, title, data);
  const article = normalizeSummary(data, lang);
  dispatchToBackgroundCache(article, lang);
  return article;
}

// Track which titles have already been dispatched to the cache to avoid re-sends
const _cacheDispatched = new Set();
const _cacheQueue = new Map(); // `${userId}\u0001${lang}` -> Map<title, article>
let _cacheFlushTimer = null;

function flushCacheQueue() {
  _cacheFlushTimer = null;
  const batches = [..._cacheQueue.entries()];
  _cacheQueue.clear();
  for (const [key, titleMap] of batches) {
    const [userId, lang] = key.split('\u0001');
    const articles = [...titleMap.values()];
    if (articles.length) storeArticleCache(userId, lang, articles).catch(() => {});
  }
}

function dispatchToBackgroundCache(article, lang) {
  if (!_cacheUserId || !hasCacheClient()) return;
  const key = `${_cacheUserId}::${lang}::${article.title}`;
  if (_cacheDispatched.has(key)) return;
  _cacheDispatched.add(key);

  const qKey = `${_cacheUserId}\u0001${lang}`;
  if (!_cacheQueue.has(qKey)) _cacheQueue.set(qKey, new Map());
  _cacheQueue.get(qKey).set(article.title, article);

  if (_cacheDispatched.size > 500) {
    const arr = [..._cacheDispatched];
    arr.slice(0, 100).forEach(k => _cacheDispatched.delete(k));
  }
  if (!_cacheFlushTimer) _cacheFlushTimer = setTimeout(flushCacheQueue, 1200);
}

/** Persist a batched Action API article so cache-first paint and 429 fallback still work. */
function rememberArticle(article, lang) {
  setPersistedSummaryJson(lang, article.title, {
    title: article.title,
    displaytitle: article.displayTitle,
    extract: article.extract,
    thumbnail: article.image ? { source: article.image } : undefined,
    content_urls: { desktop: { page: article.url } },
  });
  dispatchToBackgroundCache(article, lang);
}

// Fetch random article titles (returns array of title strings)
export async function fetchRandomTitles(count = 20, lang = 'en') {
  const url = `${baseUrl(lang)}/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=${count}&format=json&origin=*`;
  const data = await fetchWithTimeout(url);
  return (data?.query?.random || []).map(p => p.title);
}

// Search for titles matching a query
export async function searchTitles(query, limit = 15, lang = 'en') {
  if (!query?.trim()) return [];
  const url = `${baseUrl(lang)}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
  const data = await fetchWithTimeout(url);
  return (data?.query?.search || []).map(r => r.title);
}

// Fetch articles by category
export async function fetchCategoryMembers(category, limit = 20, lang = 'en') {
  const url = `${baseUrl(lang)}/w/api.php?action=query&list=categorymembers&cmtitle=Category:${encodeURIComponent(category)}&cmlimit=${limit}&cmtype=page&format=json&origin=*`;
  const data = await fetchWithTimeout(url);
  return (data?.query?.categorymembers || []).map(p => p.title);
}

// Fetch a fuller plain-text intro paragraph/extract for a given title.
export async function fetchArticleIntro(title, lang = 'en') {
  if (!title) return '';
  try {
    const url = `${baseUrl(lang)}/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&exintro=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
    const data = await fetchWithTimeout(url);
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    return cleanWikipediaText(page?.extract || '');
  } catch {
    return '';
  }
}

// Batch-fetch real Wikipedia categories for a list of titles in a single API call.
// Returns a Map<title, string[]> of lowercase category names (without "Category:" prefix).
export async function fetchCategoriesBatch(titles, lang = 'en') {
  const map = new Map();
  if (!titles.length) return map;

  // Action API supports up to 50 titles per request
  const chunks = [];
  for (let i = 0; i < titles.length; i += 50) {
    chunks.push(titles.slice(i, i + 50));
  }

  for (const chunk of chunks) {
    try {
      const joined = chunk.map(encodeURIComponent).join('|');
      // clshow=!hidden filters out maintenance/tracking categories
      const url = `${baseUrl(lang)}/w/api.php?action=query&titles=${joined}&prop=categories&cllimit=20&clshow=!hidden&format=json&origin=*`;
      const data = await fetchWithTimeout(url);
      const pages = data?.query?.pages || {};
      for (const page of Object.values(pages)) {
        const cats = (page.categories || [])
          .map(c => c.title.replace(/^Category:/i, '').toLowerCase());
        map.set(page.title, cats);
      }
    } catch {
      // Silently skip - articles will fall back to no categories
    }
  }
  return map;
}

/**
 * Fetch article data for a list of titles. Categories now arrive in the same
 * batched request, so there is no separate categories round-trip.
 * `opts.includeCategories` is accepted for backward compatibility and ignored.
 */
export async function fetchSummaryBatch(titles, lang = 'en', opts = {}) {
  const { onChunkProgress } = opts;
  if (!titles.length) return [];

  // Supabase cache check for signed-in users (unchanged)
  let cachedMap = new Map();
  if (_cacheUserId && hasCacheClient() && titles.length > 2) {
    try {
      cachedMap = await checkArticleCache(_cacheUserId, lang, titles);
    } catch {
      cachedMap = new Map();
    }
  }

  const missing = titles.filter(t => !cachedMap.has(t));
  const merged = [...cachedMap.values()];

  if (missing.length > 0) {
    const BATCH = 20;
    const totalChunks = Math.max(1, Math.ceil(missing.length / BATCH));
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      try {
        const arts = await fetchArticlesBatch(chunk, lang);
        for (const a of arts) {
          if (a.extract?.length > 50) merged.push(a);
        }
      } catch { /* skip chunk, keep the rest */ }
      onChunkProgress?.({
        chunkIndex: Math.min(Math.floor(i / BATCH), totalChunks - 1),
        totalChunks,
      });
    }
  }

  return merged;
}

// Get featured article of the day (bonus quality content)
export async function fetchFeaturedToday(lang = 'en') {
  try {
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = String(today.getUTCMonth() + 1).padStart(2, '0');
    const d = String(today.getUTCDate()).padStart(2, '0');
    const url = `${baseUrl(lang)}/api/rest_v1/feed/featured/${y}/${m}/${d}`;
    const data = await fetchWithTimeout(url);
    if (data?.tfa) {
      const article = normalizeSummary(data.tfa, lang);
      // Fetch categories for the featured article too
      const catMap = await fetchCategoriesBatch([article.title], lang);
      article.categories = catMap.get(article.title) || [];
      return article;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Wikimedia Commons image search (key-free) ----
const _commonsCache = new Map();
export async function fetchCommonsImages(query, limit = 12) {
  const q = (query || '').trim();
  if (!q) return [];
  const key = `${q}::${limit}`;
  if (_commonsCache.has(key)) return _commonsCache.get(key);
  const n = Math.min(Math.max(1, limit), 24);
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
      `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=${n}` +
      `&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=320`;
    const data = await fetchWithTimeout(url);
    const pages = data?.query?.pages || {};
    const images = Object.values(pages).map(p => {
      const info = p.imageinfo?.[0];
      if (!info?.thumburl) return null;
      if (info.mime && !String(info.mime).startsWith('image/')) return null;
      return { title: p.title, thumb: info.thumburl, full: info.url,
        page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}` };
    }).filter(Boolean);
    _commonsCache.set(key, images);
    return images;
  } catch {
    _commonsCache.set(key, []);
    return [];
  }
}

// ---- Wikidata claims (batched, cached) ----
const _wdCache = new Map();
function _wdClaims(ent, prop) {
  return (ent?.claims?.[prop] || []).map(c => c?.mainsnak?.datavalue?.value).filter(Boolean);
}
function normalizeWikidataEntity(ent) {
  const ids = (p) => _wdClaims(ent, p).map(v => v?.id).filter(Boolean);
  const str = (p) => _wdClaims(ent, p).map(v => (typeof v === 'string' ? v : v?.text || v?.url)).filter(Boolean);
  const x = str('P2002')[0], ig = str('P2003')[0];
  return {
    qid: ent?.id || null,
    instanceOf: ids('P31'),
    officialWebsite: str('P856')[0] || null,
    spotifyArtist: str('P1902')[0] || null,
    imdb: str('P345')[0] || null,
    x: x ? `https://x.com/${x}` : null,
    instagram: ig ? `https://instagram.com/${ig}` : null,
    occupations: ids('P106'),
    tmdbMovie: str('P4947')[0] || null,
    tmdbTv: str('P4983')[0] || null,
    rottenTomatoes: str('P1258')[0] || null,
    metacritic: str('P1712')[0] || null,
    netflixId: str('P1874')[0] || null,
    musicbrainzArtist: str('P434')[0] || null,
    musicbrainzReleaseGroup: str('P436')[0] || null,
    lastfm: str('P3192')[0] || null,
    openLibrary: str('P648')[0] || null,
    steamAppId: str('P1733')[0] || null,
    igdbId: str('P5794')[0] || null,
    mobygamesId: str('P1933')[0] || null,
    hltbId: str('P2816')[0] || null,
    pcgamingwikiId: str('P6337')[0] || null,
  };
}
export async function fetchWikidataEntities(qids = []) {
  const ids = [...new Set(qids.filter(Boolean))];
  if (!ids.length) return new Map();
  const out = new Map();
  const missing = [];
  for (const id of ids) {
    if (_wdCache.has(id)) out.set(id, _wdCache.get(id));
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*` +
        `&props=claims&ids=${chunk.join('%7C')}`;
      const data = await fetchWithTimeout(url);
      for (const [qid, ent] of Object.entries(data?.entities || {})) {
        const norm = normalizeWikidataEntity(ent);
        _wdCache.set(qid, norm);
        out.set(qid, norm);
      }
    } catch { /* skip chunk */ }
  }
  return out;
}
