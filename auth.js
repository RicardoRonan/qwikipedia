// auth.js - Supabase auth integration
// Replace SUPABASE_URL and SUPABASE_ANON_KEY with your project values

import { Storage } from './storage.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

let _supabase = null;

function getClient() {
  if (_supabase) return _supabase;
  if (typeof supabase === 'undefined') {
    console.warn('Supabase SDK not loaded');
    return null;
  }
  _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

export async function getSession() {
  const client = getClient();
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data?.session || null;
  } catch {
    return null;
  }
}

export async function getCurrentUser() {
  const session = await getSession();
  return session?.user || null;
}

export async function signUp(email, password, displayName) {
  const client = getClient();
  if (!client) throw new Error('Auth not available');
  const name = String(displayName || '').trim();
  const options = name ? { data: { display_name: name } } : {};
  const { data, error } = await client.auth.signUp({ email, password, options });
  if (error) throw error;
  return data.user;
}

export async function signIn(email, password) {
  const client = getClient();
  if (!client) throw new Error('Auth not available');
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  const client = getClient();
  if (!client) return;
  await client.auth.signOut();
}

export async function updateDisplayName(displayName) {
  const client = getClient();
  if (!client) throw new Error('Auth not available');
  const value = String(displayName || '').trim();
  if (value.length < 2) throw new Error('Display name must be at least 2 characters');
  const { data, error } = await client.auth.updateUser({ data: { display_name: value } });
  if (error) throw error;
  return data.user;
}

export async function sendPasswordReset(email) {
  const client = getClient();
  if (!client) throw new Error('Auth not available');
  const target = String(email || '').trim();
  if (!target || !target.includes('@')) throw new Error('A valid email is required');
  const { error } = await client.auth.resetPasswordForEmail(target, {
    redirectTo: window.location.origin,
  });
  if (error) throw error;
}

export function onAuthStateChange(callback) {
  const client = getClient();
  if (!client) return () => {};
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    callback(session?.user || null);
  });
  return () => data?.subscription?.unsubscribe();
}

// Profile operations (profiles table in Supabase)
export async function getProfile(userId) {
  const client = getClient();
  if (!client || !userId) return null;
  try {
    const { data, error } = await client
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  } catch {
    return null;
  }
}

export async function upsertProfile(userId, fields) {
  const client = getClient();
  if (!client || !userId) return;
  try {
    await client
      .from('profiles')
      .upsert({ id: userId, ...fields, updated_at: new Date().toISOString() });
  } catch {}
}

// ===== user_interests table operations =====

/** Fetch all interests for a user from the dedicated table. Returns string[] of topic IDs. */
export async function fetchUserInterests(userId) {
  const client = getClient();
  if (!client || !userId) return [];
  try {
    const { data, error } = await client
      .from('user_interests')
      .select('topic_id')
      .eq('user_id', userId);
    if (error) throw error;
    return (data || []).map(r => r.topic_id);
  } catch {
    return [];
  }
}

/** Replace all interests for a user (delete + insert in one call). */
export async function saveUserInterests(userId, topicIds) {
  const client = getClient();
  if (!client || !userId) return;
  try {
    // Delete existing
    await client.from('user_interests').delete().eq('user_id', userId);
    // Insert new (skip empty)
    if (topicIds.length > 0) {
      const rows = topicIds.map(topic_id => ({ user_id: userId, topic_id }));
      await client.from('user_interests').upsert(rows, { onConflict: 'user_id,topic_id' });
    }
  } catch {}
}

function mergeTitleLists(cloudArr, localArr, maxLen) {
  const seen = new Set();
  const out = [];
  for (const t of [...(cloudArr || []), ...(localArr || [])]) {
    if (typeof t !== 'string' || !t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= maxLen) break;
  }
  return out;
}

/** Prefer richer objects (more keys / longer extract) when merging by title */
function mergeLikedArticles(cloudArr, localArr) {
  const byTitle = new Map();
  const score = (a) => (a?.extract?.length || 0) + (a?.image ? 100 : 0) + (a?.displayTitle?.length || 0);
  const addList = (arr) => {
    for (const a of arr || []) {
      if (!a || typeof a.title !== 'string') continue;
      const prev = byTitle.get(a.title);
      if (!prev || score(a) > score(prev)) byTitle.set(a.title, { ...a });
    }
  };
  addList(cloudArr);
  addList(localArr);
  return [...byTitle.values()].slice(0, 300);
}

function mergeStats(cloud, local) {
  const c = cloud && typeof cloud === 'object' ? cloud : {};
  const l = local || {};
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0; };
  // Math.max is intentional: totals are cumulative and must not be summed across
  // devices (that would double-count). A true cross-device merge needs per-device
  // deltas, which is out of scope here.
  return {
    totalSeen:      Math.max(n(c.totalSeen),      n(l.totalSeen)),
    totalLiked:     Math.max(n(c.totalLiked),     n(l.totalLiked)),
    totalDismissed: Math.max(n(c.totalDismissed), n(l.totalDismissed)),
    totalTimeMs:    Math.max(n(c.totalTimeMs),    n(l.totalTimeMs)),
  };
}

