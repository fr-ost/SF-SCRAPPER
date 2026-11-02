# SF Scrapper: TwitterScore Smart Followers (Chrome MV3)

SF Scrapper is a Chrome extension that pulls the smart followers of any X/Twitter account from the
[TwitterScore API](https://twitterscore.gitbook.io/twitterscore/developers/api-documentation).
It can skip followers below a minimum score and saves the rest in a local database that you can
search and export.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, and click **Load unpacked**. Select this folder.
2. The dashboard opens on **Settings**. Paste your TwitterScore API key and click **Save**.
3. Click **Test API** with any username. It uses 1 request and shows the raw response along with the record that would be stored.
4. Go to **Scan**, paste your usernames, set **Min score**, and click **Start scraping**.

You can also start scans from the toolbar popup. The scan runs in the background, so you can close the popup or the dashboard while it works.

## How it gets the most out of your plan (300 req/min, 250k/month)

| Technique | Effect |
|---|---|
| A global limiter spaces requests evenly and also checks a 60-second sliding window | Uses the full per-minute budget without triggering 429s. The default is 295/min to leave a small margin. |
| Several accounts are scanned in parallel (8 by default), with 3 pages per account in flight | The limiter stays busy even when the API is slow (24 requests in flight). |
| **Early stop.** `get_followers` is sorted by score, so once a page drops below your min score the account is finished | Pages of low-score followers are never fetched. This is usually the largest saving. |
| Page 1 is fetched first for each account | Unknown or invalid usernames cost 1 request, not a whole batch of pages. |
| On a 429, every request pauses for `Retry-After` and the same page is retried | No data is lost. |
| Monthly counter, with the stop point set by the "Monthly request limit" setting | Scanning stops automatically when the quota is used up. **Check plan limits** calls `/limits` so you can sync the counter with the server. |
| A hidden offscreen page pings the background worker every 20 s, plus API keep-alive calls | Chrome doesn't stop the worker while a scan runs, so scans can go for hours. |
| State is saved continuously; restarts come from the ping or a 30-second alarm | If Chrome kills the worker anyway, the scan resumes within seconds from where it stopped. |
| Watchdog | If requests stop completing for 3 minutes (a hung connection), the worker loops restart and the pages in flight are fetched again. |
| An HTTP 401/403 for one account skips only that account | Only a clearly invalid key, or 6 auth failures in a row, stops the engine. The stop reason appears in the status line and the Log tab. |

In a test against a mock server rate-limited at 300/min, the extension held about 292 req/min with
zero 429s, which is roughly 7,300 followers saved per minute at 25 per page.

## Run button and toolbar icon

The big **Run** button sits at the top of the popup and the dashboard. While a scan is running it turns green, pulses, and reads **Running · Stop**; click it to stop. When scans are paused it reads **Resume**.
While a scan is running, the toolbar icon gets a green ▶ and a badge showing how many accounts are left. When scans are paused the badge shows **II**.

The icon in `icons/` is an original design. To use TwitterScore's own logo, replace `icons/icon16.png`, `icon32.png`, `icon48.png` and `icon128.png` (plus the `-run` versions) with PNGs of the same size and name, then click reload in `chrome://extensions`.

## Skipping accounts already scanned

**Skip accounts already scanned before** is on by default, in the popup and on the Scan tab. An account that already has a *completed* scan in **Scan history** is skipped and costs 0 requests. The message after you click Start lists which accounts were skipped.
- Untick the box to rescan anyway. The setting is remembered.
- **Settings → "rescan if the last scan is older than N days"** allows an automatic rescan once the data gets old. 0 means never.
- Scans that failed or were stopped part-way don't count as scanned, so those accounts are always retried.

## Filters

- **💾 Save as default** (next to Min score in the popup and on the Scan tab) remembers your min score, plus the category and tag filters on the Scan tab, for every new scan.
- **Min score:** only followers with `twitter_score ≥ min` are saved. Followers below it are neither scraped (thanks to early stop) nor stored.
- **Category / Tag / Tag-category:** these are the API's server-side filters (`category_id`, `tag_id`, `tag_category_id`). Click **Load categories & tags** to fill the dropdowns. This costs 2 requests, and the results are cached.

## Database

The database is stored in IndexedDB inside the extension (`unlimitedStorage`), so it can hold millions of rows.

**`followers`** has **one row per smart account, with no duplicates.** Its key is the lower-case username.
If the same person is found again, from another scanned account or in a later scan, the existing row is updated. No second row is ever created.

| Field | Meaning |
|---|---|
| `scan_time` | When this account was last scraped (ISO). |
| `score` | Twitter Score, taken from the latest scan. |
| `username`, `name`, `twitter_id`, `url` | Identity of the follower. |
| `followers_count`, `description`, `profile_image` | Profile data. |
| `tags`, `categories` | TwitterScore tags and categories (names). |
| `subscribed_at` | When TwitterScore first saw the follow. |
| `first_seen_at`, `scan_count` | When the account was first stored, and how many scans have seen it. |
| `scan_id`, `page`, `min_score_filter` | Which scan last updated the row, and the settings it used. |
| `raw` | **The complete API object from the latest scan, unchanged.** |

Databases from older versions are converted to this format automatically: duplicate rows are merged and the old "scanned from" fields are removed. Which accounts you scanned is still recorded in **Scan history**.
The **🧬 Remove duplicates** button in the Database tab re-checks and merges everything on demand.

**`scans`** has one row per account scan: source, status, min score, filters, start and finish times, pages, requests, found, saved, new, skipped, and the error or stop reason.

In the **Database** tab you can:

- Search, filter by score range, sort, and page through results.
- **🧹 Clean database:** remove saved accounts whose score is below a value, with a preview count first. The Scan tab has a quick **Remove saved below this score** button that uses the current min score.
- Export to **XLSX** (Excel) or **CSV**. Every API field is added as an `api_*` column or **JSON** (a full backup), or clear everything.
- **Import XLSX / JSON:** import a spreadsheet or JSON backup. The sheet needs at least a `username` column. Imported rows are merged by username, so importing never creates duplicates.

## Settings reference

The endpoint, parameter names, page size, and auth mode (`?api_key=` or the `X-API-Key` header) are all editable.
If TwitterScore changes the API, you can adapt to it without changing any code. A numeric input in the username list is sent as `twitter_id`.

## Files

```
manifest.json      MV3 manifest
background.js      scraping engine (rate limiter, scheduler, retries, quota, resume)
lib/api.js         settings, URL building, response parsing, normalisation
lib/db.js          IndexedDB layer (followers + scans, purge below score)
lib/xlsx.js        dependency-free XLSX writer/reader
icons/             toolbar icons (idle + running)
popup.html         quick-start popup
dashboard.html     full dashboard: Scan / Database / Scan history / Settings / Log
ui/*.js, ui/*.css  UI code
```
