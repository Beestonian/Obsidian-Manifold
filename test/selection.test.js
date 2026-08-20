"use strict";
/* Headless harness for Claude Lab's graph selection tools: alt-click toggling,
   the shift-lasso and its deselect-wins rule, and the multi-file context menu.

   Run with the Node bundled inside NodeGX:
     ELECTRON_RUN_AS_NODE=1 NodeGX.exe test/selection.test.js
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
let lastMenu = null;
const workspaceHandlers = {};
const fakeObsidian = {
  Plugin: class {
    constructor(app) { this.app = app; }
    registerDomEvent() {}
    registerEvent() {}
    addCommand(c) { (this.commands = this.commands || []).push(c); }
    addSettingTab() {}
    async loadData() { return null; }
    async saveData() {}
  },
  PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
  Setting: FakeSetting,
  Notice: class { constructor(msg) { this.msg = msg; } },
  Menu: class { constructor() { lastMenu = this; this.shown = false; } showAtMouseEvent() { this.shown = true; } },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "obsidian") return fakeObsidian;
  return origLoad.apply(this, arguments);
};

/* ---------------- environment ---------------- */
global.document = {
  __fake: true,
  createElementNS: () => ({
    _attrs: {},
    children: [],
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    appendChild(c) { this.children.push(c); },
    remove() { this.parentElement = null; },
    parentElement: null,
  }),
};
global.window = {
  devicePixelRatio: 1,
  setTimeout: (fn) => 1,
  clearTimeout: () => {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
};

/* ---------------- fake vault ---------------- */
const files = {
  "Notes/Alpha.md": { path: "Notes/Alpha.md" },
  "Notes/Beta.md": { path: "Notes/Beta.md" },
  "Notes/Sub/Deep.md": { path: "Notes/Sub/Deep.md" },
  "Notes/Orphan.md": { path: "Notes/Orphan.md" },
};
const folders = {
  Notes: { path: "Notes", children: [], collapsedItem: true },
  "Notes/Sub": { path: "Notes/Sub", children: [], collapsedItem: true },
};
folders.Notes.children = [files["Notes/Alpha.md"], files["Notes/Beta.md"], folders["Notes/Sub"]];
folders["Notes/Sub"].children = [files["Notes/Sub/Deep.md"]];
files["Notes/Alpha.md"].parent = folders.Notes;
files["Notes/Beta.md"].parent = folders.Notes;
files["Notes/Orphan.md"].parent = folders.Notes;
files["Notes/Sub/Deep.md"].parent = folders["Notes/Sub"];
folders["Notes/Sub"].parent = folders.Notes;
folders.Notes.parent = { path: "/" };

/* ---------------- fake file explorer ---------------- */
function fakeEl() {
  const classes = new Set();
  return { addClass: (c) => classes.add(c), removeClass: (c) => classes.delete(c), has: (c) => classes.has(c) };
}
function makeExplorer() {
  const tree = {
    selectedDoms: new Set(),
    selectItem(item) { this.selectedDoms.add(item); },
    deselectItem(item) { this.selectedDoms.delete(item); },
    clearSelectedDoms() { this.selectedDoms.clear(); },
  };
  const view = { tree, fileItems: {} };
  // The real explorer builds a row for EVERY file in the vault as it loads,
  // open or collapsed -- so selection reaches files that are not on screen.
  for (const path of Object.keys(files)) {
    view.fileItems[path] = { file: files[path], selfEl: fakeEl() };
  }
  view.fileItems["Notes"] = {
    file: folders.Notes, selfEl: fakeEl(),
    collapsed: false,
    toggleCollapsed(v) { this.collapsed = !!v; },
  };
  view.fileItems["Notes/Sub"] = {
    file: folders["Notes/Sub"], selfEl: fakeEl(),
    collapsed: true,
    toggleCollapsed(v) { this.collapsed = !!v; },
  };
  return view;
}
const explorer = makeExplorer();

/* ---------------- fake graph ---------------- */
function node(id, x, y, type) {
  return { id, x, y, type: type || "", forward: {}, reverse: {} };
}
const renderer = {
  scale: 1,
  panX: 0,
  panY: 0,
  highlightNode: null,
  nodeLookup: {},
  nodes: [
    node("Notes/Alpha.md", 10, 10),
    node("Notes/Beta.md", 20, 20),
    node("Notes/Sub/Deep.md", 200, 200),
    node("#some/tag", 12, 12, "tag"),
    node("Ghost", 14, 14, "unresolved"),
  ],
  changed() {},
};
for (const n of renderer.nodes) renderer.nodeLookup[n.id] = n;

/* The drawn links -- the graph AFTER its filters, which is what growing and
   shrinking must follow. Alpha - Beta - Deep is a chain; Alpha also touches a
   tag, which is visible but not selectable. */
function link(a, b) {
  return { source: renderer.nodeLookup[a], target: renderer.nodeLookup[b] };
}
renderer.links = [
  link("Notes/Alpha.md", "Notes/Beta.md"),
  link("Notes/Beta.md", "Notes/Sub/Deep.md"),
  link("Notes/Alpha.md", "#some/tag"),
];
/* A note joined only through a node the filters have removed. */
renderer.nodes.push(node("Notes/Orphan.md", 750, 750)); // clear of every test lasso
renderer.nodeLookup["Notes/Orphan.md"] = renderer.nodes[renderer.nodes.length - 1];
renderer.links.push({ source: renderer.nodeLookup["Notes/Orphan.md"], target: { id: "Filtered/Away.md" } });

const canvas = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  parentElement: { appendChild() {} },
};
const graphContainer = { contains: () => true, querySelector: () => canvas };

