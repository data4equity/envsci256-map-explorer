/* ENVSCI 256 map explorer: the five steps (filter → color → condition → buffer → save) in a left
   panel beside a Leaflet map. Logic lives in core.js; this file is the page.
   Built from the approved mockups (Dropbox: Map explorer (Felt cap) - handoff/mockups-2026-11-18). */
(function (root) {
  const C = root.ExplorerCore;
  const ACS_SHARES = {
    pct_65plus: { label: "Residents 65 and older", src: "Census estimate (ACS 2019–2023)", unit: "%", decimals: 1, moe: "pct_65plus_moe90" },
    pct_hh_children: { label: "Households with children under 18", src: "Census estimate (ACS 2019–2023)", unit: "%", decimals: 1, moe: "pct_hh_children_moe90" }
  };
  const COLUMN_NOTES = {
    value: "<b>Value</b> The census tract's value for the layer chosen in step 2, in the unit shown in the column heading.",
    ci: "<b>95% Confidence Intervals</b> A range around the value. If the survey were repeated many times, about 95 of every 100 ranges built this way would hold the true value. A wide range means a less certain estimate.",
    moe: "<b>Margin of error (±)</b> How far the estimate could sit from the true value, at 95% confidence. The range in the column to its left equals the value plus or minus this number.",
    buffer: "<b>Included in the buffer?</b> “Yes” means some part of the census tract touches at least one buffer. A census tract counts even when only a corner sits inside a buffer."
  };
  const BUF_COLORS = [["#ea580c", "Orange"], ["#dc2626", "Red"], ["#1d2522", "Black"], ["#c026d3", "Magenta"], ["#0f766e", "Teal"], ["#2563eb", "Blue"]];
  const FOCUS_COLS = ["#d97706", "#2563eb", "#c026d3", "#0f766e", "#dc2626", "#4d7c0f"];
  const FOCUS_DASH = ["", "10 6", "3 5"];
  const STORE_COLOR = "#5b2a86"; // Question C stores: filled inside a buffer, hollow outside (approved mockup)
  const CHC_COLOR = "#c2185b"; // community health centers, as in the approved Question B mockup
  const ACCESS = [["Y", "Y · open to the public"], ["L", "L · limited access"], ["N", "N · not open"], ["X", "X · unknown"], ["any", "Any access"]];

  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = v => v == null ? "–" : (Math.round(v * 10) / 10).toFixed(1);
  const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); e.innerHTML = html; return e; };

  /** Property holding a measure's value / 95% range (PLACES columns end in _CrudePrev / _Crude95CI). */
  // Term Project layers read from a question's file (data/term/…): { key: {label, unit, src, decimals, year} }.
  // Registered once per file; only a team page lists them in step 2, so Exercise 4 and the midterm never see them.
  const TERM = {};
  const valueKey = m => (ACS_SHARES[m] || TERM[m] ? m : `${m}_CrudePrev`);
  const ciKey = m => (ACS_SHARES[m] || TERM[m] ? null : `${m}_Crude95CI`);
  const unitOf = m => (TERM[m] ? TERM[m].unit : "%");
  const fmtFor = m => v => { const d = TERM[m] ? TERM[m].decimals : 1; return v == null ? "–" : (Math.round(v * 10 ** d) / 10 ** d).toFixed(d); };

  /** A layer whose range the page computes (Census layers, Term Project layers), or null for PLACES. */
  const rangeField = m => TERM[m] || ACS_SHARES[m] || null;

  /** Tract card line(s) for such a layer: its 95% interval and margin of error, or why it has none. */
  function termRangeLine(m, p) {
    const f = rangeField(m), r = C.acsRange(f, p, m);
    if (r && r.ci) return `<div class="small">95% confidence interval: <b>${esc(r.ci)}</b></div><div class="small">Margin of error: <b>${esc(r.moe)}</b> ${f.unit === "%" ? "percentage points" : esc(f.unit)}</div>`;
    if (r && r.none) return `<div class="small muted">${esc(r.none)}</div>`;
    return `<div class="small muted">${esc(f.src)}; no margin of error for this tract</div>`;
  }

  function measureLabel(key) {
    if (ACS_SHARES[key]) return `${ACS_SHARES[key].label}, %`;
    if (TERM[key]) return TERM[key].unit === "year" ? TERM[key].label : `${TERM[key].label}, ${TERM[key].unit}${TERM[key].per ? " " + TERM[key].per : ""}`;
    const m = root.PLACES_MEASURES[key];
    return m ? `${m.label}, %` : key;
  }

  const DEFAULT_STATE = {
    towns: [], measure: "BPHIGH", method: "quantile", classes: 5, ramp: "Blues", legend: "",
    condType: "routes", routeMode: "name", routeNames: [], adminType: 2, rtNumber: "1",
    access: "Y", minAcres: 0, onlyTowns: false, off: [], miles: 0.12,
    bufColor: "#ea580c", condName: "", bufName: "", title: "", focus: null
  };

  let explorerCount = 0;

  class Explorer {
    /** data: { tracts, routes, sources, openSpaceFor(bbox) → Promise<features>, healthCenters() → Promise<features> }
        opts (team pages only): { termLayers: [keys], termHeading: "Question A layers", conditions: ["chcs"],
                                  stores: [{ key, label }] with data.storesFor(key) → Promise<{ label, source, features }> } */
    constructor(rootEl, data, state, opts) {
      this.root = rootEl; this.data = data; this.opts = opts || {};
      this.opening = structuredClone(this.opts.opening || DEFAULT_STATE);
      this.s = Object.assign({}, DEFAULT_STATE, state || {});
      if (!this.s.legend) this.s.legend = measureLabel(this.s.measure);
      this.towns = [...new Set(data.tracts.map(f => f.properties.City_Town))].filter(Boolean).sort();
      this.routeNames = [...new Set(data.routes.map(f => f.properties.Route_Name))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      this.parkList = []; this.offParks = []; this.offCenters = []; this.cond = []; this.bufs = []; this.touch = new Set(); this.focusGroup = []; this.storeRows = [];
      this.viewAlpha = 1; this.peek = false; this.insetOff = false; this.noteOpen = null;
      this.build();
      this.update(true);
    }

    set(key, value, refit) {
      this.s[key] = value;
      if (key === "measure") this.s.legend = measureLabel(value);
      if (key === "towns" || key === "condType" || key === "access" || key === "minAcres" || key === "onlyTowns") this.s.focus = null;
      return this.update(refit);
    }

    setMany(obj, replace = false) {
      if (replace) this.s = Object.assign({}, DEFAULT_STATE, obj); else Object.assign(this.s, obj);
      return this.update(Object.prototype.hasOwnProperty.call(obj, "towns"));
    }

    /* ---------------- layout ---------------- */
    build() {
      const r = this.root; r.innerHTML = ""; r.className = "xp";
      this.panel = el("div", { class: "xpanel" });
      this.mapEl = el("div", { class: "xmap", role: "region", "aria-label": "Map of census tracts" });
      this.legendEl = el("div", { class: "xlegend" });
      this.focusEl = el("div", { class: "xfocus" }); this.focusEl.hidden = true;
      this.tableEl = el("div", { class: "xtable" });
      const mapCol = el("div", { class: "xmapcol" });
      const id = `xstrength-${++explorerCount}`;
      const bar = el("div", { class: "xviewbar" }, `<label for="${id}">Buffer and layer strength</label><input id="${id}" type="range" min="0" max="100" step="5" value="100"><output>100%</output><button type="button" class="btn ghost peek" aria-pressed="false">Census tract colors only (press and hold)</button>`);
      const range = bar.querySelector("input"), output = bar.querySelector("output"), peek = bar.querySelector("button");
      range.addEventListener("input", () => { this.viewAlpha = Number(range.value) / 100; output.textContent = `${range.value}%`; this.applyView(); });
      const setPeek = value => { this.peek = value; peek.setAttribute("aria-pressed", String(value)); this.applyView(); };
      peek.addEventListener("pointerdown", () => setPeek(true));
      ["pointerup", "pointerleave", "pointercancel"].forEach(event => peek.addEventListener(event, () => setPeek(false)));
      peek.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!e.repeat) setPeek(true); } });
      peek.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setPeek(false); } });
      const strip = el("aside", { class: "xstrip" }), header = el("div", { class: "inhead" }, '<span class="il">Census tract colors only</span>');
      const toggle = el("button", { class: "rlink", type: "button" }, "Remove the inset");
      this.insetEl = el("div", { class: "inbox" });
      toggle.onclick = () => { this.insetOff = !this.insetOff; this.insetEl.hidden = this.insetOff; toggle.textContent = this.insetOff ? "Show the inset" : "Remove the inset"; };
      header.append(toggle); strip.append(header, this.insetEl, this.legendEl);
      this.mapEl.append(this.focusEl); mapCol.append(bar, this.mapEl, strip);
      r.append(this.panel, mapCol, this.tableEl);
      this.open = new Set(["Filter"]);
      this.map = L.map(this.mapEl, { preferCanvas: true, zoomSnap: 0.25 });
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16, attribution: "Basemap: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community" }).addTo(this.map);
      this.map.createPane("overlay"); this.map.getPane("overlay").style.zIndex = 420;
      this.overlayRenderer = L.canvas({ pane: "overlay" });
      this.lyr = { grey: L.layerGroup(), tracts: L.layerGroup(), cond: L.layerGroup(), buf: L.layerGroup(), focus: L.layerGroup(), pick: L.layerGroup() };
      Object.values(this.lyr).forEach(l => l.addTo(this.map));
      this.map.createPane("labels"); this.map.getPane("labels").style.zIndex = 450; this.map.getPane("labels").style.pointerEvents = "none";
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels" }).addTo(this.map);
      [this.legendEl, this.focusEl].forEach(e => { L.DomEvent.disableClickPropagation(e); L.DomEvent.disableScrollPropagation(e); });
      this.map.on("popupopen", e => {
        const pe = e.popup.getElement(); if (!pe) return;
        pe.querySelectorAll("[data-zoom]").forEach(b => b.onclick = () => { this.map.closePopup(); this.set("focus", +b.dataset.zoom); });
        pe.querySelectorAll("[data-tog]").forEach(b => b.onclick = () => { this.map.closePopup(); this.toggleOff(+b.dataset.tog); });
        pe.querySelectorAll("[data-ctog]").forEach(b => b.onclick = () => { this.map.closePopup(); this.toggleCenter(+b.dataset.ctog); });
      });
    }

    toggleOff(id) { const off = this.s.off; return this.set("off", off.includes(id) ? off.filter(x => x !== id) : [...off, id]); }
    toggleCenter(id) { const off = this.s.chcsOff || []; return this.set("chcsOff", off.includes(id) ? off.filter(x => x !== id) : [...off, id]); }

    renderPanel() {
      const keepScroll = this.panel.scrollTop;
      this.panel.innerHTML = "";
      const start = el("button", { class: "btn ghost startover", type: "button", "data-k": "startover" }, "↺ Start over");
      start.onclick = () => { this.pick = null; const next = C.resetStep(this.s, this.opening, "all"); if (!next.legend) next.legend = measureLabel(next.measure || DEFAULT_STATE.measure); this.setMany(next, true); };
      this.panel.append(start);
      const steps = [["Filter", "Filter tracts by town (one or more)", this.gFilter()], ["Style", "Color the tracts", this.gStyle()],
        ["Condition", "Add the neighborhood condition", this.gCond()], ["Buffer", "Buffer around the neighborhood condition", this.gBuffer()], ["Save", "Title, save and link", this.gSave()]];
      steps.forEach(([key, title, body], i) => {
        const step = key.toLowerCase();
        const d = el("details", this.open.has(key) ? { open: "" } : {}, `<summary><span class="num">${i + 1}</span> ${title}${i < 4 ? `<button type="button" class="rlink" data-reset="${step}">Reset</button>` : ""}</summary>`);
        if (i < 4) d.querySelector("[data-reset]").onclick = e => {
          e.preventDefault(); e.stopPropagation();
          const next = C.resetStep(this.s, this.opening, step);
          this.s = Object.assign({}, DEFAULT_STATE, next);
          if (!this.s.legend) this.s.legend = measureLabel(this.s.measure);
          this.setMany(step === "filter" ? { towns: next.towns } : {});
        };
        d.addEventListener("toggle", () => { d.open ? this.open.add(key) : this.open.delete(key); });
        d.append(body); this.panel.append(d);
      });
      this.panel.scrollTop = keepScroll;
    }

    /* ---------------- step 1: filter ---------------- */
    gFilter() {
      const s = this.s, w = el("div", { class: "ctl" });
      w.innerHTML = `<div class="hint">You can choose <b>more than one town</b>. Add your town, then add each town you compare it with, one at a time. Every town you add stays on the map.</div>
        <div class="frow"><span class="fpill">City_Town</span><span class="muted small">is any of</span></div>
        <div class="chips">${s.towns.map(t => `<span class="chip">${esc(t)}<button type="button" data-x="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`).join("") || '<span class="muted small">No filter yet: the map shows all of Massachusetts.</span>'}</div>
        <label for="xp-add-town" class="sr">Add a town</label>
        <select id="xp-add-town"><option value="">${s.towns.length ? "+ Add another town…" : "+ Add a town…"}</option>${this.towns.filter(t => !s.towns.includes(t)).map(t => `<option>${esc(t)}</option>`).join("")}</select>
        <div class="muted small">${this.sel.length.toLocaleString()} of ${this.data.tracts.length.toLocaleString()} census tracts in your filter. Other towns show in grey.</div>`;
      w.querySelectorAll("[data-x]").forEach(b => b.onclick = () => this.set("towns", s.towns.filter(t => t !== b.dataset.x), true));
      w.querySelector("select").onchange = e => { const v = e.target.value; if (v) this.set("towns", [...s.towns, v], true); };
      return w;
    }

    /* ---------------- step 2: color ---------------- */
    gStyle() {
      const s = this.s, w = el("div", { class: "ctl" });
      const places = Object.keys(root.PLACES_MEASURES).sort((a, b) => root.PLACES_MEASURES[a].label.localeCompare(root.PLACES_MEASURES[b].label));
      w.innerHTML = `<label>Color tracts by<select data-k="measure">
          <optgroup label="Health (CDC PLACES 2025)">${places.map(k => `<option value="${k}" ${k === s.measure ? "selected" : ""}>${esc(root.PLACES_MEASURES[k].label)} (${k})</option>`).join("")}</optgroup>
          <optgroup label="Population (ACS 2019–2023)">${Object.keys(ACS_SHARES).map(k => `<option value="${k}" ${k === s.measure ? "selected" : ""}>${esc(ACS_SHARES[k].label)} (${k})</option>`).join("")}</optgroup>${this.termOptions()}</select></label>
        <div class="two"><label>Classification<select data-k="method">${Object.entries(C.METHODS).map(([k, v]) => `<option value="${k}" ${k === s.method ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>Classes<select data-k="classes">${[3, 4, 5, 6, 7].map(n => `<option ${n === s.classes ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>
        <div class="lbl">Color ramp</div><div class="ramps">${Object.keys(C.RAMPS).map(r => `<button type="button" data-r="${r}" aria-pressed="${r === s.ramp}" aria-label="${r}">${C.rampColors(r, 5).map(c => `<i style="background:${c}"></i>`).join("")}</button>`).join("")}</div>
        <label>Layer name (shows as the legend title)<input type="text" data-k="legend" value="${esc(s.legend)}"></label>`;
      w.querySelector("[data-k=measure]").onchange = e => this.set("measure", e.target.value);
      w.querySelector("[data-k=method]").onchange = e => this.set("method", e.target.value);
      w.querySelector("[data-k=classes]").onchange = e => this.set("classes", +e.target.value);
      w.querySelector("[data-k=legend]").oninput = e => { s.legend = e.target.value; this.renderLegend(); };
      w.querySelectorAll("[data-r]").forEach(b => b.onclick = () => this.set("ramp", b.dataset.r));
      return w;
    }

    termOptions() {
      const keys = (this.opts.termLayers || []).filter(k => TERM[k]), s = this.s;
      return keys.length ? `<optgroup label="${esc(this.opts.termHeading || "Term Project layers")}">${keys.map(k => `<option value="${k}" ${k === s.measure ? "selected" : ""}>${esc(TERM[k].per ? measureLabel(k) : TERM[k].label)} (${k})</option>`).join("")}</optgroup>` : "";
    }

    /* ---------------- step 3: condition ---------------- */
    gCond() {
      const s = this.s, w = el("div", { class: "ctl" });
      let body = "";
      if (s.condType === "routes") {
        body = `<div class="seg" role="group" aria-label="Filter routes by"><button type="button" data-m="name" aria-pressed="${s.routeMode === "name"}">By name</button><button type="button" data-m="num" aria-pressed="${s.routeMode === "num"}">By type + number</button></div>` +
          (s.routeMode === "name"
            ? `<label>Route_Name is any of (hold Ctrl or ⌘ to pick more than one)<select data-k="rn" multiple size="6">${this.routeNames.map(r => `<option ${s.routeNames.includes(r) ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>`
            : `<div class="two"><label>ADMIN_TYPE<select data-k="at">${[[1, "1 · Interstate"], [2, "2 · U.S. route"], [3, "3 · State route"]].map(([k, v]) => `<option value="${k}" ${k == s.adminType ? "selected" : ""}>${v}</option>`).join("")}</select></label><label>RT_NUMBER<input type="text" data-k="rt" value="${esc(s.rtNumber)}"></label></div>`) +
          `<div class="muted small">${this.condCount} route${this.condCount === 1 ? "" : "s"} kept</div>`;
      } else if (s.condType === "chcs") {
        body = this.centerPicker();
      } else if (s.condType === "parks") {
        body = `<div class="two"><label>PUB_ACCESS<select data-k="pa">${ACCESS.map(([k, v]) => `<option value="${k}" ${k === s.access ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label>GIS_ACRES at least<input type="number" min="0" step="1" data-k="ac" value="${s.minAcres}"></label></div>
          <label class="check"><input type="checkbox" data-k="ot" ${s.onlyTowns ? "checked" : ""}> <span>Only open space inside the towns I chose in step 1</span></label>` + this.storePicker() + this.parkPicker();
      }
      w.innerHTML = `<label>Layer<select data-k="ct"><option value="none" ${s.condType === "none" ? "selected" : ""}>No condition</option><option value="routes" ${s.condType === "routes" ? "selected" : ""}>MA_major_routes · major roads</option><option value="parks" ${s.condType === "parks" ? "selected" : ""}>MA_openspace · parks and open space</option>${(this.opts.conditions || []).includes("chcs") ? `<option value="chcs" ${s.condType === "chcs" ? "selected" : ""}>CHCS_PT · community health centers</option>` : ""}</select></label><button type="button" class="btn ghost" data-k="rmcond" ${s.condType === "none" ? "disabled" : ""}>Remove</button>${body}
        ${s.condType !== "none" ? `<label>Layer name (shows in the legend)<input type="text" data-k="cn" value="${esc(this.condName())}"></label>` : ""}`;
      const q = k => w.querySelector(`[data-k=${k}]`);
      q("ct").onchange = e => this.set("condType", e.target.value, false);
      q("rmcond").onclick = () => this.setMany({ condType: "none", miles: 0, focus: null });
      if (q("cn")) q("cn").oninput = e => { s.condName = e.target.value; this.renderLegend(); };
      w.querySelectorAll("[data-m]").forEach(b => b.onclick = () => this.set("routeMode", b.dataset.m));
      if (q("rn")) q("rn").onchange = e => this.set("routeNames", [...e.target.selectedOptions].map(o => o.value));
      if (q("at")) { q("at").onchange = e => this.set("adminType", +e.target.value); q("rt").onchange = e => this.set("rtNumber", e.target.value.trim()); }
      if (q("pa")) {
        q("pa").onchange = e => this.set("access", e.target.value);
        q("ac").onchange = e => this.set("minAcres", Math.max(0, +e.target.value || 0));
        q("ot").onchange = e => this.set("onlyTowns", e.target.checked);
      }
      w.querySelectorAll(".plist [data-pid]").forEach(c => c.onchange = () => this.toggleOff(+c.dataset.pid));
      w.querySelectorAll(".plist [data-zoom]").forEach(b => b.onclick = e => { e.preventDefault(); this.set("focus", +b.dataset.zoom); });
      if (q("st")) q("st").onchange = e => this.set("stores", e.target.value);
      w.querySelectorAll(".plist [data-cid]").forEach(c => c.onchange = () => this.toggleCenter(+c.dataset.cid));
      if (q("call")) {
        q("call").onclick = () => this.set("chcsOff", []);
        q("cnone").onclick = () => this.set("chcsOff", this.centerList.map(f => f.properties.id));
      }
      if (q("pall")) {
        q("pall").onclick = () => this.set("off", []);
        q("pnone").onclick = () => this.set("off", this.parkList.map(f => f.properties.id));
        q("ps").oninput = e => { const v = e.target.value.toLowerCase(); w.querySelectorAll(".prow").forEach(r => { r.hidden = !r.textContent.toLowerCase().includes(v); }); };
      }
      return w;
    }

    parkPicker() {
      const s = this.s, list = [...this.parkList].sort((a, b) => ((a.properties.Town || "") + (a.properties.SITE_NAME || "")).localeCompare((b.properties.Town || "") + (b.properties.SITE_NAME || "")));
      if (!s.towns.length) return `<div class="muted small">Filter to your towns in step 1 first. Then the parks near them are listed here.</div>`;
      if (!list.length) return `<div class="muted small">No open space matches these filters near your towns.</div>`;
      return `<div class="pk-head"><b>Which parks get a buffer?</b><span class="muted small">${list.length - this.offParks.length} of ${list.length} in view</span></div>
        <div class="muted small">Uncheck a park to remove its buffer; a removed park turns grey. Click Zoom, or click a park on the map, to look at it up close.</div>
        <div class="row"><label for="xp-park-search" class="sr">Search parks</label><input id="xp-park-search" type="text" data-k="ps" placeholder="Search by name or town"><button class="btn ghost" data-k="pall" type="button">All</button><button class="btn ghost" data-k="pnone" type="button">None</button></div>
        <div class="plist">${list.map(f => { const p = f.properties; return `<label class="prow"><input type="checkbox" data-pid="${p.id}" ${s.off.includes(p.id) ? "" : "checked"}><span>${esc(p.SITE_NAME || "Unnamed open space")}</span><span class="muted">${esc(p.Town)} · ${fmt(p.GIS_ACRES)} ac</span><button type="button" class="zbtn" data-zoom="${p.id}">Zoom</button></label>`; }).join("")}</div>`;
    }

    /** Question C: one store layer at a time, shown as points over the open-space buffer. */
    storePicker() {
      const list = this.opts.stores || [], cur = this.s.stores || "";
      if (!list.length) return "";
      return `<label>Show stores as points<select data-k="st"><option value="">No stores</option>${list.map(o => `<option value="${o.key}" ${o.key === cur ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`;
    }
    storeLabel() { const o = (this.opts.stores || []).find(x => x.key === this.s.stores); return o ? o.label : ""; }

    centerPicker() {
      const s = this.s, off = s.chcsOff || [], list = [...this.centerList].sort((a, b) => (a.properties.GEOG_MUNI + a.properties.NAME + a.properties.ADDRESS).localeCompare(b.properties.GEOG_MUNI + b.properties.NAME + b.properties.ADDRESS));
      if (!s.towns.length) return `<div class="muted small">Filter to your towns in step 1 first. Then the health centers near them are listed here.</div>`;
      if (!list.length) return `<div class="muted small">No community health centers near your towns.</div>`;
      return `<div class="pk-head"><b>Which health centers get a buffer?</b><span class="muted small">${list.length - this.offCenters.length} of ${list.length} in view</span></div>
        <div class="muted small">Uncheck a center to remove its buffer; a removed center turns grey. Choose the buffer distance in step 4.</div>
        <div class="row"><button class="btn ghost" data-k="call" type="button">All</button><button class="btn ghost" data-k="cnone" type="button">None</button></div>
        <div class="plist">${list.map(f => { const p = f.properties; return `<label class="prow"><input type="checkbox" data-cid="${p.id}" ${off.includes(p.id) ? "" : "checked"}><span>${esc(p.NAME)}</span><span class="muted">${esc(p.ADDRESS)} · ${esc(townName(p.GEOG_MUNI))}</span></label>`; }).join("")}</div>`;
    }

    /* ---------------- step 4: buffer ---------------- */
    gBuffer() {
      const s = this.s, w = el("div", { class: "ctl" });
      w.innerHTML = `<label>Buffer distance, miles<input type="number" min="0.01" max="5" step="0.01" data-k="mi" value="${s.miles > 0 ? s.miles : ""}" placeholder="Type a distance, e.g. 0.25"></label><button type="button" class="btn ghost" data-k="bufoff" ${s.miles === 0 ? "disabled" : ""}>Turn off the buffer</button>
        <label>Layer name (shows in the legend)<input type="text" data-k="bn" value="${esc(this.bufName())}"></label>
        <div class="lbl">Buffer color</div><div class="bcols">${BUF_COLORS.map(([c, n]) => `<button type="button" data-bc="${c}" aria-pressed="${c === s.bufColor}"><i style="border-color:${c}"></i>${n}</button>`).join("")}</div>
        ${s.condType === "chcs" ? `<div class="bnote"><b>How the buffer is measured</b><div class="bwrap"><svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true"><rect width="120" height="80" fill="#eef0ef"/><circle cx="60" cy="40" r="30" fill="none" stroke="#ea580c" stroke-width="2"/><line x1="60" y1="40" x2="90" y2="40" stroke="#1d2522" stroke-dasharray="3 2"/><text x="64" y="35" font-size="10">distance</text><rect x="56" y="36" width="8" height="8" fill="#c2185b" stroke="#fff"/></svg><span>Each health center is a point, so its buffer is a circle around that point. The distance you type is the circle's radius.</span></div></div>` : `<div class="bnote"><b>How the buffer is measured</b><br>The buffer is drawn from the <b>edge</b> of each park or road (its outer boundary), not from its center. Every point on the outline is the same distance from the nearest edge. People reach a park at its edge, at a gate or the sidewalk along its side, not at its middle. A road's traffic pollution also spreads out from the road itself. So a large park gets a large outline and a small park gets a small one. If the buffer were drawn from the center instead, a big park would look farther away than it is, and part of the park could sit outside its own buffer.</div>`}
        <div class="muted small">One buffer at a time. For the High Pass, change the distance to your card's second distance and save a second map image.</div>`;
      w.querySelector("[data-k=mi]").onchange = e => this.set("miles", +e.target.value > 0 ? Math.min(5, Math.max(0.01, +e.target.value)) : 0);
      w.querySelector("[data-k=bufoff]").onclick = () => this.set("miles", 0);
      w.querySelector("[data-k=bn]").oninput = e => { s.bufName = e.target.value; this.renderLegend(); };
      w.querySelectorAll("[data-bc]").forEach(b => b.onclick = () => this.set("bufColor", b.dataset.bc));
      return w;
    }

    /* ---------------- step 5: save ---------------- */
    gSave() {
      const s = this.s, w = el("div", { class: "ctl" });
      w.innerHTML = `<label>Map title (what, where, when)<input type="text" data-k="ti" value="${esc(s.title)}" placeholder="${esc(this.defaultTitle())}"></label>
        <div class="row"><button class="btn" type="button" data-k="save">Save map image</button><button class="btn ghost" type="button" data-k="link">Copy link</button></div><div class="linkout" aria-live="polite"></div>`;
      w.querySelector("[data-k=ti]").oninput = e => { s.title = e.target.value; };
      w.querySelector("[data-k=save]").onclick = () => this.saveImage();
      w.querySelector("[data-k=link]").onclick = () => this.copyLink(w.querySelector(".linkout"));
      return w;
    }

    link() { return `${location.origin}${location.pathname}#${C.encodeState(this.s)}`; }
    async copyLink(out) {
      const url = this.link();
      history.replaceState(null, "", "#" + C.encodeState(this.s));
      try { await navigator.clipboard.writeText(url); out.innerHTML = `<b>The link is on your clipboard.</b> Paste it where your assignment asks for the map link. It reopens this exact map.`; }
      catch (e) { out.innerHTML = `Copy this link:<textarea readonly rows="3">${esc(url)}</textarea>`; out.querySelector("textarea").select(); }
    }

    /* ---------------- names ---------------- */
    condLabel() {
      const s = this.s;
      if (s.condType === "none") return "";
      if (s.condType === "chcs") return "Community health centers";
      if (s.condType === "routes") return s.routeMode === "name" ? (s.routeNames.join(" and ") || "Major routes") : `Route ${s.rtNumber} (ADMIN_TYPE ${s.adminType})`;
      return `Open space${s.access === "any" ? "" : ", PUB_ACCESS " + s.access}${s.minAcres ? `, ${s.minAcres}+ acres` : ""}`;
    }
    condName() { return this.s.condName || this.condLabel(); }
    bufName() { return this.s.bufName || `${this.s.miles}-mile buffer`; }
    defaultTitle() { const m = this.s.measure; return `${TERM[m] ? TERM[m].label : measureLabel(m).replace(/, %$/, "")} by census tract${this.s.towns.length ? ", " + this.s.towns.join(" and ") : ", Massachusetts"}, ${TERM[m] ? TERM[m].year : 2023}`; }

    /* ---------------- drawing ---------------- */
    async update(refit) {
      const s = this.s, token = (this.token = (this.token || 0) + 1);
      this.sel = s.towns.length ? this.data.tracts.filter(f => s.towns.includes(f.properties.City_Town)) : this.data.tracts;
      this.br = C.breaks(this.sel.map(f => f.properties[valueKey(s.measure)]), s.method, s.classes);
      this.pal = C.rampColors(s.ramp, Math.max(1, this.br.length - 1));
      this.cond = []; this.bufs = []; this.parkList = []; this.offParks = []; this.centerList = []; this.offCenters = [];
      if (s.condType === "routes") {
        const routes = s.routeMode === "name" ? C.filterRoutes(this.data.routes, { mode: "name", names: s.routeNames }) : C.filterRoutes(this.data.routes, { mode: "num", adminType: s.adminType, rtNumber: s.rtNumber });
        this.condCount = routes.length;
        if (s.towns.length) this.cond = C.clipToBbox(routes, C.paddedBbox(this.sel));
      } else if (s.condType === "chcs") {
        if (s.towns.length) {
          const all = await this.data.healthCenters();
          if (token !== this.token) return; // a newer update started while the centers were loading
          const off = s.chcsOff || [];
          this.centerList = C.pointsInBbox(all, C.paddedBbox(this.sel));
          this.offCenters = this.centerList.filter(f => off.includes(f.properties.id));
          this.cond = this.centerList.filter(f => !off.includes(f.properties.id));
        }
        this.condCount = this.cond.length;
      } else if (s.condType === "parks" && s.towns.length) {
        const box = C.paddedBbox(this.sel);
        const near = (await this.data.openSpaceFor(box)).filter(f => { const b = f.bbox || (f.bbox = turf.bbox(f)); return !(b[0] > box[2] || b[2] < box[0] || b[1] > box[3] || b[3] < box[1]); });
        if (token !== this.token) return; // a newer update started while parks were loading
        this.parkList = C.filterOpenSpace(near, { access: s.access, minAcres: s.minAcres, onlyTowns: s.onlyTowns ? s.towns : null, off: [] });
        this.offParks = this.parkList.filter(f => s.off.includes(f.properties.id));
        this.cond = this.parkList.filter(f => !s.off.includes(f.properties.id));
        this.condCount = this.cond.length;
      }
      if (s.towns.length && s.miles > 0 && this.cond.length) this.bufs = C.bufferEach(this.cond, s.miles);
      this.touch = C.touchedTracts(this.sel, this.bufs);
      this.storeRows = [];
      if (s.stores && s.condType === "parks" && s.towns.length && this.data.storesFor) {
        const doc = await this.data.storesFor(s.stores);
        if (token !== this.token) return; // a newer update started while the stores were loading
        this.storeSource = doc.source;
        const inTowns = C.pointsInTracts(C.pointsInBbox(doc.features, C.paddedBbox(this.sel)), this.sel);
        this.storeRows = C.storeRows(inTowns, this.cond, s.miles > 0 ? s.miles : -1); // no buffer yet: no store is "inside"
      }
      this.draw(refit);
      this.renderInset();
      this.renderPanel(); this.renderLegend(); this.renderTable(); this.renderFocus();
    }

    draw(refit) {
      const s = this.s;
      Object.values(this.lyr).forEach(l => l.clearLayers());
      if (s.towns.length) L.geoJSON({ type: "FeatureCollection", features: this.data.tracts.filter(f => !s.towns.includes(f.properties.City_Town)) },
        { style: { fillColor: "#b9c0bd", fillOpacity: 0.55, color: "#fff", weight: 0.5 }, interactive: false }).addTo(this.lyr.grey);
      const tl = L.geoJSON({ type: "FeatureCollection", features: this.sel }, {
        style: f => { const k = C.classOf(f.properties[valueKey(s.measure)], this.br, s.method); return { fillColor: k < 0 ? "#e5e5e5" : this.pal[k], fillOpacity: 0.88, color: "#fff", weight: s.towns.length ? 0.9 : 0.25 }; },
        onEachFeature: (f, l) => {
          l.bindPopup(() => this.tractPopup(f), { maxWidth: 290 });
          // Team pages: a click on a tract also highlights its row in the tract table (her ask 2026-11-20).
          if (this.opts.pickRows) l.on("click", () => this.pickTract(f.properties.TractFIPS, "map"));
        }
      }).addTo(this.lyr.tracts);
      const parkTip = f => `<b>${esc(f.properties.SITE_NAME || "Unnamed open space")}</b>, ${esc(f.properties.Town)} · ${fmt(f.properties.GIS_ACRES)} acres<br><span class="muted">Click for options</span>`;
      const parkPop = (f, on) => `<div class="pp"><div class="pph">${esc(f.properties.SITE_NAME || "Unnamed open space")}</div><div class="muted small">${esc(f.properties.Town)} · ${fmt(f.properties.GIS_ACRES)} acres · PUB_ACCESS ${esc(f.properties.PUB_ACCESS)}</div>
        <div class="row" style="margin-top:6px"><button class="btn" type="button" data-zoom="${f.properties.id}">Zoom in on this park</button><button class="btn ghost" type="button" data-tog="${f.properties.id}">${on ? "Switch off its buffer" : "Buffer it again"}</button></div></div>`;
      L.geoJSON({ type: "FeatureCollection", features: this.offParks }, { pane: "overlay", renderer: this.overlayRenderer, style: { color: "#8a948f", weight: 0.8, dashArray: "2 3", fillColor: "#d5dad7", fillOpacity: 0.85 },
        onEachFeature: (f, l) => { l.bindTooltip(parkTip(f), { sticky: true }); l.bindPopup(() => parkPop(f, false), { maxWidth: 300 }); } }).addTo(this.lyr.cond);
      const chcPop = (f, on) => { const p = f.properties; return `<div class="pp"><div class="pph">${esc(p.NAME)}</div><div class="muted small">${esc(p.ADDRESS)}, ${esc(townName(p.GEOG_MUNI))} · ${esc(p.SERVICES)}</div>
        <div class="row" style="margin-top:6px"><button class="btn ghost" type="button" data-ctog="${p.id}">${on ? "Switch off its buffer" : "Buffer it again"}</button></div></div>`; };
      const chcIcon = on => L.divIcon({ className: on ? "chc" : "chc off", iconSize: [11, 11] });
      if (s.condType === "chcs") [[this.offCenters, false], [this.cond, true]].forEach(([fs, on]) => fs.forEach(f => {
        const [x, y] = f.geometry.coordinates;
        L.marker([y, x], { pane: "overlay", icon: chcIcon(on), keyboard: false, title: f.properties.NAME }).bindPopup(() => chcPop(f, on), { maxWidth: 300 }).addTo(this.lyr.cond);
      }));
      if (s.condType !== "chcs") L.geoJSON({ type: "FeatureCollection", features: this.cond }, {
        pane: "overlay", renderer: this.overlayRenderer,
        style: f => f.geometry.type.includes("Line") ? { color: "#2b2b2b", weight: 3 } : { color: "#2f7d32", weight: 0.6, fillColor: "#7cb87f", fillOpacity: 0.7 },
        interactive: s.condType === "parks",
        onEachFeature: (f, l) => { if (s.condType === "parks") { l.bindTooltip(parkTip(f), { sticky: true }); l.bindPopup(() => parkPop(f, true), { maxWidth: 300 }); } }
      }).addTo(this.lyr.cond);
      if (this.bufs.length) L.geoJSON({ type: "FeatureCollection", features: this.bufs }, { pane: "overlay", renderer: this.overlayRenderer, style: { color: s.bufColor, weight: 1.6, fill: false }, interactive: false }).addTo(this.lyr.buf);
      this.storeRows.forEach(r => {
        const [x, y] = r.store.geometry.coordinates, p = r.store.properties;
        L.circleMarker([y, x], { pane: "overlay", renderer: this.overlayRenderer, radius: 5, color: STORE_COLOR, weight: 1.6, fillColor: r.inside ? STORE_COLOR : "#fff", fillOpacity: 1 })
          .bindPopup(`<div class="pp"><div class="pph">${esc(p.name)}</div><div class="muted small">${esc(p.addr)}, ${esc(p.town)}</div>
            <div class="small">Nearest public open space: <b>${esc(r.park || "none nearby")}</b>${r.miles == null ? "" : `, ${r.miles.toFixed(2)} mi to its edge`}</div>
            ${this.bufs.length ? `<div class="small">${r.inside ? "Inside" : "Outside"} the ${esc(this.bufName())}</div>` : ""}</div>`, { maxWidth: 290 }).addTo(this.lyr.focus);
      });
      if (refit && this.sel.length) this.map.fitBounds(tl.getBounds(), { padding: [14, 14] });
      if (this.pick && !this.sel.some(f => f.properties.TractFIPS === this.pick)) this.pick = null; // its town was filtered out
      this.drawPick(false, this.pickLabel !== false);
      // Zoom in on one park: it and every park touching it get their own colour and ring.
      this.focusGroup = []; this.focusRings = null;
      const fp = s.focus != null && s.condType === "parks" ? this.parkList.find(f => f.properties.id === s.focus) : null;
      if (fp) {
        this.focusGroup = C.touchingGroup(fp, this.parkList, FOCUS_COLS.length);
        this.focusRings = C.bufferEach(this.focusGroup, s.miles);
        this.lyr.buf.eachLayer(l => l.setStyle && l.setStyle({ opacity: 0.2 }));
        this.focusGroup.forEach((f, i) => {
          L.geoJSON(f, { pane: "overlay", renderer: this.overlayRenderer, style: { color: FOCUS_COLS[i], weight: 3, fillColor: FOCUS_COLS[i], fillOpacity: 0.35 }, interactive: false }).addTo(this.lyr.focus);
          L.geoJSON(this.focusRings[i], { pane: "overlay", renderer: this.overlayRenderer, style: { color: FOCUS_COLS[i], weight: 3, dashArray: FOCUS_DASH[i % 3], fill: false }, interactive: false }).addTo(this.lyr.focus);
        });
        if (this.focusFit !== s.focus) { this.map.fitBounds(L.geoJSON(turf.featureCollection(this.focusRings)).getBounds(), { padding: [24, 24] }); this.focusFit = s.focus; }
      } else this.focusFit = null;
      this.applyView();
    }

    applyView() { this.map.getPane("overlay").style.opacity = this.peek ? 0 : this.viewAlpha; }

    renderInset() {
      const s = this.s;
      const project = C.fitProjection(turf.bbox(turf.featureCollection(this.sel)), 214, 170).project;
      const paths = this.sel.map(f => { const c = C.classOf(f.properties[valueKey(s.measure)], this.br, s.method);
        return `<path d="${C.pathFor(f.geometry, project)}" fill="${c < 0 ? "#e5e5e5" : this.pal[c]}" stroke="#fff" stroke-width="0.6" fill-rule="evenodd"/>`; }).join("");
      this.insetEl.innerHTML = `<svg viewBox="0 0 214 170" width="100%" role="img" aria-label="${esc(s.legend)} by census tract, without other layers">${paths}</svg>`;
    }

    /** Highlight one tract on the map (a click on its row in the tract table), or clear it with null. */
    pickTract(fips, from) {
      this.pick = fips || null;
      let row = null;
      this.tableEl.querySelectorAll("tr[data-fips]").forEach(tr => { const on = tr.dataset.fips === this.pick; tr.classList.toggle("on", on); if (on) row = tr; });
      if (from === "map") {
        // Scroll only the table's own box to the row, so the page (and the popup) stay where they are.
        const sc = row && row.closest(".tscroll");
        if (sc && sc.offsetParent) sc.scrollTop += row.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 2;
        this.drawPick(false, false);
      } else this.drawPick(true, true);
    }

    drawPick(show, label = true) {
      this.lyr.pick.clearLayers();
      const f = this.pick && this.sel.find(x => x.properties.TractFIPS === this.pick);
      if (!f) return;
      L.geoJSON(f, { style: { color: "#fff", weight: 8, fill: false }, interactive: false }).addTo(this.lyr.pick);
      const g = L.geoJSON(f, { style: { color: "#111", weight: 4, fill: false }, interactive: false }).addTo(this.lyr.pick);
      if (label) g.bindTooltip(`${esc(f.properties.NAMELSAD)}, ${esc(f.properties.City_Town)}`, { permanent: true, direction: "top", className: "picktip" }).openTooltip();
      this.pickLabel = label;
      if (!show) return;
      const b = g.getBounds();
      if (!this.map.getBounds().contains(b)) this.map.panTo(b.getCenter());
      const r = this.mapEl.getBoundingClientRect();
      if (r.bottom < 60 || r.top > innerHeight - 60) this.mapEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    tractPopup(f) {
      const p = f.properties, s = this.s, ci = ciKey(s.measure) && p[ciKey(s.measure)];
      const inBuf = this.bufs.length ? `<div>${esc(this.bufName())}: <b>${this.touch.has(p.TractFIPS) ? "touches" : "does not touch"}</b></div>` : "";
      return `<div class="pp"><div class="pph">${esc(p.NAMELSAD)}, ${esc(p.City_Town)}</div><div class="muted small">TractFIPS ${esc(p.TractFIPS)}</div>
        <div class="ppv">${fmtFor(s.measure)(p[valueKey(s.measure)])}<span>${unitOf(s.measure) === "year" ? "" : unitOf(s.measure) === "%" ? "%" : " " + esc(unitOf(s.measure))}</span></div><div class="small">${esc(measureLabel(s.measure))}</div>
        ${ci ? `<div class="small">95% confidence interval: <b>${esc(ci)}</b></div>` : rangeField(s.measure) ? termRangeLine(s.measure, p) : ""}${inBuf}</div>`;
    }

    renderLegend() {
      const s = this.s, br = this.br;
      this.legendEl.innerHTML = `<div class="lt">${esc(s.legend)}</div>` +
        br.slice(1).map((v, i) => `<div><i class="sw" style="background:${this.pal[i]}"></i>${fmtFor(s.measure)(br[i])} – ${fmtFor(s.measure)(v)}</div>`).join("") +
        (this.storeRows.length ? `<div class="lsub">${esc(this.storeLabel())}</div>` + (this.bufs.length ? `<div><i class="sw st in"></i>Store inside a buffer</div><div><i class="sw st"></i>Store outside every buffer</div>` : `<div><i class="sw st"></i>Store</div>`) : "") +
        (this.bufs.length ? `<div><i class="sw ln" style="border-color:${s.bufColor}"></i>${esc(this.bufName())}</div>` : "") +
        (this.cond.length ? `<div><i class="sw ${s.condType === "routes" ? "rd" : s.condType === "chcs" ? "hc" : "pk"}"></i>${esc(this.condName())}</div>` : "") +
        `<div class="lsrc">${C.METHODS[s.method]}, ${Math.max(0, br.length - 1)} classes</div>`;
    }

    renderTable() {
      const s = this.s, t = this.tableEl;
      if (!s.towns.length) { t.innerHTML = `<div class="muted small pad">Filter to your towns in step 1 to see the tract table.</div>`; return; }
      const rows = [...this.sel].sort((a, b) => a.properties.City_Town.localeCompare(b.properties.City_Town) || a.properties.TractFIPS.localeCompare(b.properties.TractFIPS));
      const term = rangeField(s.measure), moeCol = !!(term && term.moe);
      const termCells = p => { const r = C.acsRange(term, p, s.measure); return `<td>${esc(r ? r.ci || (r.none ? "No margin of error" : "–") : "–")}</td>${moeCol ? `<td>${esc((r && r.moe) || "–")}</td>` : ""}`; };
      const pick = !!this.opts.pickRows; // team pages: click a row to highlight its tract (her ask 2026-11-19)
      const ck = ciKey(s.measure), summary = this.bufs.length ? C.countByTown(this.sel, this.touch, s.towns).map(([tw, a, n]) => `${esc(tw)}: ${a} of ${n} touch the buffer`).join(" · ") : "Add a condition and a buffer to see which tracts touch it";
      const noteButton = key => `<button type="button" class="ibtn" data-note="${key}" aria-label="About this column" aria-expanded="${this.noteOpen === key}">i</button>`;
      const shownNotes = ["value", "ci", ...(moeCol ? ["moe"] : []), ...(this.bufs.length ? ["buffer"] : [])];
      const note = shownNotes.includes(this.noteOpen) ? `<tr class="noterow"><td colspan="${4 + Number(moeCol) + Number(!!this.bufs.length)}"><div class="colnote">${COLUMN_NOTES[this.noteOpen]}</div></td></tr>` : "";
      // Option B (her pick, 2026-11-18): the summary is a visible button, with what the table holds spelled out.
      t.innerHTML = `<details class="ttab" ${this.tableOpen ? "open" : ""}><summary><span class="tbtn"><span class="tbtn-open">▸ Open the tract table</span><span class="tbtn-close">▾ Hide the tract table</span></span><span class="tsum">Every tract's value, its 95% confidence interval, and whether it is included in the buffer · ${rows.length} tracts · ${summary}${pick ? " · Click a row to see that tract on the map" : ""}</span></summary>
        <div class="tscroll"><table><thead><tr><th scope="col">GEOID</th><th scope="col">Town</th><th scope="col">Value (${esc(unitOf(s.measure))})${noteButton("value")}</th><th scope="col">95% Confidence Intervals${noteButton("ci")}</th>${moeCol ? `<th scope="col">Margin of error (±)${noteButton("moe")}</th>` : ""}${this.bufs.length ? `<th scope="col">Included in the buffer?${noteButton("buffer")}</th>` : ""}</tr>${note}</thead><tbody>` +
        rows.map(f => { const p = f.properties; return `<tr${pick ? ` data-fips="${esc(p.TractFIPS)}" tabindex="0"${p.TractFIPS === this.pick ? ' class="on"' : ""}` : ""}><td>${esc(p.TractFIPS)}</td><td>${esc(p.City_Town)}</td><td>${fmtFor(s.measure)(p[valueKey(s.measure)])}</td>${term ? termCells(p) : `<td>${esc((ck && p[ck]) || "–")}</td>`}${this.bufs.length ? `<td>${this.touch.has(p.TractFIPS) ? "Yes" : "No"}</td>` : ""}</tr>`; }).join("") +
        `</tbody></table></div>${this.bufs.length ? `<p class="colnote small">Area, not people: a “Yes” means some part of the census tract touches a buffer, not that everyone in it lives inside the buffer.</p>` : ""}</details>` + this.storeTable();
      t.querySelectorAll(".ibtn").forEach(button => { button.onclick = e => { e.preventDefault(); e.stopPropagation(); this.noteOpen = this.noteOpen === button.dataset.note ? null : button.dataset.note; this.tableOpen = true; this.renderTable(); }; });
      t.querySelector("details").addEventListener("toggle", e => { this.tableOpen = e.target.open; });
      if (pick) {
        const tb = t.querySelector("details:not(.stab) tbody"), choose = tr => tr && this.pickTract(tr.dataset.fips === this.pick ? null : tr.dataset.fips);
        tb.onclick = e => choose(e.target.closest("tr[data-fips]"));
        tb.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(e.target.closest("tr[data-fips]")); } };
      }
      const sd = t.querySelector("details.stab"); if (sd) sd.addEventListener("toggle", e => { this.storeTableOpen = e.target.open; });
    }

    /** Question C: "<X> of <Y> … are inside the …-mile buffer", then the store table (approved Option A + table C). */
    storeTable() {
      const s = this.s, rows = this.storeRows;
      if (!s.stores || s.condType !== "parks" || !s.towns.length) return "";
      const what = this.storeLabel().toLowerCase(), inside = rows.filter(r => r.inside).length;
      if (!rows.length) return `<div class="scount">No ${esc(what)} in your chosen towns.</div>`;
      const count = s.miles > 0 ? `<b>${inside} of ${rows.length}</b> ${esc(what)} are inside the ${s.miles}-mile buffer.` : `<b>${rows.length}</b> ${esc(what)} in your chosen towns. Choose a buffer distance in step 4 to count how many are inside it.`;
      return `<div class="scount">${count}</div>
        <details class="ttab stab" ${this.storeTableOpen ? "open" : ""}><summary><span class="tbtn"><span class="tbtn-open">▸ Open the store table</span><span class="tbtn-close">▾ Hide the store table</span></span><span class="tsum">Each store, the nearest public open space, and the distance to its edge</span></summary>
        <div class="tscroll"><table><thead><tr><th scope="col">Store</th><th scope="col">Address</th><th scope="col">Nearest public open space</th><th scope="col">Miles</th></tr></thead><tbody>` +
        rows.map(r => { const p = r.store.properties; return `<tr><td>${esc(p.name)}</td><td>${esc(p.addr)}${s.towns.length > 1 ? `, ${esc(p.town)}` : ""}</td><td>${esc(r.park || "–")}</td><td>${r.miles == null ? "–" : r.miles.toFixed(2)}</td></tr>`; }).join("") +
        `</tbody></table></div></details>`;
    }

    renderFocus() {
      const e = this.focusEl, g = this.focusGroup;
      e.hidden = !g.length; if (!g.length) return;
      e.innerHTML = `<div class="fch"><b>Zoomed in on ${esc(g[0].properties.SITE_NAME || "this park")}</b><button class="btn ghost" type="button" data-back>Back to all parks</button></div>` +
        g.map((f, i) => `<div class="fcr"><i style="background:${FOCUS_COLS[i]}55;border-color:${FOCUS_COLS[i]}"></i><div><b style="color:${FOCUS_COLS[i]}">${esc(f.properties.SITE_NAME || "Unnamed open space")}</b><br><span class="muted">${fmt(f.properties.GIS_ACRES)} acres · ${esc(f.properties.Town)} · its own ${this.s.miles}-mile ring</span></div></div>`).join("") +
        `<div class="muted small">${g.length > 1 ? `${g.length} separate records that touch, so they look like one green area. Each one has its own ring.` : "No other park touches this one."}</div>`;
      e.querySelector("[data-back]").onclick = () => this.set("focus", null, true);
    }

    /* ---------------- saved image (drawn on a canvas; the basemap is not included) ---------------- */
    renderImage() {
      // A team's research question (her pick 2026-11-19) prints under the title; the map moves down to make room.
      const s = this.s, rq = String(s.rq || "").trim(), rqText = rq ? `Research question: ${rq}` : "";
      const rqLines = rq ? lines(document.createElement("canvas").getContext("2d"), rqText, 1050, `italic 17px -apple-system, "Helvetica Neue", Arial, sans-serif`) : [];
      const dy = rqLines.length ? rqLines.length * 22 + 8 : 0;
      const insetHeight = this.insetOff ? 0 : 252;
      const font = (w, px) => `${w} ${px}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
      const scratch = document.createElement("canvas").getContext("2d"), legendTop = 100 + dy;
      const wrappedHeight = (text, width, weight, size, lineHeight) => Math.max(0, lines(scratch, text, width, font(weight, size)).length - 1) * lineHeight;
      let legendHeight = insetHeight + wrappedHeight(s.legend, 290, "bold", 16, 20) + 30 + this.br.slice(1).length * 27 + 32;
      if (this.storeRows.length) ["Store inside a buffer", "Store outside every buffer"].forEach(txt => { legendHeight += wrappedHeight(`${txt} (${this.storeLabel().toLowerCase()})`, 250, "", 15, 19) + 27; });
      if (this.bufs.length) legendHeight += wrappedHeight(this.bufName(), 250, "", 15, 19) + 27;
      if (this.cond.length) legendHeight += wrappedHeight(this.condName(), 250, "", 15, 19) + 27;
      this.focusGroup.forEach(f => { legendHeight += wrappedHeight(`${f.properties.SITE_NAME || "Unnamed open space"} (${fmt(f.properties.GIS_ACRES)} ac)`, 250, "bold", 15, 19) + 27; });
      if (s.towns.length) legendHeight += 18;
      const W = 1100, H = this.insetOff ? 760 + dy : Math.max(760 + dy, legendTop + legendHeight + 80), cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const g = cv.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
      const box = [24, 74 + dy, 740, 600], fitBox = [box[0], box[1], box[2], box[3] - 104]; // tracts stop above the north arrow and scale
      const frameFeats = this.focusRings || this.sel;
      const bb = turf.bbox(turf.featureCollection(frameFeats));
      const projection = C.fitProjection(bb, fitBox[2], fitBox[3]), sc = projection.sc;
      const P = point => { const [x, y] = projection.project(point); return [fitBox[0] + x, fitBox[1] + y]; };
      const poly = gm => { const ps = gm.type === "Polygon" ? [gm.coordinates] : gm.type === "MultiPolygon" ? gm.coordinates : []; g.beginPath(); ps.forEach(p => p.forEach(r => r.forEach((pt, i) => { const [a, b] = P(pt); i ? g.lineTo(a, b) : g.moveTo(a, b); }))); };
      const line = gm => { const ls = gm.type === "LineString" ? [gm.coordinates] : gm.coordinates; g.beginPath(); ls.forEach(l => l.forEach((pt, i) => { const [a, b] = P(pt); i ? g.lineTo(a, b) : g.moveTo(a, b); })); };
      const view = [bb[0] - 0.05, bb[1] - 0.05, bb[2] + 0.05, bb[3] + 0.05];
      g.save(); g.beginPath(); g.rect(...box); g.clip(); g.fillStyle = "#f3f4f3"; g.fillRect(...box);
      this.data.tracts.forEach(f => {
        if (s.towns.includes(f.properties.City_Town)) return;
        const t = f.bbox || (f.bbox = turf.bbox(f)); if (t[0] > view[2] || t[2] < view[0] || t[1] > view[3] || t[3] < view[1]) return;
        poly(f.geometry); g.fillStyle = "#e3e6e5"; g.fill("evenodd"); g.strokeStyle = "#fff"; g.lineWidth = 0.8; g.stroke();
      });
      this.sel.forEach(f => { const c = C.classOf(f.properties[valueKey(s.measure)], this.br, s.method); poly(f.geometry); g.fillStyle = c < 0 ? "#e5e5e5" : this.pal[c]; g.fill("evenodd"); g.strokeStyle = "#fff"; g.lineWidth = 1; g.stroke(); });
      g.globalAlpha = this.viewAlpha;
      this.offParks.forEach(f => { poly(f.geometry); g.fillStyle = "rgba(213,218,215,.9)"; g.fill(); });
      const sq = (gm, fill) => { const [a, b] = P(gm.coordinates); g.fillStyle = fill; g.fillRect(a - 5, b - 5, 10, 10); g.strokeStyle = "#fff"; g.lineWidth = 1.2; g.strokeRect(a - 5, b - 5, 10, 10); };
      this.offCenters.forEach(f => sq(f.geometry, "#8a948f"));
      this.cond.forEach(f => { if (f.geometry.type === "Point") sq(f.geometry, CHC_COLOR); else if (f.geometry.type.includes("Line")) { line(f.geometry); g.strokeStyle = "#2b2b2b"; g.lineWidth = 3; g.stroke(); } else { poly(f.geometry); g.fillStyle = "rgba(124,184,127,.75)"; g.fill(); } });
      this.storeRows.forEach(r => { const [a, b] = P(r.store.geometry.coordinates); g.beginPath(); g.arc(a, b, 5, 0, 2 * Math.PI); g.fillStyle = r.inside ? STORE_COLOR : "#fff"; g.fill(); g.strokeStyle = STORE_COLOR; g.lineWidth = 1.6; g.stroke(); });
      this.bufs.forEach(b => { poly(b.geometry); g.strokeStyle = s.bufColor; g.lineWidth = 1.6; g.globalAlpha = this.viewAlpha * (this.focusRings ? 0.25 : 1); g.stroke(); g.globalAlpha = this.viewAlpha; });
      this.focusGroup.forEach((f, i) => { poly(f.geometry); g.fillStyle = FOCUS_COLS[i] + "59"; g.fill(); g.strokeStyle = FOCUS_COLS[i]; g.lineWidth = 3; g.stroke();
        poly(this.focusRings[i].geometry); g.setLineDash(i % 3 === 0 ? [] : i % 3 === 1 ? [10, 6] : [3, 5]); g.stroke(); g.setLineDash([]); });
      g.restore(); g.globalAlpha = 1; g.strokeStyle = "#b8bfbc"; g.lineWidth = 1; g.strokeRect(...box);
      // title
      g.fillStyle = "#1d2522"; g.font = font("bold", 24); wrap(g, s.title || this.defaultTitle(), 24, 44, 1050, 28);
      if (rqLines.length) { g.font = font("italic", 17); g.fillStyle = "#12302d"; rqLines.forEach((ln, i) => g.fillText(ln, 24, 70 + i * 22)); }
      // legend
      let x = 790, y = 100 + dy;
      if (!this.insetOff) {
        g.fillStyle = "#1d2522"; g.font = font("bold", 13); g.fillText("Census tract colors only", x, y);
        const top = y + 10, project = C.fitProjection(turf.bbox(turf.featureCollection(this.sel)), 290, 210).project;
        g.fillStyle = "#eef0ef"; g.fillRect(x, top, 290, 210);
        this.sel.forEach(f => { const c = C.classOf(f.properties[valueKey(s.measure)], this.br, s.method);
          const path = new Path2D(C.pathFor(f.geometry, point => { const [a, b] = project(point); return [x + a, top + b]; }));
          g.fillStyle = c < 0 ? "#e5e5e5" : this.pal[c]; g.fill(path, "evenodd"); g.strokeStyle = "#fff"; g.lineWidth = 0.6; g.stroke(path); });
        y += insetHeight;
      }
      g.fillStyle = "#1d2522"; g.font = font("bold", 16); y = wrap(g, s.legend, x, y, 290, 20) + 30; g.font = font("", 15);
      this.br.slice(1).forEach((v, i) => { g.fillStyle = this.pal[i]; g.fillRect(x, y - 14, 26, 18); g.strokeStyle = "#aaa"; g.strokeRect(x, y - 14, 26, 18); g.fillStyle = "#1d2522"; g.fillText(`${fmtFor(s.measure)(this.br[i])} – ${fmtFor(s.measure)(v)}`, x + 36, y); y += 27; });
      g.fillStyle = "#555"; g.font = font("", 13); g.fillText(`${C.METHODS[s.method]}, ${Math.max(0, this.br.length - 1)} classes`, x, y); y += 32; g.font = font("", 15);
      if (this.storeRows.length) [[true, "Store inside a buffer"], [false, "Store outside every buffer"]].forEach(([on, txt]) => {
        g.beginPath(); g.arc(x + 13, y - 5, 6, 0, 2 * Math.PI); g.fillStyle = on ? STORE_COLOR : "#fff"; g.fill(); g.strokeStyle = STORE_COLOR; g.lineWidth = 1.8; g.stroke();
        g.fillStyle = "#1d2522"; y = wrap(g, `${txt} (${this.storeLabel().toLowerCase()})`, x + 36, y, 250, 19) + 27; });
      if (this.bufs.length) { g.strokeStyle = s.bufColor; g.lineWidth = 2.5; g.strokeRect(x, y - 14, 26, 18); g.fillStyle = "#1d2522"; y = wrap(g, this.bufName(), x + 36, y, 250, 19) + 27; }
      if (this.cond.length) {
        if (s.condType === "routes") { g.strokeStyle = "#2b2b2b"; g.lineWidth = 3; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 26, y - 5); g.stroke(); } else if (s.condType === "chcs") { g.fillStyle = CHC_COLOR; g.fillRect(x + 8, y - 10, 10, 10); } else { g.fillStyle = "rgba(124,184,127,.75)"; g.fillRect(x, y - 14, 26, 18); }
        g.fillStyle = "#1d2522"; y = wrap(g, this.condName(), x + 36, y, 250, 19) + 27;
      }
      this.focusGroup.forEach((f, i) => { g.fillStyle = FOCUS_COLS[i] + "59"; g.fillRect(x, y - 14, 26, 18); g.strokeStyle = FOCUS_COLS[i]; g.lineWidth = 3; g.strokeRect(x, y - 14, 26, 18); g.fillStyle = FOCUS_COLS[i]; g.font = font("bold", 15); y = wrap(g, `${f.properties.SITE_NAME || "Unnamed open space"} (${fmt(f.properties.GIS_ACRES)} ac)`, x + 36, y, 250, 19) + 27; g.font = font("", 15); });
      if (s.towns.length) { g.fillStyle = "#e3e6e5"; g.fillRect(x, y - 14, 26, 18); g.fillStyle = "#1d2522"; g.fillText("Other towns (not compared)", x + 36, y); }
      // solid north arrow + two-part scale bar, on the map below the tracts
      const pxPerMi = sc / 69.17, steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50];
      const mi = [...steps].reverse().find(d => d * pxPerMi <= 170) || 0.1, bar = mi * pxPerMi;
      const cw = bar + 100, ch = 72, cx = box[0] + box[2] - cw - 12, cy = box[1] + box[3] - ch - 12;
      g.fillStyle = "rgba(255,255,255,.94)"; g.strokeStyle = "#b8bfbc"; g.lineWidth = 1; g.beginPath(); g.roundRect(cx, cy, cw, ch, 6); g.fill(); g.stroke();
      const nx = cx + 24, ny = cy + 46;
      g.fillStyle = "#1d2522"; g.beginPath(); g.moveTo(nx, ny - 30); g.lineTo(nx - 10, ny); g.lineTo(nx, ny - 7.5); g.lineTo(nx + 10, ny); g.closePath(); g.fill();
      g.font = font("bold", 11); g.textAlign = "center"; g.fillText("N", nx, ny + 14);
      const sx = cx + 54, sy = cy + 30;
      g.fillStyle = "#1d2522"; g.fillRect(sx, sy, bar / 2, 8); g.fillStyle = "#fff"; g.fillRect(sx + bar / 2, sy, bar / 2, 8); g.strokeStyle = "#1d2522"; g.strokeRect(sx, sy, bar, 8);
      g.fillStyle = "#1d2522"; g.font = font("", 13); g.fillText("0", sx, sy + 25); g.fillText(String(mi / 2), sx + bar / 2, sy + 25); g.fillText(`${mi} mi`, sx + bar, sy + 25); g.textAlign = "left";
      // source line
      const src = this.data.sources;
      const srcText = "Sources: " + (TERM[s.measure] ? TERM[s.measure].src + "; " : "") + ["tracts", this.cond.length ? (s.condType === "routes" ? "routes" : s.condType === "chcs" ? "chcs" : "openspace") : null].filter(Boolean).filter(kk => src[kk]).map(kk => src[kk].source).concat(this.storeRows.length ? [this.storeSource] : []).join("; ") + ".";
      g.fillStyle = "#444"; g.font = font("", 13); wrap(g, srcText, 24, H - 60, 1050, 18);
      return cv;
    }

    saveImage() {
      const cv = this.renderImage(), name = (this.s.title || this.defaultTitle()).replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 80) || "map";
      cv.toBlob(blob => { const a = el("a", { href: URL.createObjectURL(blob), download: `${name}.png` }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }, "image/png");
    }
  }

  /** "CHELSEA" → "Chelsea", "EAST BOSTON" → "East Boston" (MassGIS writes towns in capitals). */
  const townName = s => String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  /** The lines `text` wraps to at width w in the given font (to size the saved image before drawing). */
  function lines(g, text, w, f) { g.font = f; const out = []; let line = ""; for (const word of String(text).split(" ")) { const t = line ? line + " " + word : word; if (g.measureText(t).width > w && line) { out.push(line); line = word; } else line = t; } if (line) out.push(line); return out; }

  function wrap(g, text, x, y, w, lh) { let line = ""; for (const word of String(text).split(" ")) { const t = line ? line + " " + word : word; if (g.measureText(t).width > w && line) { g.fillText(line, x, y); y += lh; line = word; } else line = t; } g.fillText(line, x, y); return y; }

  /** Add a question file's layers ({ key: {label, unit, src, decimals, year} }) to the explorer's labels. */
  Explorer.registerLayers = fields => Object.assign(TERM, fields);
  root.Explorer = Explorer;
  root.ExplorerDefaults = DEFAULT_STATE;
})(window);
