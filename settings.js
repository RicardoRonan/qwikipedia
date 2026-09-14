// settings.js - settings page logic: theme, text scale, account controls

import { Storage } from './storage.js';
import { showToast } from './toast.js';
import {
  getCurrentUser,
  signOut,
  getProfile,
  upsertProfile,
  scheduleSyncPrefs,
  syncPrefsToCloud,
} from './auth.js';
import { ICONS } from './icons.js';
import { escapeHtml, escapeAttr } from './text-utils.js';
import { isAiEnabled, setAiEnabled, checkAiAvailability } from './ai.js';
import { getVoices, isPronounceSupported } from './pronounce.js';
import { setButtonLoading } from './ui.js';

// Topic list mirrors the onboarding interest options
const INTEREST_OPTIONS = [
  { id: 'science',    label: 'Science',    icon: 'microscope' },
  { id: 'history',    label: 'History',    icon: 'landmark' },
  { id: 'technology', label: 'Technology', icon: 'cpu' },
  { id: 'arts',       label: 'Arts',       icon: 'palette' },
  { id: 'geography',  label: 'Geography',  icon: 'map' },
  { id: 'people',     label: 'People',     icon: 'users' },
  { id: 'nature',     label: 'Nature',     icon: 'leaf' },
  { id: 'society',    label: 'Society',    icon: 'building2' },
  { id: 'sports',     label: 'Sports',     icon: 'trophy' },
  { id: 'food',       label: 'Food',       icon: 'utensils' },
];

// ===== Theme =====

const THEME_CHROME = {
  light: '#ffffff',
  dark: '#09090b',
};

function syncBrowserChrome(resolved) {
  const color = THEME_CHROME[resolved] || THEME_CHROME.light;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.removeAttribute('media');
    themeMeta.setAttribute('content', color);
  }
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.setAttribute('content', resolved);
  const apple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (apple) {
    apple.setAttribute('content', resolved === 'dark' ? 'black-translucent' : 'default');
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  root.dataset.theme = resolved;
  syncBrowserChrome(resolved);
  Storage.setPrefs({ theme });
  updateThemeButtons(theme);
}

function updateThemeButtons(theme) {
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

// ===== Text Scale =====

export function applyTextScale(scale) {
  document.documentElement.style.setProperty('--font-scale', scale / 100);
  Storage.setPrefs({ textScale: scale });
  const label = document.getElementById('text-scale-label');
  if (label) label.textContent = `${scale}%`;
}

// ===== Settings page init =====

export function initSettings() {
  const prefs = Storage.getPrefs();

  // Apply stored prefs immediately
  applyTheme(prefs.theme);
  applyTextScale(prefs.textScale);

  // Theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.theme;
      applyTheme(t);
      syncIfLoggedIn();
    });
  });

  // Text scale slider
  const slider = document.getElementById('text-scale-slider');
  const label = document.getElementById('text-scale-label');
  if (slider) {
    slider.value = prefs.textScale;
    if (label) label.textContent = `${prefs.textScale}%`;
    slider.addEventListener('input', () => {
      applyTextScale(Number(slider.value));
      syncIfLoggedIn();
    });
  }

  // System theme watcher
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const currentTheme = Storage.getPrefs().theme;
    if (currentTheme === 'system') applyTheme('system');
  });

  const syncBtn = document.getElementById('sync-account-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      const user = await getCurrentUser();
      if (!user) {
        showToast('Sign in to sync your account', 'info');
        window.openAuthModal?.('signin');
        return;
      }
      setButtonLoading(syncBtn, true);
      try {
        await syncPrefsToCloud(user.id);
        showToast('Account synced to Supabase', 'success');
      } catch {
        showToast('Sync failed. Try again', 'error');
      } finally {
        setButtonLoading(syncBtn, false, 'Sync now');
      }
    });
  }

  // Reset algorithm button
  const resetBtn = document.getElementById('reset-algo-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (confirm('Reset your recommendation history? This cannot be undone.')) {
        setButtonLoading(resetBtn, true);
        try {
          Storage.reset();
          showToast('Algorithm reset - your feed starts fresh', 'info');
          const user = await getCurrentUser();
          if (user) scheduleSyncPrefs(user.id, 0);
          renderLikesSection();
        } finally {
          setButtonLoading(resetBtn, false, 'Reset algorithm');
        }
      }
    });
  }

  // Clear all data button
  const clearBtn = document.getElementById('clear-all-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (confirm('Delete ALL local data including preferences? This cannot be undone.')) {
        setButtonLoading(clearBtn, true);
        try {
          Storage.resetAll();
          applyTheme('system');
          applyTextScale(100);
          showToast('All data cleared', 'info');
          renderAccountSection();
          renderLikesSection();
          const user = await getCurrentUser();
          if (user) scheduleSyncPrefs(user.id, 0);
        } finally {
          setButtonLoading(clearBtn, false, 'Clear all data');
        }
      }
    });
  }

  renderAccountSection();
  renderInterestsSection();
  initAiSettings();
  initPronounceSettings();
}

