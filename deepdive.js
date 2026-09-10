import { cleanWikipediaText, escapeHtml } from './text-utils.js';

const enc = (s) => encodeURIComponent(s);

/** @param {string} topic */
function buildSearchUrl(topic, template) {
  const q = cleanWikipediaText(topic);
  if (!q) return null;
  return template(q);
}

const RESOURCES = [
  {
    category: 'Learn',
    icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>',
    links: [
      {
        name: 'Free Courses',
        desc: 'Search edX, Khan Academy, Coursera & more',
        url: (t) => `https://www.google.com/search?q=${enc(`${t} free online course`)}`,
      },
      {
        name: 'Documentaries',
        desc: 'YouTube documentaries & explainers',
        url: (t) => `https://www.youtube.com/results?search_query=${enc(`${t} documentary`)}`,
      },
      {
        name: 'Science & Math',
        desc: 'Scholarly papers & academic sources',
        url: (t) => `https://scholar.google.com/scholar?q=${enc(t)}`,
      },
      {
        name: 'Space Resources',
        desc: 'NASA articles, images & missions',
        url: (t) => `https://www.google.com/search?q=${enc(`${t} site:nasa.gov`)}`,
      },
    ],
  },
  {
    category: 'Read',
    icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
    links: [
      {
        name: 'E-Book Libraries',
        desc: 'Internet Archive & Open Library',
        url: (t) => `https://archive.org/search?query=${enc(t)}`,
      },
      {
        name: 'Audiobooks',
        desc: 'Librivox & spoken-word results',
        url: (t) => `https://librivox.org/search?title=${enc(t)}`,
      },
      {
        name: 'Educational Books',
        desc: 'Textbooks & reference titles',
        url: (t) => `https://openlibrary.org/search?q=${enc(t)}`,
      },
      {
        name: 'PDF Search',
        desc: 'Academic PDFs & documents',
        url: (t) => `https://www.google.com/search?q=${enc(`${t} filetype:pdf`)}`,
      },
    ],
  },
  {
    category: 'AI Research',
    icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    links: [
      {
        name: 'Perplexity',
        desc: 'AI answers with cited sources',
        url: (t) => `https://www.perplexity.ai/search?q=${enc(t)}`,
      },
      {
        name: 'Brave Search',
        desc: 'Independent web search',
        url: (t) => `https://search.brave.com/search?q=${enc(t)}`,
      },
      {
        name: 'DuckDuckGo',
        desc: 'Privacy-focused web search',
        url: (t) => `https://duckduckgo.com/?q=${enc(t)}`,
      },
    ],
  },
  {
    category: 'Watch & Listen',
    icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
    links: [
      {
        name: 'Educational YouTube',
        desc: 'Lectures, explainers & tutorials',
        url: (t) => `https://www.youtube.com/results?search_query=${enc(`${t} explained`)}`,
      },
      {
        name: 'Music & Podcasts',
        desc: 'Podcasts & audio on this topic',
        url: (t) => `https://www.google.com/search?q=${enc(`${t} podcast`)}`,
      },
      {
        name: 'Image Search',
        desc: 'Photos, diagrams & illustrations',
        url: (t) => `https://www.google.com/search?tbm=isch&q=${enc(t)}`,
      },
    ],
  },
  {
    category: 'Explore',
    icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
    links: [
      {
        name: 'Maps & Travel',
        desc: 'Places & geography related to topic',
        url: (t) => `https://www.google.com/maps/search/${enc(t)}`,
      },
      {
        name: 'News & Indexes',
        desc: 'Recent news & coverage',
        url: (t) => `https://news.google.com/search?q=${enc(t)}&hl=en`,
      },
      {
        name: 'Wikipedia',
        desc: 'Full article & related pages',
        url: (t) => `https://en.wikipedia.org/wiki/Special:Search?search=${enc(t)}`,
      },
    ],
  },
];

function getTopicFromCard(cardEl, fallbackTopic = '') {
  const fromData =
    cardEl?.dataset?.deepdiveTopic ||
    cardEl?.querySelector('.btn-deepdive')?.dataset?.deepdiveTopic ||
    '';
  const fromTitle = cardEl?.querySelector('.card-title')?.textContent || '';
  return cleanWikipediaText(fromData || fallbackTopic || fromTitle);
}

const DEEPDIVE_TRANSITION_MS = 220;

function closeDeepDivePanel(panel, button) {
  if (!panel || panel.dataset.closing === '1') return;
  panel.dataset.closing = '1';
  panel.classList.remove('is-open');
  button?.classList.remove('active');

  const finish = () => {
    if (!panel.isConnected) return;
    panel.remove();
  };

  const onTransitionEnd = (e) => {
    if (e.target !== panel || e.propertyName !== 'max-height') return;
    panel.removeEventListener('transitionend', onTransitionEnd);
    clearTimeout(fallback);
    finish();
  };

  panel.addEventListener('transitionend', onTransitionEnd);
  const fallback = setTimeout(() => {
    panel.removeEventListener('transitionend', onTransitionEnd);
    finish();
  }, DEEPDIVE_TRANSITION_MS + 80);
}

export function toggleDeepDive(button, cardEl, topic = '') {
  const existing = cardEl.querySelector('.deepdive-panel');
  if (existing) {
    closeDeepDivePanel(existing, button);
    return;
  }

  const searchTopic = getTopicFromCard(cardEl, topic);
  if (!searchTopic) return;

  const panel = document.createElement('div');
  panel.className = 'deepdive-panel';

  const header = document.createElement('div');
  header.className = 'deepdive-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'deepdive-title';
  titleEl.textContent = 'Deep Dive Research';

  const subtitleEl = document.createElement('span');
  subtitleEl.className = 'deepdive-subtitle';
  subtitleEl.innerHTML = `Search <strong class="deepdive-query">${escapeHtml(searchTopic)}</strong> across free research sites`;

  header.append(titleEl, subtitleEl);
  panel.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'deepdive-grid';

  for (const group of RESOURCES) {
    const col = document.createElement('div');
    col.className = 'deepdive-group';

    const groupHeader = document.createElement('div');
    groupHeader.className = 'deepdive-group-header';
    groupHeader.innerHTML = `${group.icon} <span>${group.category}</span>`;
    col.appendChild(groupHeader);

    const list = document.createElement('div');
    list.className = 'deepdive-links';
    for (const link of group.links) {
      const href = buildSearchUrl(searchTopic, link.url);
      if (!href) continue;

      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'deepdive-link';
      a.title = `Search ${searchTopic} — ${link.name}`;
      a.innerHTML = `<span class="deepdive-link-name">${link.name}</span><span class="deepdive-link-desc">${link.desc}</span>`;
      list.appendChild(a);
    }
    col.appendChild(list);
    grid.appendChild(col);
  }

  panel.appendChild(grid);

  const footer = document.createElement('div');
  footer.className = 'deepdive-footer';
  footer.innerHTML =
    'Categories inspired by <a href="https://fmhy.net/" target="_blank" rel="noopener">FMHY</a> — each link searches for this topic';
  panel.appendChild(footer);

  cardEl.querySelector('.card-body').appendChild(panel);
  button.classList.add('active');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => panel.classList.add('is-open'));
  });
}