/**
 * Sync local app state to Supabase (prefs, algorithm, likes, feed history, stats).
 * Debounced via the caller - never throws.
 * Requires matching columns on `profiles` (see supabase_profiles_extend.sql).
 */
export async function syncPrefsToCloud(userId) {
  const prefs = Storage.getPrefs();
  const engine = Storage.getEngine();
  const history = Storage.getHistory();
  const stats = Storage.getStats();
  const onboarded = typeof localStorage !== 'undefined' && localStorage.getItem('sw_onboarded') === '1';
  const interests = prefs.interests || [];

  // Save interests to the dedicated table (source of truth)
  saveUserInterests(userId, interests).catch(() => {});

  await upsertProfile(userId, {
    theme: prefs.theme,
    text_scale: prefs.textScale,
    wiki_lang: prefs.wikiLang,
    interests, // keep profiles in sync for backward compat
    ai_enabled: prefs.aiEnabled !== false,
    topic_weights: engine.topicWeights || {},
    session_count: engine.sessionCount || 0,
    liked_titles: (history.likedTitles || []).slice(0, 300),
    liked_articles: (history.likedArticles || []).slice(0, 300),
    saved_titles: (history.savedTitles || []).slice(0, 300),
    saved_articles: (history.savedArticles || []).slice(0, 300),
    seen_titles: (history.seenTitles || []).slice(0, 500),
    dismissed_titles: (history.dismissedTitles || []).slice(0, 300),
    usage_stats: stats,
    onboarded,
  });
}

/**
 * Pull remote prefs from Supabase and merge into localStorage.
 * Returns the raw profile row so callers can read additional fields if needed.
 */
export async function pullPrefsFromCloud(userId) {
  const profile = await getProfile(userId);
  if (!profile) return null;

  const prefUpdates = {};
  if (profile.theme) prefUpdates.theme = profile.theme;
  if (Number.isFinite(profile.text_scale)) prefUpdates.textScale = profile.text_scale;
  if (profile.wiki_lang) prefUpdates.wikiLang = profile.wiki_lang;

  // Load interests from the dedicated user_interests table (source of truth)
  const tableInterests = await fetchUserInterests(userId);
  if (tableInterests.length > 0) {
    prefUpdates.interests = tableInterests;
  } else if (Array.isArray(profile.interests) && profile.interests.length > 0) {
    // Fallback: migrate from legacy profiles.interests jsonb
    prefUpdates.interests = profile.interests;
    // Backfill the new table so next login is fast
    saveUserInterests(userId, profile.interests).catch(() => {});
  }

  if (typeof profile.ai_enabled === 'boolean') {
    prefUpdates.aiEnabled = profile.ai_enabled;
  }
  if (Object.keys(prefUpdates).length) Storage.setPrefs(prefUpdates);

  // Topic weights: only overwrite when the cloud has something meaningful;
  // never wipe a user's local interests with an empty cloud row.
  if (profile.topic_weights && typeof profile.topic_weights === 'object'
      && Object.keys(profile.topic_weights).length > 0) {
    const cur = Storage.getEngine();
    Storage.setEngine({
      topicWeights: profile.topic_weights,
      sessionCount: Number.isFinite(profile.session_count)
        ? profile.session_count
        : (cur.sessionCount || 0),
    });
  } else if (Number.isFinite(profile.session_count)) {
    Storage.setEngine({ sessionCount: profile.session_count });
  }

  const h = Storage.getHistory();

  const mergedArticles = mergeLikedArticles(profile.liked_articles, h.likedArticles);
  const mergedLikedTitles = mergeTitleLists(
    profile.liked_titles,
    [...mergedArticles.map(a => a.title), ...(h.likedTitles || [])],
    300,
  );

  const mergedSeen = mergeTitleLists(profile.seen_titles, h.seenTitles, 500);
  const mergedDismissed = mergeTitleLists(profile.dismissed_titles, h.dismissedTitles, 300);

  const mergedSavedArticles = mergeLikedArticles(profile.saved_articles, h.savedArticles);
  const mergedSavedTitles = mergeTitleLists(
    profile.saved_titles,
    [...mergedSavedArticles.map(a => a.title), ...(h.savedTitles || [])],
    300,
  );

  Storage.setHistory({
    likedArticles: mergedArticles,
    likedTitles: mergedLikedTitles,
    savedArticles: mergedSavedArticles,
    savedTitles: mergedSavedTitles,
    seenTitles: mergedSeen,
    dismissedTitles: mergedDismissed,
  });

  const mergedStats = mergeStats(profile.usage_stats, Storage.getStats());
  Storage.setStatsAll(mergedStats);

  if (profile.onboarded === true && typeof localStorage !== 'undefined') {
    localStorage.setItem('sw_onboarded', '1');
  }

  return profile;
}

/**
 * Debounced sync helper - call as often as you like; only one upsert fires
 * per quiet window, regardless of how many preferences changed.
 */
let _syncTimer = null;
let _pendingUserId = null;
export function scheduleSyncPrefs(userId, delayMs = 700) {
  if (!userId) return;
  _pendingUserId = userId;
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    const id = _pendingUserId;
    _pendingUserId = null;
    if (id) syncPrefsToCloud(id).catch(() => {});
  }, delayMs);
}
