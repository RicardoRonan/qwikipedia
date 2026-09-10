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
import { fetchSummary } from './wiki.js';
import { ICONS } from './icons.js';
import { escapeHtml } from './text-utils.js';
import { isAiEnabled, setAiEnabled, checkAiAvailability } from './ai.js';
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
}

/** Re-render the interests grid (called after cloud sync pulls new interests). */
export function refreshInterests() {
  renderInterestsSection();
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
    statusEl.textContent = 'Edge function not reachable—using local heuristics. Deploy the ai function (see AI_SETUP.md).';
    return;
  }
  if (ai) {
    statusEl.textContent = 'AI helper is online (Groq). Search and YouTube use smart queries when you click.';
  } else {
    statusEl.textContent = 'Edge function is up but GROQ_API_KEY is missing—using local heuristics until you add the secret.';
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

// ===== Your Likes section =====

const LIKES_PAGE_SIZE = 20;
let _likesShown = LIKES_PAGE_SIZE;
let _likesQuery = '';
/** Cache of fetched summaries keyed by title - keeps re-renders snappy. */
const _likesSummaryCache = new Map();
/** In-flight fetch promises, deduped per title. */
const _likesPending = new Map();

/** Render the "Your likes" section - only visible when signed in. */
export async function renderLikesSection() {
  const section = document.getElementById('likes-section');
  if (!section) return;

  const user = await getCurrentUser();
  if (!user) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const lang = Storage.getPrefs().wikiLang || 'en';
  const allTitles = Storage.getHistory().likedTitles || [];

  // Apply search filter
  const q = _likesQuery.trim().toLowerCase();
  const filtered = q
    ? allTitles.filter(t => t.toLowerCase().includes(q))
    : allTitles;

  const countEl = document.getElementById('likes-count');
  if (countEl) countEl.textContent = String(allTitles.length);

  const feedEl = document.getElementById('likes-feed');
  if (!feedEl) return;

  if (allTitles.length === 0) {
    feedEl.innerHTML = `
      <div class="likes-empty">
        Articles you like in the feed will appear here. Tap the heart icon on any card to start your collection.
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    feedEl.innerHTML = `
      <div class="likes-empty">No likes match "${escapeHtml(_likesQuery)}".</div>
    `;
    return;
  }

  const visible = filtered.slice(0, _likesShown);

  // Initial paint with placeholders for any uncached titles
  feedEl.innerHTML = visible.map(title => renderLikeCardHtml(title, _likesSummaryCache.get(title), lang)).join('');

  // Load missing summaries lazily and patch the DOM as they resolve
  visible.forEach(title => {
    if (_likesSummaryCache.has(title)) return;
    if (_likesPending.has(title)) return;
    const p = fetchSummary(title, lang)
      .then(article => {
        _likesSummaryCache.set(title, article);
        const row = feedEl.querySelector(`[data-like-title="${cssEscape(title)}"]`);
        if (row) row.outerHTML = renderLikeCardHtml(title, article, lang);
      })
      .catch(() => {
        const row = feedEl.querySelector(`[data-like-title="${cssEscape(title)}"]`);
        if (row) {
          row.querySelector('.like-card-extract')?.classList.remove('likes-pending');
          const ex = row.querySelector('.like-card-extract');
          if (ex) ex.textContent = 'Couldn\'t load preview - open on Wikipedia.';
        }
      })
      .finally(() => { _likesPending.delete(title); });
    _likesPending.set(title, p);
  });

  // Render "Load more" if there are more matches than currently shown
  if (filtered.length > _likesShown) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'likes-load-more';
    btn.textContent = `Show ${Math.min(LIKES_PAGE_SIZE, filtered.length - _likesShown)} more`;
    btn.addEventListener('click', () => {
      _likesShown += LIKES_PAGE_SIZE;
      renderLikesSection();
    });
    feedEl.appendChild(btn);
  }
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~\n]/g, c => '\\' + c);
}

function renderLikeCardHtml(title, article, lang) {
  const safeTitle = escapeHtml(title);
  const url = article?.url || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  const display = article?.displayTitle || article?.title || title;
  const image = article?.image;
  const extract = article?.extract;

  const initial = escapeHtml((display || title || '?').trim().charAt(0).toUpperCase());
  const thumb = image
    ? `<div class="like-card-thumb" style="--thumb-image:url('${escapeHtml(image)}')" aria-hidden="true"></div>`
    : `<div class="like-card-thumb no-image" aria-hidden="true">${initial}</div>`;

  const extractHtml = extract
    ? `<p class="like-card-extract">${escapeHtml(extract)}</p>`
    : `<p class="like-card-extract likes-pending">Loading preview…</p>`;

  return `
    <div class="like-card" data-like-title="${escapeHtml(title)}">
      ${thumb}
      <div class="like-card-body">
        <a class="like-card-title" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(display)}</a>
        ${extractHtml}
        <div class="like-card-actions">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener" aria-label="Open ${safeTitle} on Wikipedia">
            ${ICONS.externalLink || ''} Open
          </a>
          <button type="button" class="like-unlike-btn" data-unlike-title="${safeTitle}" aria-label="Unlike ${safeTitle}">
            ${ICONS.heartFilled || ''} Unlike
          </button>
        </div>
      </div>
    </div>
  `;
}

/** Wire search, clear-all, and unlike delegation (runs once - #likes-feed lives on the Account page). */
function bindLikesEvents() {
  const search = document.getElementById('likes-search');
  if (search && !search.dataset.bound) {
    search.dataset.bound = '1';
    let t = null;
    search.addEventListener('input', () => {
      _likesQuery = search.value;
      _likesShown = LIKES_PAGE_SIZE;
      clearTimeout(t);
      t = setTimeout(renderLikesSection, 120);
    });
  }

  const clearBtn = document.getElementById('likes-clear-btn');
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', async () => {
      const all = Storage.getHistory().likedTitles || [];
      if (!all.length) return;
      if (!confirm(`Remove all ${all.length} liked article${all.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
      Storage.setHistory({ likedTitles: [], likedArticles: [] });
      const user = await getCurrentUser();
      if (user) scheduleSyncPrefs(user.id, 0);
      _likesSummaryCache.clear();
      _likesPending.clear();
      _likesShown = LIKES_PAGE_SIZE;
      _likesQuery = '';
      if (search) search.value = '';
      showToast('Cleared all liked articles', 'info');
      renderLikesSection();
    });
  }

  const feed = document.getElementById('likes-feed');
  if (feed && !feed.dataset.bound) {
    feed.dataset.bound = '1';
    feed.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-unlike-title]');
      if (!btn) return;
      const title = btn.dataset.unlikeTitle;
      const card = btn.closest('.like-card');

      Storage.removeLiked(title);

      const user = await getCurrentUser();
      if (user) scheduleSyncPrefs(user.id);
      showToast(`Unliked "${title}"`, 'info');

      // Quick fade-out, then re-render
      if (card) {
        card.style.transition = 'opacity 180ms ease, transform 180ms ease';
        card.style.opacity = '0';
        card.style.transform = 'translateX(-12px)';
        setTimeout(() => renderLikesSection(), 200);
      } else {
        renderLikesSection();
      }
    });
  }
}

// Bind once at module load (DOM already exists by then via index.html)
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindLikesEvents, { once: true });
  } else {
    bindLikesEvents();
  }
}
