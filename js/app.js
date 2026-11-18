/* Page shell: tabs, data loading and Copy-link restore. */
(function () {
  const C = window.ExplorerCore;
  const TABS = ["exercise-4", "midterm", "term-project"];
  const osCache = new Map();
  let osIndex = [];

  async function getJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  /** Open-space features for every town file whose area overlaps bbox; each file is fetched once. */
  async function openSpaceFor(bbox) {
    const entries = C.townsInBbox(osIndex, bbox);
    await Promise.all(entries.filter(e => !osCache.has(e.file)).map(async e => { osCache.set(e.file, (await getJSON(`data/${e.file}`)).features); }));
    return entries.flatMap(e => osCache.get(e.file) || []);
  }

  function showTab(name) {
    const tab = TABS.includes(name) ? name : "exercise-4";
    document.querySelectorAll("[data-tab]").forEach(a => a.setAttribute("aria-selected", String(a.dataset.tab === tab)));
    document.querySelectorAll("[data-panel]").forEach(p => { p.hidden = !p.dataset.panel.split(" ").includes(tab); });
    if (window.explorer && tab !== "term-project") window.explorer.map.invalidateSize();
  }

  function route() {
    const h = location.hash.replace(/^#/, "");
    if (h.startsWith("map=")) return showTab((C.decodeState(h) || {}).tab || "exercise-4");
    showTab(h);
  }

  async function boot() {
    const status = document.getElementById("load-status");
    try {
      const [tracts, routes, index, sources] = await Promise.all(["data/tracts.json", "data/routes.json", "data/openspace/index.json", "data/sources.json"].map(getJSON));
      osIndex = index;
      const fromLink = C.decodeState(location.hash);
      window.explorer = new window.Explorer(document.getElementById("explorer"), { tracts: tracts.features, routes: routes.features, sources, openSpaceFor }, fromLink);
      status.remove();
    } catch (e) {
      status.textContent = "The map data did not load. Reload the page; if it still fails, email your instructor.";
      status.classList.add("error");
      throw e;
    }
    document.querySelectorAll("[data-tab]").forEach(a => a.addEventListener("click", ev => {
      ev.preventDefault(); history.replaceState(null, "", `#${a.dataset.tab}`); window.explorer.s.tab = a.dataset.tab; showTab(a.dataset.tab);
    }));
    window.addEventListener("hashchange", route);
    route();
  }

  boot();
})();
