// engine.js — local recommendation engine

import { Storage } from './storage.js';
import { normalizeTopic, topicTokens } from './text-utils.js';
import {
  fetchSummaryBatch,
  fetchRandomTitles,
  searchTitles,
  fetchCategoryMembers,
  fetchFeaturedToday,
} from './wiki.js';

// Topics mapped to seed search queries used for candidate generation
const TOPIC_SEEDS = {
  science:    ['science', 'physics', 'biology', 'chemistry', 'astronomy'],
  history:    ['history', 'ancient history', 'world war', 'civilization'],
  technology: ['technology', 'computer science', 'internet', 'artificial intelligence'],
  arts:       ['art', 'music', 'painting', 'literature', 'film'],
  geography:  ['geography', 'country', 'continent', 'ocean', 'mountain'],
  people:     ['biography', 'inventor', 'scientist', 'leader', 'athlete'],
  nature:     ['nature', 'animal', 'plant', 'ecology', 'wildlife'],
  society:    ['culture', 'religion', 'politics', 'economics', 'philosophy'],
  sports:     ['sport', 'football', 'olympics', 'basketball', 'tennis'],
  food:       ['food', 'cuisine', 'cooking', 'nutrition', 'recipe'],
};

// Comprehensive mapping from Wikipedia category keywords → our topic buckets.
// These match against the ACTUAL categories Wikipedia assigns to articles.
const CATEGORY_TOPIC_MAP = {
  science: [
    'science', 'physics', 'chemistry', 'biology', 'astronomy', 'geology',
    'botany', 'zoology', 'ecology', 'genetics', 'neuroscience', 'medicine',
    'medical', 'pharmaceutical', 'scientific', 'mathematics', 'statistics',
    'calculus', 'algebra', 'geometry', 'laboratory', 'research', 'clinical',
    'biochemistry', 'microbiology', 'immunology', 'pathology', 'surgery',
    'astrophysics', 'cosmology', 'optics', 'thermodynamics', 'quantum',
  ],
  history: [
    'history', 'historical', 'ancient', 'medieval', 'war', 'empire',
    'dynasty', 'civilization', 'archaeological', 'century', 'battle',
    'revolution', 'colonial', 'prehistoric', 'heritage', 'antiquity',
    'ottoman', 'roman', 'byzantine', 'mongol', 'napoleonic', 'victorian',
    'cold war', 'world war', 'conquest', 'siege',
  ],
  technology: [
    'technology', 'computing', 'software', 'hardware', 'internet',
    'programming', 'engineering', 'robotics', 'electronics',
    'telecommunications', 'computer', 'digital', 'artificial intelligence',
    'machine learning', 'semiconductor', 'cybersecurity', 'aerospace',
    'spacecraft', 'satellite', 'nuclear', 'electrical', 'mechanical',
    'civil engineering', 'chemical engineering', 'nanotechnology',
  ],
  arts: [
    'art', 'music', 'painting', 'sculpture', 'literature', 'film', 'cinema',
    'theatre', 'dance', 'opera', 'novel', 'poetry', 'architecture', 'design',
    'photography', 'animation', 'cartoon', 'comic', 'musician', 'artist',
    'actor', 'director', 'composer', 'album', 'band', 'song', 'television',
    'manga', 'anime', 'video game', 'playwright', 'fiction', 'drawing',
  ],
  geography: [
    'populated places', 'cities', 'towns', 'villages', 'municipalities',
    'districts', 'provinces', 'states', 'regions', 'countries', 'islands',
    'rivers', 'lakes', 'mountains', 'oceans', 'continents', 'capitals',
    'boroughs', 'counties', 'parishes', 'settlements', 'census',
    'administrative divisions', 'geography of',
  ],
  people: [
    'births', 'deaths', 'politicians', 'statesmen', 'presidents', 'kings',
    'queens', 'monarchs', 'generals', 'admirals', 'philosophers',
    'mathematicians', 'inventors', 'entrepreneurs', 'businesspeople',
    'activists', 'journalists', 'authors', 'writers', 'poets', 'painters',
    'academics', 'professors', 'diplomats', 'revolutionaries', 'explorers',
  ],
  nature: [
    'species', 'genus', 'family', 'insect', 'bird', 'mammal', 'reptile',
    'amphibian', 'fish', 'plant', 'flower', 'tree', 'fungus', 'bacteria',
    'moth', 'butterfly', 'beetle', 'spider', 'wildlife', 'fauna', 'flora',
    'taxonomy', 'lepidoptera', 'coleoptera', 'diptera', 'hymenoptera',
    'animalia', 'plantae', 'chordata', 'arthropoda', 'mollusca',
    'conservation', 'endangered', 'extinct', 'biosphere', 'habitat',
  ],
  society: [
    'culture', 'religion', 'law', 'education', 'government', 'policy',
    'rights', 'philosophy', 'ethics', 'economics', 'politics', 'parliament',
    'organization', 'institution', 'foundation', 'nonprofit', 'charity',
    'social', 'anthropology', 'sociology', 'theology', 'religious',
    'church', 'mosque', 'temple', 'political party', 'military',
  ],
  sports: [
    'sport', 'football', 'soccer', 'tennis', 'basketball', 'athletics',
    'swimming', 'cycling', 'rugby', 'baseball', 'hockey', 'golf', 'olympic',
    'championship', 'tournament', 'league', 'club', 'stadium',
    'wrestler', 'boxer', 'cricket', 'volleyball', 'handball', 'rowing',
    'gymnastics', 'martial arts', 'racing', 'formula one', 'motorsport',
    'skiing', 'snowboarding', 'surfing', 'triathlon',
  ],
  food: [
    'food', 'cuisine', 'dish', 'recipe', 'cooking', 'drink', 'beverage',
    'restaurant', 'ingredient', 'spice', 'bread', 'meat', 'vegetable',
    'fruit', 'dessert', 'wine', 'beer', 'cheese', 'pastry', 'sauce',
    'condiment', 'nutrition', 'diet',
  ],
};

