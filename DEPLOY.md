# Conneqt News — Full Deployment Walkthrough
## news.conneqtme.com — Arabic + English content engine

End-to-end guide: from subdomain creation in GoDaddy through live site on Cloudflare Pages with SSL. Total time: 30–45 minutes.

---

## What you're deploying

A bilingual static news site with 20 articles (10 English at root, 10 Arabic at `/ar/`) plus the autonomous content pipeline. Two structures matter:

```
news.conneqtme.com/                          ← English landing
news.conneqtme.com/articles/<slug>.html      ← English articles
news.conneqtme.com/about.html                ← English engine page

news.conneqtme.com/ar/                       ← Arabic landing (RTL)
news.conneqtme.com/ar/articles/<slug>.html   ← Arabic articles
news.conneqtme.com/ar/about.html             ← Arabic engine page

news.conneqtme.com/api/articles-en.json      ← JSON feed (for Base44, etc.)
news.conneqtme.com/api/articles-ar.json      ← JSON feed (for Base44, etc.)
news.conneqtme.com/sitemap.xml               ← For Google
news.conneqtme.com/robots.txt
```

---

## Why Cloudflare Pages (not Vercel)

- **Free for static sites** at way higher limits than you'll hit.
- **Owned by Cloudflare**, so DNS + CDN + SSL are all one company. Zero finicky verification.
- **No phone/email verification drama** — sign in with email or GitHub and you're in.
- **Faster propagation** than Vercel for custom domains.
- **Drag-drop deploy works flawlessly** — no command-line if you don't want.

**Backup if Cloudflare gives you trouble:** Netlify (very similar UX, also free). Process is nearly identical; same DNS setup at GoDaddy.

---

## PART 1 — Deploy to Cloudflare Pages (10 min)

### Step 1: Create a Cloudflare account

1. Go to **https://dash.cloudflare.com/sign-up**
2. Sign up with email (or "Continue with GitHub" — fastest)
3. Confirm email if needed
4. You'll land in the Cloudflare dashboard

### Step 2: Open Cloudflare Pages

1. In the left sidebar, click **Workers & Pages**
2. Click the **Pages** tab at the top
3. Click **Create application** → **Pages** → **Upload assets**

### Step 3: Upload your site

1. Project name: `conneqt-news` (this becomes part of the temp URL: `conneqt-news.pages.dev`)
2. Drag the **entire `public/` folder** into the upload zone
   - Open the `conneqt-news/public/` folder on your computer
   - Select all contents (Cmd+A on Mac, Ctrl+A on Windows)
   - Drag into the Cloudflare upload area
   - OR click "select from computer" and choose the `public/` folder
3. Wait for upload (under 30 seconds at this size)
4. Click **Deploy site**

### Step 4: Confirm it works

After ~30 seconds you'll see a deploy summary with a green checkmark and a URL like:
`https://conneqt-news.pages.dev`

1. Click that URL. Site should load.
2. Click "العربية" in the top-right → Arabic version loads with RTL layout.
3. Click into an article. Check it renders.
4. Visit `https://conneqt-news.pages.dev/api/articles-en.json` — you should see JSON.

**If anything looks broken at this stage, stop and message me — easier to fix now than after DNS.**

---

## PART 2 — Add the subdomain in GoDaddy (5 min + propagation wait)

### Step 1: Open GoDaddy DNS

1. Sign in at **https://godaddy.com**
2. Click your profile → **My Products**
3. Find `conneqtme.com` → click the three-dots menu next to it → **Manage DNS**
   - Alternative path: Click `conneqtme.com` → **DNS** tab

### Step 2: Add a CNAME record

You'll see your existing DNS records (probably A records pointing to your current site).

1. Click **Add New Record** (or just **ADD** button — UI varies)
2. Fill in:
   - **Type:** `CNAME`
   - **Name:** `news` (this is what creates the `news.` part of `news.conneqtme.com`)
   - **Value:** `conneqt-news.pages.dev` (your Cloudflare Pages URL **without** the `https://`)
   - **TTL:** `1 Hour` (default is fine)
3. Click **Save**

That's it on the GoDaddy side. DNS starts propagating immediately.

**Sanity check:** Open Terminal (Mac) or PowerShell (Windows) and run:
```bash
nslookup news.conneqtme.com
```
After 5–20 minutes it should resolve to `conneqt-news.pages.dev`. If you see "non-existent domain," wait longer.

---

## PART 3 — Tell Cloudflare Pages about your custom domain (5 min)

### Step 1: Add custom domain

1. Back in Cloudflare Pages dashboard, click your `conneqt-news` project
2. Click the **Custom domains** tab
3. Click **Set up a custom domain**
4. Type: `news.conneqtme.com`
5. Click **Continue**

### Step 2: Verify

Cloudflare auto-checks your CNAME. You'll see one of:

**Status: Active** ✅ — Cloudflare found the CNAME and SSL is being issued. Wait ~5 min then visit `https://news.conneqtme.com`.

**Status: Pending** ⏳ — DNS hasn't propagated yet. Wait 10–20 min, refresh. SSL provisions automatically once DNS is live.

**Status: Error** ❌ — Likely the CNAME isn't right. Recheck GoDaddy:
- Name field should be `news` only, not `news.conneqtme.com`
- Value should be `conneqt-news.pages.dev` (no protocol, no trailing slash)

### Step 3: Visit the site

Once status is Active:
- `https://news.conneqtme.com` → English site
- `https://news.conneqtme.com/ar/` → Arabic site
- SSL padlock visible in the browser
- Both URLs work without "www" or extra paths

**You're live.**

---

## PART 4 — Adding more articles (ongoing)

Two paths, depending on whether you want to manually add articles or run the pipeline automatically.

