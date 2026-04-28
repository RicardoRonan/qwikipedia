// wiki.js — Wikipedia API adapters with strict rate-limit safety

const TIMEOUT_MS  = 10000;
const MAX_RETRIES = 2;
const CONCURRENCY = 3; // Wikimedia best-practice: 3 concurrent requests max
const MIN_RETRY_AFTER_MS = 5000;

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
      const res = await limited(() => fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
      }));
      clearTimeout(timer);

      // Success clears stuck backoff so the app can recover after a cool-down.
      if (res.ok && res.status < 400) globalBackoffUntil = 0;

      if (res.status === 429 || res.status === 503) {
        const retryAfter = res.headers.get('Retry-After');
        const wait = Math.min(
          parseRetryAfterMs(retryAfter) * (attempt + 1),
          120000,
        );
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
    title: raw.title || '',
    displayTitle: raw.displaytitle?.replace(/<[^>]+>/g, '') || raw.title || '',
    extract: raw.extract || '',
    image: raw.thumbnail?.source || null,
    url: raw.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(raw.title)}`,
    categories: [],   // populated by fetchCategoriesBatch
    lang,
  };
}

// Fetch a single article summary by title
export async function fetchSummary(title, lang = 'en') {
  const url = `${baseUrl(lang)}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const data = await fetchWithTimeout(url);
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
export async function fetchSummaryBatch(titles, lang = 'en') {
  if (!titles.length) return [];

  const SUMMARY_CHUNK = 4;
  const merged = [];

  for (let i = 0; i < titles.length; i += SUMMARY_CHUNK) {
    const chunk = titles.slice(i, i + SUMMARY_CHUNK);
    const settled = await Promise.allSettled(chunk.map(t => fetchSummary(t, lang)));
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      const article = r.value;
      if (article.extract?.length > 50) merged.push(article);
    }
  }

  const okTitles = merged.map(a => a.title);
  let categoryMap = new Map();
  if (okTitles.length) {
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
