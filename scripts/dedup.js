#!/usr/bin/env node
/**
 * One-shot duplicate cleanup script.
 *
 * Run this once to clean up duplicate articles caused by the pipeline picking
 * the same news event from multiple RSS sources. Identifies likely duplicates
 * via Claude and prints suggested deletions. You confirm, script removes them.
 *
 * Usage:
 *   node scripts/dedup.js              # dry run, prints what would be removed
 *   node scripts/dedup.js --apply      # actually remove from articles.js + articles-ar.js
 *
 * Requires ANTHROPIC_API_KEY in env (or .env).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const APPLY = process.argv.includes("--apply");
const ARTICLES_DIR = path.resolve(__dirname, "../articles");
const EN_FILE = path.join(ARTICLES_DIR, "articles.js");
const AR_FILE = path.join(ARTICLES_DIR, "articles-ar.js");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function findDuplicates(articles) {
  const prompt = `Below is a list of articles by index, title, and dek. Identify groups of articles that cover THE SAME NEWS EVENT, same company announcement, or same topic angle (even if titles differ).

For each duplicate group:
- Keep the article you judge BEST (most complete, best headline, earliest date if quality equal)
- Mark the others for removal

Return JSON only via the submit_duplicates tool.

Articles:
${articles.map((a, i) => `[${i}] ${a.date} — "${a.title}"\n     ${a.dek}`).join("\n\n")}`;

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    tools: [{
      name: "submit_duplicates",
      description: "Submit identified duplicate groups",
      input_schema: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                topic: { type: "string", description: "What this duplicate group covers" },
                keep_index: { type: "number" },
                remove_indices: { type: "array", items: { type: "number" } },
              },
              required: ["topic", "keep_index", "remove_indices"],
            },
          },
        },
        required: ["groups"],
      },
    }],
    tool_choice: { type: "tool", name: "submit_duplicates" },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = res.content.find(c => c.type === "tool_use");
  return toolUse.input.groups || [];
}

async function main() {
  delete require.cache[require.resolve(EN_FILE)];
  const en = require(EN_FILE);
  const ar = fs.existsSync(AR_FILE) ? (delete require.cache[require.resolve(AR_FILE)], require(AR_FILE)) : [];

  console.log(`Analyzing ${en.length} English articles for duplicates...`);
  const groups = await findDuplicates(en);

  if (groups.length === 0) {
    console.log("\n✅ No duplicates found.");
    return;
  }

  console.log(`\nFound ${groups.length} duplicate group(s):\n`);
  const slugsToRemove = new Set();
  for (const g of groups) {
    console.log(`Topic: ${g.topic}`);
    console.log(`  KEEP: [${g.keep_index}] "${en[g.keep_index]?.title}"`);
    for (const ri of g.remove_indices) {
      console.log(`  REMOVE: [${ri}] "${en[ri]?.title}" (slug: ${en[ri]?.slug})`);
      if (en[ri]?.slug) slugsToRemove.add(en[ri].slug);
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to actually remove.");
    return;
  }

  // Apply: filter both EN and AR by removing matching slugs
  const enFiltered = en.filter(a => !slugsToRemove.has(a.slug));
  const arFiltered = ar.filter(a => !slugsToRemove.has(a.slug));

  fs.writeFileSync(EN_FILE, "module.exports = " + JSON.stringify(enFiltered, null, 2) + ";\n");
  fs.writeFileSync(AR_FILE, "module.exports = " + JSON.stringify(arFiltered, null, 2) + ";\n");

  console.log(`\n✅ Removed ${en.length - enFiltered.length} EN + ${ar.length - arFiltered.length} AR articles.`);
  console.log(`Re-run 'node scripts/generate.js' to rebuild the site (or commit and let Cloudflare rebuild).`);
}

main().catch(e => {
  console.error("Dedup error:", e);
  process.exit(1);
});