const ALL_TOPICS = Object.keys(TOPIC_SEEDS);

// Infer topics from Wikipedia categories (accurate, data-driven).
// Falls back to a conservative title-only scan if no categories are available.
export function inferTopics(article) {
  const cats = article.categories || [];

  if (cats.length > 0) {
    // Primary: match against actual Wikipedia category strings
    const matched = new Set();
    for (const cat of cats) {
      const categoryTokens = new Set(topicTokens(cat));
      for (const [topic, keywords] of Object.entries(CATEGORY_TOPIC_MAP)) {
        if (keywords.some(kw => {
          const keyTokens = topicTokens(kw);
          return keyTokens.length > 0 && keyTokens.every(t => categoryTokens.has(t));
        })) {
          matched.add(topic);
        }
      }
    }
    if (matched.size > 0) return [...matched];
  }

  // Fallback: conservative title-only keyword scan (never full extract)
  const titleTokens = new Set(topicTokens(article.title || ''));
  return ALL_TOPICS.filter(topic => {
    return TOPIC_SEEDS[topic].some(seed => {
      const seedTokens = topicTokens(seed);
      return seedTokens.length > 0 && seedTokens.every(t => titleTokens.has(t));
    });
  });
}

// Weight update constants
const W_LIKE = 2;
const W_DISLIKE = -3;
const W_SKIP = -0.5;
const W_DECAY = 0.95; // applied each session to avoid runaway bias

export function recordInteraction(article, action) {
  const engine = Storage.getEngine();
  const topics = inferTopics(article);
  const delta = action === 'like' ? W_LIKE : action === 'dislike' ? W_DISLIKE : W_SKIP;

  const weights = { ...engine.topicWeights };
  topics.forEach(t => {
    weights[t] = (weights[t] || 0) + delta;
  });

  Storage.setEngine({ topicWeights: weights, sessionCount: (engine.sessionCount || 0) });

  if (action === 'like') Storage.addLiked(article.title);
  if (action === 'dislike') Storage.addDismissed(article.title);
  if (action === 'skip') Storage.addSeen(article.title);
}

// Pick top N topics by weight; if none trained, return random selection
function pickWeightedTopics(n = 3) {
  const selectedInterests = (Storage.getPrefs().interests || []).map(normalizeTopic).filter(Boolean);
  const selectedSet = new Set(selectedInterests);
  const { topicWeights } = Storage.getEngine();
  const entries = Object.entries(topicWeights).filter(([topic, v]) => {
    if (v <= 0) return false;
    if (!selectedSet.size) return true;
    return selectedSet.has(normalizeTopic(topic));
  });

  if (entries.length === 0) {
    const basePool = selectedSet.size ? ALL_TOPICS.filter(t => selectedSet.has(normalizeTopic(t))) : [...ALL_TOPICS];
    return [...basePool].sort(() => Math.random() - 0.5).slice(0, n);
  }

  const sorted = entries.sort(([, a], [, b]) => b - a);
  const total = sorted.reduce((s, [, v]) => s + v, 0);

  // Weighted random pick
  const chosen = new Set();
  let attempts = 0;
  while (chosen.size < Math.min(n, sorted.length) && attempts < 50) {
    attempts++;
    const rand = Math.random() * total;
    let cum = 0;
    for (const [topic, w] of sorted) {
      cum += w;
      if (rand <= cum) {
        chosen.add(topic);
        break;
      }
    }
  }
  return [...chosen];
}

// Apply session decay to prevent weights from dominating forever
export function applyDecay() {
  const engine = Storage.getEngine();
  const weights = { ...engine.topicWeights };
  Object.keys(weights).forEach(t => {
    weights[t] = weights[t] * W_DECAY;
    if (Math.abs(weights[t]) < 0.1) delete weights[t];
  });
  Storage.setEngine({ topicWeights: weights });
}

