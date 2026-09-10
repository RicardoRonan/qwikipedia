// app.js - main bootstrapper, feed rendering, routing

import { Storage } from './storage.js';
import { fetchFeedBatch, getFeaturedCard, recordInteraction, applyDecay } from './engine.js';
import { getApiBackoffRemainingMs, clearApiBackoff, getCachedArticles, setCacheUserId } from './wiki.js';
import { applyTheme, applyTextScale, initSettings, refreshInterests } from './settings.js';
import { onAuthStateChange, pullPrefsFromCloud, scheduleSyncPrefs, syncPrefsToCloud } from './auth.js';
import { showToast } from './toast.js';
import { ICONS } from './icons.js';
import { cleanWikipediaText, escapeHtml, escapeAttr } from './text-utils.js';
import { bindYoutubeLinks, prefetchVisibleYoutubeQueries } from './ai.js';
import { usePullToRefresh } from './usePullToRefresh.js';
import { warmArticleCache, hasCacheClient, pruneStaleCache } from './cache.js';
import { toggleDeepDive } from './deepdive.js';
import {
  setHidden,
  setBusy,
  setButtonLoading,
  setButtonLabel,
  stateBox,
  showSkeletonCards,
  removeSkeletonCards,
  bindAppActions,
} from './ui.js';

// GSAP helper - gracefully falls back to no-op if CDN hasn't loaded yet
function gsap() { return window.gsap || null; }

// ===== State =====
let isLoading = false;
let currentUser = null;
let scrollObserver = null;
let prefetchObserver = null;

// Session tracking
const _sessionStart = Date.now();
let _sessionSeen = 0;
let _sessionLiked = 0;
let _sessionDismissed = 0;

function getSessionTimeMs() { return Date.now() - _sessionStart; }

// Flush elapsed session time to storage on page hide/unload
function flushSessionTime() {
  Storage.incrementStat('totalTimeMs', getSessionTimeMs());
}

// ===== Routing (simple in-page) =====

const ACCOUNT_HASH = '#account';

function isAccountRoute() {
  return location.hash === ACCOUNT_HASH || /^\/account\/?$/.test(location.pathname);
}

function basePath() {
  return location.pathname.replace(/\/account\/?$/, '') || '/';
}

const PAGE_TITLES = {
  'feed-page': 'Feed',
  'search-page': 'Search',
  'saved-page': 'Saved',
  'stats-page': 'Stats',
  'settings-page': 'Settings',
  'account-page': 'Account',
};

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(id);
  if (page) page.classList.add('active');

  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    const active = btn.dataset.page === id;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  const navLoginBtn = document.getElementById('nav-login-btn');
  if (navLoginBtn) {
    const accountActive = id === 'account-page';
    navLoginBtn.classList.toggle('active', accountActive);
    if (accountActive) navLoginBtn.setAttribute('aria-current', 'page');
    else navLoginBtn.removeAttribute('aria-current');
  }

  // Hash routing works on static hosts (Live Server, GitHub Pages); pathname /account 404s
  if (id === 'account-page') {
    history.replaceState(null, '', basePath() + location.search + ACCOUNT_HASH);
  } else if (isAccountRoute()) {
    history.replaceState(null, '', basePath() + location.search);
  }

  document.title = PAGE_TITLES[id] ? `${PAGE_TITLES[id]} · Qwikipedia` : 'Qwikipedia';
  window.scrollTo(0, 0);

  const heading = page?.querySelector('h1');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  } else if (page) {
    page.setAttribute('tabindex', '-1');
    page.focus({ preventScroll: true });
  }
}

async function goToPage(id) {
  showPage(id);
  if (id === 'stats-page') renderStatsPage();
  if (id === 'search-page') {
    const { renderSearchPage, resetSearchSuggestions } = await import('./search.js');
    resetSearchSuggestions?.();
    renderSearchPage();
  }
  if (id === 'saved-page') renderSavedPage();
  if (id === 'account-page') {
    const { renderAccountPage } = await import('./account.js');
    renderAccountPage();
  }
}

function showWelcomeBack() {
  const el = document.getElementById('welcome-back');
  if (!el) return;

  const stats = Storage.getStats();
  const totalTimeMs = stats.totalTimeMs || 0;
  const totalLiked = stats.totalLiked || 0;

  if (totalTimeMs <= 0 && totalLiked <= 0) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  const timeStr = totalTimeMs >= 3600000
    ? `${Math.floor(totalTimeMs / 3600000)}h`
    : `${Math.floor(totalTimeMs / 60000)}m`;
  const likedLabel = totalLiked === 1 ? 'article' : 'articles';

  el.innerHTML = `
    <p>Welcome back! You've spent <strong>${timeStr}</strong> reading and liked <strong>${totalLiked}</strong> ${likedLabel}.</p>
  `;
  el.hidden = false;
}

// ===== Card rendering =====

