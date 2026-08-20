"use strict";
/* Headless harness for the Manifold graph-hover feature.
   Stubs the `obsidian` module and a minimal DOM, then exercises both input
   channels (raw DOM hover, and the workspace "hover-link" event that Bases /
   properties / search use), the shared resolver, and the write into a fake
   graph renderer.

   Run with the Node bundled inside NodeGX:
     ELECTRON_RUN_AS_NODE=1 NodeGX.exe test/hover.test.js
*/

const Module = require("module");
const path = require("path");

/* ---------------- fake obsidian ---------------- */
class FakeSetting {
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addToggle(cb) { cb({ setValue() { return this; }, onChange() { return this; } }); return this; }
  addText(cb) { cb({ setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
}
let lastNotice = null;
const workspaceHandlers = {};
const fakeObsidian = {
  Plugin: class {
    constructor(app) { this.app = app; }
    registerDomEvent(el, evt, cb) { (this._dom = this._dom || []).push([el, evt, cb]); }
    registerEvent() {}
    addCommand(c) { (this.commands = this.commands || []).push(c); }
    addSettingTab() {}
    async loadData() { return null; }
    async saveData() {}
  },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
  Setting: FakeSetting,
  Notice: class { constructor(msg) { lastNotice = msg; } },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "obsidian") return fakeObsidian;
  return origLoad.apply(this, arguments);
};

/* ---------------- fake DOM ---------------- */
function parseSelector(sel) {
  return sel.split(",").map((s) => {
    const m = /^([a-zA-Z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)\])?$/.exec(s.trim());
    if (!m) throw new Error("test DOM cannot parse selector: " + s);
    return {
      tag: m[1] ? m[1].toUpperCase() : null,
      classes: (m[2].match(/\.[\w-]+/g) || []).map((c) => c.slice(1)),
      attr: m[3] || null,
    };
  });
}
function matches(el, parts) {
  return parts.some(
    (p) =>
      (!p.tag || el.tagName === p.tag) &&
      p.classes.every((c) => el._classes.has(c)) &&
      (!p.attr || el.getAttribute(p.attr) != null)
  );
}
function el(opts) {
  const e = {
    tagName: (opts.tag || "span").toUpperCase(),
    _classes: new Set((opts.cls || "").split(/\s+/).filter(Boolean)),
    _attrs: opts.attrs || {},
    textContent: opts.text || "",
    parentElement: opts.parent || null,
    previousElementSibling: null,
    nextElementSibling: null,
    isConnected: true,
  };
  e.classList = { contains: (c) => e._classes.has(c) };
  e.getAttribute = (n) => (n in e._attrs ? e._attrs[n] : null);
  e.addClass = (c) => e._classes.add(c);
  e.removeClass = (c) => e._classes.delete(c);
  e.closest = (sel) => {
    const parts = parseSelector(sel);
    let n = e;
    while (n) { if (matches(n, parts)) return n; n = n.parentElement; }
    return null;
  };
  e.contains = (other) => {
    let n = other;
    while (n) { if (n === e) return true; n = n.parentElement; }
    return false;
  };
  return e;
}
function run(children, parent) {
  children.forEach((c, i) => {
    c.parentElement = parent || c.parentElement || null;
    c.previousElementSibling = children[i - 1] || null;
    c.nextElementSibling = children[i + 1] || null;
  });
  return children;
}

/* Fake timers, so hover delay / linger / cancellation are testable. */
const timers = new Map();
let nextTimerId = 1;
global.document = { __fake: true };
/* Animation frames are held rather than run, so the watchdog can be stepped
   deliberately instead of spinning. */
const frames = new Map();
let nextFrameId = 1;
global.window = {
  setTimeout: (fn) => { const id = nextTimerId++; timers.set(id, fn); return id; },
  clearTimeout: (id) => { timers.delete(id); },
  requestAnimationFrame: (fn) => { const id = nextFrameId++; frames.set(id, fn); return id; },
  cancelAnimationFrame: (id) => { frames.delete(id); },
};
/** Run one frame of whatever is scheduled. */
function tick() {
  const fns = [...frames.values()];
  frames.clear();
  fns.forEach((fn) => fn());
}
function flush() {
  const fns = [...timers.values()];
  timers.clear();
  fns.forEach((fn) => fn());
}

/* ---------------- fake app ---------------- */
function makeRenderer(ids) {
  const lookup = {};
  for (const id of ids) lookup[id] = { id, __node: true, forward: {}, reverse: {} };
  return { nodeLookup: lookup, highlightNode: null, mouseX: 10, mouseY: 20, changes: 0, changed() { this.changes++; } };
}

const vaultFiles = [
  "Notes/Alpha.md",
  "Notes/Beta.md",
  "Notes/Sub/Deep.md",
  "Attachments/pic.png",
  "Active Quests.base",
];
/* What the global graph holds. Kept explicit so later rebuilds cannot pick up
   files added to the vault afterwards. */
const GRAPH_IDS = [...vaultFiles, "#project/alpha", "Ghost"];
const globalRenderer = makeRenderer(GRAPH_IDS);
const localRenderer = makeRenderer(["Notes/Alpha.md", "#project/alpha"]);
/* Exists in the vault but in neither graph: what a filter looks like. */
vaultFiles.push("Notes/Hidden.md");

/* A fake vault tree: folders have children, files do not. */
function fileEntry(p) { return { path: p }; }
const folders = {
  "Notes/Sub": { path: "Notes/Sub", children: [fileEntry("Notes/Sub/Deep.md")] },
  Attachments: { path: "Attachments", children: [fileEntry("Attachments/pic.png")] },
  Empty: { path: "Empty", children: [] },
};
folders["Notes"] = {
  path: "Notes",
  children: [fileEntry("Notes/Alpha.md"), fileEntry("Notes/Beta.md"), folders["Notes/Sub"]],
};

/* The marker id the plugin injects; kept in sync with main.js by this test. */
const MARKER = "claude-lab:folder-focus";
/* The size the marker reports, which is what keeps the renderer's per-frame
   distance check from evicting it while the pointer is over the canvas. */
function makeMarkerSize() {
  return feature.markerFor(globalRenderer).getSize();
}
function hasKey(renderer, id, key) {
  const node = renderer.nodeLookup[id];
  return !!(node && Object.prototype.hasOwnProperty.call(node.reverse, key));
}
function exempt(renderer, id) {
  return hasKey(renderer, id, MARKER);
}

/* A stand-in for the file explorer's tree: a Set of selected rows plus the
   three mutators the plugin wraps. */
function makeTree() {
  return {
    selectedDoms: new Set(),
    selectItem(item) { this.selectedDoms.add(item); },
    deselectItem(item) { this.selectedDoms.delete(item); },
    clearSelectedDoms() { this.selectedDoms.clear(); },
  };
}
const tree = makeTree();
function row(path, isFolder) {
  return { file: isFolder ? folders[path] : { path } };
}

/* Parent chains, so a hovered node can be traced back to where it lives. */
const fileObjects = {};
for (const p of ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Sub/Deep.md", "Notes/Hidden.md"]) {
  fileObjects[p] = { path: p };
}
folders["Notes"].parent = { path: "/" };
folders["Notes/Sub"].parent = folders["Notes"];
fileObjects["Notes/Alpha.md"].parent = folders["Notes"];
fileObjects["Notes/Beta.md"].parent = folders["Notes"];
fileObjects["Notes/Hidden.md"].parent = folders["Notes"];
fileObjects["Notes/Sub/Deep.md"].parent = folders["Notes/Sub"];

/* Explorer rows. "Notes" is open, "Notes/Sub" is collapsed. */
function explorerRow(cls) {
  const e = el({ cls: cls || "nav-file-title" });
  return e;
}
const fileItems = {
  "Notes/Alpha.md": { file: fileObjects["Notes/Alpha.md"], selfEl: explorerRow() },
  "Notes/Beta.md": { file: fileObjects["Notes/Beta.md"], selfEl: explorerRow() },
  "Notes/Hidden.md": { file: fileObjects["Notes/Hidden.md"], selfEl: explorerRow() },
  "Notes/Sub/Deep.md": { file: fileObjects["Notes/Sub/Deep.md"], selfEl: explorerRow() },
  Notes: { file: folders["Notes"], selfEl: explorerRow("nav-folder-title"), collapsed: false },
  "Notes/Sub": { file: folders["Notes/Sub"], selfEl: explorerRow("nav-folder-title"), collapsed: true },
};
const tinted = (p) => fileItems[p].selfEl._classes.has("claude-lab-explorer-hover");

/* The graph pane's control cluster, which gets nudged when a hover names
   something the graph is not showing. */
const controlsEl = el({ cls: "graph-controls" });
controlsEl.querySelector = () => null; // no inner button in this fixture
const graphContainerEl = {
  querySelector: (sel) => (sel.includes("graph-controls") ? controlsEl : null),
};
const nudged = () => controlsEl._classes.has("claude-lab-filter-hint");

const app = {
  workspace: {
    on: (name, cb) => { workspaceHandlers[name] = cb; return {}; },
    onLayoutReady: (cb) => cb(),
    getLeavesOfType: (type) =>
      type === "graph" ? [{ view: { renderer: globalRenderer, containerEl: graphContainerEl } }]
      : type === "localgraph" ? [{ view: { renderer: localRenderer } }]
      : type === "file-explorer" ? [{ view: { tree, fileItems } }]
      : [],
    iterateAllLeaves: () => {},
    getActiveFile: () => ({ path: "Notes/Source.md" }),
  },
  vault: {
    adapter: { write: async () => {} },
    getAbstractFileByPath: (p) =>
      folders[p] || fileObjects[p] || (vaultFiles.includes(p) ? fileEntry(p) : null),
  },
  metadataCache: {
    getFirstLinkpathDest: (linkpath) => {
      const hit = vaultFiles.find(
        (f) => f === linkpath || f === linkpath + ".md" ||
          path.basename(f, ".md") === linkpath || path.basename(f) === linkpath
      );
      return hit ? { path: hit } : null;
    },
  },
};

/* ---------------- boot ---------------- */
const PluginClass = require(path.join(__dirname, "..", "main.js"));

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got      ${a}\n        expected ${e}`}`);
}
function idsFor(element) {
  return feature.candidatesFor(feature.intentFromElement(element));
}
function highlighted(renderer) {
  return renderer.highlightNode ? renderer.highlightNode.id : null;
}
function reset() {
  tree.clearSelectedDoms();
  feature.baseIds = null;
  feature.stopWatchdog();
  feature.cancelAll();
  timers.clear();
  frames.clear();
  // Tests poke at internals directly, so scrub any flag or slot left behind;
  // each case must start from a clean graph.
  for (const renderer of [globalRenderer, localRenderer]) {
    renderer.highlightNode = null;
    for (const node of Object.values(renderer.nodeLookup)) {
      for (const key of Object.keys(node.reverse)) {
        if (node.reverse[key] === true) delete node.reverse[key];
      }
    }
  }
  globalRenderer.changes = 0;
  localRenderer.changes = 0;
}
/** Select rows the way the explorer would, then let the debounce settle. */
function selectRows(...rows) {
  for (const r of rows) tree.selectItem(r);
  flush();
}

