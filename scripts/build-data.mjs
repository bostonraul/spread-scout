// Spread Scout data build.
// Runs in the GitHub Action (and locally with `node scripts/build-data.mjs`):
//   1. reads NSE CSV files dropped into incoming/, merges them into issuer profiles, moves them to data/raw/
//   2. refreshes the regulatory news feed from SEBI and RBI RSS
//   3. if ECOURTS_API_KEY is set, checks court cases for the issuers with the strongest signals
//   4. compiles everything into data/data.js, which the site loads
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const E = require(path.join(ROOT, "js/engine.js"));
const P = (...p) => path.join(ROOT, ...p);
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(P(p), "utf8")); } catch (e) { return d; } };
const writeJson = (p, v, pretty) => fs.writeFileSync(P(p), JSON.stringify(v, null, pretty ? 1 : 0) + "\n");
const cfg = readJson("scripts/config.json", {});
const now = new Date();
const nowIso = now.toISOString();
const log = (...a) => console.log(...a);
const report = [];

// ---------- 1. incoming NSE files ----------
const issuers = readJson("data/state/issuers.json", {});
const uploads = readJson("data/state/uploads.json", {});
fs.mkdirSync(P("data/raw"), { recursive: true });
fs.mkdirSync(P("incoming"), { recursive: true });
const incoming = fs.readdirSync(P("incoming")).filter(f => /\.csv$/i.test(f));
for (const file of incoming) {
  const src = P("incoming", file);
  const text = fs.readFileSync(src, "utf8");
  const { headers, records } = E.toRecords(E.parseCSV(text));
  const type = E.detect(headers);
  if (!type || !records.length) {
    fs.mkdirSync(P("incoming/not-recognised"), { recursive: true });
    fs.renameSync(src, P("incoming/not-recognised", file));
    report.push(`Not recognised, moved to incoming/not-recognised: ${file}`);
    continue;
  }
  const res = E.process(type, records, {});
  const sm = res.summary;
  let newIssuers = 0;
  for (const p of res.partials) {
    if (!issuers[p.slug]) newIssuers++;
    issuers[p.slug] = E.mergeIssuer(issuers[p.slug] || null, p, { type, file, uploadedAt: nowIso, from: sm.from, to: sm.to });
  }
  let dest = file;
  if (fs.existsSync(P("data/raw", dest))) dest = file.replace(/\.csv$/i, "") + "-" + nowIso.slice(0, 10) + "-" + crypto.randomBytes(2).toString("hex") + ".csv";
  fs.renameSync(src, P("data/raw", dest));
  uploads["u-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex")] = {
    file, type, sizeBytes: Buffer.byteLength(text), uploadedAt: nowIso, uploadedBy: "admin",
    rawPath: "data/raw/" + dest, summary: sm, issuersTouched: res.partials.length, newIssuers
  };
  report.push(`Processed ${file}: ${E.TYPE_LABEL[type]}, ${sm.rows} rows, ${res.partials.length} issuers (${newIssuers} new)`);
}

