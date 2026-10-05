/* Spread Scout ingestion engine: turns NSE debt CSV downloads into issuer profiles.
   Shared by the page (admin upload) and by the seeding script, so both process data the same way. */
(function (root) {
  "use strict";

  const RANKS = ["AAA","AA+","AA","AA-","A+","A","A-","BBB+","BBB","BBB-","BB+","BB","BB-","B+","B","B-","CCC","CC","C","D"];
  const CAP = { isins: 400, ratingEvents: 120, issues: 400, payments: 120 };

  // ---------- CSV ----------
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, "");
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function toRecords(rows) {
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0].map(h => h.replace(/\s+/g, " ").trim().toUpperCase());
    const records = rows.slice(1).filter(r => r.some(v => v && v.trim())).map(r => {
      const o = {}; headers.forEach((h, i) => { o[h] = (r[i] ?? "").replace(/\s+/g, " ").trim(); }); return o;
    });
    return { headers, records };
  }
  function detect(headers) {
    const h = new Set(headers);
    if (h.has("NAME OF CREDIT RATING AGENCY") && h.has("CREDIT RATING")) return "crd";
    if (h.has("DATE OF DEFAULT") && h.has("NATURE OF ISSUE")) return "dpd";
    if (h.has("DETAILS") && h.has("TYPE") && h.has("ISIN") && h.has("DATE")) return "docs";
    return null;
  }
  const TYPE_LABEL = { crd: "Credit rating details", dpd: "Default payment details", docs: "Debt offer documents and term sheets" };

  // ---------- helpers ----------
  const MON = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
  function isoDate(s) {
    if (!s) return null;
    s = String(s).trim();
    let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
    m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})/);
    if (m && MON[m[2].toUpperCase()]) return `${m[3]}-${String(MON[m[2].toUpperCase()]).padStart(2,"0")}-${m[1].padStart(2,"0")}`;
    return null;
  }
  function slugify(name) {
    return String(name).toLowerCase().replace(/&/g, " and ")
      .replace(/\b(limited|ltd|private|pvt)\b\.?/g, " ")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "unknown";
  }
  function agencyShort(a) {
    const s = String(a || "").toUpperCase();
    if (s.includes("CRISIL")) return "CRISIL";
    if (s.includes("ICRA")) return "ICRA";
    if (s.includes("CARE")) return "CARE";
    if (s.includes("INDIA RATINGS") || /^IND\b/.test(s)) return "India Ratings";
    if (s.includes("BRICKWORK") || s.includes("BWR")) return "Brickwork";
    if (s.includes("INFOMERICS") || s.includes("IVR")) return "Infomerics";
    if (s.includes("ACUIT")) return "Acuite";
    return a ? String(a).trim() : "";
  }
  // Long-term rating symbol from free text; short-term scales (A1+, A4 ...) and agency prefixes are ignored.
  function ratingSym(r) {
    if (!r) return null;
    let s = String(r).replace(/(^|\s)n(?=\s|$)/g, " ").replace(/;\s*n(?=[A-Z])/g, "; ").toUpperCase();
    if (/WITHDRAWN/.test(s) && !/(AAA|AA|BBB|BB)/.test(s)) return null;
    s = s.replace(/\bMINUS\b/g, "-").replace(/\bPLUS\b/g, "+")
      .replace(/INDIA RATINGS|\bINDIA\b|CRISIL|ICRA|CARE|ACUITE|ACUITÉ|INFOMERICS|BRICKWORK|BWR|IVR|\bIND\b|^IND(?=[ABCD])|\bPP\b|\bMLD\b|PP-MLD|\(CE\)|\(SO\)|\(CE\b/g, " ")
      .replace(/\s+/g, "");
    const m = s.match(/(?<![A-Z])(AAA|AA|BBB|BB|A|B|CCC|CC|C|D)(?:([+-])|(?![A-Z0-9]))/);
    if (!m) return null;
    return m[1] + (m[2] || "");
  }
  const rank = (sym) => sym ? RANKS.indexOf(sym) : -1;
  function crore(v) { const n = parseFloat(String(v || "").replace(/,/g, "")); return isNaN(n) ? null : Math.round(n / 1e7 * 100) / 100; }
  function isinKind(isin) {
    const c = String(isin || "").slice(7, 9);
    return ({ "07": "Debenture (usually secured)", "08": "Debenture (usually unsecured)", "14": "Commercial paper", "15": "Securitised / other debt", "16": "Certificate of deposit" })[c] || null;
  }
  function parseTerms(detail) {
    const d = String(detail || "");
    const pct = d.match(/(\d{1,2}(?:\.\d{1,4})?)\s*%/);
    let structure = "Fixed";
    if (/market\s*l(in)?k|mkt\s*l(in)?k|\bmld\b/i.test(d)) structure = "Market-linked";
    else if (/t-?bill\s*l(in)?k|tbill/i.test(d)) structure = "T-bill linked";
    else if (/shelf offer/i.test(d)) structure = "Shelf document";
    else if (/trust deed/i.test(d)) structure = "Trust deed";
    let coupon = pct ? parseFloat(pct[1]) : null;
    if (coupon === 0) structure = "Zero coupon";
    let maturity = null;
    const after = pct ? d.slice(pct.index + pct[0].length) : d;
    const y = after.match(/\b(20\d{2})\b/);
    if (y && structure !== "Shelf document") maturity = y[1];
    const cp = d.match(/CP\s+(\d{2})\/(\d{2})\/(\d{2,4})/i);
    if (cp) { maturity = `${cp[3].length === 2 ? "20" + cp[3] : cp[3]}-${cp[2]}-${cp[1]}`; structure = "Commercial paper"; }
    return { coupon: structure === "Fixed" || structure === "Zero coupon" ? coupon : null, structure, maturity };
  }

  // ---------- processors: file records -> partial issuer profiles ----------
  function process(type, records, meta) {
    meta = meta || {};
    const issuers = new Map();
    const get = (name) => {
      const slug = slugify(name);
      if (!issuers.has(slug)) issuers.set(slug, { slug, name: name.trim(), isins: new Set(), ratingEvents: new Map(), issues: new Map(), payments: new Map() });
      return issuers.get(slug);
    };
    const dates = [];
    let skipped = 0;

    for (const r of records) {
      const name = r["COMPANY NAME"];
      if (!name) { skipped++; continue; }
      const p = get(name);
      const isin = (r["ISIN"] || "").toUpperCase();
      if (/^IN[A-Z0-9]{10}$/.test(isin)) p.isins.add(isin);

      if (type === "crd") {
        const agency = agencyShort(r["NAME OF CREDIT RATING AGENCY"]);
        const raw = r["CREDIT RATING"] || "";
        const sym = ratingSym(raw);
        const outlook = r["OUTLOOK"] || "";
        const date = isoDate(r["DATE OF CREDIT RATING"]) || isoDate(r["DATE"]);
        const eAgency = agencyShort(r["NAME OF CREDIT RATING AGENCY (EARLIER RATING)"]);
        const eRaw = r["CREDIT RATING (EARLIER RATING)"] || "";
        const eSym = ratingSym(eRaw);
        const withdrawn = /withdrawn/i.test(raw + " " + outlook + " " + (r["SPECIFY OTHER RATING ACTION"] || ""));
        let dir = 0;
        if (sym && eSym && eAgency === agency && sym !== eSym) dir = rank(eSym) > rank(sym) ? 1 : -1;
        const filedOn = isoDate(r["DATE"]);
        if (filedOn || date) dates.push(filedOn || date);
        const k = [agency, sym || raw.slice(0, 30), outlook.slice(0, 40), date, eSym || "", eAgency, withdrawn ? "W" : ""].join("|");
        const ev = p.ratingEvents.get(k) || {
          k, date, agency, rating: raw.slice(0, 80), sym, outlook: outlook.slice(0, 120),
          action: r["RATING ACTION"] || "", other: (r["SPECIFY OTHER RATING ACTION"] || "").slice(0, 120),
          earlier: eAgency === agency ? eRaw.slice(0, 60) : "", earlierSym: eAgency === agency ? eSym : null,
          dir, withdrawn, isinCount: 0, filed: isoDate(r["DATE"]), url: r["XBRL FILE NAME"] || ""
        };
        ev.isinCount++;
        p.ratingEvents.set(k, ev);
      }

      if (type === "docs") {
        const t = r["TYPE"] || "";
        const kind = /NCD/i.test(t) ? "NCD" : /CP/i.test(t) ? "CP" : /trust deed/i.test(t) ? "Trust deed" : t;
        const date = isoDate(r["DATE"]);
        if (date) dates.push(date);
        const terms = parseTerms(r["DETAILS"]);
        const k = [isin, kind, r["DETAILS"]].join("|").slice(0, 200);
        if (!p.issues.has(k)) p.issues.set(k, {
          k, isin, kind, reissue: /re-?issue/i.test(t), placement: r["ISSUE"] || "", detail: (r["DETAILS"] || "").slice(0, 140),
          date, coupon: terms.coupon, structure: kind === "CP" ? "Commercial paper" : terms.structure, maturity: terms.maturity
        });
      }

      if (type === "dpd") {
        const due = isoDate(r["DUE DATE OF INTEREST/PAYMENT"]);
        if (due) dates.push(due);
        const k = [isin, r["NATURE OF ISSUE"], due].join("|");
        p.payments.set(k, {
          k, isin, nature: r["NATURE OF ISSUE"] || "", issueSizeCr: crore(r["ISSUE SIZE"]), due,
          defaultDate: isoDate(r["DATE OF DEFAULT"]), detail: (r["DEFAULT DETAILS"] || "").replace(/n+(?=[A-Z\[(\d])/g, " ").slice(0, 200),
          amountCr: crore(r["AMOUNT OF DEFAULT"]), paidOn: isoDate(r["ACTUAL PAYMENT DATE"]),
          trusteeVerified: /yes/i.test(r["VERIFICATION ON STATUS OF DEBENTURES TRUSTEE"] || ""), url: r["XBRL FILE NAME"] || ""
        });
      }
    }

    dates.sort();
    const partials = [...issuers.values()].map(p => ({
      slug: p.slug, name: p.name, isins: [...p.isins],
      ratingEvents: [...p.ratingEvents.values()], issues: [...p.issues.values()], payments: [...p.payments.values()]
    }));
    const summary = summarize(type, partials, records.length, skipped, dates[0], dates[dates.length - 1]);
    return { type, label: TYPE_LABEL[type], partials, summary, meta };
  }

  function summarize(type, partials, rows, skipped, from, to) {
    const s = { rows, skipped, issuers: partials.length, from: from || null, to: to || null };
    if (type === "crd") {
      const ev = partials.flatMap(p => p.ratingEvents);
      s.ratingEvents = ev.length;
      s.upgrades = partials.filter(p => p.ratingEvents.some(e => e.dir > 0)).length;
      s.downgrades = partials.filter(p => p.ratingEvents.some(e => e.dir < 0)).length;
      s.defaults = partials.filter(p => p.ratingEvents.some(e => e.sym === "D" || /default/i.test(e.outlook))).length;
      s.subA = partials.filter(p => p.ratingEvents.some(e => e.sym && rank(e.sym) >= 7)).length;
    }
    if (type === "docs") {
      const is = partials.flatMap(p => p.issues);
      s.ncd = is.filter(i => i.kind === "NCD").length;
      s.cp = is.filter(i => i.kind === "CP").length;
      s.trustDeeds = is.filter(i => i.kind === "Trust deed").length;
      s.highCoupon = partials.filter(p => p.issues.some(i => i.kind === "NCD" && i.coupon >= 10)).length;
    }
    if (type === "dpd") {
      const pm = partials.flatMap(p => p.payments);
      s.payments = pm.length;
      s.amountCr = Math.round(pm.reduce((a, b) => a + (b.amountCr || 0), 0) * 100) / 100;
    }
    return s;
  }

  // ---------- merge partial into stored issuer doc (idempotent) ----------
  function mergeIssuer(existing, partial, source) {
    const d = existing ? JSON.parse(JSON.stringify(existing)) : { slug: partial.slug, name: partial.name, isins: [], ratingEvents: [], issues: [], payments: [], sourcesSeen: {} };
    const byK = (arr) => new Map((arr || []).map(x => [x.k, x]));
    const isins = new Set([...(d.isins || []), ...partial.isins]);
    d.isins = [...isins].slice(0, CAP.isins);
    d.isinTotal = Math.max(d.isinTotal || 0, isins.size);
    const re = byK(d.ratingEvents); partial.ratingEvents.forEach(e => re.set(e.k, e));
    d.ratingEvents = [...re.values()].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, CAP.ratingEvents);
    const is = byK(d.issues); partial.issues.forEach(e => is.set(e.k, e));
    d.issues = [...is.values()].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, CAP.issues);
    const pm = byK(d.payments); partial.payments.forEach(e => pm.set(e.k, e));
    d.payments = [...pm.values()].sort((a, b) => (b.due || "").localeCompare(a.due || "")).slice(0, CAP.payments);
    d.sourcesSeen = Object.assign({}, d.sourcesSeen, source ? { [source.type]: { file: source.file, uploadedAt: source.uploadedAt, from: source.from, to: source.to } } : {});
    d.updatedAt = source && source.uploadedAt || new Date().toISOString();
    d.derived = derive(d);
    return d;
  }

  // ---------- signals ----------
  const SIGNALS = {
    default:   { label: "Default history", lens: "distress", w: 4 },
    downgrade: { label: "Downgraded", lens: "distress", w: 3 },
    watch:     { label: "On rating watch", lens: "distress", w: 2 },
    negative:  { label: "Negative outlook", lens: "distress", w: 2 },
    withdrawn: { label: "Rating withdrawn", lens: "distress", w: 1 },
    subA:      { label: "Rated below A-", lens: "yield", w: 3 },
    aBand:     { label: "A band", lens: "yield", w: 1 },
    highCoupon:{ label: "Coupon 10%+", lens: "yield", w: 3 },
    raising:   { label: "Raised NCDs in last 90 days", lens: "raising", w: 2 },
    cpHeavy:   { label: "Heavy CP rollover", lens: "raising", w: 1 },
    upgrade:   { label: "Upgraded", lens: "improving", w: 2 }
  };
  function derive(d, now) {
    now = now ? new Date(now) : new Date();
    const cutoff = new Date(now.getTime() - 90 * 864e5).toISOString().slice(0, 10);
    const latest = {};
    for (const e of d.ratingEvents || []) {
      if (!e.agency) continue;
      const cur = latest[e.agency];
      if (!cur || (e.date || "") > (cur.date || "")) latest[e.agency] = e;
    }
    const current = Object.values(latest).filter(e => e.sym && !e.withdrawn);
    const lowest = current.map(e => e.sym).sort((a, b) => rank(b) - rank(a))[0] || null;
    const ncds = (d.issues || []).filter(i => i.kind === "NCD");
    const cps = (d.issues || []).filter(i => i.kind === "CP");
    const coupons = ncds.map(i => i.coupon).filter(c => c != null && c > 0);
    const maxCoupon = coupons.length ? Math.max(...coupons) : null;
    const f = new Set();
    const evs = d.ratingEvents || [];
    if ((d.payments || []).length || current.some(e => e.sym === "D") || Object.values(latest).some(e => /default/i.test(e.outlook + " " + e.other))) f.add("default");
    if (evs.some(e => e.dir < 0)) f.add("downgrade");
    if (evs.some(e => e.dir > 0)) f.add("upgrade");
    if (Object.values(latest).some(e => /watch/i.test(e.outlook + " " + e.other))) f.add("watch");
    if (Object.values(latest).some(e => /negative/i.test(e.outlook))) f.add("negative");
    if (Object.values(latest).some(e => e.withdrawn)) f.add("withdrawn");
    if (lowest && rank(lowest) >= 7) f.add("subA"); else if (lowest && rank(lowest) >= 4) f.add("aBand");
    if (maxCoupon != null && maxCoupon >= 10) f.add("highCoupon");
    if (ncds.some(i => i.date && i.date >= cutoff)) f.add("raising");
    if (cps.length >= 10) f.add("cpHeavy");
    const flags = [...f];
    const score = flags.reduce((a, k) => a + SIGNALS[k].w, 0);
    const dates = [...evs.map(e => e.date), ...(d.issues || []).map(i => i.date), ...(d.payments || []).map(p => p.due)].filter(Boolean).sort();
    return {
      lowest, current: current.map(e => ({ agency: e.agency, sym: e.sym, rating: e.rating, outlook: e.outlook, date: e.date })),
      flags, score, lenses: [...new Set(flags.map(k => SIGNALS[k].lens))],
      maxCoupon, ncdCount: ncds.length, cpCount: cps.length, trustDeeds: (d.issues || []).filter(i => i.kind === "Trust deed").length,
      lastNcd: (() => { const n = ncds.find(i => i.isin) || ncds[0]; return n ? { isin: n.isin, coupon: n.coupon, structure: n.structure, maturity: n.maturity, date: n.date } : null; })(),
      lastEvent: dates[dates.length - 1] || null
    };
  }

  const api = { RANKS, SIGNALS, TYPE_LABEL, parseCSV, toRecords, detect, process, mergeIssuer, derive, ratingSym, slugify, isinKind, isoDate, parseTerms };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ScoutEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
