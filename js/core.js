/* Map explorer core: the pure logic behind filter → style → condition → buffer → save.
   No DOM here, so the same file runs in the page and in the Node tests.
   Needs the globals `turf` (Turf 7.1) and `ss` (simple-statistics 7.8), both vendored. */
(function (root) {
  const RAMPS = {
    Blues: ["#eff3ff", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#084594"],
    Greens: ["#edf8e9", "#c7e9c0", "#a1d99b", "#74c476", "#41ab5d", "#238b45", "#005a32"],
    Purples: ["#f2f0f7", "#dadaeb", "#bcbddc", "#9e9ac8", "#807dba", "#6a51a3", "#4a1486"],
    Oranges: ["#feedde", "#fdd0a2", "#fdae6b", "#fd8d3c", "#f16913", "#d94801", "#8c2d04"]
  };
  const METHODS = { quantile: "Quantiles", equal: "Equal intervals", jenks: "Natural breaks (Jenks)" };
  const BBOX_PAD_DEG = 0.03; // about two miles: keeps nearby roads and parks in view of the filtered towns

  /** n colours from a ramp, spread from lightest to darkest. */
  function rampColors(name, n) {
    const r = RAMPS[name] || RAMPS.Blues;
    if (n >= r.length) return r.slice();
    if (n <= 1) return [r[r.length - 1]];
    return [...Array(n)].map((_, i) => r[Math.round(i * (r.length - 1) / (n - 1))]);
  }

  /** Class boundaries (n + 1 numbers). Never more classes than distinct values. */
  function breaks(values, method, n) {
    const v = values.filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
    if (!v.length) return [];
    const k = Math.max(1, Math.min(n, new Set(v).size));
    if (k === 1) return [v[0], v[v.length - 1]];
    if (method === "equal") {
      const lo = v[0], hi = v[v.length - 1];
      return [...Array(k + 1)].map((_, i) => lo + (hi - lo) * i / k);
    }
    if (method === "jenks") return ss.jenks(v, k);
    return [...Array(k + 1)].map((_, i) => ss.quantileSorted(v, i / k));
  }

  function classOf(value, br) {
    if (value == null || br.length < 2) return -1;
    for (let i = 1; i < br.length; i++) if (value <= br[i]) return i - 1;
    return br.length - 2;
  }

  function paddedBbox(features, pad = BBOX_PAD_DEG) {
    const b = turf.bbox(turf.featureCollection(features));
    return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  }

  const bboxesOverlap = (a, b) => !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
  const featureBbox = f => f.bbox || (f.bbox = turf.bbox(f));

  /** Open-space town files whose features could be in view. */
  function townsInBbox(index, bbox) {
    return index.filter(e => bboxesOverlap(e.bbox, bbox));
  }

  function filterRoutes(routes, rule) {
    if (rule.mode === "num") return routes.filter(f => f.properties.ADMIN_TYPE === Number(rule.adminType) && String(f.properties.RT_NUMBER) === String(rule.rtNumber).trim());
    return routes.filter(f => rule.names.includes(f.properties.Route_Name));
  }

  /** Routes cut to the area around the filtered towns, so a statewide road is buffered only where it matters. */
  function clipToBbox(lines, bbox) {
    return lines.map(f => turf.bboxClip(f, bbox)).filter(f => f.geometry.coordinates.length);
  }

  /** access: "Y" | "L" | "N" | "X" | "any"; onlyTowns: null or town names; off: ids switched off. */
  function filterOpenSpace(features, { access, minAcres, onlyTowns, off }) {
    return features.filter(f => {
      const p = f.properties;
      return (access === "any" || p.PUB_ACCESS === access) && (p.GIS_ACRES || 0) >= (minAcres || 0)
        && (!onlyTowns || onlyTowns.includes(p.Town)) && !(off || []).includes(p.id);
    });
  }

  /** One buffer per feature, measured outward from its edge. Buffers are never merged. */
  function bufferEach(features, miles) {
    return features.map(f => turf.buffer(f, miles, { units: "miles" })).filter(Boolean);
  }

  /** TractFIPS of every tract that touches at least one buffer. */
  function touchedTracts(tracts, buffers) {
    const hit = new Set();
    for (const t of tracts) {
      const tb = featureBbox(t);
      for (const b of buffers) {
        if (!bboxesOverlap(featureBbox(b), tb)) continue;
        if (turf.booleanIntersects(t, b)) { hit.add(t.properties.TractFIPS); break; }
      }
    }
    return hit;
  }

  /** [[town, tracts touching, tracts in town], …] in the order the towns were chosen. */
  function countByTown(tracts, touched, towns) {
    return towns.map(town => {
      const inTown = tracts.filter(f => f.properties.City_Town === town);
      return [town, inTown.filter(f => touched.has(f.properties.TractFIPS)).length, inTown.length];
    });
  }

  /** Parks that touch the given park (for "Zoom in on this park"), the park itself first. */
  function touchingGroup(park, candidates, max = 6) {
    return [park, ...candidates.filter(f => f !== park && f.properties.id !== park.properties.id && turf.booleanIntersects(f, park))].slice(0, max);
  }

  // Copy link: the whole map state travels in the link, base64url-encoded JSON after "#map=".
  const LINK_PREFIX = "map=";
  function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = ""; bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromBase64Url(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }
  function encodeState(state) { return LINK_PREFIX + toBase64Url(JSON.stringify(state)); }
  function decodeState(hash) {
    const h = String(hash || "").replace(/^#/, "");
    if (!h.startsWith(LINK_PREFIX)) return null;
    try { return JSON.parse(fromBase64Url(h.slice(LINK_PREFIX.length))); } catch (e) { return null; }
  }

  const api = { RAMPS, METHODS, rampColors, breaks, classOf, paddedBbox, townsInBbox, filterRoutes, clipToBbox,
    filterOpenSpace, bufferEach, touchedTracts, countByTown, touchingGroup, encodeState, decodeState };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ExplorerCore = api;
})(typeof self !== "undefined" ? self : this);