/** Re-render the interests grid (called after cloud sync pulls new interests). */
export function refreshInterests() {
  renderInterestsSection();
}

function initPronounceSettings() {
  const toggle = document.getElementById('pronounce-enabled-toggle');
  const rate = document.getElementById('pronounce-rate');
  const voiceSelect = document.getElementById('pronounce-voice');
  const note = document.getElementById('pronounce-unsupported');
  const section = document.getElementById('pronounce-settings-section');

  if (!isPronounceSupported()) {
    section?.querySelectorAll('.pronounce-control').forEach(el => { el.classList.add('is-hidden'); });
    if (note) note.hidden = false;
    return;
  }

  const prefs = Storage.getPrefs();
  if (toggle) {
    toggle.checked = prefs.pronounceEnabled !== false;
    toggle.addEventListener('change', () => {
      Storage.setPrefs({ pronounceEnabled: toggle.checked });
      syncIfLoggedIn();
    });
  }

  if (rate) {
    const storedRate = Number(prefs.pronounceRate);
    rate.value = Number.isFinite(storedRate) ? storedRate : 1;
    rate.addEventListener('input', () => {
      Storage.setPrefs({ pronounceRate: parseFloat(rate.value) });
      syncIfLoggedIn();
    });
  }

  function populateVoices() {
    if (!voiceSelect) return;
    const voices = getVoices();
    const currentPrefs = Storage.getPrefs();
    const current = currentPrefs.pronounceVoice || '';
    const wikiLang = currentPrefs.wikiLang === 'simple' ? 'en' : (currentPrefs.wikiLang || 'en');
    const base = String(wikiLang).split('-')[0].toLowerCase();
    const sorted = [...voices].sort((a, b) => {
      const aMatch = (a.lang || '').toLowerCase().startsWith(base) ? 0 : 1;
      const bMatch = (b.lang || '').toLowerCase().startsWith(base) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return (a.name || '').localeCompare(b.name || '');
    });
    voiceSelect.innerHTML = `<option value="">Automatic</option>` +
      sorted.map(v => `<option value="${escapeAttr(v.voiceURI)}">${escapeHtml(`${v.name} (${v.lang})`)}</option>`).join('');
    voiceSelect.value = current;
    if (current && voiceSelect.value !== current) voiceSelect.value = '';
  }

  populateVoices();
  if (voiceSelect) {
    voiceSelect.addEventListener('change', () => {
      Storage.setPrefs({ pronounceVoice: voiceSelect.value });
      syncIfLoggedIn();
    });
  }
  window.speechSynthesis?.addEventListener?.('voiceschanged', populateVoices);
}

function initAiSettings() {
  const toggle = document.getElementById('ai-enabled-toggle');
  const statusEl = document.getElementById('ai-status-text');
  if (!toggle) return;

  toggle.checked = isAiEnabled();
  toggle.addEventListener('change', () => {
    setAiEnabled(toggle.checked);
    updateAiStatus(statusEl);
    syncIfLoggedIn();
  });

  updateAiStatus(statusEl);
}

async function updateAiStatus(statusEl) {
  if (!statusEl) return;
  if (!isAiEnabled()) {
    statusEl.textContent = 'AI enhancements are off. Local heuristics only when you use videos or search.';
    return;
  }
  statusEl.textContent = 'Checking AI helper…';
  const { available, ai, reason } = await checkAiAvailability();
  if (!available) {
    statusEl.textContent = 'Edge function not reachable, using local heuristics. Deploy the ai function (see AI_SETUP.md).';
    return;
  }
  if (ai) {
    statusEl.textContent = 'AI helper is online (Groq). Search and YouTube use smart queries when you click.';
  } else {
    statusEl.textContent = 'Edge function is up but GROQ_API_KEY is missing, using local heuristics until you add the secret.';
  }
}

async function syncIfLoggedIn() {
  const user = await getCurrentUser();
  if (user) scheduleSyncPrefs(user.id);
}

// ===== Interests section =====

