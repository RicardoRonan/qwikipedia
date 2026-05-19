import { searchTitles, fetchSummaryBatch } from './wiki.js';
import { Storage } from './storage.js';
import { cleanWikipediaText } from './text-utils.js';
import { ICONS } from './icons.js';

export async function renderSearchPage() {
  const container = document.getElementById('search-results');
  if (!container) return;
  container.innerHTML = `
    <div class="state-box">
      <p>Search for articles to get started.</p>
    </div>
  `;
}

export async function doSearch(query) {
  const container = document.getElementById('search-results');
  const input = document.getElementById('search-input');
  if (!container || !query?.trim()) return;

  container.innerHTML = `
    <div class="state-box">
      <div class="loading-spinner" style="width:24px;height:24px;margin:0 auto 12px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:spin 0.9s linear infinite;"></div>
      <p>Searching…</p>
    </div>
  `;

  const lang = Storage.getPrefs().wikiLang || 'en';
  try {
    const titles = await searchTitles(query, 20, lang);
    if (!titles.length) {
      container.innerHTML = `
        <div class="state-box">
          <p>No results found for "${escapeHtml(query)}". Try different keywords.</p>
        </div>
      `;
      return;
    }
    const articles = await fetchSummaryBatch(titles, lang, { includeCategories: true });
    if (!articles.length) {
      container.innerHTML = `
        <div class="state-box">
          <p>No readable articles found for "${escapeHtml(query)}".</p>
        </div>
      `;
      return;
    }
    container.innerHTML = `<div id="search-card-feed" class="card-list"></div>`;
    const feed = document.getElementById('search-card-feed');
    articles.forEach(a => {
      const card = createSearchCard(a);
      feed.appendChild(card);
    });
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
  const safeUrl = article.url || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.title)}`;
  const imageHtml = article.image
    ? `<div class="card-image-wrap"><img class="card-image media" src="${escapeAttr(article.image)}" alt="${escapeAttr(article.title)}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '';
  el.innerHTML = `
    <div class="card-body">
      <h2 class="card-title">${escapeHtml(cleanWikipediaText(article.displayTitle || article.title))}</h2>
      <p class="card-extract">${escapeHtml(cleanWikipediaText(article.extract || ''))}</p>
      ${imageHtml}
      <div class="card-actions">
        <a class="card-read-link" href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener">${ICONS.externalLink} wikipedia.org</a>
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