const app = {
  workspace: {
    on: (name, cb) => { workspaceHandlers[name] = cb; return {}; },
    onLayoutReady: (cb) => cb(),
    getLeavesOfType: (type) =>
      type === "graph" ? [{ view: { containerEl: graphContainer, renderer } }]
      : type === "file-explorer" ? [{ view: explorer }]
      : [],
    trigger: (name, ...args) => { workspaceHandlers["__last_" + name] = args; },
  },
  vault: {
    getAbstractFileByPath: (p) => files[p] || folders[p] || null,
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
let tools;
function selected() {
  return [...explorer.tree.selectedDoms].map((i) => i.file.path).sort();
}
function reset() {
  explorer.tree.clearSelectedDoms();
  tools.endLasso();
}
/** Drag a rectangle in canvas coordinates. */
function lasso(x1, y1, x2, y2) {
  const ev = (x, y) => ({
    button: 0, shiftKey: true, clientX: x, clientY: y,
    target: {}, preventDefault() {}, stopPropagation() {},
  });
  tools.onPointerDown(ev(x1, y1));
  tools.onPointerMove(ev(x2, y1));
  tools.onPointerMove(ev(x2, y2));
  tools.onPointerMove(ev(x1, y2));
  tools.onPointerUp(ev(x1, y1));
}

(async () => {
  const plugin = new PluginClass(app);
  plugin.app = app;
  await plugin.onload();
  tools = plugin.features.find((f) => f.constructor.id === "graphSelectionTools");
  check("the feature is registered", !!tools, true);

  /* =========== alt-click =========== */

  reset();
  check("plain click is not consumed", tools.onNodeClick({ altKey: false }, "Notes/Alpha.md"), false);
  check("and selects nothing", selected(), []);

  check("alt-click is consumed", tools.onNodeClick({ altKey: true }, "Notes/Alpha.md"), true);
  check("alt-click selects", selected(), ["Notes/Alpha.md"]);

  tools.onNodeClick({ altKey: true }, "Notes/Beta.md");
  check("alt-click adds to the selection", selected(), ["Notes/Alpha.md", "Notes/Beta.md"]);

  tools.onNodeClick({ altKey: true }, "Notes/Alpha.md");
  check("alt-click again removes it", selected(), ["Notes/Beta.md"]);

  tools.onNodeClick({ altKey: true }, "#some/tag");
  check("a tag has nothing to select", selected(), ["Notes/Beta.md"]);
  check("but the click is still swallowed", tools.onNodeClick({ altKey: true }, "#some/tag"), true);
  reset();

  /* =========== lasso: what it catches =========== */

  lasso(0, 0, 50, 50);
  check("lasso selects the nodes inside it", selected(), ["Notes/Alpha.md", "Notes/Beta.md"]);
  check("tags and unresolved links are ignored", selected().includes("#some/tag"), false);
  reset();

  lasso(100, 100, 300, 300);
  check("a lasso elsewhere catches only what is there", selected(), ["Notes/Sub/Deep.md"]);
  check("without opening the collapsed folder it lives in", explorer.fileItems["Notes/Sub"].collapsed, true);
  reset();

  /* =========== lasso: deselection wins =========== */

  tools.select(["Notes/Alpha.md"]);
  lasso(0, 0, 50, 50);
  check("a mixed lasso deselects, and adds nothing", selected(), []);

  lasso(0, 0, 50, 50);
  check("lassoing the cleared region then fills it", selected(), ["Notes/Alpha.md", "Notes/Beta.md"]);

  lasso(0, 0, 50, 50);
  check("and lassoing again clears it", selected(), []);
  reset();

  /* Selection outside the lasso is never touched. */
  tools.select(["Notes/Sub/Deep.md"]);
  lasso(0, 0, 50, 50);
  check("outside selection survives an adding lasso", selected(), ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Sub/Deep.md"]);
  lasso(0, 0, 50, 50);
  check("and survives a removing one", selected(), ["Notes/Sub/Deep.md"]);
  reset();

  /* An empty lasso changes nothing. */
  tools.select(["Notes/Alpha.md"]);
  lasso(400, 400, 500, 500);
  check("a lasso around nothing leaves the selection alone", selected(), ["Notes/Alpha.md"]);
  reset();

  /* =========== gestures that are not the lasso =========== */

  const plain = { button: 0, shiftKey: false, clientX: 0, clientY: 0, target: {}, preventDefault() {}, stopPropagation() {} };
  tools.onPointerDown(plain);
  check("plain drag is left to the graph to pan", tools.lasso, null);

  const rightDrag = { button: 2, shiftKey: true, clientX: 0, clientY: 0, target: {}, preventDefault() {}, stopPropagation() {} };
  tools.onPointerDown(rightDrag);
  check("right drag is not a lasso", tools.lasso, null);

  tools.settings.lasso = false;
  tools.onPointerDown({ button: 0, shiftKey: true, clientX: 0, clientY: 0, target: {}, preventDefault() {}, stopPropagation() {} });
  check("the lasso can be switched off", tools.lasso, null);
  tools.settings.lasso = true;
  reset();

  /* =========== right-click a multi-selection =========== */

  tools.select(["Notes/Alpha.md"]);
  check("a single selection keeps the normal menu", tools.onNodeRightClick({}, "Notes/Alpha.md"), false);

  tools.select(["Notes/Beta.md"]);
  check("a multi-selection takes over", tools.onNodeRightClick({}, "Notes/Alpha.md"), true);
  check("and shows a menu", lastMenu && lastMenu.shown, true);
  const args = workspaceHandlers["__last_files-menu"];
  check("built from Obsidian's own files-menu event", args && args[1].map((f) => f.path).sort(), ["Notes/Alpha.md", "Notes/Beta.md"]);

  check(
    "right-clicking outside the selection is left alone",
    tools.onNodeRightClick({}, "Notes/Sub/Deep.md"),
    false
  );
  reset();

  /* =========== growing and shrinking along visible links =========== */

  reset();
  tools.select(["Notes/Alpha.md"]);
  tools.growSelection();
  check("grow reaches a linked neighbour", selected(), ["Notes/Alpha.md", "Notes/Beta.md"]);
  check("but not through a tag", selected().includes("#some/tag"), false);

  tools.growSelection();
  check("growing again walks one more step", selected(), ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Sub/Deep.md"]);

  tools.growSelection();
  check("and stops when there is nothing left to reach", selected(), ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Sub/Deep.md"]);

  /* A whole connected component has no edge, so there is nothing to drop --
     the same rule a mesh editor uses, and the reason shrink is not simply undo. */
  tools.shrinkSelection();
  check("a complete cluster has no edge to shrink from", selected(), ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Sub/Deep.md"]);
  reset();

  /* Shrink undoes a grow whenever the grown set still touches something
     unselected: only nodes with every visible neighbour selected survive. */
  tools.select(["Notes/Alpha.md"]);
  tools.growSelection();
  check("grown to two", selected(), ["Notes/Alpha.md", "Notes/Beta.md"]);
  tools.shrinkSelection();
  check("shrink takes the edge back off", selected(), ["Notes/Alpha.md"]);
  reset();

  /* Physical closeness is not adjacency: the tag node sits right beside Alpha
     and Beta but shares no note-to-note link. */
  tools.select(["Notes/Sub/Deep.md"]);
  tools.growSelection();
  check("grow follows links, not distance", selected(), ["Notes/Beta.md", "Notes/Sub/Deep.md"]);
  reset();

  /* A link whose far end has been filtered out of the graph is not traversable,
     because the user cannot see it. */
  tools.select(["Notes/Orphan.md"]);
  tools.growSelection();
  check("a link to a filtered-out node is not followed", selected(), ["Notes/Orphan.md"]);
  reset();

  /* Select connected: grow to exhaustion. */
  tools.select(["Notes/Alpha.md"]);
  tools.selectConnected();
  check("select connected takes the whole cluster", selected(), ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Sub/Deep.md"]);
  check("still without the tag", selected().includes("#some/tag"), false);
  reset();

  /* An isolated node has no edge to be on, so shrinking leaves it. */
  tools.select(["Notes/Orphan.md"]);
  tools.shrinkSelection();
  check("an unconnected node survives shrinking", selected(), ["Notes/Orphan.md"]);
  reset();

  /* Nothing selected is a no-op, not an error. */
  tools.growSelection();
  check("growing nothing selects nothing", selected(), []);

  /* Adjacency must come from the drawn links, never from the node link maps --
     those carry the focus feature's flags, which are not real edges. */
  renderer.nodeLookup["Notes/Alpha.md"].reverse["Notes/Sub/Deep.md"] = true;
  tools.select(["Notes/Alpha.md"]);
  tools.growSelection();
  check("a focus flag is not mistaken for a link", selected(), ["Notes/Alpha.md", "Notes/Beta.md"]);
  delete renderer.nodeLookup["Notes/Alpha.md"].reverse["Notes/Sub/Deep.md"];
  reset();

  /* =========== folder hints =========== */

  const HINT = "claude-lab-contains-selection";
  const hinted = (folderPath) => explorer.fileItems[folderPath].selfEl.has(HINT);

  reset();
  tools.refreshFolderHints();
  check("no selection, no hints", hinted("Notes"), false);

  /* A file selected inside a collapsed folder is invisible without this. */
  tools.select(["Notes/Sub/Deep.md"]);
  tools.refreshFolderHints();
  check("the folder holding it is tinted", hinted("Notes/Sub"), true);
  check("and so is the folder above that", hinted("Notes"), true);
  check("the collapsed folder was not opened", explorer.fileItems["Notes/Sub"].collapsed, true);

  tools.deselect(["Notes/Sub/Deep.md"]);
  tools.refreshFolderHints();
  check("clearing the selection clears the tint", hinted("Notes/Sub"), false);
  check("all the way up", hinted("Notes"), false);

  /* Narrowing a selection must narrow the tint too. */
  tools.select(["Notes/Alpha.md", "Notes/Sub/Deep.md"]);
  tools.refreshFolderHints();
  check("both branches tinted", [hinted("Notes"), hinted("Notes/Sub")], [true, true]);
  tools.deselect(["Notes/Sub/Deep.md"]);
  tools.refreshFolderHints();
  check("the emptied branch loses its tint", hinted("Notes/Sub"), false);
  check("the branch still holding one keeps it", hinted("Notes"), true);

  tools.settings.folderHints = false;
  tools.refreshFolderHints();
  check("hints can be switched off", hinted("Notes"), false);
  tools.settings.folderHints = true;
  reset();
  tools.refreshFolderHints();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
