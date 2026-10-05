# Spread Scout

An NCD scouting site that runs on GitHub Pages. It refreshes itself every morning and republishes whenever the admin uploads new NSE files.

## What updates by itself

| What | How often | Source |
|---|---|---|
| Regulatory and market news | Daily at 06:45 IST | SEBI RSS, RBI notifications RSS |
| Court cases for flagged issuers (optional) | Daily run; each issuer is rechecked weekly, up to 15 per run | eCourtsIndia API, only if you add a key |
| Issuer profiles, ratings, defaults, term sheets | Whenever you upload NSE CSVs | NSE Corporate Filings, downloaded by hand |

NSE files are not fetched automatically, because NSE's terms don't allow automated collection.

## One-time setup (about 10 minutes)

1. **Create the repository.** Sign in to GitHub with your own account and create a new **public** repository, for example `spread-scout`. Don't add any collaborators: only your account will be able to publish.
2. **Upload the files.** On the new repository's page, choose *uploading an existing file*. Drag in everything inside this folder, including the hidden `.github` folder, and choose *Commit changes*.
   - If your file browser hides `.github`, create the workflow file by hand instead: *Add file → Create new file*, name it `.github/workflows/refresh.yml`, and paste in the contents of that file.
3. **Turn on Pages.** Open *Settings → Pages*. Under *Build and deployment → Source*, choose **GitHub Actions**.
4. **Let the workflow save data.** Open *Settings → Actions → General*. Under *Workflow permissions*, choose **Read and write permissions**, then *Save*.
5. **Run it once.** Open the *Actions* tab, choose **Refresh data and publish**, then *Run workflow*. After 2–3 minutes the site is live at `https://<your-username>.github.io/spread-scout/`.

### Optional: court checks

1. Create an account at ecourtsindia.com and copy your API key (it starts with `eci_live_`).
2. In the repository, open *Settings → Secrets and variables → Actions → New repository secret*. Name it `ECOURTS_API_KEY`, paste the key as the value, and save.

Don't paste the key anywhere else. The next run checks court cases for issuers with the strongest signals, and the results appear in each issuer's profile under **Court cases**.

The matches are made on company name, so treat them as leads to verify on eCourts. Each check uses API credit. Change `maxPerRun` in `scripts/config.json` to control how much is used.

## Uploading new NSE files (admin)

1. Open the site with `#admin` at the end of the address, for example `https://<you>.github.io/spread-scout/#admin`, and sign in with `rsivarajan1234@gmail.com`.
2. **Get the files from NSE:** use *Open the NSE source page*, which links to <https://www.nseindia.com/companies-listing/corporate-filings-offer-documents#>. Set the date range and choose *Download (.csv)*. For ratings and defaults, also download *Credit Rating Details* and *Default Payment Details* from the same Corporate Filings menu.
3. **Check a file (optional):** pick it under *Check a file before uploading* to see what the site will read from it.
4. **Upload:** choose *Upload files on GitHub*. This opens the repository's `incoming` folder. Drag the CSVs in and choose *Commit changes*.

The workflow then processes the files and moves them to `data/raw/`. Files it can't recognise go to `incoming/not-recognised/`. The site republishes in about three minutes.

If you open the site somewhere other than `github.io` (a custom domain, say), set `repo: "your-username/spread-scout"` in `js/config.js` so the upload link works.

## About the admin sign-in

The email sign-in only decides who sees the admin tools. It is **not security**: anyone reading the page source could see the address.

What actually protects the site is GitHub. Only accounts with write access to the repository can upload files or change data, and that is just your account as long as you add no collaborators. Keep your GitHub account protected with two-factor authentication.

## Editing content by hand

These files can be edited directly on GitHub; the site rebuilds on commit:

- `data/manual/ncds.json` – the NCD universe (yield ladder)
- `data/manual/leads.json` – research leads
- `data/manual/intel.json` – hand-written intelligence items. Automatic news lives in `data/feeds/news.json`.
- `scripts/config.json` – feed list, news keywords and court-check limits
- `js/config.js` – admin email, repository name, NSE source link

Don't edit `data/data.js` or `data/state/*`, because the workflow overwrites them on every run.

## Running locally

```
node scripts/build-data.mjs   # Node 22+
python3 -m http.server        # then open http://localhost:8000
```

Opening `index.html` directly also works.
