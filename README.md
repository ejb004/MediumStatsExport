# Medium Stats Export

A Chrome extension (Manifest V3) that exports your Medium story stats to Excel (`.xlsx`) or CSV — no API key needed, just your normal login session.

## Install

```bash
# 1. Download SheetJS (one-time setup)
bash setup.sh

# 2. Generate icons — open icons/create_icons.html in Chrome, click all three download buttons,
#    save icon16.png, icon48.png, icon128.png into the icons/ folder

# 3. Load the extension in Chrome
#    chrome://extensions → Enable Developer mode → Load unpacked → select this folder
```

## Usage

### Mode A — All stories
1. Navigate to `https://medium.com/me/stats`
2. **Scroll to the bottom** so all stories load (infinite scroll)
3. Click the extension icon → **Export All Stories**
4. A `.xlsx` file downloads with a Summary sheet + one sheet per story

### Mode B — Single story
1. Click any story's stats link: `https://medium.com/me/stats/post/{postId}`
2. Click the extension icon → **Export This Story**
3. A `.csv` file downloads with daily rows for that story

## Settings

| Setting | Default | Description |
|---|---|---|
| Date range | All time | 7d / 30d / 6m / 1y / All time |
| Include zero-activity days | Off | Whether to include days with no activity in output |
| Separate member / non-member columns | Off | Split into memberViews, nonMemberViews, etc. |
| Also export flat CSV | Off | Exports summary + timeseries CSVs alongside the XLSX (Mode A only) |

## Output columns

**Summary sheet / CSV**

| Column | Description |
|---|---|
| postId | Medium's internal story ID |
| title | Story title |
| totalViews | Total views across all days |
| totalReads | Total reads |
| totalClaps | Total claps |
| totalReplies | Total replies |
| totalHighlights | Total highlights |
| totalFollows | New follows attributed to this story |
| earningsCents | Total earnings in cents |
| earningsUSD | Total earnings in USD |

**Daily rows (per-story sheet or single-story CSV)**

Same columns as above but per-day, plus `date` (YYYY-MM-DD).

When "Separate member / non-member" is enabled, `views` splits into `memberViews` + `nonMemberViews`, etc.

## How it works

The extension uses Medium's own internal GraphQL API — the same `/_/graphql` endpoint their frontend calls. It reads your session cookie automatically (you must be logged in). No API key or OAuth is required.

Story IDs are scraped from the DOM on the stats page. For each story, one GraphQL request is made with a 300ms delay between requests to be respectful of rate limits.

## Files

```
medium-stats-export/
  manifest.json       Chrome extension manifest (MV3)
  popup.html/css/js   Extension popup UI
  scraper.js          Injected into Medium tab — fetches GraphQL data
  background.js       Service worker — routes messages popup ↔ scraper
  lib/
    xlsx.full.min.js  SheetJS (run setup.sh to download)
  icons/
    create_icons.html Open in browser to generate PNG icons
    icon16/48/128.png Place downloaded icons here
```

---

☕ [Support this tool on Ko-fi](https://ko-fi.com/ethanbeddard)
