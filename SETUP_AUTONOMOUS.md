# AI News KSA — Full Autonomous Engine Setup
## ainewsksa.com → bilingual auto-publishing every 6 hours

End-to-end walkthrough. Total active time: ~60–90 minutes. Total elapsed time including propagation: 2–4 hours.

You'll end up with:
- `https://ainewsksa.com` — English site, 10 seed articles
- `https://ainewsksa.com/ar/` — Arabic site (RTL), 10 seed articles
- Automatic content generation every 6 hours (3 EN + 3 AR new articles per day max)
- All running autonomously with zero ongoing manual work

---

## Prerequisites checklist

Before you start, have these ready:
- [ ] GoDaddy account with ainewsksa.com registered
- [ ] An email address for new account signups
- [ ] A credit card for Anthropic API (~$5 minimum deposit)
- [ ] About 90 minutes of focused time

---

## PART 1 — Get the code into GitHub (15 min)

The autonomous setup requires the code to live in a Git repository. GitHub Actions runs the pipeline; Cloudflare Pages auto-rebuilds from the repo.

### Step 1.1: Create a GitHub account
- Go to https://github.com/signup
- Sign up with email or use existing account
- Verify email

### Step 1.2: Create a new repo
1. Click the `+` in the top-right → **New repository**
2. Repository name: `ainewsksa`
3. Visibility: **Private** (recommended) — the content is yours
4. Initialize with: **none** (we have files to push)
5. Create repository

### Step 1.3: Upload the project files

**Easy path — GitHub web UI (no command-line):**
1. On the empty repo page, click **uploading an existing file** link
2. Drag the entire contents of the `conneqt-news` folder (NOT the folder itself — its contents) into the upload zone
3. Wait for upload (~1 min for ~25 files)
4. Commit message: "Initial commit"
5. Click **Commit changes**

**Better path — Git CLI (if you have it):**
```bash
cd conneqt-news
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ainewsksa.git
git push -u origin main
```

### Step 1.4: Verify
You should see all files in the repo: `articles/`, `scripts/`, `public/`, `.github/`, `package.json`, etc.

---

## PART 2 — Set up Anthropic API key (5 min)

The pipeline calls Claude to generate articles. You need an API key.

### Step 2.1: Create Anthropic account
1. Go to https://console.anthropic.com
2. Sign up (email or Google)
3. Verify email

### Step 2.2: Add billing
1. Click your profile → **Plans & Billing** → **Add payment method**
2. Add a credit card
3. Add credits: $5 is fine to start (covers ~2 weeks of autonomous operation at default settings)
4. Set up **Auto-reload** to top up automatically if you want zero-touch operation (recommended for the case study)

### Step 2.3: Generate API key
1. Profile → **API Keys** → **Create Key**
2. Name: `ainewsksa-pipeline`
3. Copy the key immediately (looks like `sk-ant-api03-...`)
4. **Store it somewhere safe** — you won't be able to see it again

### Step 2.4: Add API key to GitHub
1. Back in your GitHub repo: **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `ANTHROPIC_API_KEY`
4. Secret: paste the key from step 2.3
5. **Add secret**

---

## PART 3 — Deploy to Cloudflare Pages connected to GitHub (10 min)

### Step 3.1: Sign in to Cloudflare
You already have an account from the earlier setup. Go to https://dash.cloudflare.com.

### Step 3.2: Connect Pages to GitHub repo
1. **Workers & Pages** → **Pages** tab → **Create application** → **Pages** → **Connect to Git**
2. Authorize GitHub access (one-time)
3. Select the `ainewsksa` repo
4. Set up builds:
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** `npm install && node scripts/generate.js`
   - **Build output directory:** `public`
   - **Root directory:** (leave blank)
5. Click **Save and Deploy**

### Step 3.3: Verify deploy
Cloudflare runs `npm install` then `node scripts/generate.js`, then deploys `/public`. After ~1 min you get a URL like `ainewsksa.pages.dev`. Visit it. Both English and `/ar` should work.

