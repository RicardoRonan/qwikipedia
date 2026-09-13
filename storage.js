// storage.js - single interface for all localStorage persistence

const KEYS = {
  PREFS:   'sw_prefs',
  ENGINE:  'sw_engine',
  HISTORY: 'sw_history',
  STATS:   'sw_stats',
};

const DEFAULT_PREFS = {
  theme: 'system',
  textScale: 100,
  wikiLang: 'en',
  interests: [],
  aiEnabled: true,
  pronounceEnabled: true,
  pronounceRate: 1,
  pronounceVoice: '',
};

const DEFAULT_ENGINE = {
  topicWeights: {},
  sessionCount: 0,
};

const DEFAULT_HISTORY = {
  likedTitles: [],
  likedArticles: [],
  dismissedTitles: [],
  seenTitles: [],
  savedTitles: [],
  savedArticles: [],
};

const DEFAULT_STATS = {
  totalSeen:      0,
  totalLiked:     0,
  totalDismissed: 0,
  totalTimeMs:    0,
};

function _read(key, defaults) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

function _write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export const Storage = {
  getPrefs() {
    return _read(KEYS.PREFS, DEFAULT_PREFS);
  },
  setPrefs(partial) {
    const current = this.getPrefs();
    _write(KEYS.PREFS, { ...current, ...partial });
  },

  getEngine() {
    return _read(KEYS.ENGINE, DEFAULT_ENGINE);
  },
  setEngine(partial) {
    const current = this.getEngine();
    _write(KEYS.ENGINE, { ...current, ...partial });
  },

  getHistory() {
    return _read(KEYS.HISTORY, DEFAULT_HISTORY);
  },
  setHistory(partial) {
    const current = this.getHistory();
    _write(KEYS.HISTORY, { ...current, ...partial });
  },

  addSeen(title) {
    const h = this.getHistory();
    if (!h.seenTitles.includes(title)) {
      h.seenTitles = [title, ...h.seenTitles].slice(0, 500);
      _write(KEYS.HISTORY, h);
    }
  },

  addLiked(title) {
    const h = this.getHistory();
    if (!h.likedTitles.includes(title)) {
      h.likedTitles = [title, ...h.likedTitles].slice(0, 300);
      _write(KEYS.HISTORY, h);
    }
  },

  setLikedArticle(article) {
    if (!article?.title) return;
    const h = this.getHistory();
    const next = [article, ...(h.likedArticles || []).filter(a => a?.title !== article.title)];
    h.likedArticles = next.slice(0, 300);
    if (!h.likedTitles.includes(article.title)) {
      h.likedTitles = [article.title, ...h.likedTitles].slice(0, 300);
    }
    _write(KEYS.HISTORY, h);
  },

  removeLiked(title) {
    const h = this.getHistory();
    h.likedTitles = (h.likedTitles || []).filter(t => t !== title);
    h.likedArticles = (h.likedArticles || []).filter(a => a?.title !== title);
    _write(KEYS.HISTORY, h);
  },

  isLiked(title) {
    const h = this.getHistory();
    return (h.likedTitles || []).includes(title);
  },

  getLikedState() {
    const h = this.getHistory();
    const likedArticleIds = [...new Set(h.likedTitles || [])];
    const likedArticles = (h.likedArticles || []).filter(a => a?.title && likedArticleIds.includes(a.title));
    return { likedArticleIds, likedArticles };
  },

  addDismissed(title) {
    const h = this.getHistory();
    if (!h.dismissedTitles.includes(title)) {
      h.dismissedTitles = [title, ...h.dismissedTitles].slice(0, 300);
      _write(KEYS.HISTORY, h);
    }
  },

  addSaved(title) {
    const h = this.getHistory();
    if (!h.savedTitles.includes(title)) {
      h.savedTitles = [title, ...h.savedTitles].slice(0, 300);
      _write(KEYS.HISTORY, h);
    }
  },

  setSavedArticle(article) {
    if (!article?.title) return;
    const h = this.getHistory();
    const next = [article, ...(h.savedArticles || []).filter(a => a?.title !== article.title)];
    h.savedArticles = next.slice(0, 300);
    if (!h.savedTitles.includes(article.title)) {
      h.savedTitles = [article.title, ...h.savedTitles].slice(0, 300);
    }
    _write(KEYS.HISTORY, h);
  },

  removeSaved(title) {
    const h = this.getHistory();
    h.savedTitles = (h.savedTitles || []).filter(t => t !== title);
    h.savedArticles = (h.savedArticles || []).filter(a => a?.title !== title);
    _write(KEYS.HISTORY, h);
  },

  isSaved(title) {
    const h = this.getHistory();
    return (h.savedTitles || []).includes(title);
  },

  isSeen(title) {
    const h = this.getHistory();
    return h.seenTitles.includes(title) || h.dismissedTitles.includes(title);
  },

  getStats() {
    return _read(KEYS.STATS, DEFAULT_STATS);
  },

  incrementStat(key, amount = 1) {
    const s = this.getStats();
    s[key] = Math.max(0, (s[key] || 0) + amount);
    _write(KEYS.STATS, s);
  },

  /** Replace stats in one write (e.g. cloud merge) */
  setStatsAll(stats) {
    _write(KEYS.STATS, { ...DEFAULT_STATS, ...stats });
  },

  reset() {
    localStorage.removeItem(KEYS.ENGINE);
    localStorage.removeItem(KEYS.HISTORY);
    localStorage.removeItem(KEYS.STATS);
  },

  resetAll() {
    Object.values(KEYS).forEach(k => localStorage.removeItem(k));
  },
};