// ---------- 2. news feeds ----------
const news = readJson("data/feeds/news.json", { items: {}, sources: {} });
news.items = news.items || {}; news.sources = news.sources || {};
const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
  .replace(/\s+/g, " ").trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? m[1] : ""; };
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
function parseDate(s) {
  s = decode(s);
  let m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const t = Date.parse(s); return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
const has = (text, words) => words.some(w => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${w.length <= 4 ? "([^a-z]|$)" : ""}`, "i").test(text));
function categorise(text) {
  if (has(text, ["alternative investment", "aif"])) return "AIFs";
  if (has(text, ["foreign portfolio", "fpi", "fcnr", "nre", "non-resident", "nri", "external commercial", "ecb", "fema", "remittance", "lrs", "overseas"])) return "Capital flows";
  if (has(text, ["repo", "monetary policy", "interest rate", "liquidity"])) return "Rates";
  return "Regulatory";
}
async function fetchText(url, id) {
  if (process.env.SS_FEED_FIXTURES) return fs.readFileSync(path.join(process.env.SS_FEED_FIXTURES, id + ".xml"), "utf8");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (spread-scout feed reader)", accept: "application/rss+xml, application/xml, text/xml" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
for (const f of (cfg.feeds || []).filter(f => f.enabled)) {
  try {
    const xml = await fetchText(f.url, f.id);
    const items = xml.split(/<item[\s>]/i).slice(1).map(s => s.split(/<\/item>/i)[0]);
    let added = 0;
    for (const it of items) {
      const title = decode(tag(it, "title"));
      const link = decode(tag(it, "link"));
      const desc = decode(tag(it, "description"));
      const date = parseDate(tag(it, "pubDate")) || nowIso.slice(0, 10);
      const text = (title + " " + desc).toLowerCase();
      if (!title || has(text, cfg.exclude || []) || !has(text, cfg.include || [])) continue;
      const id = "auto-" + crypto.createHash("sha1").update(link || title).digest("hex").slice(0, 12);
      if (news.items[id]) continue;
      news.items[id] = {
        title, date, category: categorise(text), scope: "Market",
        summary: desc && desc.toLowerCase() !== title.toLowerCase() ? desc.slice(0, 320) : `${f.label} published this on ${date}.`,
        source: { label: f.label, url: link || f.url }, auto: true
      };
      added++;
    }
    news.sources[f.id] = { ok: true, checkedAt: nowIso, items: items.length, added };
    report.push(`${f.label} feed: ${items.length} items read, ${added} relevant new`);
  } catch (e) {
    news.sources[f.id] = { ok: false, checkedAt: nowIso, error: String(e.message || e) };
    report.push(`${f.label} feed failed: ${e.message || e}`);
  }
}
const cutoff = new Date(now.getTime() - (cfg.newsKeepDays || 120) * 864e5).toISOString().slice(0, 10);
news.items = Object.fromEntries(Object.entries(news.items)
  .filter(([, v]) => (v.date || "") >= cutoff)
  .sort((a, b) => (b[1].date || "").localeCompare(a[1].date || ""))
  .slice(0, cfg.newsMaxItems || 150));
news.lastRun = nowIso;

// ---------- 3. court checks (optional) ----------
const KEY = process.env.ECOURTS_API_KEY;
let court = { enabled: !!KEY, checked: 0 };
if (KEY) {
  const cc = cfg.courtChecks || {};
  const recheckBefore = new Date(now.getTime() - (cc.recheckDays || 7) * 864e5).toISOString();
  const from = new Date(now.getTime() - (cc.lookbackYears || 3) * 365 * 864e5).toISOString().slice(0, 10);
  const candidates = Object.entries(issuers)
    .map(([slug, d]) => ({ slug, d, v: E.derive(d, now) }))
    .filter(x => x.v.score >= (cc.minScore || 5) || x.v.flags.some(f => ["default", "downgrade", "subA", "watch", "negative"].includes(f)))
    .filter(x => !x.d.litigation || (x.d.litigation.checkedAt || "") < recheckBefore)
    .sort((a, b) => b.v.score - a.v.score)
    .slice(0, cc.maxPerRun || 15);
  for (const { slug, d } of candidates) {
    const name = d.name.replace(/\b(limited|ltd|private|pvt)\b\.?/gi, "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
    const qs = new URLSearchParams({ litigants: name, pageSize: "10", filingDateFrom: from });
    try {
      const r = await fetch("https://webapi.ecourtsindia.com/api/partner/search?" + qs, { headers: { Authorization: "Bearer " + KEY, accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const data = j.data || {};
      d.litigation = {
        checkedAt: nowIso, query: name, totalHits: data.totalHits || 0,
        cases: (data.results || []).slice(0, 10).map(c => ({
          cnr: c.cnr, court: c.courtName, type: c.caseType, status: c.caseStatus, filed: c.filingDate,
          nextHearing: c.nextHearingDate, decided: c.decisionDate,
          petitioners: (c.petitioners || []).slice(0, 3), respondents: (c.respondents || []).slice(0, 3)
        }))
      };
      court.checked++;
    } catch (e) {
      report.push(`Court check failed for ${d.name}: ${e.message || e}`);
      if (/HTTP (401|402|403)/.test(String(e.message))) break;
    }
  }
  report.push(`Court checks: ${court.checked} issuers checked`);
} else {
  report.push("Court checks skipped: add an ECOURTS_API_KEY secret to turn them on");
}

// ---------- 4. compile ----------
writeJson("data/state/issuers.json", issuers);
writeJson("data/state/uploads.json", uploads, true);
writeJson("data/feeds/news.json", news, true);
const manual = { ncds: readJson("data/manual/ncds.json", {}), leads: readJson("data/manual/leads.json", {}), intel: readJson("data/manual/intel.json", {}) };
const data = {
  meta: { generatedAt: nowIso, feeds: news.sources, newsLastRun: news.lastRun, court, report },
  issuers, uploads, ncds: manual.ncds, leads: manual.leads,
  intel: Object.assign({}, news.items, manual.intel),
  watchlist: {}
};
fs.writeFileSync(P("data/data.js"),
  "/* Spread Scout data file. Generated by scripts/build-data.mjs on " + nowIso + ". Do not edit by hand: edit data/manual/*.json instead. */\n" +
  "window.SPREAD_SCOUT_DATA = " + JSON.stringify(data) + ";\n");
log("Spread Scout data build, " + nowIso);
report.forEach(r => log(" - " + r));
log(`Issuers ${Object.keys(issuers).length}, news ${Object.keys(news.items).length}, NCDs ${Object.keys(manual.ncds).length}, leads ${Object.keys(manual.leads).length}`);
