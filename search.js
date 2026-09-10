import { searchTitles, fetchSummaryBatch } from './wiki.js';
import { Storage } from './storage.js';
import { cleanWikipediaText, escapeHtml, escapeAttr } from './text-utils.js';
import { ICONS } from './icons.js';
import { refineSearchQuery, getSearchSuggestions, isAiEnabled, bindYoutubeLinks } from './ai.js';
import { stateBox, skeletonCardsHtml, setBusy } from './ui.js';

let _suggestionsLoaded = false;

export function resetSearchSuggestions() {
  _suggestionsLoaded = false;
}

export async function renderSearchPage() {
  const container = document.getElementById('search-results');
  if (!container) return;

  const prefs = Storage.getPrefs();
  const interests = prefs.interests?.length
    ? prefs.interests
    : Object.keys(Storage.getEngine().topicWeights || {}).slice(0, 4);

  let suggestions = interests.slice(0, 4).map(id => ({
    label: id.charAt(0).toUpperCase() + id.slice(1),
    query: id,
  }));

  if (isAiEnabled() && !_suggestionsLoaded) {
    _suggestionsLoaded = true;
    try {
      suggestions = await getSearchSuggestions({ interests });
    } catch { /* keep defaults */ }
  }

  const chips = suggestions.map(s => `
    <button type="button" class="search-suggestion-chip" data-query="${escapeAttr(s.query)}">${escapeHtml(s.label)}</button>
  `).join('');

  container.innerHTML = stateBox({
    icon: ICONS.search,
    title: 'Search Wikipedia',
    body: 'Search for articles to get started.',
    extra: `${isAiEnabled() ? '<p class="search-ai-hint">AI can refine vague queries and improve video search when the edge helper is deployed.</p>' : ''}
      ${chips ? `<div class="search-suggestions" role="group" aria-label="Suggested searches">${chips}</div>` : ''}`,
  });
  container.querySelector('.state-box')?.classList.add('search-empty-state');

  container.querySelectorAll('.search-suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const input = document.getElementById('search-input');
      if (input) input.value = chip.dataset.query || '';
      doSearch(chip.dataset.query || '');
    });
  });

  renderRecentSearches(container);
}

function getRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem('qwikipedia_recent_searches') || '[]');
  } catch {
    return [];
  }
}

function addRecentSearch(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const searches = getRecentSearches().filter(s => s !== q);
  searches.unshift(q);
  if (searches.length > 10) searches.pop();
  try {
    localStorage.setItem('qwikipedia_recent_searches', JSON.stringify(searches));
  } catch { /* quota / private mode */ }
}

function renderRecentSearches(container) {
  const searches = getRecentSearches();
  if (!container || searches.length === 0) return;

  const html = `
    <div class="recent-searches">
      <div class="recent-searches-header">Recent searches</div>
      ${searches.map(s => `
        <button type="button" class="recent-search-item" data-query="${escapeAttr(s)}">${escapeHtml(s)}</button>
      `).join('')}
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);

  container.querySelectorAll('.recent-search-item').forEach(item => {
    item.addEventListener('click', () => {
      const input = document.getElementById('search-input');
      if (input) input.value = item.dataset.query || '';
      doSearch(item.dataset.query || '');
    });
  });
}

export async function doSearch(query, opts = {}) {
  const container = document.getElementById('search-results');
  const input = document.getElementById('search-input');
  if (!container || !query?.trim()) return;

  const rawQuery = query.trim();
  if (!opts.retried) addRecentSearch(rawQuery);
  let searchQuery = rawQuery;
  let refinedNote = '';

  container.innerHTML = `<div class="card-list" aria-busy="true">${skeletonCardsHtml()}</div>`;
  setBusy(container, true);

  if (isAiEnabled() && !opts.skipRefine) {
    const { query: refined, source } = await refineSearchQuery(rawQuery);
    if (refined && refined !== rawQuery) {
      searchQuery = refined;
      refinedNote = source === 'ai'
        ? `Searched for “${escapeHtml(refined)}” (refined from your query)`
        : `Searched for “${escapeHtml(refined)}”`;
    }
  }

  const lang = Storage.getPrefs().wikiLang || 'en';
  try {
    let titles = await searchTitles(searchQuery, 20, lang);

    if (!titles.length && searchQuery !== rawQuery) {
      titles = await searchTitles(rawQuery, 20, lang);
      refinedNote = '';
    }

    if (!titles.length && isAiEnabled() && !opts.retried) {
      const alt = await refineSearchQuery(`${rawQuery} overview`);
      if (alt.query && alt.query !== searchQuery && alt.query !== rawQuery) {
        return doSearch(alt.query, { skipRefine: true, retried: true });
      }
    }

    if (!titles.length) {
      container.innerHTML = stateBox({
        icon: ICONS.search,
        title: 'No articles found',
        body: `No results found for “${escapeHtml(rawQuery)}”. Try different keywords.`,
      });
      setBusy(container, false);
      return;
    }

    const articles = await fetchSummaryBatch(titles, lang, { includeCategories: true });
    if (!articles.length) {
      container.innerHTML = stateBox({
        icon: ICONS.inbox,
        title: 'No articles found',
        body: `No readable articles found for “${escapeHtml(rawQuery)}”.`,
      });
      setBusy(container, false);
      return;
    }

    const noteHtml = refinedNote
      ? `<p class="search-refined-note">${refinedNote}</p>`
      : '';

    const countLabel = `${articles.length} result${articles.length !== 1 ? 's' : ''} found`;
    container.innerHTML = `
      ${noteHtml}
      <div class="search-result-count" role="status">${countLabel}</div>
      <div id="search-card-feed" class="card-list"></div>
    `;
    const feed = document.getElementById('search-card-feed');
    articles.forEach(a => {
      feed.appendChild(createSearchCard(a));
    });
    bindYoutubeLinks(feed);
    setBusy(container, false);
  } catch (err) {
    container.innerHTML = stateBox({
      icon: ICONS.alertCircle,
      title: 'Search failed',
      body: 'Check your connection and try again.',
      action: { label: 'Try again', action: 'retry-search' },
    });
    setBusy(container, false);
  }
}

function createSearchCard(article) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.title = article.title;
  const lang = Storage.getPrefs().wikiLang || 'en';
  const displayTitle = article.displayTitle || article.title || '';
  const safeUrl = article.url || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.title)}`;
  const imageHtml = article.image
    ? `<div class="card-image-wrap"><img class="card-image media" src="${escapeAttr(article.image)}" alt="${escapeAttr(displayTitle)}" loading="lazy" onerror="this.parentElement.classList.add('is-hidden')"></div>`
    : '';
  el.innerHTML = `
    <div class="card-body">
      <h2 class="card-title">${escapeHtml(cleanWikipediaText(displayTitle))}</h2>
      <p class="card-extract">${escapeHtml(cleanWikipediaText(article.extract || ''))}</p>
      ${imageHtml}
      <div class="card-actions">
        <div class="card-links">
          <a class="card-read-link" href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener">${ICONS.externalLink} wikipedia.org</a>
          <a class="card-youtube-link" href="#" data-youtube-title="${escapeAttr(displayTitle)}" aria-label="Watch related videos on YouTube">
            ${ICONS.youtube || '▶'} Watch related videos
          </a>
        </div>
      </div>
    </div>
  `;
  return el;
}
