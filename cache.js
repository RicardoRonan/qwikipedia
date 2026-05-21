// cache.js - Supabase-backed article preload cache
// Speeds up feed loading by serving pre-fetched articles from Supabase
// instead of hitting the Wikipedia API every time.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PREFETCH_PER_RUN = 20; // articles preloaded per background cycle

let _supabase = null;

function getClient() {
  if (_supabase) return _supabase;
  if (typeof supabase === 'undefined') return null;
  _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

export function hasCacheClient() {
  return !!getClient();
}

/**
 * Batch-check which of the given titles exist in the Supabase cache
 * for the given user + lang. Returns a Map<title, article> of cached hits.
 */
export async function checkArticleCache(userId, lang, titles) {
  const client = getClient();
  if (!client || !userId || !titles.length) return new Map();

  try {
    const { data, error } = await client
      .from('article_cache')
      .select('title, display_title, extract, image, url, categories, fetched_at')
      .eq('user_id', userId)
      .eq('lang', lang)
      .in('title', titles);

    if (error) return new Map();

    const cutoff = Date.now() - CACHE_TTL_MS;
    const map = new Map();
    for (const row of data || []) {
      if (new Date(row.fetched_at).getTime() < cutoff) continue;
      map.set(row.title, {
        title: row.title,
        displayTitle: row.display_title,
        extract: row.extract,
        image: row.image,
        url: row.url,
        categories: row.categories || [],
        lang,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Store articles in the Supabase cache for a user.
 * Upserts by (user_id, lang, title) so re-fetches refresh the entry.
 */
export async function storeArticleCache(userId, lang, articles) {
  const client = getClient();
  if (!client || !userId || !articles.length) return;

  const rows = articles
    .filter(a => a && a.title)
    .map(a => ({
      user_id: userId,
      lang,
      title: a.title,
      display_title: a.displayTitle || a.title,
      extract: a.extract || '',
      image: a.image || null,
      url: a.url || null,
      categories: a.categories || [],
      fetched_at: new Date().toISOString(),
    }));

  try {
    await client.from('article_cache').upsert(rows, {
      onConflict: 'user_id,lang,title',
      ignoreDuplicates: false,
    });
  } catch {}
}

/**
 * Get a batch of cached articles from Supabase for the user's feed.
 * Returns up to `count` cached articles, most recently cached first.
 */
export async function getCachedFeedBatch(userId, lang, count = 8) {
  const client = getClient();
  if (!client || !userId) return [];

  try {
    const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    const { data, error } = await client
      .from('article_cache')
      .select('title, display_title, extract, image, url, categories')
      .eq('user_id', userId)
      .eq('lang', lang)
      .gt('fetched_at', cutoff)
      .order('fetched_at', { ascending: false })
      .limit(count);

    if (error) return [];

    return (data || []).map(row => ({
      title: row.title,
      displayTitle: row.display_title,
      extract: row.extract,
      image: row.image,
      url: row.url,
      categories: row.categories || [],
      lang,
    }));
  } catch {
    return [];
  }
}

/**
 * Remove stale cache entries (older than TTL) for a user+lang.
 * Call periodically to keep the cache lean.
 */
export async function pruneStaleCache(userId, lang) {
  const client = getClient();
  if (!client || !userId) return;

  try {
    const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    await client
      .from('article_cache')
      .delete()
      .eq('user_id', userId)
      .eq('lang', lang)
      .lt('fetched_at', cutoff);
  } catch {}
}

/**
 * Background warm: prefetch articles and store them in the Supabase cache.
 * Call this after feed loads to build up a cache for the next load.
 */
export async function warmArticleCache(userId, lang) {
  const client = getClient();
  if (!client || !userId) return;

  try {
    const { fetchRandomTitles, fetchSummaryBatch } = await import('./wiki.js');
    const titles = await fetchRandomTitles(MAX_PREFETCH_PER_RUN, lang);
    if (!titles.length) return;

    const articles = await fetchSummaryBatch(titles, lang, {
      includeCategories: true,
    });
    if (articles.length) {
      await storeArticleCache(userId, lang, articles);
    }
  } catch {}
}