If the build fails, check the build log in Cloudflare — usually a missing dependency. The `npm install` step should grab everything from `package.json`.

---

## PART 4 — Add ainewsksa.com to Cloudflare DNS (20 min + propagation)

Same DNS-transfer process as before, but for the new domain — **zero risk because no existing site is using ainewsksa.com yet.**

### Step 4.1: Add the site to Cloudflare
1. Cloudflare dash → **Add a Site** (top right)
2. Type: `ainewsksa.com`
3. Continue → Choose **Free plan** → Continue

### Step 4.2: DNS records
Cloudflare scans for existing DNS records at the current registrar (GoDaddy). For a fresh domain there usually aren't any records to import — just continue. You can add records later as needed.

### Step 4.3: Get the Cloudflare nameservers
Cloudflare gives you 2 nameservers, looking like:
```
something.ns.cloudflare.com
otherthing.ns.cloudflare.com
```
Copy both. Don't click "Done, check nameservers" yet.

### Step 4.4: Update nameservers at GoDaddy
1. Sign in to GoDaddy → **My Products**
2. Find `ainewsksa.com` → click **DNS** or **Manage DNS**
3. Scroll to **Nameservers** section → **Change**
4. Select **I'll use my own nameservers**
5. Replace GoDaddy's nameservers with the two Cloudflare nameservers
6. Save

### Step 4.5: Wait for propagation
- Usually 5–30 min
- Sometimes up to 24h
- Cloudflare emails you when active
- You can check with: `nslookup ainewsksa.com 8.8.8.8` from terminal

### Step 4.6: Attach the custom domain to Pages
Once Cloudflare confirms DNS is active:
1. Workers & Pages → your `ainewsksa` project → **Custom domains** → **Set up a custom domain**
2. Type: `ainewsksa.com`
3. Click **Continue**
4. Cloudflare auto-creates the CNAME record
5. SSL provisions in ~5 min
6. Visit `https://ainewsksa.com` → site is live

Also add `www.ainewsksa.com` if you want it (Custom domains → Set up another → `www.ainewsksa.com`).

---

## PART 5 — Enable the autonomous pipeline (5 min)

The pipeline workflow is already in the repo at `.github/workflows/pipeline.yml`. Now you need to enable it.

### Step 5.1: Enable GitHub Actions
1. Repo → **Actions** tab
2. GitHub will say "Workflows aren't being run on this forked repository" or similar — click the green **I understand my workflows, go ahead and enable them** button
3. The "Content Pipeline" workflow is now visible

### Step 5.2: Run the pipeline manually for the first time (test it)
1. Click **Content Pipeline** in the left sidebar
2. Click **Run workflow** → **Run workflow** (green button)
3. Refresh after a few seconds — a new run appears
4. Click the run to see logs
5. Wait ~3–5 min for completion
6. Check the logs:
   - Should see "Got X items across 5 feeds"
   - Should see "Selected 3 stories"
   - Should see "Generating EN..." and "Generating AR..." for each story
   - Should see "Appended" lines
   - Final line: "Done. 3/3 stories shipped in both languages."

### Step 5.3: Verify auto-rebuild
After the pipeline commits, Cloudflare Pages should auto-detect the commit and rebuild. Check:
1. Cloudflare → your project → **Deployments**
2. A new deployment should appear within ~30 seconds
3. After ~1 min, visit `https://ainewsksa.com` — newest article appears at the top

### Step 5.4: Confirm the cron is active
1. Back in GitHub → Actions tab → Content Pipeline workflow
2. The schedule is set to every 6 hours (00:00, 06:00, 12:00, 18:00 UTC)
3. GitHub Actions will fire automatically — you'll see new runs appear over time
4. No further action needed from you

**You're done. The engine is autonomous.**

---

## PART 6 — Monitor & tune

### Daily check (30 seconds)
- Visit `ainewsksa.com` — newest article should be from today
- If not, check GitHub Actions tab for any failed runs