// Build a pool of candidate article titles — all network calls run in parallel
// Re-runs random fetches if the seen-filter wipes most of the pool.
async function buildCandidatePool(lang = 'en', onProgress, minTargetSize = 8) {
  onProgress?.(6);
  const history = Storage.getHistory();
  const seen = new Set([...history.seenTitles, ...history.dismissedTitles, ...history.likedTitles]);

  // Keep candidate generation conservative to avoid bursty API traffic.
  // One topic seeded search keeps first paint fast; random titles supply variety.
  const topics = pickWeightedTopics(1);
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    console.debug('[feed] selected interests', Storage.getPrefs().interests || []);
    console.debug('[feed] weighted topics picked', topics);
  }
  const searches = topics.map(topic => {
    const seeds = TOPIC_SEEDS[topic] || [topic];
    const query = seeds[Math.floor(Math.random() * seeds.length)];
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      console.debug('[feed] fetching query', query);
    }
    return searchTitles(query, 6, lang).catch(() => []);
  });

  const [randomTitles, ...searchResults] = await Promise.all([
    fetchRandomTitles(10, lang).catch(() => []),
    ...searches,
  ]);
  onProgress?.(11);

  const pool = new Set([...randomTitles, ...searchResults.flat()]);

  /* If history is large, the seen-filter often drains the pool — top up with
   * extra random pages until we have a workable batch (or give up after 2 tries). */
  let unseen = [...pool].filter(t => !seen.has(t));
  let topUps = 0;
  const TOPUP_MAX = 1;
  while (unseen.length < minTargetSize && topUps < TOPUP_MAX) {
    topUps++;
    const more = await fetchRandomTitles(12, lang).catch(() => []);
    more.forEach(t => pool.add(t));
    unseen = [...pool].filter(t => !seen.has(t));
    onProgress?.(11 + Math.round((topUps / TOPUP_MAX) * 6));
  }

  onProgress?.(18);
  return unseen;
}

// Fetch next batch of feed articles (`onProgress` is 0–99; caller sets 100% when rendered)
export async function fetchFeedBatch(lang = 'en', batchSize = 8, onProgress) {
  onProgress?.(2);
  const candidates = await buildCandidatePool(lang, onProgress);

  // Shuffle — only fetch summaries for what we realistically need (keeps request count low)
  const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, batchSize + 4);

  const articles = await fetchSummaryBatch(shuffled, lang, {
    includeCategories: false,
    onChunkProgress: onProgress
      ? ({ chunkIndex, totalChunks }) => {
          const pct = 20 + ((chunkIndex + 1) / totalChunks) * 62;
          onProgress(Math.min(82, Math.round(pct)));
        }
      : undefined,
  });

  onProgress?.(84);

  // Enforce topic diversity when we can infer topics (categories or title seeds).
  // Without categories, inferTopics is often [] for every title — they would all
  // bucket as "other" and wrongly cap the batch at 3 articles.
  // Also filter by the user's selected interests: if the user has explicitly
  // chosen interests, only show articles whose inferred topics match at least one.
  const selectedInterests = new Set((Storage.getPrefs().interests || []).map(normalizeTopic).filter(Boolean));
  const hasSelectedInterests = selectedInterests.size > 0;
  const topicCounts = {};
  const diverse = [];
  for (const article of articles) {
    const topics = inferTopics(article);
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      console.debug('[feed] article topics', { title: article.title, categories: article.categories || [], topics });
    }
    // If user has selected interests, skip articles whose topics don't match any selected interest
    if (hasSelectedInterests && topics.length > 0) {
      const matchesSelected = topics.some(t => selectedInterests.has(normalizeTopic(t)));
      if (!matchesSelected) continue;
    }
    if (topics.length === 0) {
      diverse.push(article);
    } else {
      const dominant = topics[0];
      topicCounts[dominant] = (topicCounts[dominant] || 0) + 1;
      if (topicCounts[dominant] <= 3) diverse.push(article);
    }
    if (diverse.length >= batchSize) break;
  }

  // Pad with random if not enough
  if (diverse.length < 3) {
    try {
      onProgress?.(86);
      const extraTitles = await fetchRandomTitles(6, lang);
      const extra = await fetchSummaryBatch(extraTitles, lang, {
        includeCategories: false,
        onChunkProgress: onProgress
          ? ({ chunkIndex, totalChunks }) => {
              const pct = 86 + ((chunkIndex + 1) / totalChunks) * 12;
              onProgress(Math.min(96, Math.round(pct)));
            }
          : undefined,
      });
      extra.slice(0, batchSize - diverse.length).forEach(a => {
        diverse.push(a);
      });
    } catch {}
  }

  onProgress?.(99);
  return diverse;
}

// Fetch a single featured article (for a "featured today" card)
export async function getFeaturedCard(lang = 'en') {
  const history = Storage.getHistory();
  const seen = new Set([...history.seenTitles, ...history.dismissedTitles, ...(history.likedTitles || [])]);
  try {
    const featured = await fetchFeaturedToday(lang);
    if (featured && !seen.has(featured.title)) {
      return featured;
    }
  } catch {}
  return null;
}