### Manual addition

1. Open `articles/articles.js` (English) or `articles/articles-ar.js` (Arabic) on your local machine
2. Add a new object at the top of the array (newest first):
```javascript
{
  slug: "your-article-slug",
  title: "Your article title",
  dek: "One-sentence subhead.",
  date: "2026-05-12",
  tags: ["Tag A", "Tag B"],
  readTime: "5 min read",
  body: `<p>First paragraph.</p>
<h2>A subhead</h2>
<p>More content.</p>`
}
```
3. Rebuild:
```bash
cd conneqt-news
node scripts/generate.js
```
4. Re-deploy:
   - **Easy path:** drag the new `public/` folder into Cloudflare Pages → Deployments → "Upload new version"
   - **Better path:** push to GitHub (see below) and Cloudflare auto-rebuilds

### Autonomous pipeline (after Monday — when you have time to set it up)

The pipeline at `scripts/pipeline.js` fetches AI news RSS feeds, generates new articles via Claude, fact-checks them, and appends to the site. Cost ceiling: ~$1.50/day at 3 articles per run, 4 runs per day.

To run:

1. Get an Anthropic API key at https://console.anthropic.com
2. Create `.env` in the project:
```
ANTHROPIC_API_KEY=sk-ant-...
```
3. Install deps and run:
```bash
cd conneqt-news
npm install
node scripts/pipeline.js
```

The pipeline as written generates English only. To also generate Arabic, you'd run it twice with different language flags — happy to extend the script when you're ready.

### Scheduled automation

The cleanest setup is GitHub Actions. Push the repo to GitHub:

```bash
cd conneqt-news
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/conneqt-news.git
git push -u origin main
```

Then connect Cloudflare Pages to the GitHub repo (Pages → Settings → Builds & deployments → Connect to Git) so every commit to `main` triggers a rebuild.

Add a GitHub Action workflow at `.github/workflows/pipeline.yml`:

```yaml
name: Conneqt News Pipeline
on:
  schedule:
    - cron: '0 */6 * * *'  # every 6 hours
  workflow_dispatch:        # also run manually from GitHub UI

jobs:
  generate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install
      - run: node scripts/pipeline.js
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Commit changes
        run: |
          git config user.name "Conneqt Pipeline"
          git config user.email "pipeline@conneqt.com"
          git add articles/ public/
          git diff --staged --quiet || git commit -m "pipeline: new articles"
          git push
```

Add the secret in GitHub: Settings → Secrets and variables → Actions → New repository secret → name `ANTHROPIC_API_KEY` → paste your Anthropic key.

Result: every 6 hours, GitHub fetches new AI news, generates articles, commits to the repo. Cloudflare Pages sees the commit and rebuilds. Site updates automatically.

---

## PART 5 — JSON API for any downstream consumer

The site exposes two JSON feeds for any system that wants to consume the articles programmatically (Base44, another site, a mobile app, etc.):

```
https://news.conneqtme.com/api/articles-en.json
https://news.conneqtme.com/api/articles-ar.json
```

Each returns:
```json
{
  "site": "Conneqt News",
  "language": "en",
  "generated_at": "2026-05-10T15:30:00Z",
  "article_count": 10,
  "articles": [
    {
      "slug": "...",
      "title": "...",
      "dek": "...",
      "date": "2026-05-09",
      "tags": ["..."],
      "read_time": "5 min read",
      "url": "https://news.conneqtme.com/articles/...",
      "body_html": "<p>...</p>"
    }
  ]
}
```

If you later want to pull these into Base44 to display under `conneqtme.com/AInews`, point Base44 at these JSON URLs and render the `body_html` field. Cloudflare serves both files with proper CORS headers and CDN caching.

---

## Troubleshooting

### Site loads on `*.pages.dev` but not `news.conneqtme.com`
DNS propagation. Wait up to 24h (usually 10–60 min). Run `nslookup news.conneqtme.com 8.8.8.8` to check Google's DNS view.

### SSL not provisioning
Cloudflare needs DNS pointing correctly before it issues SSL. Once DNS resolves, SSL auto-issues in 5–15 min. If it stays Pending for hours, delete the custom domain in Cloudflare Pages and re-add it.

### Arabic page shows English content
Hard refresh (Cmd+Shift+R / Ctrl+Shift+R). The English version may be cached.

### Articles look broken on mobile
The CSS includes mobile media queries. If something specific breaks, screenshot it and I'll fix it.

### Want to change the domain later
Update `SITE.url` in `scripts/generate.js`, re-run `node scripts/generate.js`, re-deploy. The site uses absolute URLs in canonical tags and JSON feeds.

---

## What to show Sam on the call

1. **Open `https://news.conneqtme.com`** — live, real domain, real content.
2. **Click an article** — show that the content is substantive.
3. **Click "العربية"** — show that Arabic native version exists, not translation.
4. **Open `/about.html`** — walk Sam through the 8-layer engine pipeline visualization.
5. **The line:** *"This site is our engine running on our own content — same architecture, retrained for your data, ships for Betway in 6 weeks. Two languages, autonomous publishing, fact-checked at scale."*

6. **If Sam wants to dig:** open `scripts/pipeline.js` in a code editor. Show that it's a real working pipeline, not a slide deck.

---

## Files in this package

```
conneqt-news/
├── public/              ← The live site (this is what gets deployed)
├── articles/
│   ├── articles.js      ← English articles (10)
│   └── articles-ar.js   ← Arabic articles (10)
├── scripts/
│   ├── generate.js      ← Static site builder
│   └── pipeline.js      ← Autonomous content pipeline
├── package.json
├── DEPLOY.md            ← This file
└── .env.example
```

Good luck Monday.