### Cost monitoring
- Check Anthropic console once a week — usage should sit around $0.50–$1/day
- If you hit cost ceilings unexpectedly, edit `scripts/pipeline.js` → `MAX_NEW_PER_RUN` → reduce to 1 or 2

### Adjust frequency
Edit `.github/workflows/pipeline.yml` → change the cron line:
- Every 12 hours: `0 */12 * * *`
- Once a day at 9 AM UTC: `0 9 * * *`
- Twice a day: `0 9,21 * * *`

After editing, commit + push. The new schedule activates immediately.

### Pause the pipeline temporarily
- GitHub → Actions → Content Pipeline → `...` menu → **Disable workflow**
- Site stays live with existing content; no new articles ship
- Re-enable any time

---

## PART 7 — Showing this to Sam

**The story when you walk in:**

*"This site runs autonomously. Every 6 hours, the pipeline fetches AI news from major industry sources, picks the most relevant stories for our MENA marketing-leader audience, generates a full article in both English and native Arabic — not translation, parallel generation — fact-checks each output against the source material, and publishes to the site. Zero human in the loop. The site has been running like this since [date]. This is the engine you'd deploy for Betway, retrained on your fixture feed instead of AI news feeds."*

**What to show on screen:**
1. `https://ainewsksa.com` — homepage with latest articles
2. Click newest article — show the timestamp is recent (last 6h)
3. Switch to Arabic via the language toggle — show native RTL Arabic
4. Click `/about` — walk through the 8-layer pipeline diagram
5. Open GitHub Actions tab — show the cron history, "this ran 4h ago, ran 10h ago, ran 16h ago, etc."
6. Open `pipeline.js` in the GitHub UI — show the code is real

**The clincher:**
*"This entire setup took 90 minutes. The pilot we'd run for Betway is the same architecture, configured for your data — 6 weeks because we tune the voice prompts, regulatory guardrails, and ad-network integrations specifically to Betway. The engine itself is ready."*

---

## Troubleshooting

### "Workflow run failed: ANTHROPIC_API_KEY"
The secret didn't get set correctly. Repo → Settings → Secrets → Actions → check that `ANTHROPIC_API_KEY` exists exactly with that name (no trailing spaces).

### "Cloudflare Pages deployment failed"
Check the build log. Most common: a syntax error in articles.js after a bad pipeline run. Fix the file locally, commit, push — Cloudflare rebuilds.

### "Pipeline runs but no new articles appear"
Either: (a) RSS feeds returned no new items since the last run (normal), or (b) all generated articles failed fact-check (rare). Check the workflow logs.

### "Articles aren't showing on the site after a successful pipeline run"
Cloudflare Pages needs ~30-60 seconds to rebuild. Refresh after a minute. Hard-refresh if needed (Cmd+Shift+R / Ctrl+Shift+R).

### Arabic articles look weird in some browsers
The site uses system Arabic fonts. On macOS/iOS this looks great. On Windows it depends on installed Arabic fonts. If you need a specific Arabic font, swap the font-family in `scripts/generate.js` → `baseCSS` → `html[lang="ar"]` rule.

### Want to delete a bad article
Edit `articles/articles.js` or `articles/articles-ar.js`, remove the object, commit, push. The site rebuilds and the article is gone.

---

## Files in this package

```
ainewsksa/
├── .github/workflows/pipeline.yml    ← GitHub Actions cron config
├── public/                            ← Generated static site (rebuilt by pipeline)
├── articles/
│   ├── articles.js                    ← English articles (seed + auto-appended)
│   ├── articles-ar.js                 ← Arabic articles (seed + auto-appended)
│   └── .tracked.json                  ← Pipeline-managed: stories already processed
├── scripts/
│   ├── generate.js                    ← Static site builder
│   └── pipeline.js                    ← Autonomous content pipeline
├── package.json
├── DEPLOY.md                          ← Original (subdomain) deploy guide
├── SETUP_AUTONOMOUS.md                ← This file (Path C full setup)
└── .env.example
```

Good luck. The first 90 minutes are setup. Every minute after that is autonomous.