function createCard(article, featured = false) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.title = article.title;
  const isLiked = Storage.isLiked(article.title);
  const isSaved = Storage.isSaved(article.title);

  const lang = Storage.getPrefs().wikiLang || 'en';
  const displayTitleRaw = article.displayTitle || article.title || '';
  const safeUrl = article.url || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.title)}`;
  const imageHtml = article.image
    ? `<div class="card-image-wrap"><img class="card-image media" src="${escapeAttr(article.image)}" alt="${escapeAttr(displayTitleRaw)}" loading="lazy" onerror="this.parentElement.classList.add('is-hidden')"></div>`
    : ``;

  const featuredBadge = featured
    ? `<div class="card-featured-badge">${ICONS.arrowRight} Today's featured article</div>`
    : '';

  el.innerHTML = `
    <div class="card-body">
      ${featuredBadge}
      <h2 class="card-title">${escapeHtml(cleanWikipediaText(displayTitleRaw))}</h2>
      <p class="card-extract">${escapeHtml(cleanWikipediaText(article.extract || ''))}</p>
      ${imageHtml}
      <div class="card-actions">
        <div class="card-links">
          <a class="card-read-link" href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener" aria-label="Read on Wikipedia">
            ${ICONS.externalLink} wikipedia.org
          </a>
          <a class="card-youtube-link" href="#" data-youtube-title="${escapeAttr(displayTitleRaw)}" aria-label="Watch related videos on YouTube">
            ${ICONS.youtube || '▶'} Watch related videos
          </a>
        </div>
        <div class="card-icon-group">
          <button class="card-icon-btn btn-save ${isSaved ? 'saved' : ''}" aria-label="${isSaved ? 'Remove from saved' : 'Save for later'}">${isSaved ? ICONS.bookmarkFilled : ICONS.bookmark}</button>
          <button class="card-icon-btn btn-like ${isLiked ? 'liked' : ''}" aria-label="Like this article">${isLiked ? ICONS.heartFilled : ICONS.heart}</button>
          <button class="card-icon-btn btn-dislike" aria-label="Not interested">${ICONS.x}</button>
          <button class="card-icon-btn btn-deepdive" data-deepdive-topic="${escapeAttr(displayTitleRaw)}" aria-label="Deep dive research">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;

  const likeBtn = el.querySelector('.btn-like');
  const dislikeBtn = el.querySelector('.btn-dislike');
  const saveBtn = el.querySelector('.btn-save');
  const extractEl = el.querySelector('.card-extract');

  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    animateLike(el, likeBtn, article);
  });

  dislikeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    animateDismiss(el, article);
  });

  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    animateSave(el, saveBtn, article);
  });

  const deepDiveBtn = el.querySelector('.btn-deepdive');
  if (deepDiveBtn) {
    deepDiveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDeepDive(deepDiveBtn, el, displayTitleRaw);
    });
  }

  setupExtractExpansion(el, extractEl);

  // Entrance animation
  const g = gsap();
  if (g) {
    g.from(el, { opacity: 0, y: 12, duration: 0.3, ease: 'power2.out', clearProps: 'all' });
  }

  return el;
}

function setupExtractExpansion(cardEl, extractEl) {
  if (!cardEl || !extractEl) return;
  if ((extractEl.textContent || '').trim().length === 0) return;
  extractEl.classList.add('expandable');
  extractEl.setAttribute('role', 'button');
  extractEl.setAttribute('tabindex', '0');
  extractEl.setAttribute('aria-expanded', 'false');
}

const _extractFetchCache = new Map();

async function toggleExtractExpansion(extractEl) {
  if (!extractEl) return;
  const cardEl = extractEl.closest('.card');
  if (!cardEl) return;
  const wasExpanded = extractEl.classList.contains('expanded');
  if (wasExpanded) {
    extractEl.classList.remove('expanded');
    extractEl.setAttribute('aria-expanded', 'false');
    return;
  }
  extractEl.classList.add('expanded');
  extractEl.setAttribute('aria-expanded', 'true');

  const title = cardEl.dataset.title || '';
  const lang = Storage.getPrefs().wikiLang || 'en';
  if (!title) return;
  const key = `${lang}::${title}`;
  if (_extractFetchCache.has(key)) {
    const cached = _extractFetchCache.get(key);
    if (cached && cached.length > (extractEl.textContent || '').trim().length) {
      extractEl.textContent = cached;
    }
    return;
  }
  try {
    const startingLen = (extractEl.textContent || '').trim().length;
    const { fetchArticleIntro } = await import('./wiki.js');
    const raw = await fetchArticleIntro(title, lang);
    const full = cleanWikipediaText(raw || '');
    _extractFetchCache.set(key, full);
    if (full && full.length > startingLen && extractEl.classList.contains('expanded')) {
      extractEl.textContent = full;
    }
  } catch {}
}

function initExtractClickDelegation() {
  const feed = document.getElementById('feed-cards');
  if (!feed || feed.dataset.extractDelegationBound === '1') return;
  feed.dataset.extractDelegationBound = '1';
  feed.addEventListener('click', (e) => {
    const extractEl = e.target.closest?.('.card-extract');
    if (!extractEl || !feed.contains(extractEl)) return;
    // ignore link clicks inside the extract
    if (e.target.closest('a, button')) return;
    // ignore real text selections
    const sel = window.getSelection?.();
    if (sel && sel.toString().length > 0) return;
    e.preventDefault();
    toggleExtractExpansion(extractEl);
  });
  feed.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const extractEl = e.target.closest?.('.card-extract.expandable');
    if (!extractEl) return;
    e.preventDefault();
    toggleExtractExpansion(extractEl);
  });
}

function animateLike(cardEl, likeBtn, article) {
  const g = gsap();
  const alreadyLiked = Storage.isLiked(article.title);
  if (alreadyLiked) {
    Storage.removeLiked(article.title);
    likeBtn.innerHTML = ICONS.heart;
    likeBtn.classList.remove('liked');
    showToast('Removed from likes', 'info');
  } else {
    recordInteraction(article, 'like');
    Storage.setLikedArticle({
      title: article.title,
      displayTitle: cleanWikipediaText(article.displayTitle),
      extract: cleanWikipediaText(article.extract || ''),
      image: article.image || null,
      url: article.url || null,
      lang: article.lang || 'en',
    });
    Storage.incrementStat('totalLiked');
    _sessionLiked++;
    likeBtn.innerHTML = ICONS.heartFilled;
    likeBtn.classList.add('liked');
    showToast('Added to likes', 'success');
  }
  if (currentUser) scheduleSyncPrefs(currentUser.id);
  // Refresh the likes section on the settings page (no-op if not yet rendered)
  import('./settings.js').then(m => m.renderLikesSection?.()).catch(() => {});

  if (g) {
    g.fromTo(likeBtn, { scale: 1 }, { scale: 1.35, duration: 0.14, yoyo: true, repeat: 1, ease: 'back.out(3)' });
  }
}

function animateDismiss(cardEl, article) {
  const g = gsap();

  recordInteraction(article, 'dislike');
  Storage.incrementStat('totalDismissed');
  _sessionDismissed++;
  if (currentUser) scheduleSyncPrefs(currentUser.id);

  if (g) {
    g.to(cardEl, {
      opacity: 0, x: -20, duration: 0.22, ease: 'power2.in',
      onComplete: () => {
        cardEl.remove();
        showToast('Article dismissed', 'info');
      },
    });
  } else {
    cardEl.remove();
    showToast('Article dismissed', 'info');
  }
}

function animateSave(cardEl, saveBtn, article) {
  const alreadySaved = Storage.isSaved(article.title);
  if (alreadySaved) {
    Storage.removeSaved(article.title);
    saveBtn.innerHTML = ICONS.bookmark;
    saveBtn.classList.remove('saved');
    saveBtn.setAttribute('aria-label', 'Save for later');
    showToast('Removed from saved', 'info');
  } else {
    Storage.addSaved(article.title);
    Storage.setSavedArticle({
      title: article.title,
      displayTitle: cleanWikipediaText(article.displayTitle || article.title),
      extract: cleanWikipediaText(article.extract || ''),
      image: article.image || null,
      url: article.url || null,
      lang: article.lang || 'en',
    });
    saveBtn.innerHTML = ICONS.bookmarkFilled;
    saveBtn.classList.add('saved');
    saveBtn.setAttribute('aria-label', 'Remove from saved');
    showToast('Saved for later', 'success');
  }
  if (currentUser) scheduleSyncPrefs(currentUser.id);
}

// ===== Feed loading =====

const BATCH_SIZE       = 10;  // articles rendered per batch
const SENTINEL_FROM_END = 4;  // cards from the bottom; higher = more lead time for fast readers
const AUTOLOAD_COOLDOWN_MS = 1200;
/** Pre-fetch when sentinel is within this many px below the viewport bottom */
const INFINITE_SCROLL_ROOT_MARGIN_PX = 400;
/** Cap on auto-chained underfill loads after a full reload (prevents short-page loops) */
const UNDERFILL_MAX_CHAIN = 2;
let _underfillChain = 0;
/** Prefetch triggers this many cards before the load sentinel - fires earlier so data is ready */
const PREFETCH_FROM_END = 5;
/** rootMargin for the prefetch sentinel - much larger than the load sentinel's 240px */
const PREFETCH_ROOT_MARGIN_PX = 600;

// Single in-flight prefetch promise - prevents duplicate background fetches
let _prefetchPromise = null;
let _prefetchLang    = null;
let _lastAutoLoadAt  = 0;
let _didSeenRecovery = false;
const FEED_SESSION_CACHE_KEY = 'sw_feed_session_cache_v1';
const FEED_PERSISTED_CACHE_KEY = 'sw_feed_cache_v1';

function startPrefetch(lang) {
  // Never start a second prefetch if one is already in flight for this language
  if (_prefetchPromise && _prefetchLang === lang) return;
  // Don't fan out network calls while Wikipedia is asking us to back off.
  // The sentinel will re-arm and prefetch will resume once cooldown expires.
  if (getApiBackoffRemainingMs() > 1000) return;
  _prefetchLang    = lang;
  _prefetchPromise = fetchFeedBatch(lang, BATCH_SIZE).catch(() => []);
}

function consumePrefetch() {
  const p = _prefetchPromise;
  _prefetchPromise = null;
  _prefetchLang    = null;
  return p; // caller awaits this
}

function setFeedHintVisible(visible) {
  const hint = document.getElementById('feed-loading-hint');
  if (!hint) return;
  setHidden(hint, !visible);
  setBusy(hint, visible);
}

function setFeedLoadingPct(value) {
  const n = Math.min(100, Math.max(0, Math.round(value)));
  const bar = document.getElementById('feed-loading-bar');
  const hint = document.getElementById('feed-loading-hint');
  if (!bar) return;
  const visible = hint && !hint.classList.contains('is-hidden');
  // Keep a visible sliver while loading so the top line appears immediately
  const visual = n === 0 && visible ? 8 : n;
  bar.style.width = `${visual}%`;
  bar.setAttribute('aria-valuenow', String(n));
}

/** Build a serializable article from what's currently rendered on a card (for session restore). */
function articlePayloadFromCardDom(card) {
  const title = card.dataset.title;
  if (!title) return null;
  const titleEl = card.querySelector('.card-title');
  const extractEl = card.querySelector('.card-extract');
  const img = card.querySelector('.card-image-wrap img');
  const readLink = card.querySelector('.card-read-link');
  const displayTitle = (titleEl?.textContent || '').trim() || title;
  const extract = (extractEl?.textContent || '').trim();
  const image = img?.getAttribute('src') || null;
  const url = readLink?.getAttribute('href') || null;
  const lang = Storage.getPrefs().wikiLang || 'en';
  return {
    title,
    displayTitle,
    extract,
    image,
    url: url || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    lang,
  };
}

function snapshotFeedSession() {
  const cards = [...document.querySelectorAll('#feed-cards .card')];
  const articles = cards.map(card => {
    const fromDom = articlePayloadFromCardDom(card);
    if (!fromDom) return null;
    const liked = Storage.getLikedState().likedArticles.find(a => a?.title === fromDom.title);
    if (liked) {
      return {
        ...fromDom,
        image: liked.image || fromDom.image,
        url: liked.url || fromDom.url,
        extract: fromDom.extract || liked.extract || '',
        displayTitle: fromDom.displayTitle || liked.displayTitle || fromDom.title,
      };
    }
    return fromDom;
  }).filter(Boolean);
  try {
    const payload = JSON.stringify({ ts: Date.now(), articles });
    sessionStorage.setItem(FEED_SESSION_CACHE_KEY, payload);
    localStorage.setItem(FEED_PERSISTED_CACHE_KEY, payload);
  } catch {}
}

/** Old session cache stored only `{ title }` - not enough to render a card. */
function cacheEntryHasRenderablePayload(a) {
  if (!a?.title) return false;
  if (String(a.extract || '').trim().length > 0) return true;
  if (String(a.image || '').trim().length > 0) return true;
  if (String(a.url || '').trim().length > 0) return true;
  const d = String(a.displayTitle || '').trim();
  if (d && d !== String(a.title).trim()) return true;
  return false;
}

function restoreFeedSession(container) {
  try {
    const raw = sessionStorage.getItem(FEED_SESSION_CACHE_KEY) || localStorage.getItem(FEED_PERSISTED_CACHE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > 1000 * 60 * 30) return false;
    if (!Array.isArray(parsed.articles) || parsed.articles.length === 0) return false;
    if (!parsed.articles.every(cacheEntryHasRenderablePayload)) {
      try {
        sessionStorage.removeItem(FEED_SESSION_CACHE_KEY);
        localStorage.removeItem(FEED_PERSISTED_CACHE_KEY);
      } catch {}
      return false;
    }
    const likedTitles = new Set(Storage.getHistory().likedTitles || []);
    const frag = document.createDocumentFragment();
    const added = new Set();
    parsed.articles.forEach(article => {
      if (!article?.title || added.has(article.title)) return;
      if (likedTitles.has(article.title)) return;
      added.add(article.title);
      frag.appendChild(createCard(article));
    });
    container.innerHTML = '';
    container.appendChild(frag);
    afterFeedCardsUpdated(container);
    attachScrollSentinel();
    attachPrefetchSentinel();
    showWelcomeBack();
    return true;
  } catch {
    return false;
  }
}

function afterFeedCardsUpdated(container) {
  if (!container) return;
  bindYoutubeLinks(container);
  prefetchVisibleYoutubeQueries(container);
}

function appendUniqueArticles(container, articles = []) {
  const onScreen = new Set([...container.querySelectorAll('.card')].map(el => el.dataset.title));
  const likedTitles = new Set(Storage.getHistory().likedTitles || []);
  let added = 0;
  articles.forEach(a => {
    if (!a?.title || onScreen.has(a.title)) return;
    // Exclude liked articles from the main feed
    if (likedTitles.has(a.title)) return;
    onScreen.add(a.title);
    Storage.addSeen(a.title);
    container.appendChild(createCard(a));
    Storage.incrementStat('totalSeen');
    _sessionSeen++;
    added++;
  });
  if (added) afterFeedCardsUpdated(container);
}

let _backoffStatusInterval = null;
let _loadingLabelDefault = 'Loading articles';
function refreshLoadingStatus() {
  const labelEl = document.getElementById('feed-loading-label');
  const hintEl  = document.getElementById('feed-loading-hint');
  if (!labelEl) return;
  const remaining = getApiBackoffRemainingMs();

  // If cards are already on screen, NEVER show an alarming banner -
  // the user already has content; the next load will resume silently.
  if (remaining > 250) {
    const hasCards = !!document.querySelector('#feed-cards .card');
    if (hasCards && hintEl) {
      setFeedHintVisible(false);
      return;
    }
    labelEl.textContent = `Easing off Wikipedia for ${Math.ceil(remaining / 1000)}s…`;
  } else {
    labelEl.textContent = _loadingLabelDefault;
  }
}
/** Schedule a silent background refresh (skipped while we're in backoff). */
function silentBackgroundRefresh(container, lang) {
  if (getApiBackoffRemainingMs() > 1000) {
    // Wait out the cooldown, then try once more (silently).
    const wait = getApiBackoffRemainingMs() + 250;
    setTimeout(() => silentBackgroundRefresh(container, lang), wait);
    return;
  }
  fetchFeedBatch(lang, BATCH_SIZE).then(fresh => {
    const before = container.querySelectorAll('.card').length;
    appendUniqueArticles(container, fresh);
    const after = container.querySelectorAll('.card').length;
    const addedAny = after > before;
    if (addedAny) attachScrollSentinel();
    startPrefetch(lang);
  }).catch(() => {
    startPrefetch(lang);
  });
}

/** Append cached articles silently (used for auto-scroll loads when prefetch isn't ready). */
function appendCachedThenRefresh(container, cached, lang) {
  appendUniqueArticles(container, cached);
  attachScrollSentinel();
  attachPrefetchSentinel();
  silentBackgroundRefresh(container, lang);
}

/** Paint cached articles immediately, then silently fetch fresh ones and append non-dupes. */
function renderCachedThenRefresh(container, cached, lang) {
  container.innerHTML = '';
  appendUniqueArticles(container, cached);

  setFeedHintVisible(false);
  stopLoadingStatusPolling();

  // Infinite scroll armed right away - no waiting
  attachScrollSentinel();
  attachPrefetchSentinel();

  silentBackgroundRefresh(container, lang);
  showWelcomeBack();

  // Featured card (silent, no blocking) - also gated on backoff
  if (getApiBackoffRemainingMs() <= 1000) getFeaturedCard(lang).then(featured => {
    if (!featured) return;
    if (container.querySelector(`.card[data-title="${CSS.escape(featured.title)}"]`)) return;
    container.insertBefore(createCard(featured, true), container.firstChild);
  }).catch(() => {});
}

function startLoadingStatusPolling(defaultLabel) {
  _loadingLabelDefault = defaultLabel || 'Loading articles';
  if (_backoffStatusInterval) clearInterval(_backoffStatusInterval);
  refreshLoadingStatus();
  _backoffStatusInterval = setInterval(refreshLoadingStatus, 1000);
}
function stopLoadingStatusPolling() {
  if (_backoffStatusInterval) {
    clearInterval(_backoffStatusInterval);
    _backoffStatusInterval = null;
  }
}

async function loadFeed(append = false) {
  if (isLoading) return;
  isLoading = true;

  // Disconnect the observer immediately so it cannot fire again while we load
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
  if (prefetchObserver) { prefetchObserver.disconnect(); prefetchObserver = null; }

  const container  = document.getElementById('feed-cards');
  const loadMoreBtn = document.getElementById('load-more-btn');
  const loadingLabel = document.getElementById('feed-loading-label');
  const lang = Storage.getPrefs().wikiLang || 'en';
  const refreshBtn = document.getElementById('quick-refresh-btn');

  try {
    await runLoadFeed(append, { container, loadMoreBtn, loadingLabel, lang, refreshBtn });
  } finally {
    isLoading = false;
    setButtonLoading(refreshBtn, false);
    setButtonLoading(loadMoreBtn, false);
  }
}

async function runLoadFeed(append, { container, loadMoreBtn, loadingLabel, lang, refreshBtn }) {

  // Full reload should not compete with a background prefetch
  if (!append) {
    _prefetchPromise = null;
    _prefetchLang = null;
    _underfillChain = 0;
  }

  // Discard a stale prefetch if the language changed
  if (_prefetchLang && _prefetchLang !== lang) { _prefetchPromise = null; _prefetchLang = null; }

  const hasPrefetch = !!_prefetchPromise;
  const hasExistingFeed = !append && container.querySelector('.card') !== null;

  /* ── Cache-first rendering ──────────────────────────────────────────────────
   * If we have cached articles, paint them instantly (no spinner) and refresh
   * fresh ones in the background. The percentage loader only shows during
   * true "bulk" loads (first-run / empty cache) or explicit user retries. */
  const seenTitles = new Set([...container.querySelectorAll('.card')].map(el => el.dataset.title));
  const cachedAvailable = getCachedArticles(lang, BATCH_SIZE).filter(a => !seenTitles.has(a.title));

  if (!append && !hasExistingFeed && !hasPrefetch && cachedAvailable.length >= 4) {
    renderCachedThenRefresh(container, cachedAvailable, lang);
    return;
  }

  if (append && !hasPrefetch && cachedAvailable.length >= 4) {
    appendCachedThenRefresh(container, cachedAvailable, lang);
    return;
  }

  /* ── Backoff guard ──────────────────────────────────────────────────────────
   * Wikipedia is asking us to slow down. If we have ANY cached articles, append
   * them silently. Otherwise just stop - never show the alarm banner over a
   * feed that already has content. The sentinel will re-arm after the backoff
   * window so loading resumes naturally. */
  const backoffMs = getApiBackoffRemainingMs();
  if (backoffMs > 1000) {
    if (cachedAvailable.length > 0) {
      appendCachedThenRefresh(container, cachedAvailable, lang);
      return;
    }
    // No cache to fall back on. If there are already cards on screen, do nothing
    // visible - re-arm the sentinel after the cooldown so scrolling resumes.
    if (hasExistingFeed || append) {
      setTimeout(() => { if (!isLoading) { attachScrollSentinel(); attachPrefetchSentinel(); } }, backoffMs + 250);
      return;
    }
  }

  if (loadMoreBtn) setButtonLoading(loadMoreBtn, true, 'Load more articles');
  if (!append) setButtonLoading(refreshBtn, true);
  setFeedHintVisible(true);
  setBusy(container, true);
  startLoadingStatusPolling(append ? 'Loading more articles' : 'Loading articles');

  setFeedLoadingPct(0);

  if (!append && !hasExistingFeed && !hasPrefetch) {
    container.innerHTML = '';
    showSkeletonCards(container);
  }

  let gotArticles = false;
  try {
    let articles;
    let featured = null;

    if (append) {
      if (hasPrefetch) {
        setFeedLoadingPct(85);
        articles = await consumePrefetch();
      } else {
        articles = await fetchFeedBatch(lang, BATCH_SIZE, setFeedLoadingPct);
      }
    } else if (hasPrefetch) {
      setFeedLoadingPct(85);
      [articles, featured] = await Promise.all([
        consumePrefetch(),
        getFeaturedCard(lang).catch(() => null),
      ]);
    } else {
      [articles, featured] = await Promise.all([
        fetchFeedBatch(lang, BATCH_SIZE, setFeedLoadingPct),
        getFeaturedCard(lang).catch(() => null),
      ]);
    }

    setFeedLoadingPct(100);

    // Last-resort: if engine returned nothing, fall back to a small raw-random batch.
    // Kept small to avoid bursting over Wikimedia's per-minute caps.
    if (articles.length === 0) {
      try {
        const { fetchRandomTitles, fetchSummaryBatch } = await import('./wiki.js');
        articles = await fetchSummaryBatch(await fetchRandomTitles(10, lang), lang, {
          includeCategories: false,
          onChunkProgress: ({ chunkIndex, totalChunks }) => {
            setFeedLoadingPct(10 + Math.round(((chunkIndex + 1) / totalChunks) * 88));
          },
        });
      } catch { /* stay empty */ }
    }

    gotArticles = articles.length > 0;

    if (!gotArticles) {
      // Self-heal: history grew so large that every random title is filtered out.
      // Trim the oldest seen titles (keep most recent 50) so future loads have room.
      if (!_didSeenRecovery) {
        const history = Storage.getHistory();
        const seenLen = (history.seenTitles || []).length;
        if (seenLen > 50) {
          _didSeenRecovery = true;
          Storage.setHistory({ seenTitles: (history.seenTitles || []).slice(0, 50) });
          showToast('Refreshing your feed history…', 'info');
          if (loadMoreBtn) setButtonLoading(loadMoreBtn, false, 'Load more articles');
          setFeedHintVisible(false);
          setFeedLoadingPct(0);
          stopLoadingStatusPolling();
          setBusy(container, false);
          isLoading = false;
          return loadFeed(append);
        }
      }
      if (!append && !hasExistingFeed) { removeSkeletonCards(container); showEmptyState(container); }
      if (!append && hasExistingFeed) showToast('No new articles right now - pull to refresh', 'info');
      if (append) showEndOfFeed(container);
    } else {
      if (!append) {
        // Atomic swap to prevent blank flash on reload.
        removeSkeletonCards(container);
        container.innerHTML = '';
        if (featured) container.appendChild(createCard(featured, true));
        appendUniqueArticles(container, articles);
      } else {
        appendUniqueArticles(container, articles);
      }
    }
    if (!append) showWelcomeBack();
  } catch (err) {
    if (!append && !hasExistingFeed) { removeSkeletonCards(container); showErrorState(container); }
    if (!append && hasExistingFeed) showToast('Reload failed - keeping current feed', 'error');
    if (!append) showWelcomeBack();
    console.error('Feed load error:', err);
    setFeedHintVisible(false);
    setFeedLoadingPct(0);
  }

  stopLoadingStatusPolling();
  if (loadMoreBtn) setButtonLoading(loadMoreBtn, false, 'Load more articles');
  setFeedHintVisible(false);
  setFeedLoadingPct(0);
  setBusy(container, false);
  if (loadingLabel) loadingLabel.textContent = _loadingLabelDefault;
  snapshotFeedSession();

  // If Wikimedia asked us to slow down, pause auto-loading and prefetch quietly.
  const tailBackoffMs = getApiBackoffRemainingMs();
  if (tailBackoffMs > 0) {
    setTimeout(() => {
      if (!isLoading) {
        attachScrollSentinel();
        attachPrefetchSentinel();
        startPrefetch(lang);
      }
    }, tailBackoffMs + 200);
    return;
  }

  // Attach new sentinel AFTER loading is fully done
  attachScrollSentinel();
  attachPrefetchSentinel();

  // Start prefetching the NEXT batch in the background - only one at a time
  startPrefetch(lang);

  if (gotArticles) scheduleUnderfillIfShort();

}

/** When there are cards but not enough vertical content to scroll, load another batch automatically. */
function scheduleUnderfillIfShort() {
  if (_underfillChain >= UNDERFILL_MAX_CHAIN) return;
  window.requestAnimationFrame(() => {
    setTimeout(() => {
      if (isLoading) return;
      const wrap = document.getElementById('feed-cards');
      if (!wrap?.querySelector('.card')) return;
      // Require a meaningful underfill (more than 1.4x viewport) so we don't chain on
      // pages that are "almost full" - those should rely on real user scrolling.
      const shortPage = document.documentElement.scrollHeight < window.innerHeight * 1.4;
      if (!shortPage) {
        _underfillChain = 0;
        return;
      }
      _underfillChain++;
      loadFeed(true);
    }, 280);
  });
}

function attachScrollSentinel() {
  const container = document.getElementById('feed-cards');
  if (!container) return;

  container.querySelector('.scroll-sentinel')?.remove();
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }

  const cards = container.querySelectorAll('.card');
  if (cards.length === 0) return;

  /* Sentinel sits very near the bottom - auto-load only fires once it actually
   * scrolls into view, never on initial attachment. */
  const back       = Math.min(SENTINEL_FROM_END, cards.length - 1);
  const targetCard = cards[cards.length - 1 - back];
  const sentinel   = document.createElement('div');
  sentinel.className  = 'scroll-sentinel';
  sentinel.style.cssText = 'height:1px;pointer-events:none;';
  targetCard.insertAdjacentElement('afterend', sentinel);

  /* Two-phase arming: the observer must first see the sentinel as
   * NOT intersecting (i.e. still off-screen), then the next intersection
   * triggers a load. This prevents fire-on-attach loops when the sentinel
   * happens to be inside the rootMargin trigger zone right after a load. */
  let armed = false;

  setTimeout(() => {
    if (isLoading) return;
    scrollObserver = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries[0].isIntersecting;

        if (!armed) {
          if (!isIntersecting) armed = true;
          return;
        }

        if (!isIntersecting || isLoading) return;

        const now = Date.now();
        if (now - _lastAutoLoadAt < AUTOLOAD_COOLDOWN_MS) return;
        _lastAutoLoadAt = now;

        loadFeed(true);
      },
      {
        root: null,
        rootMargin: `0px 0px ${INFINITE_SCROLL_ROOT_MARGIN_PX}px 0px`,
        threshold: 0,
      },
    );
    scrollObserver.observe(sentinel);
  }, 120);
}

/** Place a higher sentinel that triggers prefetching well before the load sentinel.
 *  This ensures the next batch is being fetched while the user is still reading. */
function attachPrefetchSentinel() {
  const container = document.getElementById('feed-cards');
  if (!container) return;

  container.querySelector('.prefetch-sentinel')?.remove();
  if (prefetchObserver) { prefetchObserver.disconnect(); prefetchObserver = null; }

  const cards = container.querySelectorAll('.card');
  if (cards.length === 0) return;

  const back       = Math.min(PREFETCH_FROM_END, cards.length - 1);
  const targetCard = cards[cards.length - 1 - back];
  const sentinel   = document.createElement('div');
  sentinel.className  = 'prefetch-sentinel';
  sentinel.style.cssText = 'height:1px;pointer-events:none;';
  targetCard.insertAdjacentElement('afterend', sentinel);

  const lang = Storage.getPrefs().wikiLang || 'en';
  let armed = false;

  setTimeout(() => {
    if (isLoading) return;
    prefetchObserver = new IntersectionObserver(
      (entries) => {
        const isIntersecting = entries[0].isIntersecting;

        if (!armed) {
          if (!isIntersecting) armed = true;
          return;
        }

        if (!isIntersecting || isLoading) return;

        startPrefetch(lang);
      },
      {
        root: null,
        rootMargin: `0px 0px ${PREFETCH_ROOT_MARGIN_PX}px 0px`,
        threshold: 0,
      },
    );
    prefetchObserver.observe(sentinel);
  }, 120);
}

function showEndOfFeed(container) {
  container.querySelector('.end-of-feed')?.remove();
  const el = document.createElement('div');
  el.className = 'end-of-feed';
  el.innerHTML = `
    <p>You're all caught up.</p>
    <button class="btn-secondary" id="end-of-feed-retry">Find more articles</button>
  `;
  container.appendChild(el);
  el.querySelector('#end-of-feed-retry')?.addEventListener('click', () => {
    el.remove();
    const history = Storage.getHistory();
    Storage.setHistory({ seenTitles: (history.seenTitles || []).slice(0, 30) });
    _didSeenRecovery = false;
    loadFeed(true);
  });
}

function showEmptyState(container) {
  container.innerHTML = stateBox({
    icon: ICONS.inbox,
    title: 'No articles found',
    body: 'Wikipedia may be temporarily unreachable, or you\'ve seen all available articles in your feed.',
    action: { label: 'Try again', action: 'retry-feed' },
  });
}

function showErrorState(container) {
  container.innerHTML = stateBox({
    icon: ICONS.alertCircle,
    title: 'Couldn\'t load articles',
    body: 'Check your internet connection and try again. Make sure you\'re opening this via a web server, not directly from a file.',
    action: { label: 'Try again', action: 'retry-feed' },
  });
}

// ===== Auth Modal =====

function resetPasswordVisibility() {
  const passwordInput = document.getElementById('auth-password');
  const passwordToggle = document.getElementById('password-toggle');
  if (passwordInput) passwordInput.type = 'password';
  if (passwordToggle) {
    passwordToggle.setAttribute('aria-label', 'Show password');
    passwordToggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
}

let _authTrigger = null;

function openAuthModal(mode = 'signin') {
  const overlay = document.getElementById('auth-modal-overlay');
  if (overlay) {
    _authTrigger = document.activeElement;
    overlay.classList.add('open');
    resetPasswordVisibility();
    setAuthModalMode(mode);
    setTimeout(() => document.getElementById('auth-email')?.focus(), 0);
  }
}

function closeAuthModal() {
  const overlay = document.getElementById('auth-modal-overlay');
  if (overlay) overlay.classList.remove('open');
  const trigger = _authTrigger;
  _authTrigger = null;
  trigger?.focus?.();
}

function setAuthModalMode(mode) {
  const title = document.getElementById('auth-modal-title');
  const subtitle = document.getElementById('auth-modal-subtitle');
  const submitBtn = document.getElementById('auth-submit-btn');
  const switchText = document.getElementById('auth-switch-text');
  const switchLink = document.getElementById('auth-switch-link');
  const form = document.getElementById('auth-form');

  if (!form) return;
  form.dataset.mode = mode;

  const displayNameGroup = document.getElementById('auth-display-name-group');
  const displayNameInput = document.getElementById('auth-display-name');
  const passwordInput = document.getElementById('auth-password');

  if (mode === 'signin') {
    if (title) title.textContent = 'Sign in';
    if (subtitle) subtitle.textContent = 'Sync your preferences across devices';
    if (submitBtn) setButtonLabel(submitBtn, 'Sign in');
    if (switchText) switchText.textContent = "Don't have an account?";
    if (switchLink) switchLink.textContent = 'Sign up';
    if (displayNameGroup) displayNameGroup.hidden = true;
    if (displayNameInput) displayNameInput.required = false;
    if (passwordInput) passwordInput.autocomplete = 'current-password';
    const forgotLink = document.getElementById('forgot-password-link');
    if (forgotLink) forgotLink.hidden = false;
  } else {
    if (title) title.textContent = 'Create account';
    if (subtitle) subtitle.textContent = 'Your feed stays on your device - this just syncs preferences';
    if (submitBtn) setButtonLabel(submitBtn, 'Create account');
    if (switchText) switchText.textContent = 'Already have an account?';
    if (switchLink) switchLink.textContent = 'Sign in';
    if (displayNameGroup) displayNameGroup.hidden = false;
    if (displayNameInput) displayNameInput.required = true;
    if (passwordInput) passwordInput.autocomplete = 'new-password';
    const forgotLink = document.getElementById('forgot-password-link');
    if (forgotLink) forgotLink.hidden = true;
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const mode = form.dataset.mode;
  const email = document.getElementById('auth-email')?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  const displayName = document.getElementById('auth-display-name')?.value?.trim();
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit-btn');

  if (!email || !password) return;
  if (mode === 'signup' && (!displayName || displayName.length < 2)) {
    if (errorEl) {
      errorEl.textContent = 'Display name must be at least 2 characters';
      errorEl.classList.add('visible');
    }
    return;
  }

  if (errorEl) errorEl.classList.remove('visible');
  setButtonLoading(submitBtn, true);

  try {
    const { signIn, signUp } = await import('./auth.js');
    if (mode === 'signin') {
      await signIn(email, password);
    } else {
      await signUp(email, password, displayName);
    }
    closeAuthModal();
    showToast(mode === 'signin' ? 'Signed in successfully' : 'Account created - welcome!', 'success');
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || 'Something went wrong';
      errorEl.classList.add('visible');
    }
  } finally {
    setButtonLoading(submitBtn, false);
    if (submitBtn) setAuthModalMode(mode);
  }
}

// ===== Lightbox =====

function initLightbox() {
  const lb        = document.getElementById('lightbox');
  const lbImg     = document.getElementById('lightbox-img');
  const lbCaption = document.getElementById('lightbox-caption');
  const lbClose   = document.getElementById('lightbox-close');
  const lbDl      = document.getElementById('lightbox-download');
  if (!lb) return;

  let currentSrc = '';
  let _lightboxTrigger = null;

  function openLightbox(src, alt) {
    currentSrc = src;
    _lightboxTrigger = document.activeElement;
    lbImg.src = src;
    lbImg.alt = alt;
    if (lbCaption) lbCaption.textContent = alt;
    lb.classList.add('open');
    lbClose?.focus();

    const g = gsap();
    if (g) {
      g.fromTo(lb,     { opacity: 0 },          { opacity: 1, duration: 0.22, ease: 'power2.out' });
      g.fromTo(lbImg,  { scale: 0.92, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.28, ease: 'back.out(1.4)' });
    }
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    const g = gsap();
    const done = () => {
      lb.classList.remove('open');
      lbImg.src = '';
      currentSrc = '';
      document.body.style.overflow = '';
      const trigger = _lightboxTrigger;
      _lightboxTrigger = null;
      trigger?.focus?.();
    };
    if (g) {
      g.to(lb, { opacity: 0, duration: 0.18, ease: 'power2.in', onComplete: done });
    } else {
      done();
    }
  }

  lbClose?.addEventListener('click', closeLightbox);
  // Close when clicking the dimmed area (not the image, toolbar, or close button)
  lb.addEventListener('click', (e) => {
    if (
      e.target.closest('#lightbox-img')
      || e.target.closest('#lightbox-close')
      || e.target.closest('#lightbox-toolbar')
    ) {
      return;
    }
    closeLightbox();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lb.classList.contains('open')) closeLightbox(); });

  // ── Drag-to-close on mobile ──────────────────────────────────────────────
  let dragStartY = 0;
  let dragCurrentY = 0;
  let isDragging = false;
  const DISMISS_THRESHOLD = 120; // px down to auto-dismiss
  const VELOCITY_THRESHOLD = 0.6; // px/ms - fast flick also dismisses

  function resetDragState() {
    isDragging = false;
    dragStartY = 0;
    dragCurrentY = 0;
    lbImg.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    lbImg.style.transform = '';
    lbImg.style.opacity = '';
    setTimeout(() => { lbImg.style.transition = ''; }, 260);
  }

  lb.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    isDragging = true;
    dragStartY = e.touches[0].clientY;
    dragCurrentY = dragStartY;
    lbImg.style.transition = 'none';
  }, { passive: true });

  lb.addEventListener('touchmove', e => {
    if (!isDragging || e.touches.length !== 1) return;
    dragCurrentY = e.touches[0].clientY;
    const dy = Math.max(0, dragCurrentY - dragStartY); // only allow downward drag
    const progress = Math.min(dy / DISMISS_THRESHOLD, 1);
    lbImg.style.transform = `translateY(${dy}px) scale(${1 - progress * 0.08})`;
    lbImg.style.opacity = `${1 - progress * 0.5}`;
    lb.style.background = `rgba(0,0,0,${0.92 - progress * 0.5})`;
  }, { passive: true });

  lb.addEventListener('touchend', e => {
    if (!isDragging) return;
    const dy = dragCurrentY - dragStartY;
    const dt = e.timeStamp - (lb._touchStartTime || e.timeStamp);
    const velocity = dt > 0 ? dy / dt : 0;
    const shouldDismiss = dy > DISMISS_THRESHOLD || (dy > 40 && velocity > VELOCITY_THRESHOLD);

    if (shouldDismiss) {
      const g = gsap();
      if (g) {
        g.to(lbImg, { y: window.innerHeight, opacity: 0, duration: 0.22, ease: 'power2.in', onComplete: () => {
          lb.classList.remove('open');
          lb.style.background = '';
          lbImg.src = '';
          lbImg.style.transform = '';
          lbImg.style.opacity = '';
          currentSrc = '';
          document.body.style.overflow = '';
        }});
      } else {
        closeLightbox();
      }
    } else {
      // Snap back
      resetDragState();
      lb.style.background = '';
    }
    isDragging = false;
  });

  lb.addEventListener('touchstart', e => { lb._touchStartTime = e.timeStamp; }, { passive: true });

  // Download - fetch as blob to force save dialog (bypasses cross-origin restriction)
  lbDl?.addEventListener('click', async () => {
    if (!currentSrc) return;
    lbDl.classList.add('loading');
    lbDl.textContent = 'Downloading…';
    try {
      const res  = await fetch(currentSrc);
      const blob = await res.blob();
      const ext  = blob.type.split('/')[1]?.split(';')[0] || 'jpg';
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `qwikipedia-image.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast('Download failed - try right-clicking the image', 'error');
    } finally {
      lbDl.classList.remove('loading');
      lbDl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg> Download`;
    }
  });

  // Delegate click on any .card-image-wrap img
  document.getElementById('feed-cards')?.addEventListener('click', e => {
    const img = e.target.closest('.card-image-wrap img');
    if (img) openLightbox(img.src, img.alt);
  });
}

// ===== Onboarding =====

const INTEREST_OPTIONS = [
  { id: 'science',    label: 'Science',    icon: ICONS.microscope },
  { id: 'history',    label: 'History',    icon: ICONS.landmark },
  { id: 'technology', label: 'Technology', icon: ICONS.cpu },
  { id: 'arts',       label: 'Arts',       icon: ICONS.palette },
  { id: 'geography',  label: 'Geography',  icon: ICONS.map },
  { id: 'people',     label: 'People',     icon: ICONS.users },
  { id: 'nature',     label: 'Nature',     icon: ICONS.leaf },
  { id: 'society',    label: 'Society',    icon: ICONS.building2 },
  { id: 'sports',     label: 'Sports',     icon: ICONS.trophy },
  { id: 'food',       label: 'Food',       icon: ICONS.utensils },
];

function initOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;

  // Skip if user has already onboarded
  if (localStorage.getItem('sw_onboarded')) {
    overlay.classList.add('hidden');
    return;
  }

  // Inject feature icons from ICONS into the static HTML placeholders
  document.querySelectorAll('[data-feature-icon]').forEach(el => {
    const key = el.dataset.featureIcon;
    if (ICONS[key]) el.innerHTML = ICONS[key];
  });

  // Build interest chips
  const grid = document.getElementById('interest-grid');
  const selected = new Set();

  INTEREST_OPTIONS.forEach(({ id, label, icon }) => {
    const chip = document.createElement('button');
    chip.className = 'interest-chip';
    chip.dataset.topic = id;
    chip.setAttribute('aria-pressed', 'false');
    chip.innerHTML = `<span class="chip-icon">${icon}</span><span>${label}</span><span class="chip-check">${ICONS.check}</span>`;
    chip.addEventListener('click', () => {
      const g = gsap();
      if (selected.has(id)) {
        selected.delete(id);
        chip.classList.remove('selected');
        chip.setAttribute('aria-pressed', 'false');
        if (g) g.to(chip, { scale: 0.95, duration: 0.08, yoyo: true, repeat: 1, ease: 'power1.inOut' });
      } else {
        selected.add(id);
        chip.classList.add('selected');
        chip.setAttribute('aria-pressed', 'true');
        if (g) g.fromTo(chip, { scale: 0.93 }, { scale: 1, duration: 0.2, ease: 'back.out(2)' });
      }
      const nextBtn = document.getElementById('step-2-next');
      if (nextBtn) nextBtn.disabled = selected.size === 0;
    });
    grid.appendChild(chip);
  });

  // Animate chips in on arrival
  const animateChipsIn = () => {
    const g = gsap();
    if (!g) return;
    g.from(grid.children, {
      opacity: 0, scale: 0.85, duration: 0.3,
      stagger: 0.04, ease: 'back.out(1.4)', clearProps: 'all',
    });
  };

  // Step 1 → Step 2 with GSAP slide
  document.getElementById('step-1-next')?.addEventListener('click', () => {
    const step1 = document.getElementById('step-1');
    const step2 = document.getElementById('step-2');
    const g = gsap();

    if (g) {
      g.timeline()
        .to(step1, { opacity: 0, x: -28, duration: 0.22, ease: 'power2.in', onComplete: () => {
          step1.classList.remove('active');
          step2.classList.add('active');
          overlay.scrollTop = 0;
          g.from(step2, { opacity: 0, x: 28, duration: 0.25, ease: 'power2.out', clearProps: 'all' });
          animateChipsIn();
        }});
    } else {
      step1.classList.remove('active');
      step2.classList.add('active');
      overlay.scrollTop = 0;
    }
  });

  // Step 2 → Done with GSAP fade-out overlay
  document.getElementById('step-2-next')?.addEventListener('click', () => {
    if (selected.size === 0) return;

    // Seed engine weights with chosen topics
    const engine = Storage.getEngine();
    const weights = { ...engine.topicWeights };
    selected.forEach(topic => { weights[topic] = (weights[topic] || 0) + 5; });
    Storage.setEngine({ topicWeights: weights });
    Storage.setPrefs({ interests: [...selected] });
    localStorage.setItem('sw_onboarded', '1');
    if (currentUser) scheduleSyncPrefs(currentUser.id);

    const g = gsap();
    if (g) {
      g.to(overlay, { opacity: 0, duration: 0.3, ease: 'power2.in', onComplete: () => {
        overlay.classList.add('hidden');
        overlay.style.opacity = '';
        loadFeed(false);
      }});
    } else {
      overlay.classList.add('hidden');
      loadFeed(false);
    }
  });

  // Animate step 1 in on first load
  const g = gsap();
  if (g) {
    const step1 = document.getElementById('step-1');
    g.from(step1.children, {
      opacity: 0, y: 16, duration: 0.4,
      stagger: 0.07, ease: 'power2.out', clearProps: 'all',
    });
  }
}

// ===== Stats page =====

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function countUp(el, target, duration = 0.8) {
  const g = gsap();
  if (!g || target === 0) { el.textContent = target; return; }
  g.to({ val: 0 }, {
    val: target, duration, ease: 'power2.out',
    onUpdate() { el.textContent = Math.round(this.targets()[0].val); },
  });
}

function renderStatsPage() {
  const totals = Storage.getStats();
  const history = Storage.getHistory();
  const lang = Storage.getPrefs().wikiLang || 'en';
  const engine = Storage.getEngine();

  const sessionTimeSec = Math.floor(getSessionTimeMs() / 1000);
  const totalTimeSec = Math.floor((totals.totalTimeMs + getSessionTimeMs()) / 1000);

  // Stat cards
  const stats = [
    { label: 'Articles seen',      session: _sessionSeen,      total: totals.totalSeen,      icon: ICONS.arrowRight },
    { label: 'Liked',              session: _sessionLiked,     total: totals.totalLiked,     icon: ICONS.heart },
    { label: 'Not interested',     session: _sessionDismissed, total: totals.totalDismissed, icon: ICONS.x },
    { label: 'Time spent (session)', session: null,            total: null,                  timeSession: sessionTimeSec, timeTotal: totalTimeSec, icon: ICONS.refreshCw },
  ];

  const statCardsHtml = stats.map((s, i) => {
    const sessionVal = s.timeSession != null ? formatTime(s.timeSession * 1000) : null;
    const totalVal   = s.timeTotal   != null ? formatTime(s.timeTotal   * 1000) : null;
    return `
      <div class="stat-card">
        <div class="stat-card-icon">${s.icon}</div>
        <div class="stat-card-body">
          <div class="stat-card-label">${s.label}</div>
          <div class="stat-card-values">
            <span class="stat-val" data-stat-session="${i}">${sessionVal ?? (s.session ?? 0)}</span>
            <span class="stat-divider">/</span>
            <span class="stat-total" data-stat-total="${i}">${totalVal ?? (s.total ?? 0)}</span>
            <span class="stat-total-label">total</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Topic weights breakdown
  const weights = engine.topicWeights || {};
  const sorted = Object.entries(weights).sort(([, a], [, b]) => b - a);
  const topTopics    = sorted.filter(([, v]) => v > 0).slice(0, 5);
  const bottomTopics = sorted.filter(([, v]) => v < 0).slice(-5).reverse();

  const topicBar = (topic, weight, max, positive) => {
    const pct = Math.min(Math.abs(weight) / Math.max(Math.abs(max), 1) * 100, 100).toFixed(1);
    return `
      <div class="topic-bar-row">
        <span class="topic-bar-label">${topic}</span>
        <div class="topic-bar-track">
          <div class="topic-bar-fill ${positive ? 'positive' : 'negative'}" style="--bar-w:${pct}%"></div>
        </div>
        <span class="topic-bar-value">${weight > 0 ? '+' : ''}${weight.toFixed(1)}</span>
      </div>
    `;
  };

  const maxTop    = topTopics[0]?.[1]    ?? 1;
  const maxBottom = bottomTopics[0]?.[1] ?? -1;

  const topHtml = topTopics.length
    ? topTopics.map(([t, w]) => topicBar(t, w, maxTop, true)).join('')
    : `<p class="stats-empty-hint">Like some articles to see your top topics</p>`;

  const bottomHtml = bottomTopics.length
    ? bottomTopics.map(([t, w]) => topicBar(t, w, maxBottom, false)).join('')
    : `<p class="stats-empty-hint">Mark articles as "not interested" to see avoided topics</p>`;

  // Liked posts list - each row has an unlike button
  const likedHtml = history.likedTitles.length
    ? history.likedTitles.slice(0, 50).map(title => `
        <div class="liked-post-row" data-title="${escapeAttr(title)}">
          <a class="liked-post-link" href="https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}" target="_blank" rel="noopener">
            <span class="liked-post-title">${escapeHtml(title)}</span>
            ${ICONS.externalLink}
          </a>
          <button class="unlike-btn" data-unlike="${escapeAttr(title)}" aria-label="Unlike ${escapeAttr(title)}" title="Unlike">
            ${ICONS.heartFilled}
          </button>
        </div>
      `).join('')
    : `<p class="stats-empty-hint">Articles you like will appear here</p>`;

  const container = document.getElementById('stats-content');
  if (!container) return;

  container.innerHTML = `
    <div class="stats-grid">${statCardsHtml}</div>

    <div class="settings-section">
      <div class="settings-section-header">Top topics</div>
      <div class="topic-bars-wrap">${topHtml}</div>
    </div>

    <div class="settings-section">
      <div class="settings-section-header">Avoided topics</div>
      <div class="topic-bars-wrap">${bottomHtml}</div>
    </div>

    <div class="settings-section">
      <div class="settings-section-header">
        Liked articles <span class="stats-count-badge">${history.likedTitles.length}</span>
      </div>
      ${history.likedTitles.length ? `<p class="stats-section-sub">Tap the heart to unlike an article</p>` : ''}
      <div class="liked-posts-list">${likedHtml}</div>
    </div>
  `;

  // Count-up animation for numeric stats
  container.querySelectorAll('[data-stat-session]').forEach(el => {
    const i = Number(el.dataset.statSession);
    if (stats[i].session != null) countUp(el, stats[i].session);
  });
  container.querySelectorAll('[data-stat-total]').forEach(el => {
    const i = Number(el.dataset.statTotal);
    if (stats[i].total != null) countUp(el, stats[i].total, 1.0);
  });

  // Animate topic bars in
  const g = gsap();
  if (g) {
    g.from(container.querySelectorAll('.stat-card'), {
      opacity: 0, y: 10, duration: 0.3, stagger: 0.07, ease: 'power2.out', clearProps: 'all',
    });
    g.from(container.querySelectorAll('.topic-bar-fill'), {
      width: 0, duration: 0.6, stagger: 0.05, ease: 'power2.out', delay: 0.2,
    });
  }
}

