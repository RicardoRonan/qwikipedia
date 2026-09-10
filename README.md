# Qwikipedia

A personalized Wikipedia feed that learns what you like - built with vanilla HTML, CSS, and JavaScript.

## Features

- **Infinite scroll feed** of Wikipedia articles with images, title, and extract
- **Like / Not interested / Skip** interactions that train a local recommendation engine
- **Light / Dark / System** theme with instant toggle
- **Text size slider** (80%–130%) with live preview
- **Wikipedia language selector** (English, Simple English, French, and more)
- **Supabase auth** (email/password) for cross-device preference sync
- **Wikipedia username link** - connect your Wikipedia profile
- **No server needed** - recommendation logic runs entirely in your browser
- **All data stays on your device** unless you sign in (then only theme + text size sync to the cloud)

## Quick Start

1. Clone or download this folder
2. Open `index.html` in a browser - it works without any build step
3. *(Optional)* Follow `SUPABASE_SETUP.md` to enable login and preference sync

## File Structure

| File | Purpose |
|------|---------|
| `index.html` | App shell, nav, settings page markup, auth modal |
| `styles.css` | All styles: light/dark themes, typography scale, layout |
| `app.js` | Bootstrap, feed rendering, routing, auth modal logic |
| `ui.js` | Shared loading, empty/error, and button-state helpers |
| `engine.js` | Recommendation engine: weights, interaction recording, feed batch |
| `wiki.js` | Wikipedia API adapters (REST summary, search, random, featured) |
| `storage.js` | Single interface for all localStorage read/write |
| `settings.js` | Theme + text scale controls, account/profile section |
| `auth.js` | Supabase Auth: sign in, sign up, session, profile table CRUD |
| `ai.js` | AI layer: YouTube query generation, search refinement (Edge Function + heuristics) |
| `ai-heuristics.js` | Local fallbacks when the AI helper is offline |
| `supabase/functions/ai/` | Supabase Edge Function (Groq) — see `AI_SETUP.md` |

### AI enhancements (optional)

Deploy the `ai` Edge Function with a free [Groq](https://console.groq.com) API key to refine searches and YouTube queries. Without deployment, local heuristics still improve results. See **`AI_SETUP.md`**.

## Data Sources

- **Wikimedia REST API** - article summaries and thumbnails
  - `https://en.wikipedia.org/api/rest_v1/page/summary/{title}`
- **MediaWiki Action API** - search and random articles
  - `https://en.wikipedia.org/w/api.php`
- **Wikimedia Featured Content API** - featured article of the day

## Wikimedia API Rate-Limit Compliance

Qwikipedia follows the [Wikimedia API rate-limit best practices](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits)
being phased in during 2026. The goal is to stay well inside the **200 requests/minute** bucket
for anonymous browser traffic and avoid the much stricter **10/min** "unidentified" classification.

**What we do:**

| Practice | Implementation |
|----------|----------------|
| Browser User-Agent | We rely on the browser's built-in `User-Agent` header, which puts us in the "Requests made from a web browser by an unauthenticated user" 200/min bucket. We deliberately **don't** send a custom `Api-User-Agent` header because any non-safelisted header on a cross-origin `fetch` triggers a CORS preflight `OPTIONS` request - doubling the request count against Wikimedia's per-IP limit. |
| Max 3 concurrent requests | `CONCURRENCY = 2` in `wiki.js` - always under the guideline |
| Soft per-minute cap | `REQUESTS_PER_MINUTE_CAP = 80` sliding-window throttle in `wiki.js` - stays far under 200/min |
| Respect `Retry-After` | `parseRetryAfterMs()` honors the server header, capped at 30s to avoid stale long backoffs |
| Exponential fallback on network errors | 600ms, 1200ms, 1800ms between transient retries (max 2 attempts) |
| Aggressive local caching | LRU of up to 140 REST summaries in `localStorage` (8-day TTL) - cached articles render instantly and are served silently during backoff |
| No credentials | `credentials: 'omit'` on all Wikimedia requests |
| Conservative batch sizes | 8 articles per load, 10-title random pool, 6-title topic search |
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

1. Each article is tagged with inferred topics (science, history, technology, arts, etc.)
2. When you `Like` an article, those topics gain weight (+2)
3. `Not interested` drops topic weights (-3)
4. `Skip` is a small negative signal (-0.5)
5. New batches are 70% weighted-topic search, 30% random exploration
6. Diversity rules cap repeat topics per batch
7. Weights decay slightly each session to prevent the feed from getting too narrow

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
