// app.js — main bootstrapper, feed rendering, routing

import { Storage } from './storage.js';
import { fetchFeedBatch, getFeaturedCard, recordInteraction, applyDecay, inferTopics } from './engine.js';
import { getApiBackoffRemainingMs, clearApiBackoff, getCachedArticles } from './wiki.js';
import { applyTheme, applyTextScale, initSettings } from './settings.js';
import { onAuthStateChange, pullPrefsFromCloud, scheduleSyncPrefs, syncPrefsToCloud } from './auth.js';
import { showToast } from './toast.js';
import { ICONS } from './icons.js';
import { cleanWikipediaText } from './text-utils.js';
import { usePullToRefresh } from './usePullToRefresh.js';

// GSAP helper — gracefully falls back to no-op if CDN hasn't loaded yet
function gsap() { return window.gsap || null; }

// ===== State =====
let isLoading = false;
let currentUser = null;
let scrollObserver = null;

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

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(id);
  if (page) page.classList.add('active');

  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === id);
  });

  if (id === 'account-page') {
    history.replaceState(null, '', '/account');
  } else if (location.pathname === '/account') {
    history.replaceState(null, '', '/');
  }
}

// ===== Card rendering =====

function createCard(article, featured = false) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.title = article.title;
  const isLiked = Storage.isLiked(article.title);

  const imageHtml = article.image
    ? `<div class="card-image-wrap"><img class="card-image media" src="${escapeAttr(article.image)}" alt="${escapeAttr(article.displayTitle)}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : ``;

  const featuredBadge = featured
    ? `<div class="card-featured-badge">${ICONS.arrowRight} Today's featured article</div>`
    : '';

  el.innerHTML = `
    <div class="card-body">
      ${featuredBadge}
      <h2 class="card-title">${escapeHtml(cleanWikipediaText(article.displayTitle))}</h2>
      <p class="card-extract">${escapeHtml(cleanWikipediaText(article.extract || ''))}</p>
      ${imageHtml}
      <div class="card-actions">
        <a class="card-read-link" href="${escapeAttr(article.url)}" target="_blank" rel="noopener" aria-label="Read on Wikipedia">
          ${ICONS.externalLink} wikipedia.org
        </a>
        <div class="card-icon-group">
          <button class="card-icon-btn btn-dislike" aria-label="Not interested">${ICONS.x}</button>
          <button class="card-icon-btn btn-like ${isLiked ? 'liked' : ''}" aria-label="Like this article">${isLiked ? ICONS.heartFilled : ICONS.heart}</button>
        </div>
      </div>
    </div>
  `;

  const likeBtn = el.querySelector('.btn-like');
  const dislikeBtn = el.querySelector('.btn-dislike');
  const extractEl = el.querySelector('.card-extract');

  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    animateLike(el, likeBtn, article);
  });

  dislikeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    animateDismiss(el, article);
  });

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
  updateNavStats();
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
  updateNavStats();
  if (currentUser) scheduleSyncPrefs(currentUser.id);

  if (g) {
    g.to(cardEl, {
      opacity: 0, x: -20, duration: 0.22, ease: 'power2.in',
      onComplete: () => cardEl.remove(),
    });
  } else {
    cardEl.remove();
  }
}

// ===== Feed loading =====

const BATCH_SIZE       = 8;   // articles rendered per batch (keeps per-load API cost low)
const SENTINEL_FROM_END = 2;  // cards from the very bottom; small so it must scroll into view
const AUTOLOAD_COOLDOWN_MS = 1200;
/** Pre-fetch when sentinel is within this many px below the viewport bottom */
const INFINITE_SCROLL_ROOT_MARGIN_PX = 240;
/** Cap on auto-chained underfill loads after a full reload (prevents short-page loops) */
const UNDERFILL_MAX_CHAIN = 2;
let _underfillChain = 0;

// Single in-flight prefetch promise — prevents duplicate background fetches
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

function setFeedLoadingPct(value) {
  const n = Math.min(100, Math.max(0, Math.round(value)));
  const el = document.getElementById('feed-loading-pct');
  if (el) el.textContent = `${n}%`;
}

