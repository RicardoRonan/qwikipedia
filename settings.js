// settings.js — settings page logic: theme, text scale, account controls

import { Storage } from './storage.js';
import { showToast } from './toast.js';
import {
  getCurrentUser,
  signOut,
  getProfile,
  upsertProfile,
  syncPrefsToCloud,
} from './auth.js';
import { ICONS } from './icons.js';

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

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = prefersDark ? 'dark' : 'light';
  } else {
    root.dataset.theme = theme;
  }
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

  // Reset algorithm button
  const resetBtn = document.getElementById('reset-algo-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Reset your recommendation history? This cannot be undone.')) {
        Storage.reset();
        showToast('Algorithm reset — your feed starts fresh', 'info');
      }
    });
  }

  // Clear all data button
  const clearBtn = document.getElementById('clear-all-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Delete ALL local data including preferences? This cannot be undone.')) {
        Storage.resetAll();
        applyTheme('system');
        applyTextScale(100);
        showToast('All data cleared', 'info');
        renderAccountSection();
      }
    });
  }

  renderAccountSection();
  renderInterestsSection();
}

async function syncIfLoggedIn() {
  const user = await getCurrentUser();
  if (user) syncPrefsToCloud(user.id).catch(() => {});
}

// ===== Interests section =====

function renderInterestsSection() {
  const grid = document.getElementById('interests-grid');
  const status = document.getElementById('interests-status');
  if (!grid) return;

  // Boost value applied when activating a topic
  const BOOST = 5;

  function getActiveTopics() {
    const { topicWeights } = Storage.getEngine();
    return new Set(
      INTEREST_OPTIONS
        .filter(({ id }) => (topicWeights[id] || 0) > 0)
        .map(({ id }) => id)
    );
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
        <button class="btn-primary" id="open-auth-btn">Sign in</button>
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
    <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px;">
      <div class="input-group">
        <label class="input-label" for="wiki-username-input">Wikipedia username <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
        <div style="display:flex;gap:8px;width:100%;">
          <input
            class="input-field"
            id="wiki-username-input"
            type="text"
            placeholder="e.g. YourWikipediaName"
            value="${profile?.wikipedia_username || ''}"
            style="flex:1"
          />
          <button class="btn-primary" id="save-wiki-username" style="white-space:nowrap;padding:9px 14px;">Save</button>
        </div>
      </div>
      ${profile?.wikipedia_username ? `<a href="https://en.wikipedia.org/wiki/User:${encodeURIComponent(profile.wikipedia_username)}" target="_blank" rel="noopener" style="font-size:var(--fs-sm)">View your Wikipedia profile →</a>` : ''}
    </div>
  `;

  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    await signOut();
    showToast('Signed out', 'info');
    renderAccountSection();
  });

  document.getElementById('save-wiki-username')?.addEventListener('click', async () => {
    const val = document.getElementById('wiki-username-input')?.value?.trim();
    if (val !== undefined) {
      await upsertProfile(user.id, { wikipedia_username: val });
      showToast('Wikipedia username saved', 'success');
      renderAccountSection();
    }
  });
}
