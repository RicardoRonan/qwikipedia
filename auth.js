// auth.js — Supabase auth integration
// Replace SUPABASE_URL and SUPABASE_ANON_KEY with your project values

import { Storage } from './storage.js';

const SUPABASE_URL = 'https://xbvfscmtrdipmmcwxnzl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhidmZzY210cmRpcG1tY3d4bnpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMTE2MTgsImV4cCI6MjA5Mjg4NzYxOH0.PE3lQNLTMc6QuUMbu0_tZAnsgyxlog4kdIQTS3mITbA';

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

export async function signUp(email, password) {
  const client = getClient();
  if (!client) throw new Error('Auth not available');
  const { data, error } = await client.auth.signUp({ email, password });
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

/**
 * Sync local prefs (theme, text scale, language, topic interests) to Supabase.
 * Debounced via the caller — this just performs a single upsert and never throws.
 */
export async function syncPrefsToCloud(userId) {
  const prefs = Storage.getPrefs();
  const engine = Storage.getEngine();
  const history = Storage.getHistory();
  await upsertProfile(userId, {
    theme: prefs.theme,
    text_scale: prefs.textScale,
    wiki_lang: prefs.wikiLang,
    interests: prefs.interests || [],
    topic_weights: engine.topicWeights || {},
    // Cap at 300 to mirror the local cap and keep the row small
    liked_titles: (history.likedTitles || []).slice(0, 300),
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
  if (Array.isArray(profile.interests)) prefUpdates.interests = profile.interests;
  if (Object.keys(prefUpdates).length) Storage.setPrefs(prefUpdates);

  // Topic weights: only overwrite when the cloud has something meaningful;
  // never wipe a user's local interests with an empty cloud row.
  if (profile.topic_weights && typeof profile.topic_weights === 'object'
      && Object.keys(profile.topic_weights).length > 0) {
    Storage.setEngine({ topicWeights: profile.topic_weights });
  }

  // Liked titles: union of local + cloud (preserves likes from either side),
  // most-recent-first ordering taken from cloud where available.
  if (Array.isArray(profile.liked_titles)) {
    const local = Storage.getHistory().likedTitles || [];
    const seen = new Set();
    const merged = [];
    [...profile.liked_titles, ...local].forEach(t => {
      if (typeof t === 'string' && !seen.has(t)) {
        seen.add(t);
        merged.push(t);
      }
    });
    Storage.setHistory({ likedTitles: merged.slice(0, 300) });
  }

  return profile;
}

/**
 * Debounced sync helper — call as often as you like; only one upsert fires
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
