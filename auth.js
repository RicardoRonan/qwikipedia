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

// Sync local prefs to Supabase when user is logged in
export async function syncPrefsToCloud(userId) {
  const prefs = Storage.getPrefs();
  await upsertProfile(userId, {
    theme: prefs.theme,
    text_scale: prefs.textScale,
  });
}

// Pull remote prefs and apply locally
export async function pullPrefsFromCloud(userId) {
  const profile = await getProfile(userId);
  if (!profile) return;
  const updates = {};
  if (profile.theme) updates.theme = profile.theme;
  if (profile.text_scale) updates.textScale = profile.text_scale;
  if (Object.keys(updates).length) {
    Storage.setPrefs(updates);
  }
  return profile;
}
