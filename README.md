<div align="center">

<img width="100%" alt="SF Scrapper — TwitterScore smart followers, a Chrome MV3 extension" src="https://capsule-render.vercel.app/api?type=waving&amp;color=0:6C2BD9,50:FF2E93,100:FFB703&amp;height=210&amp;section=header&amp;text=SF%20Scrapper&amp;fontSize=56&amp;fontColor=ffffff&amp;fontAlignY=30&amp;animation=fadeIn&amp;desc=TwitterScore%20smart%20followers%20%C2%B7%20Chrome%20MV3&amp;descAlignY=62&amp;descAlign=50&amp;descSize=18"/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://readme-typing-svg.demolab.com?font=Fira+Code&amp;weight=600&amp;size=22&amp;duration=3600&amp;pause=700&amp;color=FFB703&amp;center=true&amp;vCenter=true&amp;width=820&amp;height=48&amp;lines=Smart+followers+from+the+TwitterScore+API;Local+IndexedDB+%C2%B7+search%2C+clean%2C+export;Early+stop+keeps+your+quota;Scan+from+the+popup+or+the+dashboard" />
  <source media="(prefers-color-scheme: light)" srcset="https://readme-typing-svg.demolab.com?font=Fira+Code&amp;weight=600&amp;size=22&amp;duration=3600&amp;pause=700&amp;color=6C2BD9&amp;center=true&amp;vCenter=true&amp;width=820&amp;height=48&amp;lines=Smart+followers+from+the+TwitterScore+API;Local+IndexedDB+%C2%B7+search%2C+clean%2C+export;Early+stop+keeps+your+quota;Scan+from+the+popup+or+the+dashboard" />
  <img width="820" alt="Smart followers from the TwitterScore API. Stored in local IndexedDB. Early stop keeps your quota. Scan from the popup or the dashboard." src="https://readme-typing-svg.demolab.com?font=Fira+Code&amp;weight=600&amp;size=22&amp;duration=3600&amp;pause=700&amp;color=6C2BD9&amp;center=true&amp;vCenter=true&amp;width=820&amp;height=48&amp;lines=Smart+followers+from+the+TwitterScore+API;Local+IndexedDB+%C2%B7+search%2C+clean%2C+export;Early+stop+keeps+your+quota;Scan+from+the+popup+or+the+dashboard" />
</picture>

*Pull the smart followers of any X account, skip scores you do not want, and keep the rest in a local database you can search and export.*

<br/>

<img alt="Chrome extension, Manifest V3" src="https://img.shields.io/badge/Chrome_MV3-6C2BD9?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white"/>
<img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&amp;logo=javascript&amp;logoColor=1A1024"/>
<img alt="HTML" src="https://img.shields.io/badge/HTML-E34F26?style=for-the-badge&amp;logo=html5&amp;logoColor=white"/>
<img alt="IndexedDB" src="https://img.shields.io/badge/IndexedDB-FF2E93?style=for-the-badge"/>
<img alt="TwitterScore API" src="https://img.shields.io/badge/TwitterScore_API-FFB703?style=for-the-badge&amp;logoColor=1A1024"/>
<img alt="Version 1.5.0" src="https://img.shields.io/badge/v1.5.0-6C2BD9?style=for-the-badge"/>

</div>

## ✨ Overview

