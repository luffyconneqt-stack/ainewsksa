#!/usr/bin/env node
/**
 * AI News KSA — bilingual autonomous content engine
 *
 * Runs on cron (default: every 6 hours via GitHub Actions). For each run:
 *   1. Ingests RSS feeds from major AI publications
 *   2. Uses Claude to select the 3 most relevant stories for an AI-marketing
 *      industry analysis audience
 *   3. For each story, generates BOTH an English article AND a native-MSA
 *      Arabic article (parallel generation, not translation)
 *   4. Fact-checks each output against source material via RAG-style verification
 *   5. Appends to articles/articles.js (EN) and articles/articles-ar.js (AR)
 *   6. Re-runs the static site generator
 *   7. Commits changes back to the repo (handled by the GitHub Actions workflow)
 *
 * Environment:
 *   ANTHROPIC_API_KEY  — required, get from https://console.anthropic.com
 *
 * Cost ceiling:
 *   ~$0.15 per article (brief + EN generate + AR generate + 2 fact-checks)
 *   3 articles per run × 2 languages × 4 runs/day = ~$3.60/day max
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const Parser = require("rss-parser");

// ============ CONFIG ============
const FEEDS = [
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "The Verge AI", url: "https://www.theverge.com/ai-artificial-intelligence/rss/index.xml" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml" },
  { name: "OpenAI", url: "https://openai.com/blog/rss.xml" },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/" },
];

const FOCUS = "AI for marketing, content, growth, lifecycle, and ad pipelines. " +
              "Industry analysis, not product announcements. Particular relevance " +
              "to MENA / GCC markets where possible.";

const MAX_NEW_PER_RUN = 3;
const ARTICLES_DIR = path.resolve(__dirname, "../articles");
const ARTICLES_EN_FILE = path.join(ARTICLES_DIR, "articles.js");
const ARTICLES_AR_FILE = path.join(ARTICLES_DIR, "articles-ar.js");
const TRACKED_FILE = path.join(ARTICLES_DIR, ".tracked.json");

const VOICE_EN = `You are writing for AI News KSA, an industry analysis publication on AI for marketing and growth in MENA markets. Editorial conventions:
- Analytical, not promotional. Skeptical of vendor claims.
- No marketing fluff. No exclamation points. No "in today's fast-paced world."
- Concrete numbers and specific examples preferred over abstract claims.
- Reference specific products / companies / vendors when relevant. Never name vendors in a way that suggests endorsement or sponsorship.
- Where natural, frame implications for MENA / GCC / KSA operators specifically.
- 600–800 words. HTML output with <p> and <h2> tags only — no markdown.`;

const VOICE_AR = `أنت تكتب لـ "أخبار الذكاء الاصطناعي KSA"، نشرة تحليل قطاعي عن الذكاء الاصطناعي للتسويق والنمو في أسواق الشرق الأوسط وشمال أفريقيا.
الاتفاقيات التحريرية:
- تحليلي، وليس ترويجياً. متشكك في ادعاءات البائعين.
- لا حشو تسويقي. لا علامات تعجب.
- أرقام محددة وأمثلة ملموسة مفضلة على الادعاءات المجردة.
- اذكر منتجات / شركات / موردين محددين عند الصلة. لا تذكر الموردين بطريقة تُوحي بالتأييد.
- حيث يكون طبيعياً، أطّر الآثار على مشغّلي الشرق الأوسط / الخليج / السعودية تحديداً.
- العربية الفصحى الحديثة (MSA)، بنبرة أعمال احترافية.
- 500-700 كلمة. مخرجات HTML بعلامات <p> و <h2> فقط — لا Markdown.
- هذا كتابة أصلية، وليس ترجمة من الإنجليزية. ابدأ من بيانات القصة المصدرية مباشرة.`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============ 01 — INGEST ============
async function ingestFeeds() {
  console.log("[01] Ingesting feeds...");
  const parser = new Parser({ timeout: 10000 });
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

// ============ 02 — BRIEF GENERATION ============
async function selectAndBrief(items, alreadyTracked) {
  console.log("[02] Selecting & briefing stories...");
  const fresh = items.filter(i => !alreadyTracked.includes(i.link));
  if (fresh.length === 0) {
    console.log("  No new items.");
    return [];
  }

  const prompt = `${FOCUS}

Below are ${fresh.length} recent items from AI news feeds. Pick the ${MAX_NEW_PER_RUN} most relevant for "AI News KSA" (AI for marketing & growth in MENA — industry analysis publication).
Return JSON only:

{ "selected": [
    { "link": "...", "angle": "the analytical angle", "tags_en": ["...", "..."], "tags_ar": ["...", "..."], "headline_en": "proposed English headline", "headline_ar": "proposed Arabic headline (MSA)" }
] }

Items:
${fresh.map((i, idx) => `[${idx}] ${i.source} — ${i.title}\n    ${i.summary}\n    ${i.link}`).join("\n\n")}`;

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Brief JSON not parsed");
  const briefs = JSON.parse(jsonMatch[0]).selected;
  console.log(`  Selected ${briefs.length} stories`);

  return briefs.map(b => ({ ...b, source: fresh.find(f => f.link === b.link) }));
}

// ============ 03–04 — VOICE + GENERATION (per language) ============
async function generateArticle(brief, lang) {
  const voice = lang === "ar" ? VOICE_AR : VOICE_EN;
  const headline = lang === "ar" ? brief.headline_ar : brief.headline_en;
  const tagsField = lang === "ar" ? "tags_ar" : "tags_en";

  const userPrompt = `${voice}

اكتب مقالاً.
${lang === "en" ? "Write an article." : ""}

ANGLE / الزاوية: ${brief.angle}
SOURCE / المصدر: ${brief.source.source} — "${brief.source.title}"
SOURCE LINK: ${brief.source.link}
SOURCE SUMMARY: ${brief.source.summary}
PROPOSED HEADLINE / العنوان المقترح: ${headline}

Output JSON only, in this shape:
{
  "title": "${lang === "ar" ? "العنوان النهائي" : "the final article title"}",
  "dek": "${lang === "ar" ? "ملخص بجملة واحدة، 25-35 كلمة" : "one-sentence subhead, 25–35 words"}",
  "body": "${lang === "ar" ? "متن المقال كـ HTML، 500-700 كلمة، باستخدام علامات <p> و <h2> فقط" : "the article body as HTML, 600–800 words, using <p> and <h2> tags only"}",
  "readTime": "${lang === "ar" ? "قراءة ٥ دقائق" : "5 min read"}"
}`;

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = res.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Article JSON not parsed (${lang})`);
  return JSON.parse(jsonMatch[0]);
}

// ============ 05 — FACT-CHECK (RAG) ============
async function factCheck(article, brief, lang) {
  const prompt = `You are the fact-check layer. Verify the article below against the source material.
Look for: stat contradictions, name/date/company errors, unsupported cause-effect claims, misattributed quotes.

If everything checks out: {"pass": true}
If issues found: {"pass": false, "issues": ["...", "..."]}

SOURCE:
${brief.source.source} — "${brief.source.title}"
${brief.source.summary}

ARTICLE (${lang}):
${article.title}
${article.dek}

${article.body}`;

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { pass: false, issues: ["fact-check parse error"] };
  return JSON.parse(jsonMatch[0]);
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
  // Slug — derive from English headline for consistency across languages
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
  console.log("=== AI News KSA — bilingual pipeline ===");
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

      // EN
      console.log("  Generating EN...");
      const articleEN = await generateArticle(brief, "en");
      const checkEN = await factCheck(articleEN, brief, "en");
      if (!checkEN.pass) {
        console.warn(`  ! EN fact-check failed: ${(checkEN.issues || []).join("; ")}`);
        continue;
      }

      // AR
      console.log("  Generating AR...");
      const articleAR = await generateArticle(brief, "ar");
      const checkAR = await factCheck(articleAR, brief, "ar");
      if (!checkAR.pass) {
        console.warn(`  ! AR fact-check failed: ${(checkAR.issues || []).join("; ")}`);
        // EN passed but AR failed — append EN only? For consistency, skip both.
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