function renderInterestsSection() {
  const grid = document.getElementById('interests-grid');
  const status = document.getElementById('interests-status');
  if (!grid) return;

  // Boost value applied when activating a topic
  const BOOST = 5;

  function getActiveTopics() {
    const fromPrefs = new Set((Storage.getPrefs().interests || []).map(v => String(v).toLowerCase().trim()).filter(Boolean));
    if (fromPrefs.size) return fromPrefs;
    const { topicWeights } = Storage.getEngine();
    return new Set(INTEREST_OPTIONS.filter(({ id }) => (topicWeights[id] || 0) > 0).map(({ id }) => id));
  }

  function buildChips() {
    const active = getActiveTopics();
    grid.innerHTML = '';

    INTEREST_OPTIONS.forEach(({ id, label, icon }) => {
      const chip = document.createElement('button');
      chip.className = 'interest-chip' + (active.has(id) ? ' selected' : '');
      chip.dataset.topic = id;
      chip.setAttribute('aria-pressed', active.has(id) ? 'true' : 'false');
      chip.innerHTML = `<span class="chip-icon">${ICONS[icon] || ''}</span><span>${label}</span><span class="chip-check">${ICONS.check}</span>`;

      chip.addEventListener('click', () => {
        const engine = Storage.getEngine();
        const weights = { ...engine.topicWeights };
        const isActive = (weights[id] || 0) > 0;

        if (isActive) {
          delete weights[id];
        } else {
          weights[id] = BOOST;
        }
        Storage.setEngine({ topicWeights: weights });
        const currentPrefs = Storage.getPrefs().interests || [];
        const nextPrefs = isActive ? currentPrefs.filter(t => t !== id) : [...new Set([...currentPrefs, id])];
        Storage.setPrefs({ interests: nextPrefs });

        // Animate and rebuild
        chip.classList.toggle('selected', !isActive);
        chip.setAttribute('aria-pressed', String(!isActive));
        if (status) {
          status.textContent = isActive
            ? `${label} removed from your interests`
            : `${label} added to your interests`;
          clearTimeout(status._t);
          status._t = setTimeout(() => { status.textContent = ''; }, 2500);
        }

        syncIfLoggedIn();
      });

      grid.appendChild(chip);
    });
  }

  buildChips();
}

// ===== Account section =====

export async function renderAccountSection() {
  const container = document.getElementById('account-section');
  if (!container) return;

  const user = await getCurrentUser();

  if (!user) {
    container.innerHTML = `
      <div class="settings-row">
        <div class="settings-row-label">
          <strong>Not signed in</strong>
          <span>Sign in to sync your preferences across devices</span>
        </div>
        <button class="btn-primary" id="open-auth-btn" data-action="open-auth"><span class="btn-label">Sign in</span></button>
      </div>
    `;
    document.getElementById('open-auth-btn')?.addEventListener('click', () => {
      window.openAuthModal?.();
    });
    return;
  }

  // Fetch profile
  const profile = await getProfile(user.id);

  container.innerHTML = `
    <div class="settings-row">
      <div class="settings-row-label">
        <strong>${user.email}</strong>
        <span>Signed in</span>
      </div>
      <button class="btn-secondary" id="sign-out-btn">Sign out</button>
    </div>
    <div class="settings-row settings-row--stack-sm">
      <div class="input-group">
        <label class="input-label" for="wiki-username-input">Wikipedia username <span class="label-optional">(optional)</span></label>
        <div class="input-row">
          <input
            class="input-field"
            id="wiki-username-input"
            type="text"
            placeholder="e.g. YourWikipediaName"
            value="${profile?.wikipedia_username || ''}"
          />
          <button class="btn-primary btn-compact" id="save-wiki-username"><span class="btn-label">Save</span></button>
        </div>
      </div>
      ${profile?.wikipedia_username ? `<a href="https://en.wikipedia.org/wiki/User:${encodeURIComponent(profile.wikipedia_username)}" target="_blank" rel="noopener" class="wiki-profile-link">View your Wikipedia profile →</a>` : ''}
    </div>
  `;

  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    await signOut();
    showToast('Signed out', 'info');
    renderAccountSection();
    renderLikesSection();
  });

  document.getElementById('save-wiki-username')?.addEventListener('click', async () => {
    const val = document.getElementById('wiki-username-input')?.value?.trim();
    const btn = document.getElementById('save-wiki-username');
    if (val === undefined) return;
    setButtonLoading(btn, true);
    try {
      await upsertProfile(user.id, { wikipedia_username: val });
      showToast('Wikipedia username saved', 'success');
      renderAccountSection();
    } catch (err) {
      showToast(err?.message || 'Could not save Wikipedia username', 'error');
    } finally {
      setButtonLoading(btn, false, 'Save');
    }
  });
}

/** Refresh the combined liked + saved page (callers still use this name). */
export async function renderLikesSection() {
  const { renderSavedPage } = await import('./app.js');
  renderSavedPage?.();
}