// ===== Saved page =====

function renderSavedPage() {
  const container = document.getElementById('saved-content');
  if (!container) return;
  const { savedTitles, savedArticles } = Storage.getHistory();
  if (!savedTitles.length) {
    container.innerHTML = stateBox({
      icon: ICONS.bookmark,
      title: 'No saved articles yet',
      body: 'Tap the bookmark icon on any card to save it here.',
    });
    return;
  }
  const lang = Storage.getPrefs().wikiLang || 'en';
  container.innerHTML = `
    <div class="likes-toolbar">
      <span class="saved-count">${savedTitles.length} saved</span>
      <button class="btn-secondary likes-clear-btn" id="saved-clear-btn" type="button">Clear all</button>
    </div>
    <div class="likes-feed" id="saved-feed">
      ${savedTitles.slice(0, 50).map(title => {
        const article = savedArticles.find(a => a?.title === title);
        return renderSavedCardHtml(title, article, lang);
      }).join('')}
    </div>
  `;
  document.getElementById('saved-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('Remove all saved articles?')) return;
    Storage.setHistory({ savedTitles: [], savedArticles: [] });
    showToast('Cleared all saved articles', 'info');
    if (currentUser) scheduleSyncPrefs(currentUser.id, 0);
    renderSavedPage();
  });
  document.getElementById('saved-feed')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-unsave-title]');
    if (!btn) return;
    const title = btn.dataset.unsaveTitle;
    Storage.removeSaved(title);
    showToast('Removed from saved', 'info');
    if (currentUser) scheduleSyncPrefs(currentUser.id);
    renderSavedPage();
  });
}

