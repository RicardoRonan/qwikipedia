// entity.js - classify an article and produce context-aware external links

const TYPE_KEYWORDS = {
  place: ['cities', 'city', 'towns', 'villages', 'municipalities', 'countries', 'islands',
    'rivers', 'lakes', 'mountains', 'continents', 'capitals', 'populated places', 'districts',
    'provinces', 'regions', 'counties', 'boroughs', 'settlements', 'landforms', 'volcanoes'],
  person: ['births', 'deaths', 'people', 'politicians', 'scientists', 'writers', 'actors',
    'singers', 'musicians', 'philosophers', 'inventors', 'businesspeople', 'activists',
    'film directors', 'footballers', 'monarchs', 'heads of state'],
  musicalArtist: ['musical groups', 'bands', 'musicians', 'singers', 'rappers',
    'record labels', 'hip hop', 'rock music', 'pop music', 'composers', 'albums', 'songs'],
  vehicle: ['automobiles', 'car models', 'vehicles', 'motorcycles', 'aircraft', 'ships',
    'locomotives', 'tractors', 'bicycles'],
  company: ['companies', 'organizations', 'businesses', 'brands', 'corporations', 'airlines',
    'banks', 'software companies', 'manufacturers', 'retailers', 'websites'],
  film: ['films', 'television series', 'television programs', 'movies', 'animated films',
    'documentary films', 'video games', 'web series'],
  book: ['novels', 'books', 'literary works', 'poems', 'plays', 'comics', 'manga'],
  species: ['species', 'animals', 'plants', 'insects', 'birds', 'mammals', 'reptiles',
    'fish', 'fungi', 'genera', 'taxa'],
};

const QID_TYPE_MAP = {
  Q515: 'place', Q486972: 'place', Q6256: 'place', Q3624078: 'place', Q532: 'place',
  Q3957: 'place', Q23442: 'place', Q4022: 'place', Q8502: 'place', Q23397: 'place',
  Q35657: 'place', Q5: 'person',
  Q215380: 'musicalArtist', Q177220: 'musicalArtist', Q639669: 'musicalArtist', Q482994: 'musicalArtist',
  Q11424: 'film', Q5398426: 'film', Q7889: 'film',
  Q571: 'book', Q7725634: 'book', Q8261: 'book',
  Q16521: 'species', Q3231690: 'vehicle', Q1420: 'vehicle',
  Q43229: 'company', Q4830453: 'company', Q783794: 'company', Q431289: 'company',
};

export function typeFromWikidata(instanceOf = []) {
  for (const qid of instanceOf) if (QID_TYPE_MAP[qid]) return QID_TYPE_MAP[qid];
  return null;
}

export function classifyEntity(article = {}) {
  const cats = (article.categories || []).map(c => String(c).toLowerCase());
  if (cats.length) {
    for (const [type, words] of Object.entries(TYPE_KEYWORDS)) {
      if (cats.some(c => words.some(w => c.includes(w)))) return type;
    }
  }
  if (article.coordinates) return 'place';
  return 'other';
}

export function getContextualLinks(article = {}, type = 'other', wd = null) {
  const title = article.displayTitle || article.title || '';
  const q = encodeURIComponent(title);
  const out = [];
  const add = (label, href, desc = '') => { if (href) out.push({ label, href, desc }); };

  if (type === 'place') {
    const c = article.coordinates;
    add('Google Maps', c ? `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`
      : `https://www.google.com/maps/search/?api=1&query=${q}`, 'Location on a map');
    add('OpenStreetMap', c ? `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=13/${c.lat}/${c.lon}`
      : `https://www.openstreetmap.org/search?query=${q}`, 'Open map data');
    add('Wikivoyage', `https://en.wikivoyage.org/wiki/Special:Search?search=${q}`, 'Travel guide');
  }
  if (type === 'person') {
    if (wd?.officialWebsite) add('Official website', wd.officialWebsite);
    if (wd?.imdb) add('IMDb', `https://www.imdb.com/name/${wd.imdb}`);
    add('Google Scholar', `https://scholar.google.com/scholar?q=${q}`, 'Publications & citations');
    if (wd?.x) add('X (Twitter)', wd.x);
    if (wd?.instagram) add('Instagram', wd.instagram);
  }
  if (type === 'musicalArtist') {
    add('Spotify', wd?.spotifyArtist ? `https://open.spotify.com/artist/${wd.spotifyArtist}`
      : `https://open.spotify.com/search/${q}`, 'Listen on Spotify');
    add('Apple Music', `https://music.apple.com/search?term=${q}`);
    add('YouTube Music', `https://music.youtube.com/search?q=${q}`);
    add('Discogs', `https://www.discogs.com/search/?q=${q}&type=all`);
  }
  if (type === 'vehicle') {
    if (wd?.officialWebsite) add('Official website', wd.officialWebsite);
    add('Wikipedia search', `https://en.wikipedia.org/w/index.php?search=${q}`);
  }
  if (type === 'company') {
    if (wd?.officialWebsite) add('Official website', wd.officialWebsite);
    add('LinkedIn', `https://www.linkedin.com/search/results/companies/?keywords=${q}`);
  }
  if (type === 'film') {
    add('IMDb', `https://www.imdb.com/find/?q=${q}`, 'Cast, crew, ratings');
    add('JustWatch', `https://www.justwatch.com/us/search?q=${q}`, 'Where to stream');
    add('Letterboxd', `https://letterboxd.com/search/${q}`, 'Reviews & lists');
  }
  if (type === 'book') {
    add('Open Library', `https://openlibrary.org/search?q=${q}`, 'Borrow & details');
    add('Goodreads', `https://www.goodreads.com/search?q=${q}`, 'Reviews & ratings');
  }
  if (type === 'species') {
    add('iNaturalist', `https://www.inaturalist.org/search?q=${q}`, 'Observations & photos');
    add('IUCN Red List', `https://www.iucnredlist.org/search?query=${q}&searchType=species`, 'Conservation status');
  }
  return out;
}