function snapshotFeedSession() {
  const cards = [...document.querySelectorAll('#feed-cards .card')];
  const articles = cards.map(card => {
    const title = card.dataset.title;
    const liked = Storage.getLikedState().likedArticles.find(a => a?.title === title);
    return liked || { title };
  }).filter(a => a?.title);
  try {
    const payload = JSON.stringify({ ts: Date.now(), articles });
    sessionStorage.setItem(FEED_SESSION_CACHE_KEY, payload);
    localStorage.setItem(FEED_PERSISTED_CACHE_KEY, payload);
  } catch {}
}

function restoreFeedSession(container) {
  try {
    const raw = sessionStorage.getItem(FEED_SESSION_CACHE_KEY) || localStorage.getItem(FEED_PERSISTED_CACHE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > 1000 * 60 * 30) return false;
    if (!Array.isArray(parsed.articles) || parsed.articles.length === 0) return false;
    const frag = document.createDocumentFragment();
    const added = new Set();
    parsed.articles.forEach(article => {
      if (!article?.title || added.has(article.title)) return;
      added.add(article.title);
      frag.appendChild(createCard(article));
    });
    container.innerHTML = '';
    container.appendChild(frag);
    attachScrollSentinel();
    return true;
  } catch {
    return false;
  }
}

function appendUniqueArticles(container, articles = []) {
  const onScreen = new Set([...container.querySelectorAll('.card')].map(el => el.dataset.title));
  articles.forEach(a => {
    if (!a?.title || onScreen.has(a.title)) return;
    onScreen.add(a.title);
    Storage.addSeen(a.title);
    container.appendChild(createCard(a));
    Storage.incrementStat('totalSeen');
    _sessionSeen++;
  });
}