function renderSavedCardHtml(title, article, lang) {
  const safeTitle = escapeHtml(title);
  const url = article?.url || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  const display = article?.displayTitle || article?.title || title;
  const image = article?.image;
  const extract = article?.extract;
  const initial = escapeHtml((display || title || '?').trim().charAt(0).toUpperCase());
  const thumb = image
    ? `<div class="like-card-thumb" style="--thumb-image:url('${escapeAttr(image)}')" aria-hidden="true"></div>`
    : `<div class="like-card-thumb no-image" aria-hidden="true">${initial}</div>`;
  return `
    <div class="like-card">
      ${thumb}
      <div class="like-card-body">
        <a class="like-card-title" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(display)}</a>
        <p class="like-card-extract">${extract ? escapeHtml(extract) : ''}</p>
        <div class="like-card-actions">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${ICONS.externalLink || ''} Open</a>
          <button type="button" class="like-unlike-btn" data-unsave-title="${safeTitle}" aria-label="Unsave ${safeTitle}">${ICONS.bookmarkFilled || ''} Unsave</button>
        </div>
      </div>
    </div>
  `;
}

// ===== Pull-to-refresh =====

function initPullToRefresh() {
  const indicator = document.getElementById('ptr-indicator');
  const feedContainer = document.getElementById('feed-page');
  const spinnerWrap = indicator?.querySelector('.ptr-spinner-wrap');
  if (spinnerWrap) spinnerWrap.innerHTML = ICONS.refreshCw;
  usePullToRefresh({
    container: feedContainer,
    indicator,
    isLoading: () => isLoading,
    canStart: () => window.scrollY <= 0,
    onRefresh: async () => {
      await loadFeed(false);
      showToast('Feed refreshed', 'info');
    },
  });
}

