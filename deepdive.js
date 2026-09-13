import { cleanWikipediaText, escapeHtml } from './text-utils.js';
import { ICONS } from './icons.js';
import { classifyEntity, getContextualLinks, typeFromWikidata } from './entity.js';
import { fetchWikidataEntities, fetchCommonsImages } from './wiki.js';

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
    icon: ICONS.bookOpen,
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
    icon: ICONS.book,
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
    icon: ICONS.lock,
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
    icon: ICONS.video,
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
    icon: ICONS.compass,
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
  const fromTitle = cardEl?.querySelector('.card-title, .like-card-title')?.textContent || '';
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

function hydrateArticleFromCard(cardEl, article) {
  const base = (article && typeof article === 'object')
    ? { ...article }
    : { title: String(article || '') };
  if (!base.qid && cardEl?.dataset?.qid) base.qid = cardEl.dataset.qid;
  if ((!base.categories || !base.categories.length) && cardEl?.dataset?.categories) {
    base.categories = cardEl.dataset.categories.split('|');
  }
  if (!base.coordinates && cardEl?.dataset?.coords) {
    const [lat, lon] = cardEl.dataset.coords.split(',');
    const latN = Number(lat);
    const lonN = Number(lon);
    if (Number.isFinite(latN) && Number.isFinite(lonN)) {
      base.coordinates = { lat: latN, lon: lonN };
    }
  }
  return base;
}

function fillContextualLinks(listEl, article, type, wd) {
  listEl.replaceChildren();
  const links = getContextualLinks(article, type, wd);
  for (const link of links) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'deepdive-link';
    a.title = link.desc ? `${link.label} - ${link.desc}` : link.label;
    a.innerHTML = `<span class="deepdive-link-name">${escapeHtml(link.label)}</span>${
      link.desc ? `<span class="deepdive-link-desc">${escapeHtml(link.desc)}</span>` : ''
    }`;
    listEl.appendChild(a);
  }
  return links.length;
}

function renderContextualGroup(article, type, wd) {
  const col = document.createElement('div');
  col.className = 'deepdive-group deepdive-context';

  const groupHeader = document.createElement('div');
  groupHeader.className = 'deepdive-group-header';
  groupHeader.innerHTML = `${ICONS.compass || ''} <span>For this article</span>`;

  const list = document.createElement('div');
  list.className = 'deepdive-links';
  const n = fillContextualLinks(list, article, type, wd);
  col.append(groupHeader, list);
  if (!n) col.hidden = true;
  return col;
}

function updateContextualGroup(el, article, type, wd) {
  if (!el) return;
  const list = el.querySelector('.deepdive-links');
  if (!list) return;
  const n = fillContextualLinks(list, article, type, wd);
  el.hidden = n === 0;
}

