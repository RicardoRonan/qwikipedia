# Qwikipedia

A personalized Wikipedia feed that learns what you like - built with vanilla HTML, CSS, and JavaScript.

## Features

- **In-app image viewer** with swipe, arrows, and a link out to the original file
- **Pronunciation (browser speech)** on feed cards
- **Infinite scroll feed** of Wikipedia articles with images, title, and extract
- **Like / Not interested / Skip** interactions that train a local recommendation engine
- **Saved for later** list and **Liked** history, both synced when signed in
- **Deep Dive** research panel on every card (free-courses, e-books, AI search, video, maps)
- **Context-aware links** (maps, official sites, Spotify) and an inline **Images** tab from Wikimedia Commons
- **Feed interests filter** - see and change the topics shaping your feed from the feed itself
- **New-articles pill** when background refresh brings in fresh content
- **Feather Icons** (v4.29.0, MIT) - single vendored icon pack, no runtime dependency
- **Light / Dark / System** theme with instant toggle
- **Text size slider** (80%-130%) with live preview
- **Wikipedia language selector** (English, Simple English, French, and more)
- **Supabase auth** (email/password) for cross-device preference sync
- **No server needed** - recommendation logic runs entirely in your browser
- **All data stays on your device** unless you sign in
- **Installable PWA** - add to your home screen and keep using the app offline

## Quick Start

1. Clone or download this folder
2. Open `index.html` in a browser - it works without any build step
3. *(Optional)* Follow `SUPABASE_SETUP.md` to enable login and preference sync

## File Structure

| File | Purpose |
|------|---------|
| `index.html` | App shell, nav, onboarding, settings/account/search/saved pages, auth modal, lightbox |
| `styles.css` | All styles: light/dark themes, tokens, typography scale, layout (design-system source of truth) |
| `app.js` | Bootstrap, feed rendering, infinite scroll, saved/likes, routing, card actions |
| `engine.js` | Recommendation engine: topic weights, interaction recording, feed batch assembly |
| `wiki.js` | Wikimedia adapters: batched Action API, REST summary, search, random, featured, Commons/Wikidata fetchers, rate-limit limiter |
| `entity.js` | Article type classification and context-aware external links |
| `cache.js` | Supabase-backed article cache (prefetch, warm, prune) |
| `deepdive.js` | Deep Dive research panel (tabbed links + Commons images per article) |
| `icons.js` | Feather Icons v4.29.0 (MIT) SVG strings |
| `search.js` | Search page and result cards |
| `storage.js` | Single interface for all localStorage read/write |
| `settings.js` | Theme, text scale, interests, account/profile sections |
| `auth.js` | Supabase Auth: sign in, sign up, session, profile table CRUD |
| `account.js` | Account page rendering |
| `ai.js` | AI layer: YouTube query generation, search refinement (Edge Function + heuristics) |
| `ai-heuristics.js` | Local fallbacks when the AI helper is offline |
| `text-utils.js` | Text cleaning/normalisation helpers |
| `ui.js` | Shared loading, empty/error, and button-state helpers |
| `toast.js` | Toast notifications |
| `usePullToRefresh.js` | Pull-to-refresh hook |
| `sw.js` | Service worker: app-shell + vendor CDN + Wikimedia API/asset caching |
| `pwa-install.js` | Install prompt and Settings → App affordance |
| `manifest.webmanifest` | PWA manifest (relative `start_url` / `scope`) |
| `icons/` | Generated app icons (192, 512, maskable, Apple touch) |
| `supabase/functions/ai/` | Supabase Edge Function (Groq) - see `AI_SETUP.md` |

## PWA / Install

Qwikipedia is an installable Progressive Web App. There is no build step: open `index.html` over `http://localhost` or HTTPS, then install from the browser (Chrome/Edge: address-bar install or Settings → App → Install app; iOS Safari: Share → Add to Home Screen).

After the first visit, the service worker precaches the app shell (`manifest.webmanifest`, styles, scripts, and `icons/`) and caches jsDelivr vendor scripts so the feed, saved list, and navigation keep working offline. Wikipedia random endpoints are never cached.

### AI enhancements (optional)