// ===== Mobile bottom-nav scroll-hide =====
/**
 * Hides the bottom nav while the user is scrolling down past a small threshold,
 * brings it back on any upward scroll. Only active when nav is in bottom-bar mode
 * (matchMedia matches the same breakpoint as the CSS).
 */
function initScrollHideNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;

  const mql = window.matchMedia('(max-width: 768px)');
  let lastY = window.scrollY;
  let ticking = false;
  const SHOW_NEAR_TOP_PX = 80;
  const HIDE_AFTER_PX    = 24;

  function update() {
    ticking = false;
    if (!mql.matches) {
      nav.classList.remove('nav-hidden');
      return;
    }
    const y = window.scrollY;
    const dy = y - lastY;

    if (y < SHOW_NEAR_TOP_PX) {
      nav.classList.remove('nav-hidden');
    } else if (dy > HIDE_AFTER_PX) {
      nav.classList.add('nav-hidden');
      lastY = y;
    } else if (dy < -HIDE_AFTER_PX) {
      nav.classList.remove('nav-hidden');
      lastY = y;
    }
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });

  // Always show on viewport resize / breakpoint flip
  mql.addEventListener?.('change', () => nav.classList.remove('nav-hidden'));
}

// ===== Init =====

async function init() {
  // Apply stored prefs immediately (before anything renders)
  const prefs = Storage.getPrefs();
  applyTheme(prefs.theme);
  applyTextScale(prefs.textScale);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register(`${new URL('./sw.js', import.meta.url)}`).catch(() => {});
  }

  // Expose helpers for data-action delegation
  window.openAuthModal = openAuthModal;
  window.showPage = showPage;
  window.reloadFeed = () => {
    if (isLoading) return;
    clearApiBackoff();
    _prefetchPromise = null;
    _prefetchLang = null;
    return loadFeed(false);
  };
  bindAppActions();

  // Nav routing (page buttons)
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      await goToPage(btn.dataset.page);
    });
  });

  document.querySelectorAll('.quick-action-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => goToPage(btn.dataset.page));
  });

  document.getElementById('quick-refresh-btn')?.addEventListener('click', () => {
    window.reloadFeed?.();
  });

  document.querySelectorAll('.app-footer a[data-page]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      goToPage(link.dataset.page);
      window.scrollTo(0, 0);
    });
  });

  document.getElementById('footer-signin-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (currentUser) {
      await goToPage('account-page');
      window.scrollTo(0, 0);
    } else {
      openAuthModal('signin');
    }
  });

  // Logo: go to feed if on another page, or reload feed if already there
  document.getElementById('nav-logo')?.addEventListener('click', (e) => {
    e.preventDefault();
    const feedPage = document.getElementById('feed-page');
    if (feedPage?.classList.contains('active')) {
      loadFeed(false);
    } else {
      showPage('feed-page');
    }
  });

  // Auth modal controls
  document.getElementById('auth-modal-close')?.addEventListener('click', closeAuthModal);
  document.getElementById('auth-modal-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAuthModal();
  });
  document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('auth-modal-overlay');
    if (!overlay?.classList.contains('open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAuthModal();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hidden && !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  document.getElementById('auth-form')?.addEventListener('submit', handleAuthSubmit);
  document.getElementById('auth-switch-link')?.addEventListener('click', () => {
    const form = document.getElementById('auth-form');
    setAuthModalMode(form?.dataset.mode === 'signin' ? 'signup' : 'signin');
  });

  const passwordToggle = document.getElementById('password-toggle');
  const passwordInput = document.getElementById('auth-password');
  passwordToggle?.addEventListener('click', () => {
    if (!passwordInput) return;
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    passwordToggle.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
    passwordToggle.innerHTML = isPassword
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  });

  document.getElementById('forgot-password-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email')?.value?.trim();
    if (!email || !email.includes('@')) {
      showToast('Enter your email first', 'info');
      return;
    }
    try {
      const { sendPasswordReset } = await import('./auth.js');
      await sendPasswordReset(email);
      showToast('Password reset email sent - check your inbox', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not send reset email', 'error');
    }
  });

  window.addEventListener('hashchange', async () => {
    if (location.hash === ACCOUNT_HASH) {
      showPage('account-page');
      const { renderAccountPage } = await import('./account.js');
      renderAccountPage();
    } else if (document.getElementById('account-page')?.classList.contains('active')) {
      showPage('feed-page');
    }
  });

  // Account button: go to Settings (account section) when signed in, else open auth modal
  document.getElementById('nav-login-btn')?.addEventListener('click', async () => {
    const { getCurrentUser } = await import('./auth.js');
    const user = await getCurrentUser();
    if (user) {
      showPage('account-page');
      const { renderAccountPage } = await import('./account.js');
      renderAccountPage();
    } else {
      openAuthModal('signin');
    }
  });

  // Load more
  document.getElementById('load-more-btn')?.addEventListener('click', () => loadFeed(true));

  // Search - submit on button click or Enter key
  document.getElementById('search-submit-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('search-submit-btn');
    const { renderSearchPage, doSearch } = await import('./search.js');
    const input = document.getElementById('search-input');
    setButtonLoading(btn, true);
    try {
      if (input?.value?.trim()) await doSearch(input.value.trim());
      else await renderSearchPage();
    } finally {
      setButtonLoading(btn, false);
    }
  });
  document.getElementById('search-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('search-submit-btn')?.click();
    }
  });

  // Settings page
  initSettings();

  // Auth state listener - pull prefs on login, push local prefs on first sign-up
  let _accountRendering = false;
  let _cacheWarmed = false;
  onAuthStateChange(async user => {
    const wasSignedIn = !!currentUser;
    currentUser = user;
    updateNavUser(user);

    // Sync the cache userId so wiki.js stores fetched articles in Supabase
    setCacheUserId(user?.id || null);

    if (user) {
      try {
        const profile = await pullPrefsFromCloud(user.id);

        // Apply pulled prefs to the live UI
        const refreshedPrefs = Storage.getPrefs();
        applyTheme(refreshedPrefs.theme);
        applyTextScale(refreshedPrefs.textScale);
        refreshInterests();

        // Reflect pulled language in the selector and reload the feed if it changed
        const langSelect = document.getElementById('wiki-lang-select');
        if (langSelect && refreshedPrefs.wikiLang && langSelect.value !== refreshedPrefs.wikiLang) {
          langSelect.value = refreshedPrefs.wikiLang;
          window.reloadFeed?.();
        }

        // Push merged local + cloud state so likes, saved, AI toggle, and algo stay in sync
        await syncPrefsToCloud(user.id).catch(() => {});

        if (!wasSignedIn) showToast('Account synced', 'info');

        // Warm the Supabase article cache in the background (once per session)
        if (!_cacheWarmed && hasCacheClient()) {
          _cacheWarmed = true;
          const lang = refreshedPrefs.wikiLang || 'en';
          warmArticleCache(user.id, lang).catch(() => {});
          pruneStaleCache(user.id, lang).catch(() => {});
        }
      } catch {}
    } else {
      _cacheWarmed = false;
    }

    // Bad or stale feed restore (e.g. old { title }-only cache): refill from API
    const feedEl = document.getElementById('feed-cards');
    if (feedEl && localStorage.getItem('sw_onboarded')) {
      const cards = feedEl.querySelectorAll('.card');
      const allGhost = cards.length > 0 && [...cards].every(c => !(c.querySelector('.card-title')?.textContent?.trim()));
      if (allGhost) {
        try {
          sessionStorage.removeItem(FEED_SESSION_CACHE_KEY);
          localStorage.removeItem(FEED_PERSISTED_CACHE_KEY);
        } catch {}
        loadFeed(false);
      }
    }

    const { renderAccountSection, renderLikesSection } = await import('./settings.js');
    const { renderAccountPage } = await import('./account.js');
    renderAccountSection();
    renderLikesSection();
    if (!_accountRendering) {
      _accountRendering = true;
      renderAccountPage().finally(() => { _accountRendering = false; });
    }
  });

  // Handle page lifecycle - persist state without reloading
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushSessionTime();
      snapshotFeedSession();
      if (currentUser) scheduleSyncPrefs(currentUser.id, 0);
    }
  });
  window.addEventListener('pagehide', () => {
    flushSessionTime();
    snapshotFeedSession();
    if (currentUser) scheduleSyncPrefs(currentUser.id, 0);
  });

  // Restore from bfcache without re-fetching everything
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      const feedCards = document.getElementById('feed-cards');
      if (feedCards && !feedCards.querySelector('.card')) {
        const restored = restoreFeedSession(feedCards);
        if (!restored) {
          const lang = Storage.getPrefs().wikiLang || 'en';
          const cached = getCachedArticles(lang, 8);
          if (cached.length >= 2) {
            renderCachedThenRefresh(feedCards, cached, lang);
          }
        }
      }
    }
  });

  // Lightbox
  initLightbox();

  // Click-to-expand delegation for card extracts
  initExtractClickDelegation();

  document.getElementById('stats-content')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-unlike]');
    if (!btn) return;
    const title = btn.dataset.unlike;
    const row = btn.closest('.liked-post-row');
    const g = window.gsap || null;

    const doRemove = () => {
      Storage.removeLiked(title);
      const eng = Storage.getEngine();
      const weights = { ...eng.topicWeights };
      Storage.setEngine({ topicWeights: weights });
      if (currentUser) scheduleSyncPrefs(currentUser.id);
      showToast(`Unliked "${title}"`, 'info');
      renderStatsPage();
    };

    if (g && row) {
      g.to(row, { opacity: 0, x: 20, duration: 0.2, ease: 'power2.in', onComplete: doRemove });
    } else {
      doRemove();
    }
  });

  // Pull-to-refresh
  initPullToRefresh();

  // Hide bottom nav on scroll-down (mobile only)
  initScrollHideNav();

  // Onboarding (must come before loadFeed)
  initOnboarding();

  // Apply session decay at start of each session
  applyDecay();

  // Start the feed
  const initialPage = isAccountRoute() ? 'account-page' : 'feed-page';
  showPage(initialPage);
  if (initialPage === 'account-page') {
    const { renderAccountPage } = await import('./account.js');
    renderAccountPage();
  }
  // Only auto-load feed if onboarding is already done
  if (localStorage.getItem('sw_onboarded')) {
    const restored = restoreFeedSession(document.getElementById('feed-cards'));
    if (!restored) await loadFeed(false);
    else startPrefetch(Storage.getPrefs().wikiLang || 'en');
  }
}

function updateNavUser(user) {
  const loginBtn = document.getElementById('nav-login-btn');
  if (user) {
    if (loginBtn) {
      loginBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span class="nav-tooltip">Account</span>`;
      loginBtn.setAttribute('aria-label', 'Account');
    }
    const footerSignin = document.getElementById('footer-signin-link');
    if (footerSignin) footerSignin.textContent = 'Account';
  } else {
    if (loginBtn) {
      loginBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span class="nav-tooltip">Sign in</span>`;
      loginBtn.setAttribute('aria-label', 'Sign in');
    }
    const footerSignin = document.getElementById('footer-signin-link');
    if (footerSignin) footerSignin.textContent = 'Sign In';
  }
}

document.addEventListener('DOMContentLoaded', init);
