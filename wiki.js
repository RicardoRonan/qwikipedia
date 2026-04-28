import { cleanWikipediaText } from './text-utils.js';
// wiki.js — Wikipedia API adapters following the Wikimedia rate-limit best practices
// https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits

const TIMEOUT_MS  = 10000;
const MAX_RETRIES = 2;
/** Wikimedia guideline: ≤ 3 concurrent requests. We run at 2 for extra headroom. */
const CONCURRENCY = 2;
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

/** Clear client-side backoff — e.g. after user clicks “Try again” */
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
      // No custom headers — keeps requests CORS-"simple" so browsers don't
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

/** Local LRU of raw REST `/page/summary` JSON — inspired by bundled-data demos; cuts repeat/article traffic. */
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
    while (bundle.order.length > 40) {
      const drop = bundle.order.shift();
      if (drop) delete bundle.entries[drop];
      try {
        localStorage.setItem(SUMMARY_DISK_KEY, JSON.stringify(bundle));
      } catch { /* quota */ }
      return;
    }
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

/** Returns up to `limit` cached normalized articles for a language — used during rate-limit fallback. */
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
  if (hit) return normalizeSummary(hit, lang);
  const url = `${baseUrl(lang)}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const data = await fetchWithTimeout(url);
  setPersistedSummaryJson(lang, title, data);
  return normalizeSummary(data, lang);
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
    const url = `${baseUrl(lang)}/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&exintro=1&exchars=1600&titles=${encodeURIComponent(title)}&format=json&origin=*`;
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
      // Silently skip — articles will fall back to no categories
    }
  }
  return map;
}

// Fetch summaries in **small sequential chunks** (no giant parallel fan-out).
// Categories are fetched once for titles that actually got summaries.
/**
 * @param {string[]} titles
 * @param {string} [lang='en']
 * @param {{ includeCategories?: boolean, onChunkProgress?: (info: { chunkIndex: number, totalChunks: number }) => void }} [opts]
 *   Include categories (extra Action API batch). Omit on first batch for faster time-to-cards.
 */
export async function fetchSummaryBatch(titles, lang = 'en', opts = {}) {
  const { includeCategories = true, onChunkProgress } = opts;
  if (!titles.length) return [];

  const SUMMARY_CHUNK = 4;
  const totalChunks = Math.max(1, Math.ceil(titles.length / SUMMARY_CHUNK));
  const merged = [];

  for (let i = 0; i < titles.length; i += SUMMARY_CHUNK) {
    const chunk = titles.slice(i, i + SUMMARY_CHUNK);
    const settled = await Promise.allSettled(chunk.map(t => fetchSummary(t, lang)));
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      const article = r.value;
      if (article.extract?.length > 50) merged.push(article);
    }
    onChunkProgress?.({
      chunkIndex: Math.floor(i / SUMMARY_CHUNK),
      totalChunks,
    });
  }

  let categoryMap = new Map();
  if (includeCategories && merged.length) {
    const okTitles = merged.map(a => a.title);
    try {
      categoryMap = await fetchCategoriesBatch(okTitles, lang);
    } catch {
      categoryMap = new Map();
    }
  }

  return merged.map(a => ({
    ...a,
    categories: categoryMap.get(a.title) || [],
  }));
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