**SF Scrapper** is a Chrome extension (Manifest V3, version 1.5.0) that pulls the smart followers of any X/Twitter account from the [TwitterScore API](https://twitterscore.gitbook.io/twitterscore/developers/api-documentation). It can skip followers below a minimum score and saves the rest in a local database that you can search and export.

The extension talks only to `https://twitterscore.io/*`. Followers and scan history live in IndexedDB inside the extension (`unlimitedStorage`), so the database can hold millions of rows. There is no build step and no remote account for the extension itself.

Two surfaces share the same engine:

| Surface | What it is for |
| --- | --- |
| **Toolbar popup** | Paste usernames, set a min score, start a scan, and watch session counts. |
| **Dashboard** | Full workspace: **Scan**, **Database**, **Scan history**, **Settings**, and **Log**. |

On install, the dashboard opens on **Settings**. A scan runs in the background service worker, so you can close the popup or the dashboard while it works.

## ⚡ Key features

- **Score filter with early stop.** `get_followers` is sorted by score. Once a page drops below your min score, that account is finished and low-score pages are never fetched.
- **One row per account.** The `followers` store is keyed by lower-case username. The same person found from another account, or in a later scan, updates the existing row.
- **Skip work you already did.** A completed scan in **Scan history** is skipped and costs 0 requests. Failed or stopped scans are always retried.
- **Server-side filters.** Optional `category_id`, `tag_id`, and `tag_category_id`, loaded from the API and cached.
- **Search, clean, export, import.** Filter the local database, drop rows below a score, and move data as XLSX, CSV, or JSON.
- **Quota-aware engine.** A global limiter, parallel accounts, 429 pauses, a monthly counter, and automatic resume if Chrome restarts the worker.
- **Adaptable API settings.** Endpoint, parameter names, page size, and auth mode are editable, so a TwitterScore API change does not require a code change.

## 🧰 Tech stack

| Piece | Role |
| --- | --- |
| Chrome Manifest V3 | Service worker, action popup, options page, alarms, offscreen document |
| Vanilla JavaScript (ES modules) | Scraping engine, API client, dashboard, popup |
| IndexedDB (`sf-scrapper`) | `followers` and `scans` stores |
| `lib/xlsx.js` | Dependency-free XLSX writer and reader |
| TwitterScore HTTP API | `https://twitterscore.io/api/v1` by default |

Permissions are `storage`, `unlimitedStorage`, `alarms`, and `offscreen`. The only host permission is `https://twitterscore.io/*`.

## 🚀 Getting started

1. Open `chrome://extensions`, turn on **Developer mode**, and click **Load unpacked**. Select this folder.
2. The dashboard opens on **Settings**. Paste your TwitterScore API key and click **Save**.
3. Click **Test API** with any username. It uses 1 request and shows the raw response along with the record that would be stored.
4. Go to **Scan**, paste your usernames, set **Min score**, and click **Start scraping**.

You can also start scans from the toolbar popup. The scan runs in the background, so you can close the popup or the dashboard while it works.

Usernames accept one per line, commas, `@handles`, `x.com` / `twitter.com` links, or a numeric Twitter id. A numeric value in the list is sent as `twitter_id`.

## ⚙️ Configuration

There are no environment variables and no `.env` file. Everything is saved in the extension with `chrome.storage.local` under the setting name `settings`. Paste the API key in the dashboard. It is stored locally as `apiKey` and is never written into the repo.

**Settings → Reset to defaults** restores the table below and keeps the current API key.

| Setting | Default | What it controls |
| --- | --- | --- |
| `apiKey` | empty | TwitterScore API key. Set this in the password field on **Settings**. |
| `baseUrl` | `https://twitterscore.io/api/v1` | API origin and version prefix. |
| `endpoint` | `get_followers` | Paginated followers list, sorted by score. |
| `userParam` | `username` | Query name for a handle. A numeric id uses `twitter_id` instead. |
| `pageParam` | `page` | Page query name. |
| `sizeParam` | `size` | Page-size query name. |
| `pageSize` | `25` | Followers requested per page. |
| `firstPage` | `1` | First page index. |
| `authMode` | `query` | `query` sends `?api_key=`, `header` sends `X-API-Key`, `both` sends both. |
| `extraParams` | empty | Raw query string appended to every followers request. |
| `rpm` | `295` | Requests-per-minute target. The plan limit called out in the UI is 300; 295 leaves a small margin. |
| `monthlyLimit` | `250000` | Local stop point for the month. The UI labels the plan as 250,000. |
| `maxConcurrent` | `24` | Maximum HTTP requests in flight. |
| `parallelAccounts` | `8` | Usernames scanned at the same time. |
| `pageWindow` | `3` | Pages of one account fetched in parallel, after page 1. |
| `maxPagesPerAccount` | `0` | `0` means no page cap. |
| `earlyStop` | on | Stop an account once a page falls below the min score. |
| `requestTimeoutMs` | `30000` | Per-request timeout. |
| `defaultMinScore` | `0` | Min score remembered for new scans. |
| `skipScanned` | on | Skip accounts that already have a completed scan. |
| `rescanAfterDays` | `0` | `0` means never rescan automatically. `N` allows a rescan once the last scan is older than N days. |
| `defaultFilters` | empty ids | Saved `category_id`, `tag_id`, and `tag_category_id`. |

**Check plan limits** calls `/limits` so you can sync the local monthly counter with the server. **Correct local monthly counter** on the same panel overwrites that counter without calling the API.

## 🧭 Usage

### Run button and toolbar icon

The big **Run** button sits at the top of the popup and the dashboard. While a scan is running it turns green, pulses, and reads **Running · Stop**; click it to stop. When scans are paused it reads **Resume**.

While a scan is running, the toolbar icon gets a green ▶ and a badge showing how many accounts are left. When scans are paused the badge shows **II**.

The icon in `icons/` is an original design. To use TwitterScore's own logo, replace `icons/icon16.png`, `icon32.png`, `icon48.png` and `icon128.png` (plus the `-run` versions) with PNGs of the same size and name, then click reload in `chrome://extensions`.

### Skipping accounts already scanned

**Skip accounts already scanned before** is on by default, in the popup and on the Scan tab. An account that already has a *completed* scan in **Scan history** is skipped and costs 0 requests. The message after you click Start lists which accounts were skipped.

- Untick the box to rescan anyway. The setting is remembered.
- **Settings → "rescan if the last scan is older than N days"** allows an automatic rescan once the data gets old. 0 means never.
- Scans that failed or were stopped part-way do not count as scanned, so those accounts are always retried.

### Filters

- **💾 Save as default** (next to Min score in the popup and on the Scan tab) remembers your min score, plus the category and tag filters on the Scan tab, for every new scan.
- **Min score:** only followers with `twitter_score ≥ min` are saved. Followers below it are neither scraped (thanks to early stop) nor stored.
- **Category / Tag / Tag-category:** these are the API's server-side filters (`category_id`, `tag_id`, `tag_category_id`). Click **Load categories & tags** to fill the dropdowns. This costs 2 requests, and the results are cached.

### Database

The database is stored in IndexedDB inside the extension (`unlimitedStorage`), so it can hold millions of rows.

**`followers`** has **one row per smart account, with no duplicates.** Its key is the lower-case username (or `twitter_id` when there is no username). If the same person is found again, from another scanned account or in a later scan, the existing row is updated. No second row is ever created.

| Field | Meaning |
| --- | --- |
| `scan_time` | When this account was last scraped (ISO). |
| `score` | Twitter Score, taken from the latest scan. |
| `username`, `name`, `twitter_id`, `url` | Identity of the follower. `url` is `https://x.com/{username}` when a username exists. |
| `followers_count`, `description`, `profile_image` | Profile data. |
| `tags`, `categories` | TwitterScore tags and categories (names). |
| `subscribed_at` | When TwitterScore first saw the follow. |
| `first_seen_at`, `scan_count` | When the account was first stored, and how many scans have seen it. |
| `scan_id`, `page`, `min_score_filter` | Which scan last updated the row, and the settings it used. |
| `raw` | **The complete API object from the latest scan, unchanged.** |

Databases from older versions are converted to this format automatically: duplicate rows are merged and the old "scanned from" fields are removed. Which accounts you scanned is still recorded in **Scan history**. The **🧬 Remove duplicates** button in the Database tab re-checks and merges everything on demand.

**`scans`** has one row per account scan: source, status, min score, filters, start and finish times, pages, requests, found, saved, new, skipped, and the error or stop reason.

In the **Database** tab you can:

- Search (username, name, bio, tags), filter by score range, sort, and page through results.
- **🧹 Clean database:** remove saved accounts whose score is below a value, with a preview count first. Rows with no score are included when that checkbox is on. The Scan tab has a quick **Remove saved below this score** button that uses the current min score.
- Export to **XLSX** (Excel) or **CSV**. Every API field is added as an `api_*` column, or **JSON** (a full backup). **Clear database** wipes followers and scan history.
- **Import XLSX / JSON:** import a spreadsheet or JSON backup. The sheet needs at least a `username` column. Imported rows are merged by username, so importing never creates duplicates.

<details>
<summary><b>Dashboard map</b></summary>

| Tab | What you do there |
| --- | --- |
| **Scan** | Paste accounts, set min score and filters, start / stop / resume, and watch live req/min, in-flight requests, saved rows, and the queue. |
| **Database** | Search, page, clean, dedupe, export, and import. |
| **Scan history** | One row per account scan, with a CSV export. |
| **Settings** | API key, endpoint, speed, quota, **Test API**, and **Check plan limits**. |
| **Log** | The engine log, including stop reasons. |

</details>

## 📊 Spending the plan

Designed around a plan of **300 requests/minute** and **250,000 requests/month**. The defaults aim at that budget without sitting on the ceiling.

| Technique | Effect |
| --- | --- |
| A global limiter spaces requests evenly and also checks a 60-second sliding window | Uses the full per-minute budget without triggering 429s. The default is 295/min to leave a small margin. |
| Several accounts are scanned in parallel (8 by default), with 3 pages per account in flight | The limiter stays busy even when the API is slow (24 requests in flight). |
| **Early stop.** `get_followers` is sorted by score, so once a page drops below your min score the account is finished | Pages of low-score followers are never fetched. This is usually the largest saving. |
| Page 1 is fetched first for each account | Unknown or invalid usernames cost 1 request, not a whole batch of pages. |
| On a 429, every request pauses for `Retry-After` and the same page is retried | No data is lost. |
| Monthly counter, with the stop point set by the "Monthly request limit" setting | Scanning stops automatically when the quota is used up. **Check plan limits** calls `/limits` so you can sync the counter with the server. |
| A hidden offscreen page pings the background worker every 20 s, plus API keep-alive calls | Chrome does not stop the worker while a scan runs, so scans can go for hours. |
| State is saved continuously; restarts come from the ping or a 30-second alarm | If Chrome kills the worker anyway, the scan resumes within seconds from where it stopped. |
| Watchdog | If requests stop completing for 3 minutes (a hung connection), the worker loops restart and the pages in flight are fetched again. |
| An HTTP 401/403 for one account skips only that account | Only a clearly invalid key, or 6 auth failures in a row, stops the engine. The stop reason appears in the status line and the Log tab. |

In a test against a mock server rate-limited at 300/min, the extension held about 292 req/min with zero 429s, which is roughly 7,300 followers saved per minute at 25 per page.

## 📁 Project structure

```
manifest.json      MV3 manifest
background.js      scraping engine (rate limiter, scheduler, retries, quota, resume)
offscreen.html     hidden page that keeps the service worker alive during a scan
offscreen.js       20-second ping back to the worker
lib/api.js         settings, URL building, response parsing, normalisation
lib/db.js          IndexedDB layer (followers + scans, purge below score)
lib/xlsx.js        dependency-free XLSX writer/reader
icons/             toolbar icons (idle + running)
popup.html         quick-start popup
dashboard.html     full dashboard: Scan / Database / Scan history / Settings / Log
ui/*.js, ui/*.css  popup, dashboard, and shared UI
```

## 💜 Credits

Built by **[Shahriar Ahmed](https://github.com/fr-ost)**, Co-Founder & COO of **[Unique Labs](https://www.uniquelabs.org)**.

[shahriarahmed.net](https://shahriarahmed.net) · [X / @0x_nation](https://x.com/0x_nation) · [Unique Labs](https://www.uniquelabs.org)

<div align="center">

<img width="100%" alt="Footer wave" src="https://capsule-render.vercel.app/api?type=waving&amp;color=0:FFB703,50:FF2E93,100:6C2BD9&amp;height=110&amp;section=footer"/>

</div>