function googleImagesUrl(topic) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(topic)}`;
}

function appendGoogleImagesLink(host, topic) {
  const a = document.createElement('a');
  a.href = googleImagesUrl(topic);
  a.target = '_blank';
  a.rel = 'noopener';
  a.className = 'deepdive-images-more';
  a.textContent = 'See all on Google Images';
  host.appendChild(a);
}

function renderImageSkeletons(imagesPanel) {
  imagesPanel.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'deepdive-images';
  for (let i = 0; i < 8; i++) {
    const tile = document.createElement('div');
    tile.className = 'deepdive-image deepdive-image-skeleton';
    tile.setAttribute('aria-hidden', 'true');
    grid.appendChild(tile);
  }
  imagesPanel.appendChild(grid);
}

function renderImageGrid(imagesPanel, imgs, searchTopic) {
  imagesPanel.replaceChildren();
  if (imgs?.length) {
    const grid = document.createElement('div');
    grid.className = 'deepdive-images';
    for (const image of imgs) {
      const a = document.createElement('a');
      a.className = 'deepdive-image';
      a.href = image.page;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = image.title;
      const img = document.createElement('img');
      img.src = image.thumb;
      img.alt = image.title;
      img.loading = 'lazy';
      a.appendChild(img);
      grid.appendChild(a);
    }
    imagesPanel.appendChild(grid);
  }
  appendGoogleImagesLink(imagesPanel, searchTopic);
}

function appendResourceGroups(grid, searchTopic) {
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
      a.title = `Search ${searchTopic} - ${link.name}`;
      a.innerHTML = `<span class="deepdive-link-name">${link.name}</span><span class="deepdive-link-desc">${link.desc}</span>`;
      list.appendChild(a);
    }
    col.appendChild(list);
    grid.appendChild(col);
  }
}

export function toggleDeepDive(button, cardEl, article = '') {
  const existing = cardEl.querySelector('.deepdive-panel');
  if (existing) {
    closeDeepDivePanel(existing, button);
    return;
  }

  const articleObj = hydrateArticleFromCard(cardEl, article);
  const searchTopic = cleanWikipediaText(articleObj.displayTitle || articleObj.title || '')
    || getTopicFromCard(cardEl, '');
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

  const uid = `dd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const tabs = document.createElement('div');
  tabs.className = 'deepdive-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Deep dive sections');

  const linksTab = document.createElement('button');
  linksTab.type = 'button';
  linksTab.className = 'deepdive-tab';
  linksTab.setAttribute('role', 'tab');
  linksTab.id = `${uid}-links-tab`;
  linksTab.setAttribute('aria-controls', `${uid}-links`);
  linksTab.setAttribute('aria-selected', 'true');
  linksTab.textContent = 'Links';

  const imagesTab = document.createElement('button');
  imagesTab.type = 'button';
  imagesTab.className = 'deepdive-tab';
  imagesTab.setAttribute('role', 'tab');
  imagesTab.id = `${uid}-images-tab`;
  imagesTab.setAttribute('aria-controls', `${uid}-images`);
  imagesTab.setAttribute('aria-selected', 'false');
  imagesTab.tabIndex = -1;
  imagesTab.textContent = 'Images';

  tabs.append(linksTab, imagesTab);
  panel.appendChild(tabs);

  const linksPanel = document.createElement('div');
  linksPanel.className = 'deepdive-tabpanel';
  linksPanel.id = `${uid}-links`;
  linksPanel.setAttribute('role', 'tabpanel');
  linksPanel.setAttribute('aria-labelledby', `${uid}-links-tab`);

  const imagesPanel = document.createElement('div');
  imagesPanel.className = 'deepdive-tabpanel';
  imagesPanel.id = `${uid}-images`;
  imagesPanel.setAttribute('role', 'tabpanel');
  imagesPanel.setAttribute('aria-labelledby', `${uid}-images-tab`);
  imagesPanel.hidden = true;

  let type = classifyEntity(articleObj);
  const ctxEl = renderContextualGroup(articleObj, type, null);
  linksPanel.appendChild(ctxEl);

  const grid = document.createElement('div');
  grid.className = 'deepdive-grid';
  appendResourceGroups(grid, searchTopic);
  linksPanel.appendChild(grid);

  const footer = document.createElement('div');
  footer.className = 'deepdive-footer';
  footer.innerHTML =
    'Categories inspired by <a href="https://fmhy.net/" target="_blank" rel="noopener">FMHY</a> - each link searches for this topic';
  linksPanel.appendChild(footer);

  panel.append(linksPanel, imagesPanel);

  let imagesLoaded = false;
  async function loadImages() {
    if (imagesLoaded) return;
    imagesLoaded = true;
    renderImageSkeletons(imagesPanel);
    const imgs = await fetchCommonsImages(searchTopic, 12).catch(() => []);
    renderImageGrid(imagesPanel, imgs, searchTopic);
  }

  function selectTab(which) {
    const showImages = which === 'images';
    linksTab.setAttribute('aria-selected', showImages ? 'false' : 'true');
    imagesTab.setAttribute('aria-selected', showImages ? 'true' : 'false');
    linksTab.tabIndex = showImages ? -1 : 0;
    imagesTab.tabIndex = showImages ? 0 : -1;
    linksPanel.hidden = showImages;
    imagesPanel.hidden = !showImages;
    if (showImages) loadImages();
  }

  linksTab.addEventListener('click', () => selectTab('links'));
  imagesTab.addEventListener('click', () => selectTab('images'));

  if (articleObj.qid) {
    fetchWikidataEntities([articleObj.qid]).then(map => {
      const wd = map.get(articleObj.qid) || null;
      updateContextualGroup(ctxEl, articleObj, typeFromWikidata(wd?.instanceOf) || type, wd);
    }).catch(() => {});
  }

  const panelHost = cardEl.querySelector('.card-body, .like-card-body') || cardEl;
  panelHost.appendChild(panel);
  button.classList.add('active');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => panel.classList.add('is-open'));
  });
}
