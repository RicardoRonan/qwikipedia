export function decodeHtmlEntities(text = '') {
  if (!text) return '';
  const el = document.createElement('textarea');
  el.innerHTML = String(text);
  return el.value;
}

export function cleanWikipediaText(text = '') {
  const decoded = decodeHtmlEntities(String(text || ''));
  return decoded
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTopic(topic = '') {
  const cleaned = cleanWikipediaText(topic).toLowerCase().trim();
  if (!cleaned) return '';
  if (cleaned === 'sport' || cleaned === 'sports') return 'sports';
  if (['science', 'history', 'technology', 'arts', 'geography', 'people', 'nature', 'society', 'sports', 'food'].includes(cleaned)) {
    return cleaned;
  }
  if (cleaned.endsWith('ies')) return `${cleaned.slice(0, -3)}y`;
  if (cleaned.endsWith('s') && !cleaned.endsWith('ss')) return cleaned.slice(0, -1);
  return cleaned;
}

export function topicTokens(text = '') {
  return normalizeTopic(text)
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}