let _backoffStatusInterval = null;
let _loadingLabelDefault = 'Loading articles';
function refreshLoadingStatus() {
  const labelEl = document.getElementById('feed-loading-label');
  const hintEl  = document.getElementById('feed-loading-hint');
  if (!labelEl) return;
  const remaining = getApiBackoffRemainingMs();

  // If cards are already on screen, NEVER show an alarming banner —
  // the user already has content; the next load will resume silently.
  if (remaining > 250) {
    const hasCards = !!document.querySelector('#feed-cards .card');
    if (hasCards && hintEl) {
      hintEl.style.display = 'none';
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
  silentBackgroundRefresh(container, lang);
}

/** Paint cached articles immediately, then silently fetch fresh ones and append non-dupes. */
function renderCachedThenRefresh(container, cached, lang) {
  container.innerHTML = '';
  appendUniqueArticles(container, cached);

  // Hide any leftover loading hint — cached articles are visible now.
  const hint = document.getElementById('feed-loading-hint');
  if (hint) hint.style.display = 'none';
  stopLoadingStatusPolling();

  // Infinite scroll armed right away — no waiting
  attachScrollSentinel();

  silentBackgroundRefresh(container, lang);

  // Featured card (silent, no blocking) — also gated on backoff
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

  const container  = document.getElementById('feed-cards');
  const loadMoreBtn = document.getElementById('load-more-btn');
  const loadingHint = document.getElementById('feed-loading-hint');
  const loadingLabel = document.getElementById('feed-loading-label');
  const lang = Storage.getPrefs().wikiLang || 'en';

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
    isLoading = false;
    return;
  }

  if (append && !hasPrefetch && cachedAvailable.length >= 4) {
    appendCachedThenRefresh(container, cachedAvailable, lang);
    isLoading = false;
    return;
  }

  /* ── Backoff guard ──────────────────────────────────────────────────────────
   * Wikipedia is asking us to slow down. If we have ANY cached articles, append
   * them silently. Otherwise just stop — never show the alarm banner over a
   * feed that already has content. The sentinel will re-arm after the backoff
   * window so loading resumes naturally. */
  const backoffMs = getApiBackoffRemainingMs();
  if (backoffMs > 1000) {
    if (cachedAvailable.length > 0) {
      appendCachedThenRefresh(container, cachedAvailable, lang);
      isLoading = false;
      return;
    }
    // No cache to fall back on. If there are already cards on screen, do nothing
    // visible — re-arm the sentinel after the cooldown so scrolling resumes.
    if (hasExistingFeed || append) {
      isLoading = false;
      setTimeout(() => { if (!isLoading) attachScrollSentinel(); }, backoffMs + 250);
      return;
    }
  }

  if (loadMoreBtn) loadMoreBtn.disabled = true;
  if (loadingHint) loadingHint.style.display = '';
  startLoadingStatusPolling(append ? 'Loading more articles' : 'Loading articles');

  setFeedLoadingPct(0);

  if (!append && !hasExistingFeed && !hasPrefetch) container.innerHTML = '';

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
          isLoading = false;
          if (loadMoreBtn) { loadMoreBtn.disabled = false; loadMoreBtn.textContent = 'Load more articles'; }
          if (loadingHint) {
            loadingHint.style.display = 'none';
            setFeedLoadingPct(0);
          }
          stopLoadingStatusPolling();
          return loadFeed(append);
        }
      }
      if (!append && !hasExistingFeed) showEmptyState(container);
      if (!append && hasExistingFeed) showToast('No new articles right now — pull to refresh', 'info');
      if (append) showEndOfFeed(container);
    } else {
      if (!append) {
        // Atomic swap to prevent blank flash on reload.
        container.innerHTML = '';
        if (featured) container.appendChild(createCard(featured, true));
        appendUniqueArticles(container, articles);
      } else {
        appendUniqueArticles(container, articles);
      }
    }
  } catch (err) {
    if (!append && !hasExistingFeed) showErrorState(container);
    if (!append && hasExistingFeed) showToast('Reload failed — keeping current feed', 'error');
    console.error('Feed load error:', err);
    if (loadingHint) {
      loadingHint.style.display = 'none';
      setFeedLoadingPct(0);
    }
  }

  isLoading = false;
  stopLoadingStatusPolling();
  if (loadMoreBtn) { loadMoreBtn.disabled = false; loadMoreBtn.textContent = 'Load more articles'; }
  if (loadingHint) {
    loadingHint.style.display = 'none';
    setFeedLoadingPct(0);
  }
  if (loadingLabel) loadingLabel.textContent = _loadingLabelDefault;
  snapshotFeedSession();

  // If Wikimedia asked us to slow down, pause auto-loading and prefetch quietly.
  const tailBackoffMs = getApiBackoffRemainingMs();
  if (tailBackoffMs > 0) {
    setTimeout(() => {
      if (!isLoading) {
        attachScrollSentinel();
        startPrefetch(lang);
      }
    }, tailBackoffMs + 200);
    return;
  }

  // Attach new sentinel AFTER loading is fully done
  attachScrollSentinel();

  // Start prefetching the NEXT batch in the background — only one at a time
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
      // pages that are "almost full" — those should rely on real user scrolling.
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

  /* Sentinel sits very near the bottom — auto-load only fires once it actually
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
  container.innerHTML = `
    <div class="state-box">
      <div class="state-icon">${ICONS.inbox}</div>
      <h3>No articles found</h3>
      <p>Wikipedia may be temporarily unreachable, or you've seen all available articles in your feed.</p>
      <button class="btn-primary" style="margin-top:16px" onclick="window.reloadFeed?.()">Try again</button>
    </div>
  `;
}

function showErrorState(container) {
  container.innerHTML = `
    <div class="state-box">
      <div class="state-icon">${ICONS.alertCircle}</div>
      <h3>Couldn't load articles</h3>
      <p>Check your internet connection and try again. Make sure you're opening this via a web server, not directly from a file.</p>
      <button class="btn-primary" style="margin-top:16px" onclick="window.reloadFeed?.()">Retry</button>
    </div>
  `;
}

function updateNavStats() {
  // Nav stat display removed; stats are on the Stats page
}

// ===== Auth Modal =====

function openAuthModal(mode = 'signin') {
  const overlay = document.getElementById('auth-modal-overlay');
  if (overlay) {
    overlay.classList.add('open');
    setAuthModalMode(mode);
  }
}

function closeAuthModal() {
  const overlay = document.getElementById('auth-modal-overlay');
  if (overlay) overlay.classList.remove('open');
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

  if (mode === 'signin') {
    if (title) title.textContent = 'Sign in';
    if (subtitle) subtitle.textContent = 'Sync your preferences across devices';
    if (submitBtn) submitBtn.textContent = 'Sign in';
    if (switchText) switchText.textContent = "Don't have an account?";
    if (switchLink) switchLink.textContent = 'Sign up';
  } else {
    if (title) title.textContent = 'Create account';
    if (subtitle) subtitle.textContent = 'Your feed stays on your device — this just syncs preferences';
    if (submitBtn) submitBtn.textContent = 'Create account';
    if (switchText) switchText.textContent = 'Already have an account?';
    if (switchLink) switchLink.textContent = 'Sign in';
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const mode = form.dataset.mode;
  const email = document.getElementById('auth-email')?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit-btn');

  if (!email || !password) return;

  if (errorEl) errorEl.classList.remove('visible');
  if (submitBtn) submitBtn.textContent = 'Please wait…';

  try {
    const { signIn, signUp } = await import('./auth.js');
    if (mode === 'signin') {
      await signIn(email, password);
    } else {
      await signUp(email, password);
    }
    closeAuthModal();
    showToast(mode === 'signin' ? 'Signed in successfully' : 'Account created — welcome!', 'success');
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || 'Something went wrong';
      errorEl.classList.add('visible');
    }
  } finally {
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

  function openLightbox(src, alt) {
    currentSrc = src;
    lbImg.src = src;
    lbImg.alt = alt;
    if (lbCaption) lbCaption.textContent = alt;
    lb.classList.add('open');

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
  const VELOCITY_THRESHOLD = 0.6; // px/ms — fast flick also dismisses

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

  // Download — fetch as blob to force save dialog (bypasses cross-origin restriction)
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
      a.download = `scrollwiki-image.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast('Download failed — try right-clicking the image', 'error');
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
          <div class="topic-bar-fill ${positive ? 'positive' : 'negative'}" style="width:${pct}%"></div>
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

  // Liked posts list — each row has an unlike button
  const likedHtml = history.likedTitles.length
    ? history.likedTitles.slice(0, 50).map(title => `
        <div class="liked-post-row" data-title="${escapeAttr(title)}">
          <a class="liked-post-link" href="https://en.wikipedia.org/wiki/${encodeURIComponent(title)}" target="_blank" rel="noopener">
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

  // Unlike button handler — remove from liked list and re-render
  container.addEventListener('click', e => {
    const btn = e.target.closest('[data-unlike]');
    if (!btn) return;
    const title = btn.dataset.unlike;
    const row = btn.closest('.liked-post-row');
    const g = gsap();

    const doRemove = () => {
      Storage.removeLiked(title);
      // Also nudge the engine weight down slightly
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

  // Expose helpers to window for inline handlers
  window.openAuthModal = openAuthModal;
  window.reloadFeed = () => {
    clearApiBackoff();
    _prefetchPromise = null;
    _prefetchLang = null;
    return loadFeed(false);
  };

  // Nav routing (page buttons)
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const page = btn.dataset.page;
      if (page === 'account-page') {
        const { getCurrentUser } = await import('./auth.js');
        const user = await getCurrentUser();
        if (!user) {
          openAuthModal('signin');
          return;
        }
        const { renderAccountPage } = await import('./account.js');
        await renderAccountPage();
      }
      showPage(page);
      if (page === 'stats-page') renderStatsPage();
    });
  });

  // Logo: go to feed if on another page, or reload feed if already there
  document.getElementById('nav-logo')?.addEventListener('click', (e) => {
    e.preventDefault();
    const feedPage = document.getElementById('feed-page');
    if (feedPage?.classList.contains('active')) {
      loadFeed(false);
    } else {
      showPage('feed-page');
      document.querySelectorAll('.nav-btn[data-page]').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-btn[data-page="feed-page"]')?.classList.add('active');
    }
  });

  // Auth modal controls
  document.getElementById('auth-modal-close')?.addEventListener('click', closeAuthModal);
  document.getElementById('auth-modal-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAuthModal();
  });
  document.getElementById('auth-form')?.addEventListener('submit', handleAuthSubmit);
  document.getElementById('auth-switch-link')?.addEventListener('click', () => {
    const form = document.getElementById('auth-form');
    setAuthModalMode(form?.dataset.mode === 'signin' ? 'signup' : 'signin');
  });

  // Account button: go to Settings (account section) when signed in, else open auth modal
  document.getElementById('nav-login-btn')?.addEventListener('click', async () => {
    const { getCurrentUser } = await import('./auth.js');
    const user = await getCurrentUser();
    if (user) {
      showPage('account-page');
      document.querySelectorAll('.nav-btn[data-page]').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-btn[data-page="account-page"]')?.classList.add('active');
      const { renderAccountPage } = await import('./account.js');
      renderAccountPage();
    } else {
      openAuthModal('signin');
    }
  });

  // Load more
  document.getElementById('load-more-btn')?.addEventListener('click', () => loadFeed(true));

  // Settings page
  initSettings();

  // Auth state listener — pull prefs on login, push local prefs on first sign-up
  onAuthStateChange(async user => {
    const wasSignedIn = !!currentUser;
    currentUser = user;
    updateNavUser(user);

    if (user) {
      try {
        const profile = await pullPrefsFromCloud(user.id);

        // Apply pulled prefs to the live UI
        const refreshedPrefs = Storage.getPrefs();
        applyTheme(refreshedPrefs.theme);
        applyTextScale(refreshedPrefs.textScale);

        // Reflect pulled language in the selector and reload the feed if it changed
        const langSelect = document.getElementById('wiki-lang-select');
        if (langSelect && refreshedPrefs.wikiLang && langSelect.value !== refreshedPrefs.wikiLang) {
          langSelect.value = refreshedPrefs.wikiLang;
          window.reloadFeed?.();
        }

        // Brand-new account (no row yet, or empty) → seed it with the local prefs we have
        if (!profile || !profile.theme) {
          await syncPrefsToCloud(user.id).catch(() => {});
        }

        if (!wasSignedIn) showToast('Preferences synced from your account', 'info');
      } catch {}
    }

    const { renderAccountSection, renderLikesSection } = await import('./settings.js');
    const { renderAccountPage } = await import('./account.js');
    renderAccountSection();
    renderLikesSection();
    renderAccountPage();
  });

  // Sync prefs whenever the page is hidden (catches changes that didn't trigger
  // an explicit sync — e.g. system theme change, future settings additions).
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentUser) {
      scheduleSyncPrefs(currentUser.id, 0);
    }
  });

  // Flush session time on page hide
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSessionTime();
  });
  window.addEventListener('pagehide', flushSessionTime);
  window.addEventListener('pagehide', snapshotFeedSession);

  // Lightbox
  initLightbox();

  // Click-to-expand delegation for card extracts
  initExtractClickDelegation();

  // Pull-to-refresh
  initPullToRefresh();

  // Hide bottom nav on scroll-down (mobile only)
  initScrollHideNav();

  // Onboarding (must come before loadFeed)
  initOnboarding();

  // Apply session decay at start of each session
  applyDecay();

  // Start the feed
  showPage(location.pathname === '/account' ? 'account-page' : 'feed-page');
  if (location.pathname === '/account') {
    const { renderAccountPage } = await import('./account.js');
    renderAccountPage();
  }
  // Only auto-load feed if onboarding is already done
  if (localStorage.getItem('sw_onboarded')) {
    const restored = restoreFeedSession(document.getElementById('feed-cards'));
    if (!restored) await loadFeed(false);
    else startPrefetch(Storage.getPrefs().wikiLang || 'en');
  }
  updateNavStats();
}

function updateNavUser(user) {
  const nameEl  = document.getElementById('nav-user-name');
  const loginBtn = document.getElementById('nav-login-btn');
  if (user) {
    const initials = (user.email?.split('@')[0] || 'U').slice(0, 2).toUpperCase();
    if (loginBtn) {
      loginBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="width:18px;height:18px">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span class="nav-tooltip">Account</span>`;
      loginBtn.setAttribute('aria-label', 'Account');
    }
    if (nameEl) { nameEl.textContent = initials; nameEl.style.display = ''; }
  } else {
    if (nameEl) nameEl.style.display = 'none';
    if (loginBtn) {
      loginBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="width:18px;height:18px">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span class="nav-tooltip">Sign in</span>`;
      loginBtn.setAttribute('aria-label', 'Sign in');
    }
  }
}

// ===== Utility =====

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', init);
