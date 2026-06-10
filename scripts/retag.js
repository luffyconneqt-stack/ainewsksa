/**
 * AI News KSA — One-shot tag migration
 *
 * Relabels every existing EN + AR article with tags drawn ONLY from the fixed
 * taxonomy (kept in sync with pipeline.js). Processes in batches via Claude
 * tool-use, then rewrites articles/articles.js and articles/articles-ar.js.
 *
 * Usage:
 *   node scripts/retag.js          # dry run — logs proposed changes, no writes
 *   node scripts/retag.js --apply  # apply: rewrite both article files in place
 *
 * Triggered manually from GitHub Actions via .github/workflows/retag.yml.
 * Keep the TAXONOMY_* arrays below in sync with the same constants in pipeline.js.
 */

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
require("dotenv").config();

// --- KEEP IN SYNC WITH pipeline.js ---
const TAXONOMY_EN = [
  "AI Strategy",
  "Vendor Launches",
  "Agentic AI",
  "AI Workforce",
  "Marketing AI",
  "Customer Experience",
  "E-commerce & Retail",
  "Content & Creator AI",
  "Fintech & Banking AI",
  "Sovereign & Bilingual AI",
  "AI Governance",
  "AI Economics",
  "Open Source & Research",
  "Industry Analysis",
];
const TAXONOMY_AR = [
  "استراتيجية الذكاء الاصطناعي",
  "إطلاقات الموردين",
  "الذكاء الاصطناعي الوكيلي",
  "القوى العاملة بالذكاء الاصطناعي",
  "ذكاء اصطناعي للتسويق",
  "تجربة العملاء",
  "التجارة الإلكترونية والتجزئة",
  "ذكاء اصطناعي للمحتوى والمبدعين",
  "ذكاء اصطناعي للبنوك والتمويل",
  "ذكاء اصطناعي سيادي وثنائي اللغة",
  "حوكمة الذكاء الاصطناعي",
  "اقتصاديات الذكاء الاصطناعي",
  "مصدر مفتوح وأبحاث",
  "تحليل قطاعي",
];

const MODEL = "claude-sonnet-4-6";
const BATCH_SIZE = 10; // articles per Claude call
const APPLY = process.argv.includes("--apply");

const ARTICLES_DIR = path.resolve(__dirname, "../articles");
const ARTICLES_EN_FILE = path.join(ARTICLES_DIR, "articles.js");
const ARTICLES_AR_FILE = path.join(ARTICLES_DIR, "articles-ar.js");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 5,
});

// Strip lone UTF-16 surrogates (broken emoji halves) — same sanitizer as pipeline.js.
function clean(s) {
  return typeof s === "string"
    ? s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    : s;
}

function stripHtml(s) {
  return clean(String(s || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function relabelBatch(batch) {
  const tool = {
    name: "submit_tags",
    description: "Assign canonical tags to each article from the approved taxonomy.",
    input_schema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              slug: { type: "string" },
              tags_en: {
                type: "array",
                items: { type: "string", enum: TAXONOMY_EN },
                minItems: 2,
                maxItems: 3,
              },
              tags_ar: {
                type: "array",
                items: { type: "string", enum: TAXONOMY_AR },
                minItems: 2,
                maxItems: 3,
              },
            },
            required: ["slug", "tags_en", "tags_ar"],
          },
        },
      },
      required: ["results"],
    },
  };

  const prompt = `You are relabeling articles for an industry-analysis publication on AI for marketing in MENA.

Assign 2 tags per article from this FIXED taxonomy (do NOT invent new tags):
  English: ${TAXONOMY_EN.join(" | ")}
  Arabic (index-aligned with English — use the same index when possible): ${TAXONOMY_AR.join(" | ")}

For each article below, pick the 2 most-relevant English tags and their Arabic equivalents. Return ONE entry per slug, in the same order as the input. Use the article's title, dek, and excerpt to judge — current_tags are informational only and may be noisy.

Articles:
${batch.map((a, i) =>
    `[${i}] slug: ${a.slug}
TITLE: ${clean(a.title_en || "")}
DEK: ${clean(a.dek_en || "")}
EXCERPT: ${stripHtml(a.body_en).slice(0, 400)}
CURRENT_TAGS (for reference, may be noisy): ${(a.current_tags_en || []).join(", ")}`
  ).join("\n\n")}`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_tags" },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = res.content.find(c => c.type === "tool_use");
  if (!toolUse) throw new Error("No tool_use in response");
  return toolUse.input.results;
}

async function main() {
  console.log(`=== retag.js ${APPLY ? "(APPLY)" : "(DRY RUN)"} ===`);

  delete require.cache[require.resolve(ARTICLES_EN_FILE)];
  delete require.cache[require.resolve(ARTICLES_AR_FILE)];
  const articlesEN = require(ARTICLES_EN_FILE);
  const articlesAR = require(ARTICLES_AR_FILE);

  // Use EN content as the basis (English titles/body are cleaner for classification).
  const work = articlesEN.map(en => ({
    slug: en.slug,
    title_en: en.title,
    dek_en: en.dek,
    body_en: en.body,
    current_tags_en: en.tags || [],
  }));

  console.log(`Loaded ${articlesEN.length} EN articles, ${articlesAR.length} AR articles`);
  console.log(`Processing in batches of ${BATCH_SIZE} (${Math.ceil(work.length / BATCH_SIZE)} batches)\n`);

  const tagMap = new Map(); // slug -> { tags_en, tags_ar }
  for (let i = 0; i < work.length; i += BATCH_SIZE) {
    const batch = work.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(work.length / BATCH_SIZE);
    process.stdout.write(`  Batch ${batchNum}/${total} (${batch.length} articles) ... `);
    try {
      const results = await relabelBatch(batch);
      for (const r of results) tagMap.set(r.slug, { tags_en: r.tags_en, tags_ar: r.tags_ar });
      console.log(`OK (${results.length} tagged)`);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
  }

  // Apply tag updates in-memory
  let changedEN = 0;
  let changedAR = 0;
  for (const en of articlesEN) {
    const t = tagMap.get(en.slug);
    if (!t) continue;
    const before = JSON.stringify(en.tags || []);
    en.tags = t.tags_en;
    if (JSON.stringify(en.tags) !== before) changedEN++;
  }
  for (const ar of articlesAR) {
    const t = tagMap.get(ar.slug);
    if (!t) continue;
    const before = JSON.stringify(ar.tags || []);
    ar.tags = t.tags_ar;
    if (JSON.stringify(ar.tags) !== before) changedAR++;
  }

  console.log(`\nProposed: ${changedEN} EN tag updates, ${changedAR} AR tag updates`);

  // Tag-frequency preview so we can sanity-check the distribution
  const freq = {};
  for (const a of articlesEN) for (const t of (a.tags || [])) freq[t] = (freq[t] || 0) + 1;
  console.log("\nResulting EN tag distribution:");
  Object.entries(freq).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${n.toString().padStart(3)}  ${t}`));

  if (!APPLY) {
    console.log("\nDry run — no files written. Run with --apply to commit changes.");
    return;
  }

  fs.writeFileSync(ARTICLES_EN_FILE, "module.exports = " + JSON.stringify(articlesEN, null, 2) + ";\n");
  fs.writeFileSync(ARTICLES_AR_FILE, "module.exports = " + JSON.stringify(articlesAR, null, 2) + ";\n");
  console.log(`\nWrote ${ARTICLES_EN_FILE}`);
  console.log(`Wrote ${ARTICLES_AR_FILE}`);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
