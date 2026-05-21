// ai.js - client layer for AI-enhanced features (YouTube queries, search refinement, hints)
// Calls Supabase Edge Function when available; always falls back to local heuristics.

import { AI_FUNCTION_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { Storage } from './storage.js';
import {
  buildYoutubeQueryHeuristic,
  refineSearchQueryHeuristic,
  extractSearchHintsHeuristic,
} from './ai-heuristics.js';

const CACHE_PREFIX = 'qw_ai_';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PING_TTL_MS = 10 * 60 * 1000;

let _edgeAvailable = null;
let _edgeCheckedAt = 0;
let _inflight = new Map();

export function isAiEnabled() {
  const prefs = Storage.getPrefs();
  return prefs.aiEnabled !== false;
}

export function setAiEnabled(enabled) {
  Storage.setPrefs({ aiEnabled: !!enabled });
}

function cacheKey(task, payload) {
  const raw = JSON.stringify({ task, ...payload });
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  return `${CACHE_PREFIX}${task}_${(h >>> 0).toString(36)}`;
}

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key) || localStorage.getItem(key);
    if (!raw) return null;
    const { value, at } = JSON.parse(raw);
    if (Date.now() - at > CACHE_TTL_MS) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function writeCache(key, value, persist = false) {
  try {
    const entry = JSON.stringify({ value, at: Date.now() });
    sessionStorage.setItem(key, entry);
    if (persist) localStorage.setItem(key, entry);
  } catch {}
}

async function callEdge(task, payload = {}) {
  if (!isAiEnabled()) return null;

  const key = cacheKey(task, payload);
  const cached = readCache(key);
  if (cached != null) return cached;

  if (_inflight.has(key)) return _inflight.get(key);

  const promise = (async () => {
    try {
      const res = await fetch(AI_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ task, ...payload }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.ok && data.result != null) {
        writeCache(key, data.result, task === 'youtube_query');
        _edgeAvailable = true;
        _edgeCheckedAt = Date.now();
        return data.result;
      }
    } catch {
      _edgeAvailable = false;
      _edgeCheckedAt = Date.now();
    }
    return null;
  })();

  _inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    _inflight.delete(key);
  }
}

/** Check whether the deployed edge function responds (cached ~10 min). */
export async function checkAiAvailability(force = false) {
  if (!force && _edgeAvailable != null && Date.now() - _edgeCheckedAt < PING_TTL_MS) {
    return { available: _edgeAvailable, ai: _edgeAvailable };
  }
  if (!isAiEnabled()) {
    _edgeAvailable = false;
    _edgeCheckedAt = Date.now();
    return { available: false, ai: false, reason: 'disabled' };
  }
  try {
    const res = await fetch(AI_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ task: 'ping' }),
    });
    if (!res.ok) {
      _edgeAvailable = false;
      _edgeCheckedAt = Date.now();
      return { available: false, ai: false, reason: 'unreachable' };
    }
    const data = await res.json();
    _edgeAvailable = !!data?.ok;
    _edgeCheckedAt = Date.now();
    return {
      available: !!data?.ok,
      ai: !!data?.ai,
      reason: data?.reason || null,
    };
  } catch {
    _edgeAvailable = false;
    _edgeCheckedAt = Date.now();
    return { available: false, ai: false, reason: 'network' };
  }
}

/**
 * YouTube search query for an article (AI when deployed, else heuristic).
 */
export async function getYoutubeSearchQuery({ title = '', extract = '' } = {}) {
  const heuristic = buildYoutubeQueryHeuristic(title, extract);
  if (!isAiEnabled()) return { query: heuristic, source: 'heuristic' };

  const result = await callEdge('youtube_query', { title, extract });
  const query = typeof result === 'string'
    ? result.trim()
    : (result?.query || '').trim();

  if (query && query.length >= 3) {
    return { query: query.slice(0, 96), source: 'ai' };
  }
  return { query: heuristic, source: 'heuristic' };
}

/**
 * Refine a Wikipedia search string (AI optional).
 */
export async function refineSearchQuery(query = '') {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { query: trimmed, source: 'none' };

  const heuristic = refineSearchQueryHeuristic(trimmed);
  if (!isAiEnabled()) return { query: heuristic, source: 'heuristic' };

  const result = await callEdge('search_refine', { query: trimmed });
  const refined = typeof result === 'string'
    ? result.trim()
    : (result?.query || '').trim();

  if (refined && refined.length >= 2) {
    return { query: refined.slice(0, 120), source: 'ai' };
  }
  return { query: heuristic, source: 'heuristic' };
}

/**
 * Short hint chips for the search page (interests + optional AI).
 */
export async function getSearchSuggestions({ interests = [] } = {}) {
  const base = (interests || []).slice(0, 4).map(id => ({
    label: id.charAt(0).toUpperCase() + id.slice(1),
    query: id,
  }));

  if (!isAiEnabled()) return base;

  const result = await callEdge('search_suggestions', { interests });
  const list = Array.isArray(result)
    ? result
    : (result?.suggestions || []);

  if (!list.length) return base;

  return list.slice(0, 6).map(s => {
    if (typeof s === 'string') return { label: s, query: s };
    return { label: s.label || s.query, query: s.query || s.label };
  }).filter(s => s.query);
}

/**
 * Open YouTube with an AI/heuristic query; shows loading on the link button.
 */
export async function openYoutubeSearch({ title = '', extract = '' } = {}, linkEl = null) {
  if (linkEl) {
    linkEl.classList.add('is-loading');
    linkEl.setAttribute('aria-busy', 'true');
  }
  try {
    const { query } = await getYoutubeSearchQuery({ title, extract });
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  } finally {
    if (linkEl) {
      linkEl.classList.remove('is-loading');
      linkEl.removeAttribute('aria-busy');
    }
  }
}

/**
 * Bind click handlers for .card-youtube-link elements inside a container.
 */
export function bindYoutubeLinks(root = document) {
  root.querySelectorAll('.card-youtube-link[data-youtube-title]').forEach(link => {
    if (link.dataset.youtubeBound) return;
    link.dataset.youtubeBound = '1';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const title = link.dataset.youtubeTitle || '';
      const card = link.closest('.card');
      const extractEl = card?.querySelector('.card-extract');
      const extract = link.dataset.youtubeExtract || extractEl?.textContent || '';
      openYoutubeSearch({ title, extract }, link);
    });
  });
}

/**
 * Idle prefetch for the top visible card (subtle background optimization).
 */
export function prefetchVisibleYoutubeQueries(container) {
  if (!container || !isAiEnabled()) return;
  const run = () => {
    const cards = [...container.querySelectorAll('.card')].filter(c => c.offsetParent !== null);
    const top = cards.slice(0, 2);
    for (const card of top) {
      const title = card.dataset.title || card.querySelector('.card-title')?.textContent || '';
      const extract = card.querySelector('.card-extract')?.textContent || '';
      if (title) getYoutubeSearchQuery({ title, extract }).catch(() => {});
    }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2500 });
  } else {
    setTimeout(run, 800);
  }
}

export { extractSearchHintsHeuristic };
