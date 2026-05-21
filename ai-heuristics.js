// Local fallbacks when the AI edge function is unavailable or disabled

import { cleanWikipediaText } from './text-utils.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'with', 'from', 'by', 'as', 'that', 'this', 'it', 'its', 'be', 'been', 'being', 'have', 'has', 'had',
]);

const YOUTUBE_SUFFIXES = ['explained', 'tutorial', 'how it works', 'documentary', 'crash course'];

const TECH_HINTS = [
  'http', 'https', 'web', 'server', 'client', 'database', 'network', 'software', 'protocol',
  'algorithm', 'memory', 'cpu', 'api', 'cookie', 'session', 'encryption', 'blockchain',
];

/**
 * Build a YouTube-friendly query without calling an LLM.
 */
export function buildYoutubeQueryHeuristic(title = '', extract = '') {
  let topic = cleanWikipediaText(title);
  const extractClean = cleanWikipediaText(extract).toLowerCase();

  const parenMatch = topic.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const main = parenMatch[1].trim();
    const inside = parenMatch[2].trim();
    if (inside.length > 2 && inside.length < 60) {
      topic = `${inside} ${main}`.replace(/\s+/g, ' ').trim();
    }
  }

  topic = topic
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const extractWords = extractClean.split(/\s+/).filter(Boolean);
  const hints = TECH_HINTS.filter(h => extractClean.includes(h)).slice(0, 2);

  let suffix = YOUTUBE_SUFFIXES[0];
  if (/\b(war|battle|empire|century|king|queen|president)\b/i.test(topic + ' ' + extractClean)) {
    suffix = 'documentary';
  } else if (/\b(food|recipe|cuisine|dish)\b/i.test(topic + ' ' + extractClean)) {
    suffix = 'how to make';
  } else if (hints.length > 0 || /\b(computer|software|programming|science)\b/i.test(topic)) {
    suffix = 'explained';
  }

  const parts = [topic, ...hints, suffix].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 96);
}

/**
 * Light cleanup for Wikipedia search queries.
 */
export function refineSearchQueryHeuristic(query = '') {
  let q = cleanWikipediaText(query);
  q = q.replace(/^(what is|who is|who was|tell me about|explain|define)\s+/i, '');
  q = q.replace(/\?+$/g, '').trim();
  if (q.length < 2) return query.trim();
  return q;
}

/**
 * Extract 2–4 noun-ish tokens from an extract for chip suggestions.
 */
export function extractSearchHintsHeuristic(title = '', extract = '') {
  const text = `${cleanWikipediaText(title)} ${cleanWikipediaText(extract)}`.toLowerCase();
  const tokens = text
    .split(/[^a-z0-9]+/g)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));

  const seen = new Set();
  const hints = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    hints.push(t);
    if (hints.length >= 4) break;
  }
  return hints;
}
