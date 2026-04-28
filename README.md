# ScrollWiki

A personalized Wikipedia feed that learns what you like — built with vanilla HTML, CSS, and JavaScript.

## Features

- **Infinite scroll feed** of Wikipedia articles with images, title, and extract
- **Like / Not interested / Skip** interactions that train a local recommendation engine
- **Light / Dark / System** theme with instant toggle
- **Text size slider** (80%–130%) with live preview
- **Wikipedia language selector** (English, Simple English, French, and more)
- **Supabase auth** (email/password) for cross-device preference sync
- **Wikipedia username link** — connect your Wikipedia profile
- **No server needed** — recommendation logic runs entirely in your browser
- **All data stays on your device** unless you sign in (then only theme + text size sync to the cloud)

## Quick Start

1. Clone or download this folder
2. Open `index.html` in a browser — it works without any build step
3. *(Optional)* Follow `SUPABASE_SETUP.md` to enable login and preference sync

## File Structure

| File | Purpose |
|------|---------|
| `index.html` | App shell, nav, settings page markup, auth modal |
| `styles.css` | All styles: light/dark themes, typography scale, layout |
| `app.js` | Bootstrap, feed rendering, routing, auth modal logic |
| `engine.js` | Recommendation engine: weights, interaction recording, feed batch |
| `wiki.js` | Wikipedia API adapters (REST summary, search, random, featured) |
| `storage.js` | Single interface for all localStorage read/write |
| `settings.js` | Theme + text scale controls, account/profile section |
| `auth.js` | Supabase Auth: sign in, sign up, session, profile table CRUD |

## Data Sources

- **Wikimedia REST API** — article summaries and thumbnails
  - `https://en.wikipedia.org/api/rest_v1/page/summary/{title}`
- **MediaWiki Action API** — search and random articles
  - `https://en.wikipedia.org/w/api.php`
- **Wikimedia Featured Content API** — featured article of the day

## How the Algorithm Works

1. Each article is tagged with inferred topics (science, history, technology, arts, etc.)
2. When you `Like` an article, those topics gain weight (+2)
3. `Not interested` drops topic weights (-3)
4. `Skip` is a small negative signal (-0.5)
5. New batches are 70% weighted-topic search, 30% random exploration
6. Diversity rules cap repeat topics per batch
7. Weights decay slightly each session to prevent the feed from getting too narrow

## Privacy

- No tracking, no analytics, no ads
- Recommendation data never leaves your device
- If signed in: only theme + text scale preferences are saved to Supabase
- Wikipedia API calls go directly from your browser to Wikipedia's servers
