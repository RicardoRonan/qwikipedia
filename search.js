import { searchTitles, fetchSummaryBatch } from './wiki.js';
import { Storage } from './storage.js';
import { cleanWikipediaText } from './text-utils.js';
import { ICONS } from './icons.js';
import { refineSearchQuery, getSearchSuggestions, isAiEnabled, bindYoutubeLinks } from './ai.js';

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

  container.innerHTML = `
    <div class="state-box search-empty-state">
      <p>Search for articles on Wikipedia.</p>
      ${isAiEnabled() ? '<p class="search-ai-hint">AI can refine vague queries and improve video search when the edge helper is deployed.</p>' : ''}
      ${chips ? `<div class="search-suggestions" role="group" aria-label="Suggested searches">${chips}</div>` : ''}
    </div>
  `;

  container.querySelectorAll('.search-suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const input = document.getElementById('search-input');
      if (input) input.value = chip.dataset.query || '';
      doSearch(chip.dataset.query || '');
    });
  });
}

export async function doSearch(query, opts = {}) {
  const container = document.getElementById('search-results');
  const input = document.getElementById('search-input');
  if (!container || !query?.trim()) return;

  const rawQuery = query.trim();
  let searchQuery = rawQuery;
  let refinedNote = '';

  if (isAiEnabled() && !opts.skipRefine) {
    const { query: refined, source } = await refineSearchQuery(rawQuery);
    if (refined && refined !== rawQuery) {
      searchQuery = refined;
      refinedNote = source === 'ai'
        ? `Searched for “${escapeHtml(refined)}” (refined from your query)`
        : `Searched for “${escapeHtml(refined)}”`;
    }
  }

  container.innerHTML = `
    <div class="state-box">
      <div class="loading-spinner" style="width:24px;height:24px;margin:0 auto 12px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:spin 0.9s linear infinite;"></div>
      <p>Searching…</p>
    </div>
  `;

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
      container.innerHTML = `
        <div class="state-box">
          <p>No results found for "${escapeHtml(rawQuery)}". Try different keywords.</p>
        </div>
      `;
      return;
    }

    const articles = await fetchSummaryBatch(titles, lang, { includeCategories: true });
    if (!articles.length) {
      container.innerHTML = `
        <div class="state-box">
          <p>No readable articles found for "${escapeHtml(rawQuery)}".</p>
        </div>
      `;
      return;
    }

    const noteHtml = refinedNote
      ? `<p class="search-refined-note">${refinedNote}</p>`
      : '';

    container.innerHTML = `
      ${noteHtml}
      <div id="search-card-feed" class="card-list"></div>
    `;
    const feed = document.getElementById('search-card-feed');
    articles.forEach(a => {
      feed.appendChild(createSearchCard(a));
    });
    bindYoutubeLinks(feed);
  } catch (err) {
    container.innerHTML = `
      <div class="state-box">
        <p>Search failed. Check your connection and try again.</p>
        <button class="btn-primary" style="margin-top:12px;" onclick="document.getElementById('search-submit-btn')?.click()">Retry</button>
      </div>
    `;
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
    ? `<div class="card-image-wrap"><img class="card-image media" src="${escapeAttr(article.image)}" alt="${escapeAttr(displayTitle)}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
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

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s = '') {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
