#!/usr/bin/env node
/**
 * AI News KSA — bilingual autonomous content engine
 *
 * v2 — uses Claude tool-use mode for structured outputs.
 * No more JSON parse errors; outputs are guaranteed valid per schema.
 *
 * Runs on cron (GitHub Actions, every 6h). For each run:
 *   1. Ingests RSS feeds from major AI publications
 *   2. Claude selects the 3 most relevant stories for AI-marketing audience
 *   3. For each: generates EN + AR articles in parallel (native generation, not translation)
 *   4. Fact-checks each output against source via RAG-style verification
 *   5. Appends to articles/articles.js (EN) + articles/articles-ar.js (AR)
 *   6. Re-runs static site generator
 *   7. GitHub Actions commits → Cloudflare auto-rebuilds
 *
 * Env: ANTHROPIC_API_KEY required (https://console.anthropic.com)
 * Cost ceiling: ~$3-4/day at max throughput (3 stories × 2 langs × 4 runs/day)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const Parser = require("rss-parser");

// ============ CONFIG ============
const FEEDS = [
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { name: "Marketing AI Institute", url: "https://www.marketingaiinstitute.com/blog/rss.xml" },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/" },
];

const FOCUS =
  "AI for marketing, content, growth, lifecycle, and ad pipelines. " +
  "Industry analysis, not product announcements. Particular relevance " +
  "to MENA / GCC / KSA markets where possible.";

const MAX_NEW_PER_RUN = 2;
const DEDUP_LOOKBACK_DAYS = 30;
const ARTICLES_DIR = path.resolve(__dirname, "../articles");
const ARTICLES_EN_FILE = path.join(ARTICLES_DIR, "articles.js");
const ARTICLES_AR_FILE = path.join(ARTICLES_DIR, "articles-ar.js");
const TRACKED_FILE = path.join(ARTICLES_DIR, ".tracked.json");

const VOICE_EN = `You write for AI News KSA, an industry analysis publication on AI for marketing and growth in MENA markets.
Editorial conventions:
- Analytical, not promotional. Skeptical of vendor claims.
- No marketing fluff, no exclamation points, no "in today's fast-paced world."
- Concrete numbers and specific examples over abstract claims.
- Reference specific products / companies / vendors when relevant. Never imply endorsement.
- Where natural, frame implications for MENA / GCC / KSA operators specifically.
- 600-800 words. HTML body with only <p> and <h2> tags.`;

const VOICE_AR = `أنت تكتب لـ "أخبار الذكاء الاصطناعي KSA"، نشرة تحليل قطاعي عن الذكاء الاصطناعي للتسويق والنمو في أسواق الشرق الأوسط وشمال أفريقيا.
الاتفاقيات التحريرية:
- تحليلي وليس ترويجياً. متشكك في ادعاءات البائعين.
- لا حشو تسويقي. لا علامات تعجب.
- أرقام محددة وأمثلة ملموسة مفضلة على الادعاءات المجردة.
- اذكر منتجات / شركات / موردين محددين عند الصلة. لا تذكر الموردين بطريقة توحي بالتأييد.
- حيث يكون طبيعياً، أطّر الآثار على مشغّلي الشرق الأوسط / الخليج / السعودية تحديداً.
- العربية الفصحى الحديثة (MSA)، بنبرة أعمال احترافية.
- 500-700 كلمة. متن HTML بعلامات <p> و <h2> فقط.
- هذه كتابة أصلية وليست ترجمة من الإنجليزية. ابدأ من بيانات القصة المصدرية مباشرة.`;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 5, // SDK-level retries (default is 2)
});
const MODEL = "claude-sonnet-4-6";

// Retry on transient Anthropic errors (529 overload, 5xx, 429 rate limit)
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 5;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ Helper: call Claude with forced tool use + retry ============
async function callTool(toolName, toolSchema, userPrompt, maxTokens = 3000) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        tools: [{ name: toolName, description: `Submit a ${toolName} payload`, input_schema: toolSchema }],
        tool_choice: { type: "tool", name: toolName },
        messages: [{ role: "user", content: userPrompt }],
      });
      const toolUse = res.content.find(c => c.type === "tool_use");
      if (!toolUse) throw new Error(`Tool use response missing for ${toolName}`);
      return toolUse.input;
    } catch (e) {
      lastErr = e;
      const status = e?.status;
      const errType = e?.error?.error?.type || e?.error?.type || "unknown";
      if (!RETRY_STATUSES.has(status) || attempt === MAX_RETRIES) throw e;
      // Exponential backoff with jitter: 3s, 6s, 12s, 24s, 48s, capped at 60s
      const delay = Math.min(60000, 3000 * Math.pow(2, attempt) + Math.floor(Math.random() * 1500));
      console.warn(`  ⚠ Anthropic API ${status} (${errType}) — retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ============ 01 — INGEST ============
async function ingestFeeds() {
  console.log("[01] Ingesting feeds...");
  const parser = new Parser({ timeout: 12000, headers: { "User-Agent": "AINewsKSA/1.0 (RSS aggregator)" } });
  const items = [];
  for (const feed of FEEDS) {
    try {
      const result = await parser.parseURL(feed.url);
      result.items.slice(0, 10).forEach(item => {
        items.push({
          source: feed.name,
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || item.isoDate,
          summary: (item.contentSnippet || item.content || "").slice(0, 800),
        });
      });
    } catch (e) {
      console.warn(`  ! ${feed.name} failed: ${e.message}`);
    }
  }
  console.log(`  Got ${items.length} items across ${FEEDS.length} feeds`);
  return items;
}

// ============ 02 — BRIEF GENERATION (tool use, with topic dedup) ============
function getRecentPublishedTitles() {
  // Read existing EN articles (AR mirrors EN by slug), dedup against last N days
  try {
    delete require.cache[require.resolve(ARTICLES_EN_FILE)];
    const existing = require(ARTICLES_EN_FILE);
    const cutoff = new Date(Date.now() - DEDUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return existing
      .filter(a => new Date(a.date) >= cutoff)
      .map(a => `- ${a.title}${a.dek ? " — " + a.dek.slice(0, 100) : ""}`);
  } catch (e) {
    return [];
  }
}

async function selectAndBrief(items, alreadyTracked) {
  console.log("[02] Selecting & briefing stories...");
  const fresh = items.filter(i => !alreadyTracked.includes(i.link));
  if (fresh.length === 0) {
    console.log("  No new items.");
    return [];
  }

  const recentTitles = getRecentPublishedTitles();
  const dedupBlock = recentTitles.length > 0
    ? `\n\nCRITICAL — DO NOT DUPLICATE:\nWe have already published these articles in the last ${DEDUP_LOOKBACK_DAYS} days. DO NOT select any candidate story that covers the same news event, same company announcement, same product launch, or same topic angle as any title below. If a candidate is about the same news event (even from a different source), SKIP IT.\n\n${recentTitles.join("\n")}\n\nReturn ONLY stories on genuinely new topics not represented above.`
    : "";

  const prompt = `${FOCUS}${dedupBlock}

Below are ${fresh.length} recent items from AI news feeds. Pick UP TO ${MAX_NEW_PER_RUN} most relevant stories for "AI News KSA" (AI for marketing & growth in MENA — industry analysis publication).

If fewer than ${MAX_NEW_PER_RUN} fresh non-duplicate stories exist, return only those. It is fine to return 0, 1, or ${MAX_NEW_PER_RUN}. Better to return nothing than to publish a duplicate.

Items:
${fresh.map((i, idx) => `[${idx}] ${i.source} — ${i.title}\n    ${i.summary}\n    ${i.link}`).join("\n\n")}`;

  const schema = {
    type: "object",
    properties: {
      selected: {
        type: "array",
        items: {
          type: "object",
          properties: {
            link: { type: "string", description: "Exact URL from the items list above" },
            angle: { type: "string", description: "The analytical angle for this story" },
            tags_en: { type: "array", items: { type: "string" }, description: "2-3 English tags (e.g. 'AI advertising', 'Industry analysis')" },
            tags_ar: { type: "array", items: { type: "string" }, description: "2-3 Arabic tags" },
            headline_en: { type: "string" },
            headline_ar: { type: "string", description: "MSA headline" },
          },
          required: ["link", "angle", "tags_en", "tags_ar", "headline_en", "headline_ar"],
        },
      },
    },
    required: ["selected"],
  };

  const result = await callTool("submit_selection", schema, prompt, 2500);
  const briefs = result.selected || [];
  console.log(`  Selected ${briefs.length} stories`);
  return briefs.map(b => ({ ...b, source: fresh.find(f => f.link === b.link) })).filter(b => b.source);
}

// ============ 03–04 — VOICE + GENERATION (tool use, per language) ============
async function generateArticle(brief, lang) {
  const voice = lang === "ar" ? VOICE_AR : VOICE_EN;
  const headline = lang === "ar" ? brief.headline_ar : brief.headline_en;

  const userPrompt = `${voice}

ANGLE / الزاوية: ${brief.angle}
SOURCE / المصدر: ${brief.source.source} — "${brief.source.title}"
SOURCE LINK: ${brief.source.link}
SOURCE SUMMARY: ${brief.source.summary}
PROPOSED HEADLINE / العنوان المقترح: ${headline}

Write the full article. Use only <p> and <h2> tags in the body. ${lang === "ar" ? "500-700 كلمة." : "600-800 words."}`;

  const schema = {
    type: "object",
    properties: {
      title: { type: "string", description: lang === "ar" ? "العنوان النهائي" : "Final article title" },
      dek: { type: "string", description: lang === "ar" ? "ملخص بجملة واحدة، 25-35 كلمة" : "One-sentence subhead, 25-35 words" },
      body: { type: "string", description: lang === "ar" ? "متن المقال كـ HTML بعلامات <p> و <h2> فقط" : "Article body as HTML with <p> and <h2> tags only" },
      readTime: { type: "string", description: lang === "ar" ? "مثل: قراءة 5 دقائق" : "e.g. '5 min read'" },
    },
    required: ["title", "dek", "body", "readTime"],
  };

  return await callTool("submit_article", schema, userPrompt, 4000);
}

// ============ 05 — FACT-CHECK (tool use, RAG) ============
async function factCheck(article, brief, lang) {
  const prompt = `You are the fact-check layer of an autonomous publishing pipeline. Verify the article below against the source material it was generated from.

Look for: stat contradictions, name/date/company errors, unsupported cause-effect claims, misattributed quotes, fabricated company products, fabricated statistics from named institutions.

SOURCE:
${brief.source.source} — "${brief.source.title}"
${brief.source.summary}

ARTICLE (${lang}):
TITLE: ${article.title}
DEK: ${article.dek}
BODY: ${article.body}`;

  const schema = {
    type: "object",
    properties: {
      pass: { type: "boolean", description: "True if article is faithful to source material; false if hallucinations or unsupported claims found" },
      issues: { type: "array", items: { type: "string" }, description: "Specific issues found if pass=false" },
    },
    required: ["pass"],
  };

  return await callTool("submit_check", schema, prompt, 1500);
}

// ============ 06–07 — FORMAT + PUBLISH ============
function slugify(s) {
  return s.toLowerCase()
    .replace(/[؀-ۿ]/g, "") // strip Arabic
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function appendArticle(article, brief, lang) {
  const file = lang === "ar" ? ARTICLES_AR_FILE : ARTICLES_EN_FILE;
  delete require.cache[require.resolve(file)];
  const existing = require(file);
  const tagsField = lang === "ar" ? "tags_ar" : "tags_en";
  const slug = slugify(brief.headline_en);
  const newArticle = {
    slug,
    title: article.title,
    dek: article.dek,
    date: new Date().toISOString().slice(0, 10),
    tags: brief[tagsField] || (lang === "ar" ? ["ذكاء اصطناعي", "تحليل قطاعي"] : ["AI", "Industry analysis"]),
    readTime: article.readTime,
    body: article.body,
  };
  existing.unshift(newArticle);
  const out = "module.exports = " + JSON.stringify(existing, null, 2) + ";\n";
  fs.writeFileSync(file, out);
  console.log(`  [${lang}] Appended: ${slug}`);
}

// ============ ORCHESTRATION ============
async function run() {
  console.log("=== AI News KSA — bilingual pipeline (v2 / tool use) ===");
  console.log(`Started ${new Date().toISOString()}\n`);

  const tracked = fs.existsSync(TRACKED_FILE) ? JSON.parse(fs.readFileSync(TRACKED_FILE)) : [];
  const items = await ingestFeeds();
  const briefs = await selectAndBrief(items, tracked);
  if (briefs.length === 0) {
    console.log("\nDone (no new content).");
    return;
  }

  let successCount = 0;
  for (const brief of briefs) {
    try {
      console.log(`\n[${brief.headline_en}]`);

      console.log("  Generating EN...");
      const articleEN = await generateArticle(brief, "en");
      const checkEN = await factCheck(articleEN, brief, "en");
      if (!checkEN.pass) {
        console.warn(`  ! EN fact-check failed: ${(checkEN.issues || []).join("; ")}`);
        continue;
      }

      console.log("  Generating AR...");
      const articleAR = await generateArticle(brief, "ar");
      const checkAR = await factCheck(articleAR, brief, "ar");
      if (!checkAR.pass) {
        console.warn(`  ! AR fact-check failed: ${(checkAR.issues || []).join("; ")}`);
        continue;
      }

      appendArticle(articleEN, brief, "en");
      appendArticle(articleAR, brief, "ar");
      tracked.push(brief.link);
      successCount++;
    } catch (e) {
      console.warn(`  ! Article failed: ${e.message}`);
    }
  }

  fs.writeFileSync(TRACKED_FILE, JSON.stringify(tracked, null, 2));

  if (successCount > 0) {
    console.log(`\n[regen] Rebuilding static site...`);
    require("child_process").execSync("node scripts/generate.js", {
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
    });
  }

  console.log(`\n=== Done. ${successCount}/${briefs.length} stories shipped in both languages. ===`);
}

run().catch(e => {
  console.error("Pipeline error:", e);
  process.exit(1);
});
