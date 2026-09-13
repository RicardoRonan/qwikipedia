// entity.js - classify an article and produce context-aware external links

const TYPE_KEYWORDS = {
  place: ['cities','city','towns','villages','municipalities','countries','islands','rivers','lakes','mountains','continents','capitals','populated places','districts','provinces','regions','counties','boroughs','settlements','landforms','volcanoes'],
  musicArtist: ['musical groups','bands','musicians','singers','rappers','songwriters','composers','guitarists','pianists','drummers','rock music','pop music','hip hop musicians'],
  musicRelease: ['albums','album','songs','song','singles','eps','studio albums','live albums','compilation albums','soundtracks','debut albums','debut singles'],
  person: ['births','deaths','people','politicians','scientists','writers','actors','philosophers','inventors','businesspeople','activists','film directors','footballers','monarchs','heads of state'],
  vehicle: ['automobiles','car models','vehicles','motorcycles','aircraft','ships','locomotives','tractors','bicycles'],
  company: ['companies','organizations','businesses','brands','corporations','airlines','banks','software companies','manufacturers','retailers','websites','record labels'],
  film: ['films','film','movies','movie','animated films','documentary films','film series'],
  tv: ['television series','television programs','web series','miniseries','television seasons','television episodes','tv series','tv season','anime series','seasons','season','episodes','episode'],
  book: ['novels','books','literary works','poems','plays','comics','manga'],
  species: ['species','animals','plants','insects','birds','mammals','reptiles','fish','fungi','genera','taxa'],
  game: ['video games','video game series','video game franchises','mobile games','arcade games','computer games'],
};

const QID_TYPE_MAP = {
  Q515:'place', Q486972:'place', Q6256:'place', Q3624078:'place', Q532:'place', Q3957:'place',
  Q23442:'place', Q4022:'place', Q8502:'place', Q23397:'place', Q35657:'place',
  Q5:'person',
  Q215380:'musicArtist', Q177220:'musicArtist', Q639669:'musicArtist', Q855091:'musicArtist',
  Q753110:'musicArtist', Q36834:'musicArtist', Q158852:'musicArtist',
  Q482994:'musicRelease', Q7366:'musicRelease', Q134556:'musicRelease', Q169930:'musicRelease',
  Q11424:'film', Q202866:'film', Q24856:'film',
  Q5398426:'tv', Q15416:'tv', Q3464665:'tv', Q21191270:'tv', Q1983062:'tv',
  Q7889:'game',
  Q571:'book', Q7725634:'book', Q8261:'book',
  Q16521:'species', Q729:'species', Q756:'species',
  Q3231690:'vehicle', Q1420:'vehicle',
  Q43229:'company', Q4830453:'company', Q783794:'company', Q431289:'company',
};

const MUSICIAN_QIDS = new Set(['Q177220','Q639669','Q855091','Q753110','Q36834','Q158852','Q215380']);

export function typeFromWikidata(instanceOf = []) {
  for (const qid of instanceOf) if (QID_TYPE_MAP[qid]) return QID_TYPE_MAP[qid];
  return null;
}

function keywordInText(text, word) {
  if (word === 'eps') return /(?:^|[^a-z])eps(?:[^a-z]|$)/.test(text);
  return text.includes(word);
}

function typeFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return null;
  if (/\b(episode|episodes|season|seasons)\b/.test(t)) return 'tv';
  if (/\b(song|songs|album|albums|single|singles)\b/.test(t)) return 'musicRelease';
  if (/\b(movie|movies|film|films)\b/.test(t)) return 'film';
  return null;
}

export function classifyEntity(article = {}) {
  const cats = (article.categories || []).map(c => String(c).toLowerCase());
  if (cats.length) {
    for (const [type, words] of Object.entries(TYPE_KEYWORDS)) {
      if (cats.some(c => words.some(w => keywordInText(c, w)))) return type;
    }
  }
  const fromTitle = typeFromTitle(article.displayTitle || article.title || '');
  if (fromTitle) return fromTitle;
  if (article.coordinates) return 'place';
  return 'other';
}

export function resolveType(baseType, wd) {
  const wdType = typeFromWikidata(wd?.instanceOf);
  if (wdType && wdType !== 'person') return wdType;
  if (wd?.occupations?.some(q => MUSICIAN_QIDS.has(q))) return 'musicArtist';
  return wdType || baseType;
}