Deploy the `ai` Edge Function with a free [Groq](https://console.groq.com) API key to refine searches and YouTube queries. Without deployment, local heuristics still improve results. See **`AI_SETUP.md`**.

## Data Sources

- **MediaWiki Action API** (primary) - batched article data in one request:
  `prop=extracts|pageimages|categories|coordinates|pageprops` (intro text, thumbnail, categories, coords, Wikidata QID), plus
  `list=random` / `generator=random` and `list=search`. Endpoint: `https://<lang>.wikipedia.org/w/api.php`
- **Wikimedia REST API** - single-article summaries for previews and Deep Dive:
  `https://<lang>.wikipedia.org/api/rest_v1/page/summary/{title}`
- **Wikimedia Featured Content API** - featured article of the day
- **Wikidata** (`wbgetentities`) - lazy, batched, cached claims (`P31`, official site, Spotify, socials) when a Deep Dive panel opens for an article with a QID
- **Wikimedia Commons** - lazy, cached image search for the Deep Dive Images tab (key-free)

## Wikimedia API Rate-Limit Compliance

Qwikipedia follows the [Wikimedia API rate-limit best practices](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)
being phased in during 2026. The goal is to stay well inside the **200 requests/minute** bucket
for anonymous browser traffic and avoid the much stricter **10/min** "unidentified" classification.

**What we do:**

| Practice | Implementation |
|----------|----------------|
| Browser User-Agent | We rely on the browser's built-in `User-Agent` header, which puts us in the "Requests made from a web browser by an unauthenticated user" 200/min bucket. We deliberately **don't** send a custom `Api-User-Agent` header because any non-safelisted header on a cross-origin `fetch` triggers a CORS preflight `OPTIONS` request - doubling the request count against Wikimedia's per-IP limit. |
| Max 3 concurrent requests | `CONCURRENCY = 3` in `wiki.js` - matches the Wikimedia guideline |
| Soft per-minute cap | `REQUESTS_PER_MINUTE_CAP = 80` sliding-window throttle in `wiki.js` - stays far under 200/min |
| Respect `Retry-After` | `parseRetryAfterMs()` honors the server header, capped at 30s to avoid stale long backoffs |
| Exponential fallback on network errors | 600ms, 1200ms, 1800ms between transient retries (max 2 attempts) |
| Aggressive local caching | LRU of up to 140 REST summaries in `localStorage` (8-day TTL) - cached articles render instantly and are served silently during backoff |
| No credentials | `credentials: 'omit'` on all Wikimedia requests |
| Batched, conservative requests | Article data (extract + thumbnail + categories) fetched in a single Action API request; 10 articles per load, 12-title random pool, 8-title topic search |
| Batched Supabase writes | Cached articles are queued and upserted in one request per language, not one per article |
| Background refresh | Cached-first rendering + silent background fetch; only first-run shows the % spinner |

**Rate-limit cheat sheet (from the official policy):**

| Client type | Limit |
|-------------|-------|
| Unidentified (IP only) | **10 req/min** |
| Browser, unauthenticated | **200 req/min** |
| User-Agent identified | **200 req/min** |
| Authenticated, new user | **200 req/min** |
| Authenticated, established editor | **2000 req/min** |
| Authenticated with bot flag | Exempt |

On a `429 Too Many Requests` or `503 Service Unavailable`, Qwikipedia pauses new requests until `Retry-After` elapses and keeps serving from the local cache - no silent failures, no request flood.

## How the Algorithm Works

1. Each article is tagged with inferred topics (science, history, technology, arts, etc.) from its Wikipedia categories
2. `Like` adds weight to those topics (+2); `Not interested` drops them (-3); `Skip` is a small negative (-0.5)
3. Each batch is built from one weighted-topic search plus a random-title pool, filtered by seen/dismissed history
4. Diversity rules cap how many articles from one topic appear per batch
5. When the user has selected interests, articles are filtered to those topics
6. Weights decay slightly each session so the feed never narrows permanently

## Cloud Sync (Supabase)

When a user is signed in, local state is kept in sync with their `profiles` row in Supabase (see `supabase_profiles_extend.sql` for required columns):

| Field | Column | Type |
|-------|--------|------|
| Theme (`light` / `dark` / `system`) | `theme` | `text` |
| Text scale (80–130) | `text_scale` | `int4` |
| Wikipedia language code | `wiki_lang` | `text` |
| Selected interest ids | `interests` | `jsonb` |
| Topic interest weights | `topic_weights` | `jsonb` |
| Engine session count | `session_count` | `int4` |
| Liked article titles | `liked_titles` | `jsonb` |
| Liked article cards (title, extract, image, etc.) | `liked_articles` | `jsonb` |
| Seen / dismissed titles | `seen_titles`, `dismissed_titles` | `jsonb` |
| Aggregate stats (seen / liked / dismissed / time) | `usage_stats` | `jsonb` |
| Onboarding completed | `onboarded` | `boolean` |
| AI enhancements toggle | `ai_enabled` | `boolean` |
| Saved article titles | `saved_titles` | `jsonb` |
| Saved article cards | `saved_articles` | `jsonb` |
| Wikipedia username (optional) | `wikipedia_username` | `text` |

**How it works:**

- On sign-in → `pullPrefsFromCloud()` merges cloud data into `localStorage`, then `syncPrefsToCloud()` uploads the merged state (likes, saved, AI toggle, algo, stats).
- Whenever the user changes a preference (theme, text scale, language, interests, AI toggle, like/dismiss/save), `scheduleSyncPrefs()` queues a debounced upsert (700 ms quiet window).
- On page hide, any pending change is flushed immediately so a user closing the tab never loses pref state.
- Topic weights are merge-only: an empty cloud row never wipes locally chosen interests.
- Brand-new accounts (no `profiles` row yet) are seeded with the user's local prefs on first sign-in.

RLS policies on `profiles` ensure users can only read/upsert their own row (`auth.uid() = id`).

## Privacy

- No tracking, no analytics, no ads
- Article history (seen / liked / dismissed titles, liked article previews, and usage stats) is **uploaded when you are signed in** so you can continue on another device. It is stored only in your own `profiles` row and subject to Supabase RLS.
- All Wikipedia API calls go directly from your browser to Wikipedia's servers
- If you're signed out, nothing is sent to Supabase

Built by [thedevricardo](https://thedevricardo.netlify.app)

## Credits & Acknowledgements

- Inspired by [Xikipedia](https://xikipedia.org) by [rebane2001](https://github.com/rebane2001) - an independent demonstration of local, non-ML feed ranking. Qwikipedia is an independent, unaffiliated re-imagining with a different architecture (live Wikipedia APIs, multi-language support, accounts and cloud sync). **No Xikipedia code is used in this project.**
- Article text and images are sourced from Wikipedia under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); see the [MediaWiki API](https://www.mediawiki.org/wiki/API:Main_page) terms of use.

## License

Released under the [MIT License](./LICENSE). © 2026 thedevricardo.

Qwikipedia is an independent project and is **not affiliated with, endorsed by, or sponsored by** the Wikimedia Foundation, Wikipedia, or Xikipedia.