let feature;

(async () => {
  const plugin = new PluginClass(app);
  plugin.app = app;
  await plugin.onload();
  feature = plugin.features[0];

  /* =========== resolution: links written in a note =========== */

  const readingLink = el({ tag: "a", cls: "internal-link", attrs: { "data-href": "Alpha", href: "Alpha" }, text: "Alpha" });
  check("reading view [[Alpha]] -> file path", idsFor(readingLink), ["Notes/Alpha.md"]);

  const subpathLink = el({ tag: "a", cls: "internal-link", attrs: { "data-href": "Alpha#Some heading" }, text: "Alpha > Some heading" });
  check("subpath [[Alpha#Heading]] -> file path", idsFor(subpathLink), ["Notes/Alpha.md"]);

  const lpPlain = run([
    el({ cls: "cm-formatting cm-formatting-link", text: "[[" }),
    el({ cls: "cm-hmd-internal-link cm-underline", text: "Alpha" }),
    el({ cls: "cm-formatting cm-formatting-link", text: "]]" }),
  ]);
  check("live preview [[Alpha]]", idsFor(lpPlain[1]), ["Notes/Alpha.md"]);

  const lpAlias = run([
    el({ cls: "cm-formatting cm-formatting-link", text: "[[" }),
    el({ cls: "cm-hmd-internal-link", text: "Alpha" }),
    el({ cls: "cm-hmd-internal-link cm-link-alias-pipe", text: "|" }),
    el({ cls: "cm-hmd-internal-link cm-link-alias cm-underline", text: "the first note" }),
    el({ cls: "cm-formatting cm-formatting-link", text: "]]" }),
  ]);
  check("live preview [[Alpha|alias]] hovering alias", idsFor(lpAlias[3]), ["Notes/Alpha.md"]);

  const lpAlias2 = run([
    el({ cls: "cm-hmd-internal-link", text: "Beta" }),
    el({ cls: "cm-link-alias-pipe", text: "|" }),
    el({ cls: "cm-link-alias", text: "second" }),
  ]);
  check("alias run with bare pipe span", idsFor(lpAlias2[2]), ["Notes/Beta.md"]);

  const twoLinks = run([
    el({ cls: "cm-hmd-internal-link", text: "Alpha" }),
    el({ cls: "cm-formatting cm-formatting-link", text: "]] [[" }),
    el({ cls: "cm-hmd-internal-link", text: "Beta" }),
  ]);
  check("adjacent links stay separate", idsFor(twoLinks[2]), ["Notes/Beta.md"]);

  const ghost = el({ tag: "a", cls: "internal-link is-unresolved", attrs: { "data-href": "Ghost" }, text: "Ghost" });
  check("unresolved link candidates", idsFor(ghost), ["Ghost", "Ghost.md"]);

  /* =========== resolution: tags =========== */

  const readTag = el({ tag: "a", cls: "tag", attrs: { href: "#project/alpha" }, text: "#project/alpha" });
  check("reading view tag", idsFor(readTag), ["#project/alpha"]);

  const editorTag = run([
    el({ cls: "cm-formatting cm-formatting-hashtag cm-hashtag cm-hashtag-begin", text: "#" }),
    el({ cls: "cm-hashtag cm-hashtag-end", text: "project/alpha" }),
  ]);
  check("editor tag run (hovering name)", idsFor(editorTag[1]), ["#project/alpha"]);
  check("editor tag run (hovering hash)", idsFor(editorTag[0]), ["#project/alpha"]);

  /* =========== resolution: the hover-link channel =========== */

  check(
    "hover-link payload with sourcePath (properties)",
    feature.candidatesFor({ el: readingLink, kind: "link", text: "Alpha", sourcePath: "Notes/Source.md" }),
    ["Notes/Alpha.md"]
  );
  check(
    "hover-link payload carrying a full path (Bases)",
    feature.candidatesFor({ el: readingLink, kind: "link", text: "Notes/Beta.md" }),
    ["Notes/Beta.md"]
  );

  /* =========== gating =========== */

  check("findHoverEl picks the link", feature.findHoverEl(lpPlain[1]) === lpPlain[1], true);
  feature.settings.reactToTags = false;
  check("tags off -> no tag target", feature.findHoverEl(editorTag[1]), null);
  feature.settings.reactToTags = true;

  /* =========== write-through and teardown =========== */

  reset();
  feature.highlightFor(feature.intentFromElement(readingLink));
  check("global renderer highlighted", highlighted(globalRenderer), "Notes/Alpha.md");
  check("local renderer highlighted", highlighted(localRenderer), "Notes/Alpha.md");
  check("mouseX nulled (else the render loop drops it)", globalRenderer.mouseX, null);
  check("a plain link is not outlined", readingLink._classes.has("claude-lab-graph-linked"), false);

  feature.clearHighlight();
  check("highlight cleared (global)", highlighted(globalRenderer), null);
  check("highlight cleared (local)", highlighted(localRenderer), null);
  check("glow removed", readingLink._classes.has("claude-lab-graph-linked"), false);

  reset();
  feature.highlightFor(feature.intentFromElement(readTag));
  check("tag highlighted in global", highlighted(globalRenderer), "#project/alpha");

  reset();
  feature.settings.globalGraph = false;
  feature.highlightFor(feature.intentFromElement(readingLink));
  check("global disabled -> untouched", highlighted(globalRenderer), null);
  check("local still highlighted", highlighted(localRenderer), "Notes/Alpha.md");
  feature.settings.globalGraph = true;
  reset();

  const missing = el({ tag: "a", cls: "internal-link", attrs: { "data-href": "Attachments/pic.png" }, text: "pic" });
  feature.highlightFor(feature.intentFromElement(missing));
  check("missing in local graph -> not highlighted", highlighted(localRenderer), null);
  check("present in global graph -> highlighted", highlighted(globalRenderer), "Attachments/pic.png");
  reset();

  /* =========== full hover lifecycle, DOM channel =========== */

  const noteBody = el({ cls: "markdown-preview-view" });
  const inNoteLink = el({ tag: "a", cls: "internal-link", attrs: { "data-href": "Alpha" }, text: "Alpha", parent: noteBody });
  const plainText = el({ text: "some prose", parent: noteBody });

  feature.onMouseOver({ target: inNoteLink });
  check("hover schedules, does not fire immediately", highlighted(globalRenderer), null);
  flush();
  check("after hover delay -> highlighted", highlighted(globalRenderer), "Notes/Alpha.md");

  feature.onMouseOut({ target: inNoteLink, relatedTarget: plainText });
  flush();
  check("leaving the link clears it", highlighted(globalRenderer), null);
  reset();

  /* Leaving before the delay elapses must cancel the pending highlight. */
  feature.onMouseOver({ target: inNoteLink });
  feature.onMouseOut({ target: inNoteLink, relatedTarget: plainText });
  flush();
  check("leaving during the delay cancels", highlighted(globalRenderer), null);
  reset();

  /* =========== full hover lifecycle, hover-link channel =========== */

  const basesCell = el({ cls: "bases-table-cell" });
  const basesLink = el({ tag: "a", cls: "bases-rendered-value", text: "Beta", parent: basesCell });
  const basesLinkText = el({ text: "Beta", parent: basesLink });

  check("hover-link handler was registered", typeof workspaceHandlers["hover-link"], "function");

  workspaceHandlers["hover-link"]({ source: "bases", linktext: "Notes/Beta.md", targetEl: basesLink });
  flush();
  check("Bases link highlights the graph", highlighted(globalRenderer), "Notes/Beta.md");
  reset();

  /* The same mouseover that fires hover-link then bubbles to our document
     listener, where it looks like a hover over a non-link. It must not cancel
     the hover the event channel just started. */
  workspaceHandlers["hover-link"]({ source: "bases", linktext: "Notes/Beta.md", targetEl: basesLink });
  feature.onMouseOver({ target: basesLinkText });
  flush();
  check("bubbled mouseover does not cancel the event channel", highlighted(globalRenderer), "Notes/Beta.md");

  /* Moving within the same link must not restart or clear anything. */
  const changesBefore = globalRenderer.changes;
  feature.onMouseOver({ target: basesLink });
  feature.onMouseOut({ target: basesLinkText, relatedTarget: basesLink });
  flush();
  check("moving inside the link is a no-op", globalRenderer.changes, changesBefore);
  check("still highlighted after inner move", highlighted(globalRenderer), "Notes/Beta.md");

  feature.onMouseOut({ target: basesLink, relatedTarget: basesCell });
  flush();
  check("leaving the Bases link clears it", highlighted(globalRenderer), null);
  reset();

  /* A property link hands us the source note directly. */
  const propsBlock = el({ cls: "metadata-container" });
  const propLink = el({ tag: "a", cls: "multi-select-pill-content", text: "Alpha", parent: propsBlock });
  workspaceHandlers["hover-link"]({ source: "preview", linktext: "Alpha", sourcePath: "Notes/Source.md", targetEl: propLink });
  flush();
  check("property link highlights the graph", highlighted(globalRenderer), "Notes/Alpha.md");
  reset();

  /* Both channels firing for one note link resolve to a single hover. */
  workspaceHandlers["hover-link"]({ source: "preview", linktext: "Alpha", sourcePath: "Notes/Source.md", targetEl: inNoteLink });
  flush();
  const changesAfterFirst = globalRenderer.changes;
  feature.onMouseOver({ target: inNoteLink });
  flush();
  check("duplicate channels do not re-write the renderer", globalRenderer.changes, changesAfterFirst);
  reset();

  /* =========== onlyInNotes gating across both channels =========== */

  feature.settings.onlyInNotes = true;
  check("onlyInNotes blocks a link outside a note", feature.findHoverEl(basesLink), null);
  check("onlyInNotes allows an in-note link", feature.findHoverEl(inNoteLink) === inNoteLink, true);

  workspaceHandlers["hover-link"]({ source: "bases", linktext: "Notes/Beta.md", targetEl: basesLink });
  flush();
  check("onlyInNotes blocks the Bases event", highlighted(globalRenderer), null);

  workspaceHandlers["hover-link"]({ source: "preview", linktext: "Alpha", sourcePath: "Notes/Source.md", targetEl: propLink });
  flush();
  check("onlyInNotes still allows properties", highlighted(globalRenderer), "Notes/Alpha.md");
  feature.settings.onlyInNotes = false;
  reset();

  /* Master switch. */
  feature.settings.enabled = false;
  workspaceHandlers["hover-link"]({ source: "bases", linktext: "Notes/Beta.md", targetEl: basesLink });
  feature.onMouseOver({ target: inNoteLink });
  flush();
  check("disabled -> both channels inert", highlighted(globalRenderer), null);
  feature.settings.enabled = true;
  reset();

  /* =========== data surfaces: properties and Bases =========== */

  /* Bases renders a tag as <a class="tag"> with the hash stripped and no href. */
  const basesView = el({ cls: "bases-view" });
  const basesTagCell = el({ cls: "bases-table-cell", parent: basesView });
  const basesTag = el({ tag: "a", cls: "tag", text: "project/alpha", parent: basesTagCell });
  check("Bases tag (no hash, no href)", idsFor(basesTag), ["#project/alpha"]);

  /* Property pills carry no link markup at all: resolved by asking the graph. */
  const propsBlock2 = el({ cls: "metadata-property" });
  const tagPill = el({ cls: "multi-select-pill", parent: propsBlock2 });
  const tagPillText = el({ cls: "multi-select-pill-content", text: "project/alpha", parent: tagPill });
  check("property tag pill", idsFor(tagPillText), ["#project/alpha", "project/alpha"]);
  check("findHoverEl picks the pill content", feature.findHoverEl(tagPillText) === tagPillText, true);

  const notePill = el({ cls: "multi-select-pill-content", text: "Alpha", parent: propsBlock2 });
  check("property value naming a note", idsFor(notePill), ["Notes/Alpha.md", "#Alpha", "Alpha"]);

  const prosePill = el({ cls: "bases-table-cell", text: "a".repeat(200), parent: basesView });
  check("long cell text resolves to nothing", idsFor(prosePill), []);
  const multiline = el({ cls: "bases-table-cell", text: "one\ntwo", parent: basesView });
  check("multi-value cell resolves to nothing", idsFor(multiline), []);

  const outsideData = el({ cls: "multi-select-pill-content", text: "project/alpha" });
  check("value matching is confined to data surfaces", feature.findHoverEl(outsideData), null);

  feature.settings.matchDataValues = false;
  check("value matching can be switched off", feature.findHoverEl(tagPillText), null);
  feature.settings.matchDataValues = true;

  reset();
  feature.onMouseOver({ target: tagPillText });
  flush();
  check("property tag pill highlights the graph", highlighted(globalRenderer), "#project/alpha");
  reset();

  feature.onMouseOver({ target: basesTag });
  flush();
  check("Bases tag highlights the graph", highlighted(globalRenderer), "#project/alpha");
  reset();

  /* =========== embedded base: hover retargets to rows inside =========== */

  const embed = el({ cls: "internal-embed", attrs: { src: "Active Quests.base" }, parent: noteBody });
  const embeddedBase = el({ cls: "bases-embed", parent: embed });
  const embeddedRow = el({ cls: "bases-tr", parent: embeddedBase });
  const embeddedLink = el({ tag: "a", cls: "bases-rendered-value", text: "Beta", parent: embeddedRow });

  check("embed resolves to its src", idsFor(embed), ["Active Quests.base"]);

  feature.onMouseOver({ target: embeddedBase });
  flush();
  check("hovering the embed shows the base itself", highlighted(globalRenderer), "Active Quests.base");

  /* The whole point of item 3: a link inside the embed must take over, even
     though the embed element contains it. */
  workspaceHandlers["hover-link"]({ source: "bases", linktext: "Notes/Beta.md", targetEl: embeddedLink });
  flush();
  check("a row inside the embed retargets", highlighted(globalRenderer), "Notes/Beta.md");

  feature.onMouseOver({ target: embeddedLink });
  flush();
  check("the bubbled mouseover keeps the row target", highlighted(globalRenderer), "Notes/Beta.md");
  reset();

  /* =========== file explorer, bookmarks: anything with data-path =========== */

  const navFile = el({ cls: "nav-file-title", attrs: { "data-path": "Notes/Alpha.md" }, text: "Alpha" });
  const navFileText = el({ cls: "nav-file-title-content", text: "Alpha", parent: navFile });
  check("file explorer row resolves by data-path", idsFor(navFile), ["Notes/Alpha.md"]);
  check("hovering the row label finds the row", feature.findHoverEl(navFileText) === navFile, true);

  feature.onMouseOver({ target: navFileText });
  flush();
  check("file explorer hover highlights the graph", highlighted(globalRenderer), "Notes/Alpha.md");
  check("and in the local graph too", highlighted(localRenderer), "Notes/Alpha.md");
  reset();

  /* The same row also arrives through the event channel; one hover, not two. */
  feature.onMouseOver({ target: navFileText });
  flush();
  const changesAfterNav = globalRenderer.changes;
  workspaceHandlers["hover-link"]({ source: "file-explorer", linktext: "Notes/Alpha.md", targetEl: navFile });
  flush();
  check("file explorer: both channels resolve to one hover", globalRenderer.changes, changesAfterNav);
  reset();

  const navFolder = el({ cls: "nav-folder-title", attrs: { "data-path": "Notes" }, text: "Notes" });

  const bookmark = el({ cls: "tree-item-self", attrs: { "data-path": "Notes/Beta.md" }, text: "Beta" });
  feature.onMouseOver({ target: bookmark });
  flush();
  check("bookmark row highlights too", highlighted(globalRenderer), "Notes/Beta.md");
  reset();

  feature.settings.onlyInNotes = true;
  check("onlyInNotes excludes the file explorer", feature.findHoverEl(navFileText), null);
  feature.settings.onlyInNotes = false;

  /* =========== folder focus: fade everything outside the folder =========== */

  check("folder row is recognised as a folder", feature.intentFromElement(navFolder).kind, "folder");
  check(
    "folder members, every level (default)",
    idsFor(navFolder),
    ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Sub/Deep.md"]
  );

  feature.settings.folderDepth = 1;
  check("depth 1 stops at the folder's own files", idsFor(navFolder), ["Notes/Alpha.md", "Notes/Beta.md"]);
  feature.settings.folderDepth = 2;
  check("depth 2 includes one level of subfolders", idsFor(navFolder), ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Sub/Deep.md"]);
  feature.settings.folderDepth = 0;

  reset();
  feature.onMouseOver({ target: navFolder });
  flush();
  check("folder hover parks a marker in the highlight slot", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("member stays in the foreground", exempt(globalRenderer, "Notes/Alpha.md"), true);
  check("nested member too", exempt(globalRenderer, "Notes/Sub/Deep.md"), true);
  check("non-member is left to fade", exempt(globalRenderer, "Attachments/pic.png"), false);
  check("tags fade with everything else", exempt(globalRenderer, "#project/alpha"), false);
  check("the local graph focuses its own members", exempt(localRenderer, "Notes/Alpha.md"), true);
  check("a folder row is not outlined either", navFolder._classes.has("claude-lab-graph-linked"), false);

  feature.onMouseOut({ target: navFolder, relatedTarget: navFile });
  flush();
  check("clearing releases the slot", highlighted(globalRenderer), null);
  check("clearing removes every exemption", exempt(globalRenderer, "Notes/Alpha.md"), false);
  check("including nested ones", exempt(globalRenderer, "Notes/Sub/Deep.md"), false);
  check("and in the local graph", exempt(localRenderer, "Notes/Alpha.md"), false);
  reset();

  /* Depth is honoured at hover time, not just in the id list. */
  feature.settings.folderDepth = 1;
  feature.onMouseOver({ target: navFolder });
  flush();
  check("depth 1: nested file is not exempt", exempt(globalRenderer, "Notes/Sub/Deep.md"), false);
  check("depth 1: own file is exempt", exempt(globalRenderer, "Notes/Beta.md"), true);
  feature.settings.folderDepth = 0;
  reset();

  /* Moving from a folder to a file inside it must retarget cleanly. */
  feature.onMouseOver({ target: navFolder });
  flush();
  feature.onMouseOver({ target: navFileText });
  flush();
  check("folder -> file retargets to a single node", highlighted(globalRenderer), "Notes/Alpha.md");
  check("and drops the folder exemptions", exempt(globalRenderer, "Notes/Sub/Deep.md"), false);
  reset();

  const emptyFolder = el({ cls: "nav-folder-title", attrs: { "data-path": "Empty" }, text: "Empty" });
  feature.onMouseOver({ target: emptyFolder });
  flush();
  check("a folder with nothing in the graph does nothing", highlighted(globalRenderer), null);
  check("and does not glow", emptyFolder._classes.has("claude-lab-graph-linked"), false);
  reset();

  feature.settings.folderFocus = false;
  feature.onMouseOver({ target: navFolder });
  flush();
  check("folder focus can be switched off", highlighted(globalRenderer), null);
  feature.settings.folderFocus = true;
  reset();

  /* =========== coexistence with another plugin on the same property =========== */

  feature.onMouseOver({ target: inNoteLink });
  flush();
  check("ours is set", highlighted(globalRenderer), "Notes/Alpha.md");
  const foreignNode = globalRenderer.nodeLookup["Ghost"];
  globalRenderer.highlightNode = foreignNode; // another plugin takes over
  feature.clearHighlight();
  check("a highlight we no longer own is left alone", highlighted(globalRenderer), "Ghost");
  globalRenderer.highlightNode = null;
  reset();

  /* =========== selection focus: the base layer =========== */

  reset();
  check("the explorer tree got wrapped", typeof tree.selectItem === "function", true);

  selectRows(row("Notes/Alpha.md"), row("Notes/Beta.md"));
  check("selection isolates the selected files", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("selected file is exempt", exempt(globalRenderer, "Notes/Alpha.md"), true);
  check("other selected file is exempt", exempt(globalRenderer, "Notes/Beta.md"), true);
  check("unselected file fades", exempt(globalRenderer, "Attachments/pic.png"), false);

  /* Hover is a peek on top of the selection, and pops back to it. */
  feature.onMouseOver({ target: readTag });
  flush();
  check("hover takes over from the selection", highlighted(globalRenderer), "#project/alpha");
  check("selection exemptions are lifted while peeking", exempt(globalRenderer, "Notes/Alpha.md"), false);

  feature.onMouseOut({ target: readTag, relatedTarget: null });
  flush();
  check("leaving the hover restores the selection", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("and its exemptions", exempt(globalRenderer, "Notes/Alpha.md"), true);

  /* A hover that resolves to nothing must not strand the graph unfocused. */
  const nowhere = el({ tag: "a", cls: "internal-link", attrs: { "data-href": "Nothing At All" }, text: "x" });
  feature.onMouseOver({ target: nowhere });
  flush();
  check("a hover that matches nothing keeps the selection", exempt(globalRenderer, "Notes/Alpha.md"), true);
  reset();
  check("clearing the selection unfocuses the graph", highlighted(globalRenderer), null);

  /* Selecting a folder row stands for its files. */
  selectRows(row("Notes/Sub", true));
  check("a selected folder isolates its files", exempt(globalRenderer, "Notes/Sub/Deep.md"), true);
  check("and nothing else", exempt(globalRenderer, "Notes/Alpha.md"), false);
  reset();

  /* Deselecting one of several narrows the focus rather than dropping it. */
  const rowA = row("Notes/Alpha.md");
  const rowB = row("Notes/Beta.md");
  selectRows(rowA, rowB);
  tree.deselectItem(rowB);
  flush();
  check("deselecting narrows the focus", exempt(globalRenderer, "Notes/Beta.md"), false);
  check("the rest of the selection stays", exempt(globalRenderer, "Notes/Alpha.md"), true);
  reset();

  /* A graph rebuild replaces every node object; the focus must come back. */
  selectRows(row("Notes/Alpha.md"));
  check("selection applied before rebuild", exempt(globalRenderer, "Notes/Alpha.md"), true);
  const rebuilt = makeRenderer(GRAPH_IDS);
  globalRenderer.nodeLookup = rebuilt.nodeLookup; // what setData does
  globalRenderer.highlightNode = null;
  feature.onGraphRebuilt(globalRenderer);
  check("selection repainted after a rebuild", exempt(globalRenderer, "Notes/Alpha.md"), true);
  check("and the slot is ours again", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  reset();

  feature.settings.selectionFocus = false;
  selectRows(row("Notes/Alpha.md"));
  feature.syncSelection();
  check("selection focus can be switched off", highlighted(globalRenderer), null);
  feature.settings.selectionFocus = true;
  reset();

  /* =========== selection vs. hover: who wins =========== */

  reset();
  selectRows(row("Notes/Alpha.md"));

  /* Aiming at explorer rows to extend a selection must not hijack the graph. */
  feature.onMouseOver({ target: navFileText });
  flush();
  check("explorer hover does not steal a live selection", exempt(globalRenderer, "Notes/Alpha.md"), true);
  check("and does not paint the hovered row instead", highlighted(globalRenderer) === "Notes/Alpha.md", false);

  workspaceHandlers["hover-link"]({ source: "file-explorer", linktext: "Notes/Beta.md", targetEl: navFile });
  flush();
  check("the event channel respects it too", exempt(globalRenderer, "Notes/Alpha.md"), true);

  /* Content hovers are still peeks. */
  feature.onMouseOver({ target: readTag });
  flush();
  check("a note hover still peeks", highlighted(globalRenderer), "#project/alpha");
  feature.onMouseOut({ target: readTag, relatedTarget: null });
  flush();
  check("and returns to the selection", exempt(globalRenderer, "Notes/Alpha.md"), true);

  /* Without a selection, explorer hover behaves as before. */
  reset();
  feature.onMouseOver({ target: navFileText });
  flush();
  check("with no selection, explorer hover works as before", highlighted(globalRenderer), "Notes/Alpha.md");
  reset();

  /* =========== keeping the focus while the pointer is over the graph =========== */

  check("the marker outlasts the renderer's distance check", makeMarkerSize() >= 1e6, true);

  selectRows(row("Notes/Alpha.md"));
  const changesBeforeCanvas = globalRenderer.changes;
  const canvas = el({ cls: "graph-canvas" });
  feature.onMouseOver({ target: canvas });
  flush();
  check("crossing the canvas leaves the selection painted", exempt(globalRenderer, "Notes/Alpha.md"), true);
  check("and does not repaint it", globalRenderer.changes, changesBeforeCanvas);

  /* Hovering a node in the graph is the renderer's own gesture: it takes the
     slot, and hands it back when the pointer leaves. */
  check("node hover callbacks were chained", !!(globalRenderer.onNodeHover && globalRenderer.onNodeUnhover), true);
  globalRenderer.highlightNode = globalRenderer.nodeLookup["Notes/Beta.md"]; // what the renderer does
  globalRenderer.onNodeHover({}, "Notes/Beta.md", "");
  check("the graph's own hover is left alone", highlighted(globalRenderer), "Notes/Beta.md");

  globalRenderer.highlightNode = null; // the renderer clears on pointer out
  globalRenderer.onNodeUnhover();
  check("leaving the node restores the selection", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("with its exemptions", exempt(globalRenderer, "Notes/Alpha.md"), true);

  /* A pre-existing callback must survive being chained. */
  let ownCalls = 0;
  const fresh = makeRenderer(["Notes/Alpha.md"]);
  fresh.onNodeHover = () => { ownCalls++; };
  feature.wrapNodeHover(fresh);
  fresh.onNodeHover({}, "Notes/Alpha.md", "");
  check("an existing onNodeHover still runs", ownCalls, 1);
  feature.wrapNodeHover(fresh);
  fresh.onNodeHover({}, "Notes/Alpha.md", "");
  check("wrapping twice does not double-chain", ownCalls, 2);
  reset();

  /* =========== hover adds to the selection instead of replacing it =========== */

  reset();
  selectRows(row("Notes/Alpha.md"), row("Notes/Beta.md"));
  feature.onMouseOver({ target: readTag });
  flush();
  const tagNode = globalRenderer.nodeLookup["#project/alpha"];
  check("the hovered node takes the slot, natively", highlighted(globalRenderer), "#project/alpha");
  check("selection stays in the foreground", hasKey(globalRenderer, "Notes/Alpha.md", "#project/alpha"), true);
  check("all of it", hasKey(globalRenderer, "Notes/Beta.md", "#project/alpha"), true);
  check("and nothing else is exempted", hasKey(globalRenderer, "Attachments/pic.png", "#project/alpha"), false);

  feature.onMouseOut({ target: readTag, relatedTarget: null });
  flush();
  check("leaving removes the borrowed exemptions", hasKey(globalRenderer, "Notes/Alpha.md", "#project/alpha"), false);
  check("and the selection is painted again", exempt(globalRenderer, "Notes/Alpha.md"), true);
  reset();

  /* Additive hover can be switched off, restoring replace-the-selection. */
  feature.settings.hoverAddsToSelection = false;
  selectRows(row("Notes/Alpha.md"));
  feature.onMouseOver({ target: readTag });
  flush();
  check("with the option off, the selection is not carried", hasKey(globalRenderer, "Notes/Alpha.md", "#project/alpha"), false);
  feature.settings.hoverAddsToSelection = true;
  reset();

  /* =========== re-asserting the selection when the graph drops it =========== */

  selectRows(row("Notes/Alpha.md"));
  globalRenderer.highlightNode = null; // the renderer's per-frame check evicts it
  feature.reassertBase();
  check("an emptied slot is reclaimed", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("with the selection intact", exempt(globalRenderer, "Notes/Alpha.md"), true);

  /* A slot held by the graph's own hover is left alone. */
  globalRenderer.highlightNode = globalRenderer.nodeLookup["Notes/Beta.md"];
  feature.reassertBase();
  check("someone else's highlight is not stolen", highlighted(globalRenderer), "Notes/Beta.md");

  /* Then reclaimed once they let go, without needing to leave the graph. */
  globalRenderer.highlightNode = null;
  feature.reassertBase();
  check("and reclaimed when they let go", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  reset();

  /* =========== injected keys must never be visible to setData =========== */

  selectRows(row("Notes/Alpha.md"));
  let keysDuringSetData = null;
  const probe = globalRenderer.nodeLookup["Notes/Alpha.md"];
  globalRenderer.setData = function (data) {
    keysDuringSetData = Object.keys(probe.forward).length;
  };
  feature.watchRenderer(globalRenderer);
  globalRenderer.setData({});
  check("setData sees no injected links (they skew node weight)", keysDuringSetData, 0);
  check("and the focus is restored afterwards", exempt(globalRenderer, "Notes/Alpha.md"), true);
  reset();

  /* =========== hovering a node in the graph itself =========== */

  reset();
  selectRows(row("Notes/Alpha.md"), row("Notes/Beta.md"));
  const hoveredInGraph = globalRenderer.nodeLookup["Attachments/pic.png"];

  // What the renderer does on pointer-over, then its callback.
  globalRenderer.highlightNode = hoveredInGraph;
  globalRenderer.onNodeHover({}, "Attachments/pic.png", "");
  check("the graph's own highlight is untouched", highlighted(globalRenderer), "Attachments/pic.png");
  check("selection joins it in the foreground", hasKey(globalRenderer, "Notes/Alpha.md", "Attachments/pic.png"), true);
  check("all of the selection", hasKey(globalRenderer, "Notes/Beta.md", "Attachments/pic.png"), true);
  check("the stale marker keys are gone", exempt(globalRenderer, "Notes/Alpha.md"), false);

  // Pointer-out: the renderer empties the slot and calls back.
  globalRenderer.highlightNode = null;
  globalRenderer.onNodeUnhover();
  check("the selection is repainted at once", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("borrowed exemptions are handed back", hasKey(globalRenderer, "Notes/Alpha.md", "Attachments/pic.png"), false);
  check("and the marker keys return", exempt(globalRenderer, "Notes/Alpha.md"), true);

  /* The watchdog is the safety net for whatever empties the slot after the
     pointer has stopped moving, when no event is coming to prompt a repair. */
  globalRenderer.highlightNode = null; // something clears it, silently
  check("nothing has repaired it yet", highlighted(globalRenderer), null);
  tick();
  check("the next frame repairs it", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("with the selection intact", exempt(globalRenderer, "Notes/Alpha.md"), true);

  /* It keeps watching, frame after frame. */
  globalRenderer.highlightNode = null;
  tick();
  check("and keeps watching", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);

  /* It does not fight the graph's own hover. */
  globalRenderer.highlightNode = hoveredInGraph;
  tick();
  check("a live graph hover is left alone", highlighted(globalRenderer), "Attachments/pic.png");

  /* The failure that shipped: a renderer that falls out of the tracking map
     must still be policed, or it stays undimmed forever. */
  globalRenderer.highlightNode = null;
  feature.activeRenderers.clear();
  tick();
  check("an untracked renderer is still repaired", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("and gets its exemptions back", exempt(globalRenderer, "Notes/Alpha.md"), true);

  /* The second failure: a graph holding none of the selection can never take
     the marker, so watching it would repaint on every frame forever. Beta is
     in the global graph only. */
  reset();
  selectRows(row("Notes/Beta.md"));
  check("only graphs that took the focus are policed", feature.baseRenderers.length, 1);
  check("a graph without any of it is not policed", feature.baseRenderers.includes(localRenderer), false);
  check("the local graph's slot stays empty", highlighted(localRenderer), null);

  const before = globalRenderer.changes;
  tick(); tick(); tick();
  check("and that costs no repaints at all", globalRenderer.changes, before);

  /* A marker parked on the renderer would outlive a plugin reload. */
  check("the marker is not stored on the renderer", globalRenderer.manifoldFolderMarker, undefined);

  /* And it stops when the selection does. */
  reset();
  check("no selection, no watchdog", feature.watchdogId, null);

  /* =========== the two channels of one graph hover ===========
     Taken verbatim from a recorded failure. Hovering a node in the graph fires
     BOTH the renderer's callback and the workspace "hover-link" event; the
     canvas is a single element, so no mouseout ever arrives to tidy up. If the
     event channel is allowed to cancel the renderer channel, the unhover is
     ignored and the graph stays lit until the pointer leaves it entirely. */

  reset();
  selectRows(row("Notes/Alpha.md"), row("Notes/Beta.md"));
  const graphNode = globalRenderer.nodeLookup["Attachments/pic.png"];

  // 1. the renderer highlights the node and calls back (ours runs first)
  globalRenderer.highlightNode = graphNode;
  globalRenderer.onNodeHover({}, "Attachments/pic.png", "");
  check("peek is flagged", feature.graphPeek, true);

  // 2. the view then triggers hover-link for the same node
  workspaceHandlers["hover-link"]({
    source: "graph",
    linktext: "Attachments/pic.png",
    targetEl: el({ cls: "graph-canvas" }),
  });
  flush();
  check("the event channel recognises it as the same gesture", feature.transientFromGraph, true);
  check("and does not disown the renderer's hover", feature.graphPeek, true);

  // 3. pointer moves off the node onto empty canvas: renderer empties the slot
  globalRenderer.highlightNode = null;
  globalRenderer.onNodeUnhover();
  check("the unhover is acted on", feature.transientActive, false);
  check("the selection comes straight back", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  check("with its exemptions", exempt(globalRenderer, "Notes/Alpha.md"), true);
  reset();

  /* Backstop: even if the renderer never reports the unhover, a hover with
     nothing of ours on screen is a ghost and must not wedge the watchdog. */
  selectRows(row("Notes/Alpha.md"));
  feature.transientActive = true;
  feature.transientFromGraph = true;
  feature.activeRenderers.clear();
  globalRenderer.highlightNode = null;
  tick();
  check("a ghost hover is discarded", feature.transientActive, false);
  check("and the selection is repainted", globalRenderer.highlightNode && globalRenderer.highlightNode.id, MARKER);
  reset();

  /* A hover from a note must still behave as a peek, not be mistaken for one
     of these. */
  selectRows(row("Notes/Alpha.md"));
  feature.onMouseOver({ target: readTag });
  flush();
  check("a note hover is not marked as from the graph", feature.transientFromGraph, false);
  check("and still peeks", highlighted(globalRenderer), "#project/alpha");
  tick();
  check("the backstop leaves a live note hover alone", highlighted(globalRenderer), "#project/alpha");
  reset();

  /* =========== exemptions must not touch real links ===========
     forward/reverse map id -> LINK OBJECT. setData walks `forward` and calls
     clearGraphics() on anything it finds there that the new data does not
     describe, so a flag written into `forward` either destroys a real link --
     orphaning it inside renderer.links, where it draws forever and can never be
     updated -- or crashes the rebuild. This is what produced "edges that lead
     nowhere". */

  reset();
  const alpha = globalRenderer.nodeLookup["Notes/Alpha.md"];
  const beta = globalRenderer.nodeLookup["Notes/Beta.md"];
  const realLink = { source: alpha, target: beta, clearGraphics() { this.cleared = true; } };
  alpha.forward["Notes/Beta.md"] = realLink;
  beta.reverse["Notes/Alpha.md"] = realLink;
  globalRenderer.links = [realLink];

  selectRows(row("Notes/Alpha.md"), row("Notes/Beta.md"));
  check("nothing was written into forward", Object.keys(alpha.forward), ["Notes/Beta.md"]);
  check("the real link object is untouched", alpha.forward["Notes/Beta.md"] === realLink, true);
  check("exemptions live in reverse", exempt(globalRenderer, "Notes/Alpha.md"), true);

  feature.clearHighlight();
  feature.baseIds = null;
  feature.cancelAll();
  check("releasing leaves the real link alone", alpha.forward["Notes/Beta.md"] === realLink, true);
  check("and its reverse entry", beta.reverse["Notes/Alpha.md"] === realLink, true);

  /* A node already linked to the hover target needs no flag: it is a genuine
     neighbour, so it is already bright. */
  tree.clearSelectedDoms();
  selectRows(row("Notes/Alpha.md"));
  globalRenderer.highlightNode = beta;
  globalRenderer.onNodeHover({}, "Notes/Beta.md", "");
  check("a real neighbour is not flagged", alpha.reverse["Notes/Beta.md"], undefined);
  check("and its outgoing link survives", alpha.forward["Notes/Beta.md"] === realLink, true);
  globalRenderer.highlightNode = null;
  globalRenderer.onNodeUnhover();
  reset();

  /* Repairing links the old code orphaned. */
  const orphan = { source: alpha, target: beta, clearGraphics() { this.cleared = true; } };
  globalRenderer.links = [realLink, orphan]; // orphan is in no forward map
  const removed = feature.repairLinks(globalRenderer);
  check("the orphan is found", removed, 1);
  check("and dropped from the link list", globalRenderer.links.length, 1);
  check("the healthy link is kept", globalRenderer.links[0] === realLink, true);
  check("the orphan's graphics were released", orphan.cleared, true);
  check("repairing a clean graph removes nothing", feature.repairLinks(globalRenderer), 0);
  delete alpha.forward["Notes/Beta.md"];
  delete beta.reverse["Notes/Alpha.md"];
  globalRenderer.links = [];
  reset();

  /* =========== the outline is only where Obsidian gives no feedback =========== */

  reset();
  feature.onMouseOver({ target: inNoteLink });
  flush();
  check("a plain link is not outlined", inNoteLink._classes.has("claude-lab-graph-linked"), false);
  check("but it still drives the graph", highlighted(globalRenderer), "Notes/Alpha.md");
  reset();

  const embedForOutline = el({ cls: "internal-embed", attrs: { src: "Active Quests.base" }, parent: noteBody });
  feature.onMouseOver({ target: embedForOutline });
  flush();
  check("an embed is outlined", embedForOutline._classes.has("claude-lab-graph-linked"), true);
  reset();

  const basesRow = el({ cls: "bases-view" });
  const basesValue = el({ tag: "a", cls: "bases-rendered-value", attrs: { "data-href": "Alpha" }, text: "Alpha", parent: basesRow });
  feature.onMouseOver({ target: basesValue });
  flush();
  check("a Bases row is outlined", basesValue._classes.has("claude-lab-graph-linked"), true);
  reset();

  feature.settings.glowSourceLink = false;
  feature.onMouseOver({ target: embedForOutline });
  flush();
  check("outlining can be switched off", embedForOutline._classes.has("claude-lab-graph-linked"), false);
  feature.settings.glowSourceLink = true;
  reset();

  /* =========== hidden nodes point at the graph's filters =========== */

  const hiddenLink = el({ tag: "a", cls: "internal-link", attrs: { "data-href": "Notes/Hidden.md" }, text: "Hidden" });
  feature.onMouseOver({ target: hiddenLink });
  flush();
  check("a real file with no node nudges the controls", nudged(), true);
  feature.clearHighlight();
  check("and the nudge is cleared afterwards", nudged(), false);
  reset();

  /* A hover that names nothing real has nothing to go and unhide. */
  feature.onMouseOver({ target: nowhere });
  flush();
  check("a broken link does not nudge", nudged(), false);
  reset();

  /* A match means nothing is hidden. */
  feature.onMouseOver({ target: inNoteLink });
  flush();
  check("a node that is on screen does not nudge", nudged(), false);
  reset();

  feature.settings.filterHint = false;
  feature.onMouseOver({ target: hiddenLink });
  flush();
  check("the nudge can be switched off", nudged(), false);
  feature.settings.filterHint = true;
  reset();

  /* =========== graph hover points back at the explorer =========== */

  const graphHover = (id) => {
    globalRenderer.highlightNode = globalRenderer.nodeLookup[id];
    globalRenderer.onNodeHover({}, id, "");
    workspaceHandlers["hover-link"]({
      source: "graph",
      linktext: id,
      targetEl: el({ cls: "graph-canvas" }),
    });
    flush();
  };

  reset();
  graphHover("Notes/Alpha.md");
  check("a visible row is tinted", tinted("Notes/Alpha.md"), true);
  check("its open parent folder is not", tinted("Notes"), false);

  globalRenderer.highlightNode = null;
  globalRenderer.onNodeUnhover();
  check("leaving the node clears it", tinted("Notes/Alpha.md"), false);
  reset();

  /* Buried in a collapsed folder: tint the folder you would open, and open
     nothing. */
  graphHover("Notes/Sub/Deep.md");
  check("a buried row is not tinted", tinted("Notes/Sub/Deep.md"), false);
  check("the folder you would open is", tinted("Notes/Sub"), true);
  check("nothing was expanded", fileItems["Notes/Sub"].collapsed, true);
  check("and only that one folder", tinted("Notes"), false);
  reset();
  check("clearing removes it", tinted("Notes/Sub"), false);

  /* Moving between nodes moves the tint rather than accumulating it. */
  graphHover("Notes/Alpha.md");
  graphHover("Notes/Beta.md");
  check("the tint follows the pointer", [tinted("Notes/Alpha.md"), tinted("Notes/Beta.md")], [false, true]);
  reset();

  /* A hover from a note leaves the explorer alone -- the link is already under
     the cursor there. */
  feature.onMouseOver({ target: inNoteLink });
  flush();
  check("a note hover does not tint the explorer", tinted("Notes/Alpha.md"), false);
  reset();

  /* Tags have no row to tint. */
  graphHover("#project/alpha");
  check("a tag tints nothing", [tinted("Notes/Alpha.md"), tinted("Notes")], [false, false]);
  reset();

  feature.settings.showInExplorer = false;
  graphHover("Notes/Alpha.md");
  check("it can be switched off", tinted("Notes/Alpha.md"), false);
  feature.settings.showInExplorer = true;
  reset();

  /* =========== diagnostics =========== */

  feature.diagnose();
  check("diagnose produced a report", typeof lastNotice === "string" && lastNotice.includes("nodes"), true);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