export function getContextualLinks(article = {}, type = 'other', wd = null) {
  const title = article.displayTitle || article.title || '';
  const q = encodeURIComponent(title);
  const pos = article.coordinates;
  const out = [];
  const add = (group, label, href, desc = '') => { if (href) out.push({ group, label, href, desc }); };

  if (type === 'place') {
    add('Maps', 'Google Maps', pos ? `https://www.google.com/maps/search/?api=1&query=${pos.lat},${pos.lon}` : `https://www.google.com/maps/search/?api=1&query=${q}`, 'Location on a map');
    add('Maps', 'OpenStreetMap', pos ? `https://www.openstreetmap.org/?mlat=${pos.lat}&mlon=${pos.lon}#map=13/${pos.lat}/${pos.lon}` : `https://www.openstreetmap.org/search?query=${q}`, 'Open map data');
    add('Travel', 'Wikivoyage', `https://en.wikivoyage.org/wiki/Special:Search?search=${q}`, 'Travel guide');
  }
  if (type === 'musicArtist') {
    add('Listen', 'Spotify', wd?.spotifyArtist ? `https://open.spotify.com/artist/${wd.spotifyArtist}` : `https://open.spotify.com/search/${q}`, 'Listen on Spotify');
    add('Listen', 'Apple Music', `https://music.apple.com/search?term=${q}`);
    add('Listen', 'YouTube Music', `https://music.youtube.com/search?q=${q}`);
    add('Listen', 'Last.fm', wd?.lastfm ? `https://www.last.fm/music/${encodeURIComponent(wd.lastfm)}` : `https://www.last.fm/search?q=${q}`);
    add('Listen', 'MusicBrainz', wd?.musicbrainzArtist ? `https://musicbrainz.org/artist/${wd.musicbrainzArtist}` : `https://musicbrainz.org/search?query=${q}&type=artist`);
    add('Read', 'Discogs', `https://www.discogs.com/search/?q=${q}&type=artist`);
    if (wd?.imdb) add('Profiles', 'IMDb', `https://www.imdb.com/name/${wd.imdb}`);
  }
  if (type === 'musicRelease') {
    add('Listen', 'Spotify', `https://open.spotify.com/search/${q}`, 'Search on Spotify');
    add('Listen', 'Apple Music', `https://music.apple.com/search?term=${q}`);
    add('Listen', 'YouTube Music', `https://music.youtube.com/search?q=${q}`);
    add('Listen', 'MusicBrainz', wd?.musicbrainzReleaseGroup ? `https://musicbrainz.org/release-group/${wd.musicbrainzReleaseGroup}` : `https://musicbrainz.org/search?query=${q}&type=release_group`);
    add('Read', 'Discogs', `https://www.discogs.com/search/?q=${q}&type=release`);
  }
  if (type === 'person') {
    if (wd?.officialWebsite) add('Official', 'Official website', wd.officialWebsite);
    if (wd?.imdb) add('Profiles', 'IMDb', `https://www.imdb.com/name/${wd.imdb}`);
    if (wd?.x) add('Profiles', 'X (Twitter)', wd.x);
    if (wd?.instagram) add('Profiles', 'Instagram', wd.instagram);
    add('Research', 'Google Scholar', `https://scholar.google.com/scholar?q=${q}`, 'Publications & citations');
    if (wd?.spotifyArtist) add('Listen', 'Spotify', `https://open.spotify.com/artist/${wd.spotifyArtist}`, 'Listen on Spotify');
  }
  const stream = () => {
    add('Streaming', 'JustWatch', `https://www.justwatch.com/us/search?q=${q}`, 'Where to stream');
    add('Streaming', 'Stremio (web)', `https://web.stremio.com/#/search?search=${q}`, 'Open in Stremio web');
    add('Streaming', 'Open in Stremio app', `stremio:///search?search=${q}`, 'Opens the Stremio app');
    if (wd?.netflixId) add('Streaming', 'Netflix', `https://www.netflix.com/title/${wd.netflixId}`, 'Watch on Netflix');
  };
  if (type === 'film') {
    stream();
    add('Details', 'IMDb', wd?.imdb ? `https://www.imdb.com/title/${wd.imdb}` : `https://www.imdb.com/find/?q=${q}`, 'Cast, crew, ratings');
    add('Details', 'TMDB', wd?.tmdbMovie ? `https://www.themoviedb.org/movie/${wd.tmdbMovie}` : `https://www.themoviedb.org/search?query=${q}`);
    add('Details', 'Rotten Tomatoes', wd?.rottenTomatoes ? `https://www.rottentomatoes.com/${wd.rottenTomatoes}` : `https://www.rottentomatoes.com/search?search=${q}`);
    add('Details', 'Letterboxd', `https://letterboxd.com/search/${q}`, 'Reviews & lists');
  }
  if (type === 'tv') {
    stream();
    add('Details', 'IMDb', wd?.imdb ? `https://www.imdb.com/title/${wd.imdb}` : `https://www.imdb.com/find/?q=${q}`);
    add('Details', 'TMDB', wd?.tmdbTv ? `https://www.themoviedb.org/tv/${wd.tmdbTv}` : `https://www.themoviedb.org/search/tv?query=${q}`);
    add('Details', 'Rotten Tomatoes', wd?.rottenTomatoes ? `https://www.rottentomatoes.com/${wd.rottenTomatoes}` : `https://www.rottentomatoes.com/search?search=${q}`);
    add('Details', 'Trakt', `https://trakt.tv/search?query=${q}`);
  }
  if (type === 'game') {
    add('Play', 'Steam', wd?.steamAppId ? `https://store.steampowered.com/app/${wd.steamAppId}` : `https://store.steampowered.com/search/?term=${q}`);
    add('Play', 'GOG', `https://www.gog.com/en/games?query=${q}`);
    add('Play', 'Epic Games', `https://store.epicgames.com/en-US/browse?q=${q}&sortBy=relevancy`);
    add('Details', 'IGDB', `https://www.igdb.com/search?type=1&q=${q}`);
    add('Details', 'HowLongToBeat', wd?.hltbId ? `https://howlongtobeat.com/game/${wd.hltbId}` : `https://howlongtobeat.com/?q=${q}`);
    add('Details', 'PCGamingWiki', wd?.pcgamingwikiId ? `https://www.pcgamingwiki.com/wiki/${encodeURIComponent(wd.pcgamingwikiId)}` : `https://www.pcgamingwiki.com/w/index.php?search=${q}`);
    add('Details', 'MobyGames', wd?.mobygamesId ? `https://www.mobygames.com/game/${wd.mobygamesId}` : `https://www.mobygames.com/search/?q=${q}`);
    add('Details', 'Metacritic', `https://www.metacritic.com/search/${q}/`);
  }
  if (type === 'vehicle') {
    if (wd?.officialWebsite) add('Official', 'Official website', wd.officialWebsite);
    add('Details', 'Wikipedia search', `https://en.wikipedia.org/w/index.php?search=${q}`);
  }
  if (type === 'company') {
    if (wd?.officialWebsite) add('Official', 'Official website', wd.officialWebsite);
    add('Profiles', 'LinkedIn', `https://www.linkedin.com/search/results/companies/?keywords=${q}`);
  }
  if (type === 'book') {
    add('Read', 'Open Library', wd?.openLibrary ? `https://openlibrary.org/books/${wd.openLibrary}` : `https://openlibrary.org/search?q=${q}`, 'Borrow & details');
    add('Read', 'Goodreads', `https://www.goodreads.com/search?q=${q}`, 'Reviews & ratings');
    add('Details', 'Wikipedia search', `https://en.wikipedia.org/w/index.php?search=${q}`);
  }
  if (type === 'species') {
    add('Nature', 'iNaturalist', `https://www.inaturalist.org/search?q=${q}`, 'Observations & photos');
    add('Nature', 'IUCN Red List', `https://www.iucnredlist.org/search?query=${q}&searchType=species`, 'Conservation status');
  }
  if (out.length === 0) {
    add('Generic', 'Wikipedia', `https://en.wikipedia.org/wiki/Special:Search?search=${q}`);
    add('Generic', 'Google', `https://www.google.com/search?q=${q}`);
  }
  return out;
}
