(() => {
  "use strict";
  const E = window.ScoutEngine;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  // ---------- Rating logic ----------
  const RANKS = E.RANKS;
  const BANDS = {
    AAA:{label:"AAA", color:"var(--b-aaa)", lo:7.4, hi:8.0},
    AA:{label:"AA", color:"var(--b-aa)", lo:8.0, hi:9.5},
    A:{label:"A", color:"var(--b-a)", lo:9.5, hi:11.5},
    BBB:{label:"BBB", color:"var(--b-bbb)", lo:11.5, hi:13.0},
    LOW:{label:"BB and below", color:"var(--b-low)"},
    UNR:{label:"Unrated or unclear", color:"var(--b-unr)"}
  };
  const symBand = (r) => !r ? "UNR" : r === "AAA" ? "AAA" : r.startsWith("AA") ? "AA" : r.startsWith("BBB") ? "BBB" : r.startsWith("A") ? "A" : "LOW";
  const lowestRating = (n) => {
    const rs = (n.ratings || []).map(x => E.ratingSym(x.rating)).filter(Boolean);
    if (!rs.length) return null;
    return rs.sort((a,b) => RANKS.indexOf(b) - RANKS.indexOf(a))[0];
  };
  const bandOf = (n) => symBand(lowestRating(n));
  const bandMid = (b) => BANDS[b] && BANDS[b].lo != null ? (BANDS[b].lo + BANDS[b].hi) / 2 : null;

  const COMPLETE_FIELDS = [
    ["Credit rating", n => n.ratings && n.ratings.length],
    ["Yield or coupon", n => n.yieldMax != null],
    ["Tenors", n => n.tenors && n.tenors.length],
    ["Secured or unsecured", n => n.secured === true || n.secured === false],
    ["Issue size", n => n.totalSize != null],
    ["Promoters", n => n.promoters && n.promoters.length],
    ["Use of proceeds", n => !!n.useOfProceeds],
    ["Debenture trustee", n => !!n.trustee],
    ["Subscription by category", n => !!n.subscription],
    ["Asset quality (NPA)", n => n.metrics && n.metrics.gnpa != null],
    ["ISIN", n => !!n.isin],
    ["Listing venue", n => !!n.listing],
    ["Issue dates", n => !!(n.openDate || n.closeDate)],
    ["Source links", n => n.sources && n.sources.some(s => s.url)]
  ];
  const completeness = (n) => {
    const have = COMPLETE_FIELDS.filter(f => f[1](n)).length;
    return { pct: Math.round(have / COMPLETE_FIELDS.length * 100), missing: COMPLETE_FIELDS.filter(f => !f[1](n)).map(f => f[0]) };
  };
  const autoFlags = (n) => {
    const f = [];
    const b = bandOf(n);
    if (!lowestRating(n)) f.push("No confirmed rating on file");
    if (b === "BBB" || b === "LOW") f.push("Below A: thin margin before non-investment grade");
    if (/unlisted/i.test(n.status || "")) f.push("Unlisted: no exchange exit before maturity");
    if (n.secured === false) f.push("Unsecured");
    return f;
  };
  const allFlags = (n) => [...(n.flags || []), ...autoFlags(n)];

  // ---------- State ----------
  const state = {
    ncds: [], intel: [], watch: {}, issuers: new Map(), uploads: [], leads: [],
    loaded: { ncds:false, intel:false, watch:false, issuers:false, uploads:false, leads:false },
    sort: { key:"yieldMax", dir:"desc" },
    ssort: { key:"score", dir:"desc" },
    intelCat: "All", lens: { kind:"all" },
    selected: null, bench: 6.7,
    db: null, user: null, canEdit: false,
    staged: [], names: {}
  };
  try { const v = parseFloat(localStorage.getItem("ss-bench")); if (!isNaN(v)) state.bench = v; } catch (e) {}
  $("#bench").value = state.bench.toFixed(2);
  $("#bench").addEventListener("change", () => {
    const v = parseFloat($("#bench").value);
    if (!isNaN(v)) { state.bench = v; try { localStorage.setItem("ss-bench", String(v)); } catch (e) {} renderAll(); }
  });

  const byId = (id) => state.ncds.find(n => n.id === id);
  const spreadBps = (n) => n.yieldMax != null ? Math.round((n.yieldMax - state.bench) * 100) : null;
  const bandGapBps = (n) => { const m = bandMid(bandOf(n)); return (m != null && n.yieldMax != null) ? Math.round((n.yieldMax - m) * 100) : null; };
  const fmtPct = (v) => v == null ? "–" : Number(v).toFixed(2) + "%";
  const fmtBps = (v) => v == null ? "–" : (v > 0 ? "+" : "") + v;
  const fmtDate = (d) => { if (!d) return ""; const t = new Date(d + (d.length === 10 ? "T00:00:00" : "")); return isNaN(t) ? d : t.toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"}); };
  const fmtWhen = (d) => { const t = new Date(d); return isNaN(t) ? "" : t.toLocaleString("en-IN",{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"}); };
  const statusClass = (s) => /open|upcoming/i.test(s||"") ? "st-open" : /unlisted/i.test(s||"") ? "st-unl" : "st-closed";
  const ratingText = (n) => {
    if (!n.ratings || !n.ratings.length) return "Not on file";
    return n.ratings.map(r => `${r.agency ? r.agency + " " : ""}${r.rating}${r.outlook ? "/" + r.outlook : ""}`).join(", ");
  };
  const linkedIntel = (id) => state.intel.filter(i => (i.issuers || []).includes(id));
  const issuerForNcd = (n) => state.issuers.get(E.slugify(n.issuer));
  const SIG = E.SIGNALS;
  const tagHtml = (k) => SIG[k] ? `<span class="tag t-${SIG[k].lens}">${esc(SIG[k].label)}</span>` : "";

  const meta = (window.SPREAD_SCOUT_DATA && window.SPREAD_SCOUT_DATA.meta) || {};
  // ---------- Signal board ----------
  const BOARD = [
    { key:"highCoupon", lens:"yield", text: n => `issuers filed NCD term sheets at 10% or more` },
    { key:"subA", lens:"yield", text: n => `issuers rated below A-` },
    { key:"raising", lens:"raising", text: n => `issuers filed NCDs in the last 90 days` },
    { key:"downgrade", lens:"distress", text: n => `downgraded by the same agency` },
    { key:"watchneg", lens:"distress", text: n => `on rating watch or negative outlook` },
    { key:"default", lens:"distress", text: n => `with a default on record` },
    { key:"upgrade", lens:"improving", text: n => `upgraded by the same agency` }
  ];
  const hasFlag = (d, key) => key === "watchneg" ? (d.flags.includes("watch") || d.flags.includes("negative")) : d.flags.includes(key);
  function renderBoard() {
    const all = [...state.issuers.values()];
    if (!state.loaded.issuers) { $("#sigs").innerHTML = ""; return; }
    if (!all.length) {
      $("#board-src").textContent = "No exchange files uploaded yet.";
      $("#sigs").innerHTML = `<div class="empty" style="grid-column:1/-1">Upload NSE debt files in Admin to see signals here.</div>`;
      return;
    }
    const seen = {};
    all.forEach(d => Object.values(d.sourcesSeen || {}).forEach(s => { if (s && s.file) seen[s.file] = s; }));
    const files = Object.values(seen);
    const froms = files.map(f => f.from).filter(Boolean).sort(), tos = files.map(f => f.to).filter(Boolean).sort();
    const lastUp = files.map(f => f.uploadedAt).filter(Boolean).sort().pop();
    $("#board-src").textContent = `${all.length} issuers from ${files.length} NSE file${files.length === 1 ? "" : "s"}${lastUp ? `, last uploaded ${fmtDate(lastUp.slice(0,10))}` : ""}${meta.generatedAt ? `. Data refreshed ${fmtDate(meta.generatedAt.slice(0,10))}` : ""}. Select a signal to filter the board.`;
    $("#sigs").innerHTML = BOARD.map(b => {
      const n = all.filter(d => hasFlag(d.derived, b.key)).length;
      const on = state.lens.kind === "flag" && state.lens.value === b.key;
      return `<button class="sig l-${b.lens}" data-flag="${b.key}" aria-pressed="${on}"><b>${n}</b><span>${esc(b.text(n))}</span></button>`;
    }).join("");
  }

  // ---------- Scout board ----------
  const LENSES = [
    { key:"all", label:"All issuers" },
    { key:"yield", label:"Yield hunting" },
    { key:"raising", label:"Raising money" },
    { key:"distress", label:"Distress watch" },
    { key:"improving", label:"Improving credit" }
  ];
  const SCOLS = [
    {key:"watch", label:"", sortable:false},
    {key:"score", label:"Score", cls:"num"},
    {key:"name", label:"Issuer"},
    {key:"rating", label:"Lowest current rating"},
    {key:"signals", label:"Signals", sortable:false},
    {key:"lastNcd", label:"Latest NCD term sheet"},
    {key:"maxCoupon", label:"Top coupon", cls:"num"},
    {key:"filings", label:"NCD / CP filings", cls:"num"},
    {key:"lastEvent", label:"Last filing"}
  ];
  const ssortVal = (d, k) => ({
    name: d.name, rating: d.derived.lowest ? RANKS.indexOf(d.derived.lowest) : 99, lastNcd: d.derived.lastNcd && d.derived.lastNcd.date,
    maxCoupon: d.derived.maxCoupon, filings: d.derived.ncdCount + d.derived.cpCount, lastEvent: d.derived.lastEvent, score: d.derived.score
  })[k];
  function scoutFiltered() {
    const q = $("#sq").value.trim().toLowerCase(), rb = $("#s-rating").value, ncdOnly = $("#s-ncd").checked;
    return [...state.issuers.values()].filter(d => {
      const v = d.derived;
      if (state.lens.kind === "lens" && !v.lenses.includes(state.lens.value)) return false;
      if (state.lens.kind === "flag" && !hasFlag(v, state.lens.value)) return false;
      if (rb && symBand(v.lowest) !== rb) return false;
      if (ncdOnly && !v.ncdCount) return false;
      if (q && !(d.name.toLowerCase().includes(q) || (d.isins || []).some(i => i.toLowerCase().includes(q)))) return false;
      return true;
    }).sort((a,b) => {
      const va = ssortVal(a, state.ssort.key), vb = ssortVal(b, state.ssort.key);
      const dir = state.ssort.dir === "asc" ? 1 : -1;
      if (va == null && vb == null) return (b.derived.score - a.derived.score);
      if (va == null) return 1; if (vb == null) return -1;
      const c = (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
      return c || (b.derived.score - a.derived.score) || a.name.localeCompare(b.name);
    });
  }
  function renderScout() {
    $("#lens-chips").innerHTML = LENSES.map(l => {
      const on = (l.key === "all" && state.lens.kind === "all") || (state.lens.kind === "lens" && state.lens.value === l.key);
      return `<button class="chip" data-lens="${l.key}" aria-pressed="${on}">${esc(l.label)}</button>`;
    }).join("") + (state.lens.kind === "flag" ? `<button class="chip" data-lens="all" aria-pressed="true">Signal: ${esc((BOARD.find(b => b.key === state.lens.value) || {}).text?.() || state.lens.value)} ✕</button>` : "");
    $("#s-thead").innerHTML = SCOLS.map(c => {
      if (c.sortable === false) return `<th>${c.key === "watch" ? `<span class="sub">Watch</span>` : esc(c.label)}</th>`;
      const on = state.ssort.key === c.key;
      return `<th class="${c.cls||""}" ${on ? `aria-sort="${state.ssort.dir === "asc" ? "ascending" : "descending"}"` : ""}><button data-ssort="${c.key}">${esc(c.label)}${on ? (state.ssort.dir === "asc" ? " ↑" : " ↓") : ""}</button></th>`;
    }).join("");
    if (!state.loaded.issuers) { $("#s-tbody").innerHTML = `<tr><td colspan="${SCOLS.length}" class="empty">Loading issuer profiles…</td></tr>`; return; }
    const rows = scoutFiltered();
    $("#s-count").textContent = `${rows.length} of ${state.issuers.size} issuers`;
    if (!rows.length) { $("#s-tbody").innerHTML = `<tr><td colspan="${SCOLS.length}" class="empty">${state.issuers.size ? "No issuers match. Clear a filter or pick another signal." : "No issuer profiles yet. Upload NSE files in Admin to build them."}</td></tr>`; return; }
    $("#s-tbody").innerHTML = rows.slice(0, 400).map(d => {
      const v = d.derived, ln = v.lastNcd, wid = "iss-" + d.slug, watched = !!state.watch[wid];
      const agencies = v.current.map(c => `${c.agency} ${c.sym}`).join(", ");
      return `<tr data-issuer="${esc(d.slug)}" tabindex="0">
        <td><button class="star" data-star="${esc(wid)}" data-kind="issuer" data-slug="${esc(d.slug)}" aria-pressed="${watched}" aria-label="${watched ? "Remove from" : "Add to"} watchlist">${watched ? "★" : "☆"}</button></td>
        <td class="num"><span class="score">${v.score}</span></td>
        <td><div class="iss">${esc(d.name)}</div><div class="sub">${d.isinTotal || (d.isins||[]).length} ISIN${(d.isinTotal || (d.isins||[]).length) === 1 ? "" : "s"} on file</div></td>
        <td><span class="rt" style="color:${BANDS[symBand(v.lowest)].color}">${esc(v.lowest || "–")}</span><div class="sub">${esc(agencies || "No long-term rating in uploads")}</div></td>
        <td><div class="tags">${v.flags.map(tagHtml).join("") || `<span class="sub">None</span>`}</div></td>
        <td>${ln ? `${ln.coupon != null ? `<b>${fmtPct(ln.coupon)}</b>` : `<b>${esc(ln.structure)}</b>`}${ln.maturity ? `, matures ${esc(ln.maturity)}` : ""}<div class="sub">${esc(ln.isin || "Shelf document")}, ${fmtDate(ln.date)}</div>` : `<span class="sub">None filed</span>`}</td>
        <td class="num">${v.maxCoupon != null ? `<b>${fmtPct(v.maxCoupon)}</b>` : "–"}</td>
        <td class="num">${v.ncdCount} / ${v.cpCount}</td>
        <td style="white-space:nowrap">${v.lastEvent ? fmtDate(v.lastEvent) : "–"}</td>
      </tr>`;
    }).join("");
  }

  // ---------- Issuer drawer ----------
  let lastFocus = null;
  function openDrawerShell(html) {
    $("#drawer").innerHTML = html;
    $("#scrim").hidden = false; $("#drawer").hidden = false;
    const c = $("#d-close"); if (c) { c.focus(); c.onclick = closeDrawer; }
  }
  function openIssuer(slug) {
    const d = state.issuers.get(slug); if (!d) return;
    state.selected = { kind:"issuer", id:slug }; if (!$("#drawer").contains(document.activeElement)) lastFocus = document.activeElement;
    const v = d.derived, wid = "iss-" + slug, w = state.watch[wid];
    const ncds = (d.issues || []).filter(i => i.kind === "NCD");
    const cps = (d.issues || []).filter(i => i.kind === "CP");
    const deeds = (d.issues || []).filter(i => i.kind === "Trust deed");
    const universeMatch = state.ncds.filter(n => E.slugify(n.issuer) === slug);
    const why = v.flags.map(k => {
      const expl = {
        default: "A default rating, an 'in default' outlook, or entries in NSE's default payment register.",
        downgrade: "The same agency now rates an instrument lower than its earlier rating.",
        upgrade: "The same agency now rates an instrument higher than its earlier rating.",
        watch: "The latest rating from at least one agency is on watch.",
        negative: "At least one agency's latest outlook is Negative.",
        withdrawn: "At least one agency's latest action withdrew the rating.",
        subA: "Lowest current long-term rating is BBB+ or lower.",
        aBand: "Lowest current long-term rating is in the A band.",
        highCoupon: "At least one NCD term sheet carries a fixed coupon of 10% or more.",
        raising: "Filed an NCD term sheet or shelf document in the last 90 days.",
        cpHeavy: "Ten or more commercial paper filings: relies on short-term rollover funding."
      }[k] || "";
      return `<li>${tagHtml(k)} ${esc(expl)}</li>`;
    }).join("");
    const rev = (d.ratingEvents || []).slice(0, 40);
    openDrawerShell(`
      <div class="d-head">
        <div><h2 id="d-title">${esc(d.name)}</h2><div class="sub">Issuer profile built from NSE filings</div></div>
        <button class="d-close" id="d-close" type="button">Close</button>
      </div>
      <div class="d-figs">
        <div class="fig"><span>Signal score</span><b>${v.score}</b></div>
        <div class="fig"><span>Lowest current rating</span><b style="color:${BANDS[symBand(v.lowest)].color}">${esc(v.lowest || "–")}</b></div>
        <div class="fig"><span>Top NCD coupon</span><b>${v.maxCoupon != null ? fmtPct(v.maxCoupon) : "–"}</b></div>
        <div class="fig"><span>Over G-Sec</span><b>${v.maxCoupon != null ? fmtBps(Math.round((v.maxCoupon - state.bench) * 100)) + " bps" : "–"}</b></div>
      </div>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="d-star" type="button">${w ? "Remove from watchlist" : "Add to watchlist"}</button>
      </div>
      ${universeMatch.length ? `<p class="sub">In the NCD universe: ${universeMatch.map(n => `<button class="linkish" data-open="${esc(n.id)}">${esc(n.issueName || n.issuer)}</button>`).join(", ")}</p>` : ""}
      <div class="d-sec"><h3>Why it's on the board</h3>${why ? `<ul class="flaglist" style="list-style:none;padding:0">${why}</ul>` : `<p class="sub" style="margin:0">No signals yet. It appears because it filed with the exchange.</p>`}</div>
      <div class="d-sec"><h3>Current ratings</h3>${v.current.length ? `<div class="mini-wrap"><table><thead><tr><th>Agency</th><th>Rating</th><th>Outlook</th><th>As of</th></tr></thead><tbody>${v.current.map(c => `<tr><td>${esc(c.agency)}</td><td><b>${esc(c.sym)}</b>${c.rating && c.rating.replace(/\s/g,"") !== c.sym ? ` <span class="sub">${esc(c.rating)}</span>` : ""}</td><td>${esc(c.outlook)}</td><td>${fmtDate(c.date)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub" style="margin:0">No long-term rating in the uploaded files. Check the agencies' websites before treating it as unrated.</p>`}</div>
      <div class="d-sec"><h3>NCD term sheets and offer documents <span class="sub">(${ncds.length})</span></h3>${ncds.length ? `<div class="mini-wrap"><table><thead><tr><th>Filed</th><th>ISIN</th><th class="num">Coupon</th><th>Structure</th><th>Matures</th></tr></thead><tbody>${ncds.slice(0, 40).map(i => `<tr><td>${fmtDate(i.date)}</td><td>${esc(i.isin || "–")}<div class="sub">${esc(E.isinKind(i.isin) || "")}</div></td><td class="num">${i.coupon != null ? fmtPct(i.coupon) : "–"}</td><td>${esc(i.structure)}${i.reissue ? " (re-issue)" : ""}</td><td>${esc(i.maturity || "–")}</td></tr>`).join("")}</tbody></table></div>${ncds.length > 40 ? `<p class="sub">Showing the latest 40.</p>` : ""}` : `<p class="sub" style="margin:0">No NCD filings in the uploaded offer-document files.</p>`}
      ${cps.length || deeds.length ? `<p class="sub" style="margin:8px 0 0">${cps.length} commercial paper filing${cps.length === 1 ? "" : "s"} and ${deeds.length} trust deed${deeds.length === 1 ? "" : "s"} also on file.</p>` : ""}</div>
      ${(d.payments || []).length ? `<div class="d-sec"><h3>Default payment register <span class="sub">(${d.payments.length})</span></h3><div class="mini-wrap"><table><thead><tr><th>Due</th><th>ISIN</th><th>Nature</th><th class="num">Amount (₹ cr)</th><th>Paid on</th></tr></thead><tbody>${d.payments.slice(0, 30).map(p => `<tr><td>${fmtDate(p.due)}</td><td>${esc(p.isin)}</td><td>${esc(p.nature)}<div class="sub">${esc(p.detail)}</div></td><td class="num">${p.amountCr ?? "–"}</td><td>${p.paidOn ? fmtDate(p.paidOn) : "–"}${p.trusteeVerified ? `<div class="sub">Trustee verified</div>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="sub">Entries on NSE's default register. Where the paid-on date matches the due date, the issuer is paying under a resolution plan rather than missing this instalment.</p></div>` : ""}
      ${d.litigation ? `<div class="d-sec"><h3>Court cases <span class="sub">(${d.litigation.totalHits} found by name, checked ${fmtDate(d.litigation.checkedAt.slice(0,10))})</span></h3>${(d.litigation.cases || []).length ? `<div class="mini-wrap"><table><thead><tr><th>Filed</th><th>Court</th><th>Case</th><th>Status</th><th>Next hearing</th></tr></thead><tbody>${d.litigation.cases.map(c => `<tr><td>${c.filed ? fmtDate(c.filed.slice(0,10)) : "–"}</td><td>${esc(c.court || "–")}</td><td>${esc(c.type || "")}<div class="sub">${esc([...(c.petitioners||[]).slice(0,1), ...(c.respondents||[]).slice(0,1)].join(" v ") || c.cnr || "")}</div></td><td>${esc(c.status || "–")}</td><td>${c.nextHearing ? fmtDate(c.nextHearing.slice(0,10)) : "–"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub" style="margin:0">No cases found for this name in the last three years.</p>`}<p class="lit-note">Matched on the company name "${esc(d.litigation.query)}", so some cases may belong to a similarly named party. Verify on eCourts before relying on them.</p></div>` : ""}
      <div class="d-sec"><h3>Rating history <span class="sub">(${(d.ratingEvents || []).length} distinct actions)</span></h3>${rev.length ? `<div class="mini-wrap"><table><thead><tr><th>Date</th><th>Agency</th><th>Rating</th><th>Change</th><th class="num">ISINs</th></tr></thead><tbody>${rev.map(e => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.agency)}</td><td><b>${esc(e.sym || "–")}</b> <span class="sub">${esc(e.withdrawn ? "Withdrawn" : e.outlook)}</span></td><td>${e.dir > 0 ? `<span class="dir-up">▲ from ${esc(e.earlierSym)}</span>` : e.dir < 0 ? `<span class="dir-down">▼ from ${esc(e.earlierSym)}</span>` : `<span class="sub">${esc(e.action || "–")}</span>`}</td><td class="num">${e.isinCount}</td></tr>`).join("")}</tbody></table></div>` : `<p class="sub" style="margin:0">No rating filings in the uploads.</p>`}</div>
      <div class="d-sec d-note"><h3>Team note</h3>
        <textarea id="d-note" placeholder="${w ? "What the team thinks about this issuer" : "Add to the watchlist to keep a team note"}" ${w ? "" : "disabled"}>${esc(w && w.note || "")}</textarea>
        <div class="row" style="display:flex;gap:8px;align-items:center;margin-top:6px"><button class="btn" id="d-save" type="button" ${w ? "" : "disabled"}>Save note</button><span class="sub" id="d-saved"></span></div>
      </div>
      <div class="d-sec"><h3>Sources</h3>${Object.entries(d.sourcesSeen || {}).map(([t, s]) => `<div class="sub">${esc(E.TYPE_LABEL[t] || t)}: ${esc(s.file)}${s.from ? `, covering ${fmtDate(s.from)} to ${fmtDate(s.to)}` : ""}</div>`).join("")}
        ${(() => { const u = [...new Set([...(d.ratingEvents||[]).map(e => e.url), ...(d.payments||[]).map(p => p.url)].filter(Boolean))].slice(0, 4); return u.length ? `<div style="margin-top:6px">${u.map((x, i) => `<div><a href="${esc(x)}" target="_blank" rel="noopener">NSE filing ${i + 1} (XBRL)</a></div>`).join("")}</div>` : ""; })()}
        <p class="sub">${(d.isinTotal || (d.isins||[]).length)} ISINs: ${esc((d.isins || []).slice(0, 12).join(", "))}${(d.isins||[]).length > 12 ? "…" : ""}</p></div>
    `);
    $("#d-star").onclick = () => toggleWatch(wid, { kind:"issuer", slug }).then(() => openIssuer(slug));
    $("#d-save").onclick = () => saveNote(wid, { kind:"issuer", slug });
  }

  // ---------- Ladder ----------
  function renderLadder() {
    const el = $("#ladder");
    if (!el.parentElement.clientWidth) return;
    const items = state.ncds.filter(n => n.yieldMax != null);
    const W = Math.max(el.parentElement.clientWidth, 640);
    const lo = Math.floor(Math.min(state.bench, ...items.map(n => n.yieldMax), 7) - 0.5);
    const hi = Math.ceil(Math.max(...items.map(n => n.yieldMax), 13) + 0.5);
    const pad = 36;
    const x = (v) => pad + (v - lo) / (hi - lo) * (W - pad * 2);
    const sorted = [...items].sort((a,b) => a.yieldMax - b.yieldMax);
    const rowEnds = [];
    const placed = sorted.map(n => {
      const label = n.short || n.issuer.split(" ").slice(0,2).join(" ");
      const w = label.length * 6.6 + 18;
      const cx = x(n.yieldMax);
      let row = rowEnds.findIndex(end => cx - w/2 > end + 6);
      if (row === -1) { row = rowEnds.length; rowEnds.push(-Infinity); }
      rowEnds[row] = cx + w/2;
      return { n, label, cx, row };
    });
    const rows = Math.max(rowEnds.length, 1);
    const rowH = 26, axisY = rows * rowH + 22, H = axisY + 46;
    let html = `<div class="axis" style="top:${axisY}px"></div>`;
    for (let v = lo; v <= hi; v++) html += `<div class="tick" style="left:${x(v)}px;top:${axisY + 20}px">${v}%</div>`;
    ["AAA","AA","A","BBB"].forEach(k => {
      const b = BANDS[k];
      html += `<div class="band" style="left:${x(b.lo)}px;width:${x(b.hi)-x(b.lo)}px;top:${axisY - 4}px;background:${b.color}"></div>`;
      html += `<div class="band-lbl" style="left:${x((b.lo+b.hi)/2)}px;top:${axisY + 6}px">${b.label} typical</div>`;
    });
    html += `<div class="gsec" style="left:${x(state.bench)}px;top:0;height:${axisY}px"></div>`;
    html += `<div class="gsec-lbl" style="left:${x(state.bench)}px;top:0">G-Sec ${state.bench.toFixed(2)}%</div>`;
    placed.forEach(p => {
      const top = 18 + (rows - 1 - p.row) * rowH, stem = axisY - top - 30, col = BANDS[bandOf(p.n)].color;
      html += `<button class="lad-marker" data-open="${esc(p.n.id)}" style="left:${p.cx}px;top:${top}px;color:${col}" aria-label="${esc(p.n.issuer)}, ${fmtPct(p.n.yieldMax)}, ${esc(BANDS[bandOf(p.n)].label)}">
        <span class="lbl"><span style="color:var(--ink)">${esc(p.label)} ${Number(p.n.yieldMax).toFixed(2)}</span></span>
        <span class="stem" style="height:${Math.max(stem,4)}px"></span><span class="dot"></span></button>`;
    });
    if (!items.length) html = `<div class="empty">No NCDs loaded yet.</div>`;
    el.style.width = W + "px"; el.style.height = (items.length ? H : 80) + "px";
    el.innerHTML = html;
    $("#legend").innerHTML = Object.values(BANDS).map(b => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join("") + `<span>Dashed line: your G-Sec benchmark</span>`;
  }

  // ---------- Universe table ----------
  const COLS = [
    {key:"watch", label:"", sortable:false},
    {key:"issuer", label:"Issue"},
    {key:"status", label:"Status"},
    {key:"rating", label:"Lowest rating"},
    {key:"coupon", label:"Coupon range", cls:"num"},
    {key:"yieldMax", label:"Max yield", cls:"num"},
    {key:"spread", label:"Spread over G-Sec (bps)", cls:"num"},
    {key:"bandGap", label:"vs band midpoint (bps)", cls:"num"},
    {key:"size", label:"Size (₹ cr)", cls:"num"},
    {key:"data", label:"Data on file"},
    {key:"flags", label:"Flags", cls:"num"}
  ];
  const sortVal = (n, k) => ({
    issuer: n.issuer, status: n.status, rating: (lowestRating(n) ? RANKS.indexOf(lowestRating(n)) : 99),
    coupon: n.couponMin ?? n.yieldMax, yieldMax: n.yieldMax, spread: spreadBps(n), bandGap: bandGapBps(n) ?? -9999,
    size: n.totalSize, data: completeness(n).pct, flags: allFlags(n).length
  })[k];
  function filtered() {
    const q = $("#q").value.trim().toLowerCase();
    const fs = $("#f-status").value, fb = $("#f-band").value, fsec = $("#f-sector").value, secOnly = $("#f-secured").checked;
    return state.ncds.filter(n => {
      if (fs && n.status !== fs) return false;
      if (fb && bandOf(n) !== fb) return false;
      if (fsec && n.sector !== fsec) return false;
      if (secOnly && n.secured !== true) return false;
      if (q) {
        const hay = [n.issuer, n.issueName, n.sector, n.isin, ...(n.promoters||[]), ratingText(n)].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a,b) => {
      const va = sortVal(a, state.sort.key), vb = sortVal(b, state.sort.key);
      const d = state.sort.dir === "asc" ? 1 : -1;
      if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * d;
    });
  }
  function renderFilters() {
    const fill = (sel, vals, labeler) => {
      const cur = sel.value; const first = sel.options[0].outerHTML;
      sel.innerHTML = first + vals.map(v => `<option value="${esc(v)}">${esc(labeler ? labeler(v) : v)}</option>`).join("");
      sel.value = vals.includes(cur) ? cur : "";
    };
    fill($("#f-status"), [...new Set(state.ncds.map(n => n.status).filter(Boolean))].sort());
    fill($("#f-band"), ["AAA","AA","A","BBB","LOW","UNR"].filter(b => state.ncds.some(n => bandOf(n) === b)), b => BANDS[b].label);
    fill($("#f-sector"), [...new Set(state.ncds.map(n => n.sector).filter(Boolean))].sort());
  }
  function renderTable() {
    $("#thead").innerHTML = COLS.map(c => {
      if (c.sortable === false) return `<th><span class="sub">Watch</span></th>`;
      const on = state.sort.key === c.key;
      return `<th class="${c.cls||""}" ${on ? `aria-sort="${state.sort.dir === "asc" ? "ascending" : "descending"}"` : ""}><button data-sort="${c.key}">${esc(c.label)}${on ? (state.sort.dir === "asc" ? " ↑" : " ↓") : ""}</button></th>`;
    }).join("");
    const rows = filtered();
    if (!state.loaded.ncds) { $("#tbody").innerHTML = `<tr><td colspan="${COLS.length}" class="empty">Loading the NCD universe…</td></tr>`; return; }
    if (!rows.length) { $("#tbody").innerHTML = `<tr><td colspan="${COLS.length}" class="empty">${state.ncds.length ? "No NCDs match these filters. Clear a filter to see more." : "The universe is empty. Add the first NCD you've scouted."}</td></tr>`; return; }
    $("#tbody").innerHTML = rows.map(n => {
      const c = completeness(n), sp = spreadBps(n), bg = bandGapBps(n), fl = allFlags(n).length;
      const watched = !!state.watch[n.id];
      return `<tr data-open="${esc(n.id)}" tabindex="0">
        <td><button class="star" data-star="${esc(n.id)}" data-kind="ncd" aria-pressed="${watched}" aria-label="${watched ? "Remove from" : "Add to"} watchlist">${watched ? "★" : "☆"}</button></td>
        <td><div class="iss">${esc(n.issuer)}</div><div class="sub">${esc(n.issueName || "")}${n.sector ? `<br>${esc(n.sector)}` : ""}</div></td>
        <td><span class="pill ${statusClass(n.status)}">${esc(n.status || "Unknown")}</span>${n.closeDate && /open|upcoming/i.test(n.status||"") ? `<div class="sub">Closes ${fmtDate(n.closeDate)}</div>` : ""}</td>
        <td><span class="rt" style="color:${BANDS[bandOf(n)].color}">${esc(lowestRating(n) || "–")}</span><div class="sub">${esc(ratingText(n))}</div></td>
        <td class="num">${n.couponMin != null ? fmtPct(n.couponMin) + " to " : ""}${fmtPct(n.couponMax ?? n.yieldMax)}</td>
        <td class="num"><b>${fmtPct(n.yieldMax)}</b></td>
        <td class="num">${fmtBps(sp)}</td>
        <td class="num ${bg == null ? "" : bg > 0 ? "pos" : "neg"}">${fmtBps(bg)}</td>
        <td class="num">${n.totalSize != null ? Number(n.totalSize).toLocaleString("en-IN") : "–"}</td>
        <td><span class="meter"><b style="width:${c.pct}%"></b></span><span class="sub">${c.pct}%</span></td>
        <td class="num">${fl ? `<span class="flags">${fl}</span>` : "–"}</td>
      </tr>`;
    }).join("");
  }

  // ---------- Research leads ----------
  const LEAD_STATUSES = ["New","Reviewing","Added to universe","Dismissed"];
  function renderLeads() {
    const fs = $("#l-status").value;
    if (!state.loaded.leads) { $("#leads").innerHTML = `<div class="empty">Loading research leads…</div>`; return; }
    const items = state.leads.filter(l => !fs || (l.status || "New") === fs).sort((a,b) => (b.eventDate || b.foundOn || "").localeCompare(a.eventDate || a.foundOn || ""));
    if (!items.length) { $("#leads").innerHTML = `<div class="empty" style="grid-column:1/-1">${state.leads.length ? "No leads with this status." : "No research leads yet. Leads are added as the desk reviews news, rating rationales and filings."}</div>`; return; }
    $("#leads").innerHTML = items.map(l => {
      const wid = "lead-" + l.id, watched = !!state.watch[wid];
      const rows = [["Instrument", l.instrument], ["Amount", l.amountCr != null ? `₹${l.amountCr} crore` : null], ["Coupon", l.coupon], ["Tenure", l.tenure], ["Security", l.security], ["Rating", l.rating], ["Investor", l.investor], ["Event date", l.eventDate ? fmtDate(l.eventDate) : null]].filter(r => r[1]);
      return `<article class="lead">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><h3>${esc(l.name)}</h3><button class="star" data-star="${esc(wid)}" data-kind="lead" data-lead="${esc(l.id)}" aria-pressed="${watched}" aria-label="${watched ? "Remove from" : "Add to"} watchlist">${watched ? "★" : "☆"}</button></div>
        <div class="tags">${(l.tags || []).map(t => `<span class="tag t-${esc(t.lens || "raising")}">${esc(t.label)}</span>`).join("")}</div>
        <p>${esc(l.summary)}</p>
        ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
        ${l.caution ? `<p class="warn" style="font-size:13.5px">${esc(l.caution)}</p>` : ""}
        ${l.nextStep ? `<p class="sub"><b style="color:var(--ink)">Next step:</b> ${esc(l.nextStep)}</p>` : ""}
        <div class="foot-row">
          <span>${(l.sources || []).map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : `<span class="sub">${esc(s.label)}</span>`).join(", ")}<br><span class="sub">Found ${l.foundOn ? fmtDate(l.foundOn) : ""} by ${esc(l.foundBy || "Desk research")}</span></span>
          <span class="pill st-closed">${esc(l.status || "New")}</span>
        </div>
      </article>`;
    }).join("");
  }

  // ---------- Intelligence ----------
  const CATS = ["All","Issuer","Regulatory","Rates","Capital flows","AIFs","Investment routes","Litigation","Alt assets"];
  function renderIntel() {
    const present = CATS.filter(c => c === "All" || state.intel.some(i => i.category === c));
    $("#chips").innerHTML = present.map(c => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${state.intelCat === c}">${esc(c)}</button>`).join("");
    const items = state.intel.filter(i => state.intelCat === "All" || i.category === state.intelCat).sort((a,b) => (b.date || "0").localeCompare(a.date || "0"));
    if (!state.loaded.intel) { $("#feed").innerHTML = `<div class="empty">Loading intelligence…</div>`; return; }
    if (!items.length) { $("#feed").innerHTML = `<div class="empty">No items in this category yet.</div>`; return; }
    $("#feed").innerHTML = items.map(i => {
      const iss = (i.issuers || []).map(id => byId(id)).filter(Boolean);
      return `<article class="item">
        <div class="when"><b>${i.date ? fmtDate(i.date) : "Background"}</b>${esc(i.category)}</div>
        <div>
          <h3>${esc(i.title)}</h3>
          <p>${esc(i.summary)}</p>
          ${i.caution ? `<p class="warn">${esc(i.caution)}</p>` : ""}
          <div class="meta">
            <span class="scope">${esc(i.scope || "Market")}-wide</span>
            ${iss.map(n => `<button class="linkish" data-open="${esc(n.id)}">${esc(n.issuer)}</button>`).join("")}
            ${i.source ? (i.source.url ? `<a href="${esc(i.source.url)}" target="_blank" rel="noopener">${esc(i.source.label)}</a>` : `<span class="sub">${esc(i.source.label)}</span>`) : ""}
          </div>
        </div>
      </article>`;
    }).join("");
  }

  // ---------- Watchlist ----------
  function watchTarget(id, w) {
    if (w.kind === "issuer") { const d = state.issuers.get(w.slug); return d ? { name: d.name, as: "Issuer (exchange filings)", rating: d.derived.lowest, y: d.derived.maxCoupon, attr: `data-issuer="${esc(d.slug)}"` } : null; }
    if (w.kind === "lead") { const l = state.leads.find(x => x.id === w.leadId); return l ? { name: l.name, as: "Research lead", rating: l.rating ? (E.ratingSym(l.rating) || l.rating) : null, y: null, yText: l.coupon, attr: `data-goto="leads"` } : null; }
    const n = byId(id); return n ? { name: n.issuer, as: "NCD: " + (n.issueName || ""), rating: lowestRating(n), y: n.yieldMax, attr: `data-open="${esc(id)}"` } : null;
  }
  function renderWatch() {
    const rows = Object.entries(state.watch).map(([id, w]) => [id, w, watchTarget(id, w)]).filter(r => r[2]);
    if (!rows.length) { $("#wbody").innerHTML = `<tr><td colspan="5" class="empty">Nothing on the watchlist. Star an issuer, NCD or lead to track it here with a team note.</td></tr>`; return; }
    $("#wbody").innerHTML = rows.map(([id, w, t]) => `<tr ${t.attr} tabindex="0">
        <td><div class="iss">${esc(t.name)}</div></td>
        <td class="sub">${esc(t.as)}</td>
        <td><span class="rt" style="color:${BANDS[symBand(E.ratingSym(t.rating || ""))].color}">${esc(t.rating || "–")}</span></td>
        <td class="num"><b>${t.y != null ? fmtPct(t.y) : esc(t.yText || "–")}</b></td>
        <td>${w.note ? esc(w.note) : `<span class="sub">No note yet</span>`}</td>
      </tr>`).join("");
  }

  function renderCounts() {
    $("#c-scout").textContent = state.issuers.size ? `(${state.issuers.size})` : "";
    $("#c-universe").textContent = state.ncds.length ? `(${state.ncds.length})` : "";
    $("#c-leads").textContent = state.leads.length ? `(${state.leads.length})` : "";
    $("#c-intel").textContent = state.intel.length ? `(${state.intel.length})` : "";
    const w = Object.entries(state.watch).filter(([id, w]) => watchTarget(id, w)).length;
    $("#c-watch").textContent = w ? `(${w})` : "";
  }

  // ---------- NCD drawer ----------
  function openDrawer(id) {
    const n = byId(id); if (!n) return;
    state.selected = { kind:"ncd", id }; if (!$("#drawer").contains(document.activeElement)) lastFocus = document.activeElement;
    const c = completeness(n), flags = allFlags(n), li = linkedIntel(id), w = state.watch[id], iss = issuerForNcd(n);
    const kv = (rows) => `<dl class="kv">${rows.map(([k,v]) => `<dt>${esc(k)}</dt><dd>${v == null || v === "" ? `<span class="gap">Not on file</span>` : v}</dd>`).join("")}</dl>`;
    const sub = n.subscription, m = n.metrics;
    openDrawerShell(`
      <div class="d-head">
        <div><h2 id="d-title">${esc(n.issuer)}</h2><div class="sub">${esc(n.issueName || "")}${n.sector ? `, ${esc(n.sector)}` : ""}</div></div>
        <button class="d-close" id="d-close" type="button">Close</button>
      </div>
      <div class="d-figs">
        <div class="fig"><span>Max yield</span><b>${fmtPct(n.yieldMax)}</b></div>
        <div class="fig"><span>Over G-Sec</span><b>${fmtBps(spreadBps(n))} bps</b></div>
        <div class="fig"><span>vs ${esc(BANDS[bandOf(n)].label)} midpoint</span><b>${bandGapBps(n) == null ? "–" : fmtBps(bandGapBps(n)) + " bps"}</b></div>
        <div class="fig"><span>Data on file</span><b>${c.pct}%</b></div>
      </div>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="d-star" type="button">${w ? "Remove from watchlist" : "Add to watchlist"}</button>
      </div>
      ${iss ? `<p class="sub">Exchange filings: <button class="linkish" data-issuer="${esc(iss.slug)}">${esc(iss.name)}</button>, ${iss.derived.flags.length ? iss.derived.flags.map(k => SIG[k].label.toLowerCase()).join(", ") : "no signals"}.</p>` : ""}
      ${flags.length ? `<div class="d-sec"><h3>Flags</h3><ul class="flaglist">${flags.map(f => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      <div class="d-sec"><h3>Instrument terms</h3>${kv([
        ["Status", esc(n.status)],
        ["Issue window", (n.openDate || n.closeDate) ? `${n.openDate ? fmtDate(n.openDate) : "?"} to ${n.closeDate ? fmtDate(n.closeDate) : "?"}` : null],
        ["Coupon", n.couponMin != null ? `${fmtPct(n.couponMin)} to ${fmtPct(n.couponMax ?? n.yieldMax)}` : (n.couponMax != null ? fmtPct(n.couponMax) : null)],
        ["Effective yield", n.yieldMin != null ? `${fmtPct(n.yieldMin)} to ${fmtPct(n.yieldMax)}` : fmtPct(n.yieldMax)],
        ["Tenors", n.tenors && n.tenors.length ? n.tenors.map(t => t + " months").join(", ") : null],
        ["Interest payout", n.payout && n.payout.length ? esc(n.payout.join(", ")) : null],
        ["Security", n.secured === true ? "Secured" : n.secured === false ? "Unsecured" : null],
        ["Face value / minimum", n.faceValue ? `₹${n.faceValue.toLocaleString("en-IN")}${n.minInvest ? ` / ₹${n.minInvest.toLocaleString("en-IN")}` : ""}` : null],
        ["Listing", esc(n.listing)],
        ["ISIN", esc(n.isin)]
      ])}</div>
      <div class="d-sec"><h3>Issuer and promoters</h3>${kv([
        ["Promoters", n.promoters && n.promoters.length ? esc(n.promoters.join(", ")) : null],
        ["Ratings", n.ratings && n.ratings.length ? esc(ratingText(n)) : null],
        ["Lead manager", esc(n.leadManager)],
        ["Debenture trustee", esc(n.trustee)],
        ["Registrar", esc(n.registrar)]
      ])}</div>
      <div class="d-sec"><h3>Money trail</h3>${kv([
        ["Issue size", n.totalSize != null ? `₹${Number(n.totalSize).toLocaleString("en-IN")} cr${n.baseSize != null ? ` (base ₹${n.baseSize} cr + green shoe ₹${n.greenShoe ?? "?"} cr)` : ""}` : null],
        ["Stated use of proceeds", esc(n.useOfProceeds)],
        ["Issue expenses", n.issueExpense != null ? `₹${n.issueExpense} cr` : null],
        ["Allocation", esc(n.allocation)],
        ["Subscription", sub ? `${sub.overall}x overall; retail ${sub.retail}x, HNI ${sub.hni}x, non-institutional ${sub.nii}x, institutional ${sub.qib}x` : null],
        ["Actual utilisation", esc(n.utilisation)]
      ])}</div>
      <div class="d-sec"><h3>Operating metrics</h3>${kv([
        ["Gross / net NPA", m && m.gnpa != null ? `${m.gnpa}% / ${m.nnpa ?? "?"}%` : null],
        ["Secured share of AUM", m && m.securedShareAum != null ? `${m.securedShareAum}%` : null],
        ["Branches", m && m.branches ? m.branches.toLocaleString("en-IN") : null],
        ["As of", m ? esc(m.asOf) : null]
      ])}</div>
      <div class="d-sec"><h3>Gaps to close</h3>${c.missing.length ? `<p class="sub" style="margin:0 0 6px">Missing from our file:</p><ul class="flaglist">${c.missing.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="sub" style="margin:0">Every tracked field is on file.</p>`}</div>
      <div class="d-sec"><h3>Linked intelligence</h3>${li.length ? li.map(i => `<p style="margin:0 0 8px"><b>${esc(i.title)}</b><br><span class="sub">${i.date ? fmtDate(i.date) : "Background"}: ${esc(i.summary)}</span></p>`).join("") : `<p class="sub" style="margin:0">No news tagged to this issuer yet.</p>`}</div>
      <div class="d-sec d-note"><h3>Team note</h3>
        <textarea id="d-note" placeholder="${w ? "What the team thinks about this issue" : "Add to the watchlist to keep a team note"}" ${w ? "" : "disabled"}>${esc(w && w.note || "")}</textarea>
        <div class="row" style="display:flex;gap:8px;align-items:center;margin-top:6px"><button class="btn" id="d-save" type="button" ${w ? "" : "disabled"}>Save note</button><span class="sub" id="d-saved"></span></div>
      </div>
      <div class="d-sec"><h3>Sources</h3>${(n.sources || []).length ? (n.sources).map(s => s.url ? `<div><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></div>` : `<div class="sub">${esc(s.label)}</div>`).join("") : `<p class="sub" style="margin:0">No sources recorded.</p>`}${n.asOf ? `<p class="sub">Snapshot as of ${fmtDate(n.asOf)}</p>` : ""}</div>
    `);
    $("#d-star").onclick = () => toggleWatch(id, { kind:"ncd", ncdId:id }).then(() => openDrawer(id));
    $("#d-save").onclick = () => saveNote(id, { kind:"ncd", ncdId:id });
  }
  function closeDrawer() {
    $("#scrim").hidden = true; $("#drawer").hidden = true; state.selected = null;
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  }
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });

  // ---------- Writes ----------
  const writeMsg = (e) => e && e.code === "invalid_argument" ? "This change couldn't be saved in this browser." : e && e.code === "quota_exceeded" ? "The data store is full. Remove old items before adding more." : "Couldn't save. Try again in a moment.";
  async function toggleWatch(id, meta) {
    if (!state.db) return;
    try {
      const ref = state.db.doc("watchlist/" + id);
      if (state.watch[id]) await ref.delete();
      else await ref.set(Object.assign({ note: "", updatedAt: new Date().toISOString() }, meta));
    } catch (e) { showStatus(writeMsg(e)); }
  }
  async function saveNote(id, meta) {
    if (!state.db) return;
    const btn = $("#d-save"); btn.disabled = true;
    try {
      await state.db.doc("watchlist/" + id).set(Object.assign({}, meta, { note: $("#d-note").value.trim(), updatedAt: new Date().toISOString() }));
      $("#d-saved").textContent = "Saved";
    } catch (e) { $("#d-saved").textContent = writeMsg(e); }
    btn.disabled = false;
  }

  // ---------- Admin: upload pipeline ----------
  const drop = $("#drop");
  ["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => stageFiles(e.dataTransfer.files));
  $("#file").addEventListener("change", e => { stageFiles(e.target.files); e.target.value = ""; });
  $("#clear").addEventListener("click", () => { state.staged = []; renderStaged(); });

  async function stageFiles(list) {
    for (const file of [...(list || [])]) {
      const s = { name: file.name, size: file.size, status: "reading" };
      state.staged.push(s); renderStaged();
      await new Promise(r => setTimeout(r, 30));
      try {
        if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") throw new Error("This isn't a CSV file. Download the CSV version from NSE and try again.");
        if (file.size > 20 * 1024 * 1024) throw new Error("This file is over 20 MB. Download a shorter date range from NSE.");
        const text = await file.text();
        const { headers, records } = E.toRecords(E.parseCSV(text));
        const type = E.detect(headers);
        if (!type) throw new Error("The columns don't match a supported NSE file. Supported: credit rating details, default payment details, debt offer documents.");
        if (!records.length) throw new Error("The file has column headers but no rows.");
        const res = E.process(type, records, {});
        const isNew = res.partials.filter(p => !state.issuers.has(p.slug)).length;
        Object.assign(s, { status: "ready", text, type, result: res, newIssuers: isNew });
      } catch (err) { Object.assign(s, { status: "error", error: err.message || "The file couldn't be read." }); }
      renderStaged();
    }
  }
  function findings(type, sm) {
    if (!sm) return "";
    if (type === "crd") return `${sm.ratingEvents} distinct rating actions, ${sm.upgrades} issuers upgraded, ${sm.downgrades} downgraded, ${sm.defaults} in default, ${sm.subA} rated below A-`;
    if (type === "docs") return `${sm.ncd} NCD filings, ${sm.cp} CP filings, ${sm.trustDeeds} trust deeds, ${sm.highCoupon} issuers at 10%+ coupons`;
    if (type === "dpd") return `${sm.payments} register entries totalling ₹${sm.amountCr} crore`;
    return "";
  }
  function renderStaged() {
    $("#staged").innerHTML = state.staged.map((s, i) => {
      if (s.status === "reading") return `<div class="stage"><div class="top-row"><b>${esc(s.name)}</b><span class="sub">Reading…</span></div></div>`;
      if (s.status === "error") return `<div class="stage bad"><div class="top-row"><b>${esc(s.name)}</b><button class="linkish" data-unstage="${i}">Remove</button></div><div>${esc(s.error)}</div></div>`;
      const sm = s.result.summary;
      return `<div class="stage"><div class="top-row"><b>${esc(s.name)}</b><span><span class="pill st-open">${esc(E.TYPE_LABEL[s.type])}</span> <button class="linkish" data-unstage="${i}">Remove</button></span></div>
        <div class="facts"><span><b>${sm.rows.toLocaleString("en-IN")}</b> rows</span><span><b>${sm.issuers}</b> issuer${sm.issuers === 1 ? "" : "s"} (${s.newIssuers} new)</span><span>Covers ${fmtDate(sm.from)} to ${fmtDate(sm.to)}</span></div>
        <div class="sub">${esc(findings(s.type, sm))}</div></div>`;
    }).join("");
    const ready = state.staged.filter(s => s.status === "ready");
    $("#commit-row").hidden = !state.staged.length;
  }
  $("#staged").addEventListener("click", e => { const b = e.target.closest("[data-unstage]"); if (b) { state.staged.splice(+b.dataset.unstage, 1); renderStaged(); } });

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  const plain = (d) => { if (!d) return null; const { id, ...rest } = d; return rest; };

  function renderHistory() {
    if (!state.loaded.uploads) { $("#hbody").innerHTML = `<tr><td colspan="8" class="empty">Loading…</td></tr>`; return; }
    const ups = [...state.uploads].sort((a,b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
    if (!ups.length) { $("#hbody").innerHTML = `<tr><td colspan="8" class="empty">No uploads yet.</td></tr>`; return; }
    $("#hbody").innerHTML = ups.map(u => {
      
      return `<tr>
        <td><b>${esc(u.file)}</b></td><td>${esc(E.TYPE_LABEL[u.type] || u.type)}</td>
        <td>${u.summary ? `${fmtDate(u.summary.from)} to ${fmtDate(u.summary.to)}` : "–"}</td>
        <td class="num">${u.summary ? u.summary.rows.toLocaleString("en-IN") : "–"}</td>
        <td class="num">${u.issuersTouched ?? "–"}</td>
        <td class="sub" style="max-width:320px">${esc(findings(u.type, u.summary))}</td>
        <td>${fmtWhen(u.uploadedAt)}<div class="sub">${u.uploadedBy === "admin" ? "by the admin" : "by the research desk"}</div></td>
        <td>${u.rawPath ? `<a href="${esc(u.rawPath)}" download>Download</a>` : `<span class="sub">Not stored</span>`}</td>
      </tr>`;
    }).join("");
  }
  let nameReq = false;
  async function resolveNames(ids) {
    const need = [...new Set(ids)].filter(i => !(i in state.names));
    if (!need.length || !state.user || nameReq) return;
    nameReq = true;
    try { const ps = await state.user.profiles(need); need.forEach(i => { state.names[i] = (ps[i] && ps[i].name) || ""; }); } catch (e) {}
    nameReq = false; renderHistory();
  }

  // ---------- Tabs & events ----------
  const TABS = ["scout","universe","leads","intel","watch","admin"];
  function selectTab(t) {
    TABS.forEach(k => { $("#tab-" + k).setAttribute("aria-selected", k === t); $("#p-" + k).hidden = k !== t; });
    try { localStorage.setItem("ss-tab", t); } catch (e) {}
    if (t === "universe") renderLadder();
  }
  TABS.forEach(k => $("#tab-" + k).addEventListener("click", () => selectTab(k)));

  document.addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      e.stopPropagation();
      const k = star.dataset.kind, meta = k === "issuer" ? { kind:"issuer", slug:star.dataset.slug } : k === "lead" ? { kind:"lead", leadId:star.dataset.lead } : { kind:"ncd", ncdId:star.dataset.star };
      toggleWatch(star.dataset.star, meta); return;
    }
    const fl = e.target.closest("[data-flag]");
    if (fl) { const on = state.lens.kind === "flag" && state.lens.value === fl.dataset.flag; state.lens = on ? { kind:"all" } : { kind:"flag", value: fl.dataset.flag }; selectTab("scout"); renderBoard(); renderScout(); return; }
    const ln = e.target.closest("[data-lens]");
    if (ln) { state.lens = ln.dataset.lens === "all" ? { kind:"all" } : { kind:"lens", value: ln.dataset.lens }; renderBoard(); renderScout(); return; }
    const ss = e.target.closest("[data-ssort]");
    if (ss) { const k = ss.dataset.ssort; state.ssort = { key:k, dir: state.ssort.key === k && state.ssort.dir === "desc" ? "asc" : "desc" }; renderScout(); return; }
    const s = e.target.closest("[data-sort]");
    if (s) { const k = s.dataset.sort; state.sort = { key:k, dir: state.sort.key === k && state.sort.dir === "desc" ? "asc" : "desc" }; renderTable(); return; }
    const cat = e.target.closest("[data-cat]");
    if (cat) { state.intelCat = cat.dataset.cat; renderIntel(); return; }
    const go = e.target.closest("[data-goto]");
    if (go) { selectTab(go.dataset.goto); return; }
    const is = e.target.closest("[data-issuer]");
    if (is && !e.target.closest("select")) { openIssuer(is.dataset.issuer); return; }
    const op = e.target.closest("[data-open]");
    if (op) openDrawer(op.dataset.open);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.matches("tr[data-open]")) openDrawer(e.target.dataset.open);
    else if (e.target.matches("tr[data-issuer]")) openIssuer(e.target.dataset.issuer);
    else if (e.target.matches("tr[data-goto]")) selectTab(e.target.dataset.goto);
  });
  ["#q","#f-status","#f-band","#f-sector","#f-secured"].forEach(s => $(s).addEventListener("input", renderTable));
  ["#sq","#s-rating","#s-ncd"].forEach(s => $(s).addEventListener("input", renderScout));
  $("#l-status").addEventListener("input", renderLeads);
  let rT; window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(renderLadder, 120); });

  function showStatus(msg) { $("#status").innerHTML = msg ? `<div class="notice">${esc(msg)}</div>` : ""; }

  let raf = 0;
  function renderAll() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      renderBoard(); renderScout(); renderFilters(); renderLadder(); renderTable(); renderLeads(); renderIntel(); renderWatch(); renderCounts(); renderHistory(); renderStaged(); renderAdmin();
      if (state.selected && !$("#drawer").hidden) (state.selected.kind === "issuer" ? openIssuer : openDrawer)(state.selected.id);
    });
  }
  try { const t = localStorage.getItem("ss-tab"); if (t && TABS.includes(t) && t !== "admin") selectTab(t); } catch (e) {}
  renderAll();

  // ---------- Data ----------
  const S = window.LocalStore;
  const CFG = window.SPREAD_SCOUT_CONFIG || {};
  const ADMIN = String(CFG.adminEmail || "").trim().toLowerCase();
  function repoName() {
    if (CFG.repo) return CFG.repo;
    const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (!m) return "";
    const first = location.pathname.split("/").filter(Boolean)[0];
    return first && !/\.html?$/i.test(first) ? `${m[1]}/${first}` : `${m[1]}/${m[1]}.github.io`;
  }
  function renderAdmin() {
    const el = $("#refresh-state"); if (!el) return;
    const parts = [];
    if (meta.generatedAt) parts.push(`Data last built ${fmtWhen(meta.generatedAt)}.`);
    Object.entries(meta.feeds || {}).forEach(([id, f]) => {
      const label = id === "sebi" ? "SEBI feed" : id === "rbi-notifications" ? "RBI feed" : id;
      parts.push(f.ok ? `${label} read ${fmtDate(f.checkedAt.slice(0,10))}, ${f.added} new relevant item${f.added === 1 ? "" : "s"}.` : `${label} couldn't be read on the last run.`);
    });
    if (meta.court) parts.push(meta.court.enabled ? `Court checks on: ${meta.court.checked} issuer${meta.court.checked === 1 ? "" : "s"} checked on the last run.` : "Court checks off until a court-data key is added.");
    el.textContent = parts.join(" ") || "The data hasn't been built by the refresh workflow yet.";
  }
  function setupAdminLinks() {
    const repo = repoName(), branch = CFG.branch || "main";
    $("#source-url").textContent = CFG.sourcePage || "";
    $("#source-link").href = CFG.sourcePage || "#";
    if (repo) {
      $("#upload-link").href = `https://github.com/${repo}/upload/${branch}/incoming`;
      $("#actions-link").href = `https://github.com/${repo}/actions`;
      $("#repo-note").textContent = `Files go to the incoming folder of ${repo}.`;
    } else {
      $("#upload-link").removeAttribute("href"); $("#upload-link").classList.add("disabled");
      $("#actions-link").hidden = true;
      $("#repo-note").textContent = "Set the repository name in js/config.js to turn on this link.";
    }
  }
  const adminInUrl = () => /(^|[#&?])admin(\b|=)/.test(location.hash + location.search);
  function signedInEmail() { try { return (localStorage.getItem("ss-admin-email") || "").toLowerCase(); } catch (e) { return ""; } }
  function applyAdmin() {
    const who = signedInEmail();
    const ok = !!ADMIN && who === ADMIN;
    state.canEdit = ok;
    $("#tab-admin").hidden = !(ok || adminInUrl());
    $("#admin-gate").hidden = ok; $("#admin-body").hidden = !ok;
    $("#admin-who").textContent = ok ? who : "";
    if (ok) setupAdminLinks();
  }
  $("#gate-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#gate-email").value.trim().toLowerCase();
    if (!v) { $("#gate-err").textContent = "Enter the admin email."; return; }
    if (v !== ADMIN) { $("#gate-err").textContent = "This email doesn't have admin access."; return; }
    try { localStorage.setItem("ss-admin-email", v); } catch (err) {}
    $("#gate-err").textContent = ""; applyAdmin(); renderAll();
  });
  $("#gate-email").addEventListener("input", () => { $("#gate-err").textContent = ""; });
  $("#leave-admin").addEventListener("click", () => {
    try { localStorage.removeItem("ss-admin-email"); } catch (e) {}
    if (location.hash === "#admin") history.replaceState(null, "", location.pathname + location.search);
    applyAdmin(); selectTab("scout");
  });
  window.addEventListener("hashchange", () => { applyAdmin(); if (adminInUrl()) selectTab("admin"); });
  applyAdmin();
  if (adminInUrl()) selectTab("admin");
  if (!window.SPREAD_SCOUT_DATA) showStatus("The data file (data/data.js) didn't load. Reload the page, or check that the refresh workflow has run.");

  const db = S.db;
  state.db = db;
  db.collection("ncds").onSnapshot(snap => { state.ncds = snap.docs.map(d => ({ id: d.id, ...d.data() })); state.loaded.ncds = true; renderAll(); });
  db.collection("intel").onSnapshot(snap => { state.intel = snap.docs.map(d => ({ id: d.id, ...d.data() })); state.loaded.intel = true; renderAll(); });
  db.collection("watchlist").onSnapshot(snap => { const w = {}; snap.docs.forEach(d => { const x = d.data(); w[d.id] = x.kind ? x : Object.assign({ kind:"ncd" }, x); }); state.watch = w; state.loaded.watch = true; renderAll(); });
  db.collection("leads").onSnapshot(snap => { state.leads = snap.docs.map(d => ({ id: d.id, ...d.data() })); state.loaded.leads = true; renderAll(); });
  db.collection("uploads").onSnapshot(snap => { state.uploads = snap.docs.map(d => ({ id: d.id, ...d.data() })); state.loaded.uploads = true; renderAll(); });
  db.collection("issuers").onSnapshot(snap => {
    const now = new Date(), m = new Map();
    snap.docs.forEach(d => { const x = d.data(); m.set(d.id, Object.assign({}, x, { slug: d.id, derived: E.derive(x, now) })); });
    state.issuers = m; state.loaded.issuers = true; renderAll();
  });
})();
