"use strict";

/*
 * Claude Lab -- a sandbox plugin holding a collection of small QOL features.
 *
 * No build step: this file is plain CommonJS and is what Obsidian loads
 * directly. Everything lives in one file because Obsidian only loads main.js
 * (relative require() of sibling files is not supported for plugins).
 *
 * Structure: the plugin is a host, features are modules. Each feature owns its
 * own settings blob (keyed by feature id), attaches its own listeners in
 * onload(), and draws its own section of the settings tab. Adding feature #2
 * means writing another class and appending it to FEATURES.
 */

const obsidian = require("obsidian");
const { Plugin, PluginSettingTab, Setting, Notice, Menu } = obsidian;

/* ------------------------------------------------------------------ *
 * Feature base class
 * ------------------------------------------------------------------ */

class Feature {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  /** This feature's slice of the saved settings. */
  get settings() {
    return this.plugin.settings[this.constructor.id];
  }

  async saveSettings() {
    await this.plugin.saveSettings();
  }

  onload() {}
  onunload() {}
  displaySettings(_containerEl) {}
}

/* ------------------------------------------------------------------ *
 * Feature: graph hover highlight
 * ------------------------------------------------------------------ *
 *
 * Wiring, in node-graph terms:
 *
 *   [mouseover on a link/tag] --> [resolve to a graph node id]
 *                                        |
 *                                        v
 *                       [for each open graph renderer]
 *                          global graph  <-- gated by "global" toggle
 *                          local graph   <-- gated by "local" toggle
 *                                        |
 *                                        v
 *                       renderer.highlightNode = node; renderer.changed()
 *
 * That last port is the same one Obsidian's own graph writes to when you hover
 * a node with the mouse, so we get the native effect for free: the node takes
 * the highlight fill, its links take the highlight line colour, and every node
 * that is not a direct neighbour fades back.
 *
 * One gotcha, confirmed by reading Obsidian's renderer: every frame, if
 * renderer.mouseX/mouseY are non-null, it checks whether the cursor is still
 * within the highlighted node's radius and drops the highlight if not. Since
 * our cursor is over the note, not the canvas, we null those two first.
 *
 * Hovering a folder needs the opposite of a highlight -- many nodes staying put
 * while the rest recede -- and reaches the same fade through a different door.
 * See FOLDER_MARKER_ID below.
 */

/* Link elements. Reading view uses <a class="internal-link">; live preview and
   source mode use spans carrying cm-hmd-internal-link, with the alias split
   off into its own span. */
const LINK_SELECTOR = "a.internal-link, .cm-hmd-internal-link, .cm-link-alias";

/* Sibling spans that belong to the same [[wikilink]] in the editor. The "[["
   and "]]" spans (cm-formatting-link) are deliberately excluded: they act as
   the boundary that stops one link's run from swallowing the next one. */
const LINK_RUN_CLASSES = [
  "cm-hmd-internal-link",
  "cm-link-alias",
  "cm-link-alias-pipe",
];

/* Tag elements. Reading view: <a class="tag" href="#foo">. Editor: the "#" and
   the name are separate spans, both carrying cm-hashtag. Bases renders tags as
   <a class="tag"> with the leading "#" stripped and no href at all. */
const TAG_SELECTOR = "a.tag, .cm-hashtag";
const TAG_RUN_CLASSES = ["cm-hashtag"];

/* Data surfaces: the properties block and Bases views. Anything hovered inside
   one of these is a value in a table, not prose, so it is worth resolving even
   when it is not marked up as a link or a tag -- that is how a Bases tag cell,
   a property pill, or a plain text value that happens to name a note gets
   picked up without a rule per widget. */
const DATA_CONTEXT_SELECTOR = ".metadata-property, .bases-view, .bases-embed";

/* The chips and cells inside those surfaces, innermost-wins via closest(). */
const VALUE_SELECTOR = [
  ".multi-select-pill-content",
  ".multi-select-pill",
  ".metadata-link-inner",
  ".metadata-link",
  ".bases-rendered-value",
  ".bases-metadata-value",
  ".bases-group-value",
  ".bases-cards-property",
  ".bases-list-property",
  ".bases-table-cell",
].join(", ");

/* Anything that declares which file it stands for. Obsidian stamps data-path on
   file explorer rows, bookmark items and folder rows, so one selector covers
   all of them -- and folders simply resolve to no node. */
const PATH_SELECTOR = "[data-path]";

/* Embeds are links too: an embedded note, image or .base file points at a real
   node. Checked last, because an embed wraps everything inside it -- hovering a
   row inside an embedded base must resolve to that row, not to the base. */
const EMBED_SELECTOR = ".internal-embed";

/* Where an outline on the hovered thing is worth drawing. Obsidian already
   gives links and tags their own hover feedback, so outlining those is
   redundant and costs a repaint over text. Embeds and Bases values have no
   such feedback, and there the outline says which row the graph is answering. */
const OUTLINE_SELECTOR = ".internal-embed, .bases-view, .bases-embed";

/* The graph's control cluster, nudged when a hover resolves to something the
   graph is not currently showing. */
const CONTROLS_SELECTOR = ".graph-controls";
const FILTER_HINT_CLASS = "claude-lab-filter-hint";

/* The explorer row answering a graph hover, tinted the way the explorer tints a
   row under the pointer. Never expands anything: if the row is inside a
   collapsed folder, the folder you would open is tinted instead. */
const EXPLORER_HOVER_CLASS = "claude-lab-explorer-hover";

/* Containers that count as "inside a note", for the strict mode setting.
   The metadata container is listed so the properties block counts as part of
   the note it belongs to. */
const NOTE_SELECTOR =
  ".markdown-source-view, .markdown-preview-view, .markdown-rendered, .metadata-container";

/*
 * Folder focus works with the renderer's fade rather than against it.
 *
 * Every frame, each node computes its target alpha as: full brightness if there
 * is no highlight node, or if it IS the highlight node, or if the highlight
 * node's id appears in its own forward/reverse link maps -- otherwise it eases
 * down to the faded value. Links do the same.
 *
 * So pointing highlightNode at a marker that is in no node's link maps fades the
 * entire graph, and adding that marker's id to a node's forward map exempts it.
 * Hover a folder, exempt its files, and everything else recedes -- animated by
 * the renderer itself, with the folder's nodes keeping their normal colours
 * rather than being repainted.
 *
 * The marker is shaped like a node so that any code path that reaches for one
 * finds something sane. It is never rendered: nothing holds it in renderer.nodes.
 *
 * One trap: every frame, if the pointer is over the canvas, the renderer
 * measures the cursor's distance from the highlighted node and drops it once the
 * cursor is outside that node's radius. onMouseMove sets those coordinates on
 * every movement, not just over a node -- so a marker at the origin with size 0
 * is evicted the moment the pointer crosses the graph. Reporting an enormous
 * size means the cursor is always "inside" it, and the focus survives.
 */
const FOLDER_MARKER_ID = "claude-lab:folder-focus";

function makeFolderMarker() {
  return {
    id: FOLDER_MARKER_ID,
    x: 0,
    y: 0,
    weight: 0,
    type: "",
    color: null,
    rendered: false,
    forward: {},
    reverse: {},
    getSize: () => 1e9,
  };
}

/*
 * Exemptions go into `reverse`, never `forward`, and only where nothing is
 * there already. Both maps are id -> LINK OBJECT, not id -> flag, and setData
 * walks `forward` to decide which links no longer exist: anything it finds
 * there that is not in the new data is passed to a removal routine that calls
 * clearGraphics() on it. A flag written into `forward` therefore either
 * (a) overwrites a real link object, orphaning it inside renderer.links where
 * it keeps drawing forever and can never be updated, or (b) crashes the rebuild
 * half-way through. `reverse` is only ever written by setData, never walked by
 * it, so an extra key there is inert.
 */
function exemptNode(node, key) {
  if (!node || !node.reverse || !node.forward) return false;
  // Already flagged by us: report success so it stays tracked and gets cleaned
  // up, rather than being stranded by a release we never account for.
  if (node.reverse[key] === true) return true;
  // Something real already links these two: it is exempt anyway, leave it be.
  if (Object.prototype.hasOwnProperty.call(node.reverse, key)) return false;
  if (Object.prototype.hasOwnProperty.call(node.forward, key)) return false;
  node.reverse[key] = true;
  return true;
}

function unexemptNode(node, key) {
  // Only ever remove the flag we wrote, never a link object.
  if (node && node.reverse && node.reverse[key] === true) delete node.reverse[key];
}

/**
 * The explorer's tree fires nothing when its selection changes, so its three
 * mutators are wrapped. Returns a function that stops listening -- and that
 * keeps working even if another watcher wrapped on top of ours afterwards,
 * since it silences the callback whether or not it can unwrap cleanly.
 */
function watchTreeSelection(tree, onChange) {
  const originals = {};
  const token = {};
  let live = true;

  for (const name of ["selectItem", "deselectItem", "clearSelectedDoms"]) {
    const original = tree[name];
    if (typeof original !== "function") continue;
    originals[name] = original;
    const wrapper = function (...args) {
      const result = original.apply(this, args);
      if (live) {
        try {
          onChange();
        } catch (err) {
          console.error("[Claude Lab] selection listener failed", err);
        }
      }
      return result;
    };
    wrapper.claudeLabWatch = token;
    tree[name] = wrapper;
  }

  return () => {
    live = false;
    for (const name of Object.keys(originals)) {
      if (tree[name] && tree[name].claudeLabWatch === token) tree[name] = originals[name];
    }
  };
}

/** Do two hovers point at the same thing? */
function sameIds(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

const GRAPH_HOVER_DEFAULTS = {
  enabled: true,
  globalGraph: true,
  localGraph: true,
  reactToLinks: true,
  reactToTags: true,
  matchDataValues: true,
  folderFocus: true,
  folderDepth: 0,
  selectionFocus: true,
  hoverAddsToSelection: true,
  onlyInNotes: false,
  hoverDelayMs: 50,
  lingerMs: 120,
  glowSourceLink: true,
  showInExplorer: true,
  filterHint: true,
  debug: false,
};

class GraphHoverHighlight extends Feature {
  static id = "graphHoverHighlight";
  static displayName = "Graph hover highlight";
  static defaults = GRAPH_HOVER_DEFAULTS;

  constructor(plugin) {
    super(plugin);
    /** Element currently under the cursor that we care about. */
    this.hoverEl = null;
    /** What that element resolves to: {el, kind, text, sourcePath?}. */
    this.hoverIntent = null;
    /** True while the hover delay timer is counting down. */
    this.pending = false;
    /**
     * Focus has two layers. The base layer is the file explorer's selection,
     * which persists; the transient layer is a hover, which sits on top and
     * pops back to the base when the pointer leaves. Only one is ever written
     * to the renderers, because there is only one slot to write to.
     */
    this.baseIds = null;
    this.transientActive = false;
    this.selectionTimer = null;
    /** What is currently painted: "base", "transient", or null. */
    this.appliedMode = null;
    /** True while the graph's own node hover owns the slot. */
    this.graphPeek = false;
    /** True when the live transient hover came from hovering a graph node. */
    this.transientFromGraph = false;
    /** Frame handle for the invariant watchdog, and its renderer cache. */
    this.watchdogId = null;
    this.baseRenderers = [];
    /** Per-renderer focus markers, held here so a reload starts clean. */
    this.markers = new Map();
    /** Frame-by-frame recording, for bugs that only exist under the pointer. */
    this.recording = false;
    this.recordId = null;
    this.recordStart = 0;
    this.log = [];
    this.lastSample = "";
    /** Trees and renderers we have monkeypatched, so we can put them back. */
    this.patchedTrees = new Map();
    this.patchedRenderers = new Set();
    this.hoverWrappedRenderers = new Set();
    /**
     * Renderers we have written a highlight into, mapped to the node we wrote.
     * Keeping the node lets us undo only our own highlight and leave one that
     * another plugin has since set -- graph-search-sync writes to the same
     * property, and two plugins clearing each other looks like flicker.
     */
    this.activeRenderers = new Map();
    /** Element that currently wears the outline class. */
    this.glowEl = null;
    /** Graph control clusters currently nudged, and the timer that clears them. */
    this.hintedControls = new Set();
    this.filterHintTimer = null;
    /** Explorer row currently tinted by a graph hover. */
    this.explorerHoverEl = null;
    this.enterTimer = null;
    this.leaveTimer = null;
    /** Last resolution attempt, for the diagnose command. */
    this.lastLookup = null;
  }

  onload() {
    this.attachTo(document);

    // Second source: Obsidian fires "hover-link" from every view that offers a
    // hover preview -- note body, properties, Bases, search, backlinks, file
    // explorer, tab headers. Subscribing here is what makes those all work
    // without a per-view special case; the payload hands us the link text and
    // the source note directly, so nothing has to be scraped from the DOM.
    this.plugin.registerEvent(
      this.app.workspace.on("hover-link", (info) => this.onHoverLink(info))
    );

    // Popout windows get their own document, so they need their own listeners.
    this.plugin.registerEvent(
      this.app.workspace.on("window-open", (_leaf, win) => {
        const doc = win && win.document;
        if (doc) this.attachTo(doc);
      })
    );

    // A graph closing or a layout change can leave us holding a dead renderer.
    // It can also mean a new file explorer to listen to.
    this.plugin.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.clearHighlight();
        this.watchFileExplorer();
      })
    );
    this.app.workspace.onLayoutReady(() => this.watchFileExplorer());

    this.plugin.addCommand({
      id: "toggle-graph-hover-highlight",
      name: "Toggle graph hover highlight",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        if (!this.settings.enabled) this.cancelAll();
        await this.saveSettings();
        new Notice(
          this.settings.enabled
            ? "Graph hover highlight: on"
            : "Graph hover highlight: off"
        );
      },
    });

    this.plugin.addCommand({
      id: "diagnose-graph-hover-highlight",
      name: "Diagnose graph hover highlight",
      callback: () => this.diagnose(),
    });

    this.plugin.addCommand({
      id: "repair-graph-links",
      name: "Repair orphaned graph links",
      callback: () => {
        let total = 0;
        for (const renderer of this.targetRenderers()) total += this.repairLinks(renderer);
        new Notice(
          total
            ? `Claude Lab: removed ${total} orphaned link${total === 1 ? "" : "s"}`
            : "Claude Lab: no orphaned links found",
          5000
        );
      },
    });

    this.plugin.addCommand({
      id: "record-graph-focus-log",
      name: "Record graph focus log (20s)",
      callback: () => this.startRecording(20),
    });

    this.plugin.addCommand({
      id: "stop-graph-focus-log",
      name: "Stop recording and save graph focus log",
      callback: () => this.stopRecording(),
    });
  }

  onunload() {
    window.clearTimeout(this.selectionTimer);
    this.stopWatchdog();
    this.baseIds = null;
    this.cancelAll();
    this.unwatchFileExplorer();
    this.unwatchRenderers();
  }

  attachTo(doc) {
    this.plugin.registerDomEvent(doc, "mouseover", (evt) => this.onMouseOver(evt));
    this.plugin.registerDomEvent(doc, "mouseout", (evt) => this.onMouseOut(evt));
    // Clicking a link navigates away; drop the highlight rather than let it
    // linger over a note that is no longer on screen.
    this.plugin.registerDomEvent(doc, "click", () => this.cancelAll());
    // The renderer has several ways to empty the slot -- its own pointer
    // handlers, and a per-frame check that evicts whatever the cursor is not
    // touching. Rather than chase each one, the selection is simply re-asserted
    // whenever the slot is found empty.
    this.plugin.registerDomEvent(doc, "mousemove", () => this.reassertBase());
  }

  /* -------------------------------------------------- sources
   *
   * Two input channels produce the same thing -- a hover intent of the shape
   * {el, kind: "link" | "tag", text, sourcePath?} -- and everything downstream
   * of beginHover() is shared:
   *
   *   [DOM mouseover]  --\
   *                       >-- beginHover -> candidatesFor -> renderers
   *   [hover-link event]-/
   *
   * The DOM channel exists because it is the only one that sees tags, and it
   * reads links the editor has not turned into anchors. The event channel
   * covers everywhere else a link can appear.
   */

  ready() {
    const s = this.settings;
    return s.enabled && (s.globalGraph || s.localGraph);
  }

  onMouseOver(evt) {
    if (!this.ready()) return;

    const target = evt.target;
    if (!target || typeof target.closest !== "function") return;

    const el = this.findHoverEl(target);
    if (!el) {
      // Not a link -- but do not tear down a hover that the event channel just
      // set up from this very same event (its listener runs first, then the
      // event bubbles up to us).
      if (this.hoverEl && this.contains(this.hoverEl, target)) return;
      // Only a hover needs clearing. Moving across the graph canvas with a
      // selection painted must not disturb it.
      if (this.pending || this.transientActive) this.scheduleClear();
      else this.hoverEl = null;
      return;
    }

    const intent = this.intentFromElement(el);
    if (intent) this.beginHover(intent);
  }

  onHoverLink(info) {
    if (!this.ready() || !this.settings.reactToLinks) return;
    if (!info || !info.linktext) return;

    const el = info.targetEl || (info.event && info.event.target);
    if (!el || typeof el.closest !== "function") return;
    if (this.settings.onlyInNotes && !el.closest(NOTE_SELECTOR)) return;

    this.beginHover({
      el,
      kind: "link",
      text: info.linktext,
      sourcePath: info.sourcePath,
      // Hovering a node in the graph fires this event too. It is the same
      // gesture the renderer already told us about, so it must be remembered as
      // such: the renderer, not the DOM, is what will tell us it ended. The
      // canvas is one element, so no mouseout ever arrives to clean it up.
      fromGraph: info.source === "graph" || this.graphPeek,
      nav:
        info.source === "file-explorer" ||
        info.source === "bookmarks" ||
        !!(el.getAttribute && el.getAttribute("data-path")),
    });
  }

  onMouseOut(evt) {
    if (!this.hoverEl) return;
    // Moving between children of the same link is not leaving it.
    const to = evt.relatedTarget;
    if (to && this.contains(this.hoverEl, to)) return;
    this.scheduleClear();
  }

  /**
   * The element the cursor is over that is worth resolving, or null. Ordered
   * innermost-meaning-first: an explicit tag or link beats a table value, and
   * a table value beats the embed that contains it.
   */
  findHoverEl(target) {
    const s = this.settings;
    if (s.onlyInNotes && !target.closest(NOTE_SELECTOR)) return null;

    // Tags first: a tag is never nested inside an internal link, but the
    // reverse selector could match odd markup.
    if (s.reactToTags) {
      const tagEl = target.closest(TAG_SELECTOR);
      if (tagEl) return tagEl;
    }
    if (s.reactToLinks) {
      const linkEl = target.closest(LINK_SELECTOR);
      if (linkEl) return linkEl;
    }
    if (s.matchDataValues && target.closest(DATA_CONTEXT_SELECTOR)) {
      const valueEl = target.closest(VALUE_SELECTOR);
      if (valueEl) return valueEl;
    }
    if (s.reactToLinks) {
      const pathEl = target.closest(PATH_SELECTOR);
      if (pathEl) return pathEl;
      const embedEl = target.closest(EMBED_SELECTOR);
      if (embedEl) return embedEl;
    }
    return null;
  }

  /* -------------------------------------------------- hover lifecycle */

  beginHover(intent) {
    const el = intent.el;

    // Building a selection means dragging the pointer across rows you do not
    // mean to inspect. While a selection is live, hovering navigation rows is
    // aiming, not asking -- so it leaves the selection alone. Hovering content
    // (a link, a tag, a table value) is still a peek.
    if (intent.nav && this.baseIds && this.baseIds.length) return;

    intent.candidates = this.candidatesFor(intent);

    // One pointer move can reach us twice: once through the DOM channel and
    // once through the event channel, usually anchored on different elements of
    // the same link. Two hovers are the same hover when they point at the same
    // node -- comparing what they resolve to rather than which element they
    // came from is also what lets a hover retarget from an embed to a row
    // inside it, since those resolve differently.
    if (
      (this.pending || this.activeRenderers.size) &&
      this.hoverIntent &&
      sameIds(this.hoverIntent.candidates, intent.candidates)
    ) {
      this.hoverEl = el;
      this.hoverIntent = intent;
      return;
    }

    this.hoverEl = el;
    this.hoverIntent = intent;
    this.transientFromGraph = !!intent.fromGraph;
    window.clearTimeout(this.enterTimer);
    window.clearTimeout(this.leaveTimer);
    this.pending = true;
    this.enterTimer = window.setTimeout(() => {
      this.pending = false;
      this.highlightFor(intent);
    }, Math.max(0, this.settings.hoverDelayMs));
  }

  scheduleClear() {
    window.clearTimeout(this.enterTimer);
    window.clearTimeout(this.leaveTimer);
    this.pending = false;
    this.hoverEl = null;
    this.hoverIntent = null;
    this.leaveTimer = window.setTimeout(
      () => this.clearHighlight(),
      Math.max(0, this.settings.lingerMs)
    );
  }

  contains(parent, child) {
    if (!parent || !child) return false;
    if (parent === child) return true;
    return typeof parent.contains === "function" && parent.contains(child);
  }

  /* -------------------------------------------------- selection (base layer)
   *
   * The file explorer owns the selection; this only mirrors it. That is the
   * whole point of driving Obsidian's own tree rather than keeping a parallel
   * one: right-click, drag, rename and delete keep working, and a graph rebuild
   * costs a repaint rather than losing state.
   *
   * The tree fires nothing when its selection changes, so its three mutators
   * are wrapped. They are put back on unload.
   */

  fileExplorerView() {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    return (leaf && leaf.view) || null;
  }

  fileTree() {
    const view = this.fileExplorerView();
    return (view && view.tree) || null;
  }

  /* -------------------------------------------------- graph -> explorer
   *
   * The other direction of the same brush. Hovering a node answers "where does
   * this live?" -- but expanding the tree to say so was ruled out as too
   * intrusive, so the answer adapts: if the row is on screen, tint the row; if
   * it is buried, tint the folder you would have to open. Walking the ancestor
   * chain from the root down, the first collapsed folder is exactly that: the
   * deepest one still visible, and the single thing worth clicking.
   */

  explorerTargetFor(path) {
    const view = this.fileExplorerView();
    if (!view || !view.fileItems) return null;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;

    const chain = [];
    for (let parent = file.parent; parent && parent.path && parent.path !== "/"; parent = parent.parent) {
      chain.unshift(parent);
    }
    for (const folder of chain) {
      const item = view.fileItems[folder.path];
      if (item && item.collapsed) return item;
    }
    return view.fileItems[path] || null;
  }

  showInExplorer(candidates) {
    if (!this.settings.showInExplorer) return;

    for (const id of candidates) {
      if (id.startsWith("#")) continue; // tags have no row
      const item = this.explorerTargetFor(id);
      const el = item && item.selfEl;
      if (!el) continue;
      if (el === this.explorerHoverEl) return;
      this.clearExplorerHover();
      el.addClass(EXPLORER_HOVER_CLASS);
      this.explorerHoverEl = el;
      return;
    }
    this.clearExplorerHover();
  }

  clearExplorerHover() {
    if (!this.explorerHoverEl) return;
    this.explorerHoverEl.removeClass(EXPLORER_HOVER_CLASS);
    this.explorerHoverEl = null;
  }

  watchFileExplorer() {
    const tree = this.fileTree();
    if (!tree || this.patchedTrees.has(tree)) return;

    this.patchedTrees.set(tree, watchTreeSelection(tree, () => this.scheduleSelectionSync()));
    this.scheduleSelectionSync();
  }

  unwatchFileExplorer() {
    for (const stop of this.patchedTrees.values()) stop();
    this.patchedTrees.clear();
  }

  /** A range select calls selectItem once per row, so coalesce. */
  scheduleSelectionSync() {
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => this.syncSelection(), 30);
  }

  syncSelection() {
    if (!this.settings.enabled || !this.settings.selectionFocus) {
      this.setBase(null);
      return;
    }
    const ids = this.selectedIds();
    this.setBase(ids.length ? ids : null);
  }

  /** Selected rows as graph node ids. A selected folder stands for its files. */
  selectedIds() {
    const tree = this.fileTree();
    if (!tree || !tree.selectedDoms) return [];

    const ids = [];
    for (const item of tree.selectedDoms) {
      const file = item && item.file;
      if (!file || !file.path) continue;
      if (file.children) ids.push(...this.folderMembers(file.path));
      else ids.push(file.path);
    }
    return [...new Set(ids)].sort();
  }

  setBase(ids) {
    if (sameIds(this.baseIds || [], ids || [])) return;
    this.baseIds = ids;
    if (ids && ids.length) this.startWatchdog();
    else this.stopWatchdog();
    if (!this.transientActive) this.applyBase();
  }

  /** Paint the selection, or nothing if there is none. */
  applyBase() {
    this.releaseFocus();
    this.baseRenderers = [];
    if (!this.baseIds || !this.baseIds.length) return;
    const { matched, painted } = this.applyToGraphs("isolate", this.baseIds);
    // Remember which graphs the selection could actually be painted into. A
    // graph holding none of the selected files can never take our marker, and
    // policing it would mean repainting every frame, forever.
    this.baseRenderers = painted;
    this.appliedMode = matched > 0 ? "base" : null;
    this.logEvent("applyBase", `matched=${matched} ids=${this.baseIds.length}`);
  }

  /* -------------------------------------------------- id resolution */

  /** Turn a hovered element into a hover intent. */
  intentFromElement(el) {
    const isTag =
      el.classList.contains("cm-hashtag") ||
      (el.classList.contains("tag") && el.tagName === "A");

    if (isTag) {
      const tag = this.readTagText(el);
      return tag ? { el, kind: "tag", text: tag } : null;
    }

    const linktext = this.readLinkText(el);
    if (linktext) {
      // Rows that declare a path are navigation, not content: see beginHover.
      const nav = !!(el.getAttribute && el.getAttribute("data-path"));
      // A folder row carries data-path just like a file row does, so ask the
      // vault which one this is rather than reading it off the markup.
      const entry = this.app.vault.getAbstractFileByPath(linktext);
      if (entry && entry.children) return { el, kind: "folder", text: linktext, nav };
      return { el, kind: "link", text: linktext, nav };
    }

    // No link markup: this is a value in a property or a Bases cell. What kind
    // of thing it names is decided at resolution time by asking the graph.
    const text = (el.textContent || "").trim();
    return text ? { el, kind: "value", text } : null;
  }

  /**
   * Candidate graph node ids for a hover intent, best guess first. Files are
   * keyed by vault path, tags by "#tag", unresolved links by the raw link text.
   */
  candidatesFor(intent) {
    if (!intent || !intent.text) return [];

    if (intent.kind === "tag") {
      const tag = intent.text.trim();
      if (!tag) return [];
      return [tag.startsWith("#") ? tag : "#" + tag];
    }

    if (intent.kind === "folder") {
      if (!this.settings.folderFocus) return [];
      return this.folderMembers(intent.text);
    }

    // The event channel already knows the source note; the DOM channel has to
    // work it out from where the element lives.
    const sourceOf = () =>
      intent.sourcePath != null ? intent.sourcePath : this.sourcePathFor(intent.el);
    const resolve = (text) =>
      this.app.metadataCache.getFirstLinkpathDest(text, sourceOf() || "");

    if (intent.kind === "value") {
      const text = intent.text.trim();
      // A cell that swallowed several chips, or a paragraph of prose, is not a
      // reference to anything.
      if (!text || text.length > 120 || text.includes("\n")) return [];
      if (text.startsWith("#")) return [text];

      const ids = [];
      const dest = resolve(text);
      if (dest && dest.path) ids.push(dest.path);
      // Bases strips the "#" off tags, and property pills never show it.
      ids.push("#" + text);
      ids.push(text);
      return ids;
    }

    // Strip the subpath and the alias: [[Note#Heading|Alias]] -> Note
    const path = intent.text.split("|")[0].split("#")[0].split("^")[0].trim();
    if (!path) return [];

    const dest = resolve(path);
    if (dest && dest.path) return [dest.path];

    // Unresolved link: the graph keys it by the link text as written.
    return [path, path + ".md"];
  }

  /**
   * The editor slices one link or tag into several sibling spans ("#" +
   * "name", or path + "|" + alias). Walk out to both ends of that run and join
   * the pieces back into the original source text.
   */
  joinSiblingRun(el, classes) {
    const belongs = (node) =>
      !!node &&
      !!node.classList &&
      classes.some((c) => node.classList.contains(c));

    let start = el;
    while (belongs(start.previousElementSibling)) {
      start = start.previousElementSibling;
    }
    let text = "";
    let node = start;
    while (belongs(node)) {
      text += node.textContent || "";
      node = node.nextElementSibling;
    }
    return text.trim();
  }

  readTagText(el) {
    const href = el.getAttribute && el.getAttribute("href");
    if (href && href.startsWith("#")) return decodeURIComponent(href);

    if (el.classList.contains("cm-hashtag")) {
      return this.joinSiblingRun(el, TAG_RUN_CLASSES);
    }
    return (el.textContent || "").trim();
  }

  /**
   * Link text for the hovered element, or "" if it carries no link markup.
   * Reading view hands it over on data-href, embeds on src, file explorer and
   * bookmark rows on data-path; in the editor we reassemble it from the sibling
   * run and let the caller strip the alias.
   */
  readLinkText(el) {
    const attr = (name) => (el.getAttribute ? el.getAttribute(name) : null);
    const explicit =
      attr("data-href") || attr("href") || attr("src") || attr("data-path");
    if (explicit) return explicit;

    if (LINK_RUN_CLASSES.some((c) => el.classList.contains(c))) {
      return this.joinSiblingRun(el, LINK_RUN_CLASSES);
    }
    return "";
  }

  /**
   * Every file inside a folder, as vault paths. Depth 1 is the folder's own
   * files, depth 2 adds one level of subfolders, and 0 means every level.
   * Sorted, so that two hovers over the same folder compare equal.
   */
  folderMembers(folderPath) {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !folder.children) return [];

    const configured = Number(this.settings.folderDepth);
    const maxDepth = configured > 0 ? configured : Infinity;
    const paths = [];

    const walk = (dir, depth) => {
      for (const child of dir.children) {
        if (child.children) {
          if (depth < maxDepth) walk(child, depth + 1);
        } else if (child.path) {
          paths.push(child.path);
        }
      }
    };
    walk(folder, 1);
    return paths.sort();
  }

  /** The note the hovered element lives in -- needed to resolve relative links. */
  sourcePathFor(el) {
    let path = "";
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (path) return;
      const container = leaf && leaf.containerEl;
      if (container && container.contains(el)) {
        const file = leaf.view && leaf.view.file;
        if (file && file.path) path = file.path;
      }
    });
    if (path) return path;
    const active = this.app.workspace.getActiveFile();
    return active ? active.path : "";
  }

  /* -------------------------------------------------- graph writing */

  targetRenderers() {
    const types = [];
    if (this.settings.globalGraph) types.push("graph");
    if (this.settings.localGraph) types.push("localgraph");

    const renderers = [];
    for (const type of types) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const renderer = leaf.view && leaf.view.renderer;
        if (renderer && renderer.nodeLookup) renderers.push(renderer);
      }
    }
    return renderers;
  }

  findNode(renderer, candidates) {
    const lookup = renderer.nodeLookup;
    for (const id of candidates) {
      if (lookup[id]) return lookup[id];
    }
    // Tags and filenames can differ in case from what the graph indexed.
    for (const id of candidates) {
      const wanted = id.toLowerCase();
      for (const key of Object.keys(lookup)) {
        if (key.toLowerCase() === wanted) return lookup[key];
      }
    }
    return null;
  }

  /**
   * Highlight one node the way hovering it in the graph would -- and, if a
   * selection is live, keep that visible alongside it.
   *
   * The exemption test reads the id of whatever occupies the slot, so it is not
   * specific to the marker: with a real node in the slot, writing THAT node's id
   * into the selection's link maps exempts them from the fade. The hovered node
   * still gets its highlight fill, its ring and its coloured edges, and the
   * selection stays in the foreground underneath.
   */
  focusNode(renderer, candidates, alsoKeep) {
    const node = this.findNode(renderer, candidates);
    if (!node) return null;

    const members = [];
    if (alsoKeep) {
      for (const id of alsoKeep) {
        const other = renderer.nodeLookup[id];
        if (!other || other === node) continue;
        if (exemptNode(other, node.id)) members.push(other);
      }
    }

    // See the note at the top of this feature: the render loop drops the
    // highlight if the cursor is not on the node, unless mouseX/Y are null.
    renderer.mouseX = null;
    renderer.mouseY = null;
    renderer.highlightNode = node;
    renderer.changed();
    return { node, members: members.length ? members : null, key: node.id };
  }

  /**
   * The marker is kept here rather than on the renderer. A graph view outlives
   * a plugin reload, so a marker parked on it would be inherited by the next
   * version of this code -- including the version's idea of how big it is.
   */
  markerFor(renderer) {
    let marker = this.markers.get(renderer);
    if (!marker) {
      marker = makeFolderMarker();
      this.markers.set(renderer, marker);
    }
    return marker;
  }

  /** Fade everything that is not one of these nodes. */
  isolateNodes(renderer, ids) {
    const marker = this.markerFor(renderer);
    const members = [];
    for (const id of ids) {
      const node = renderer.nodeLookup[id];
      if (node && exemptNode(node, FOLDER_MARKER_ID)) members.push(node);
    }
    if (!members.length) return null;

    renderer.mouseX = null;
    renderer.mouseY = null;
    renderer.highlightNode = marker;
    renderer.changed();
    return { node: marker, members, key: FOLDER_MARKER_ID };
  }

  /**
   * Write one focus to every eligible graph. "isolate" fades everything that is
   * not in the set; "single" is the native one-node highlight, which keeps the
   * node's neighbours bright.
   */
  applyToGraphs(mode, ids, alsoKeep) {
    let matched = 0;
    const painted = [];
    const renderers = this.targetRenderers();
    for (const renderer of renderers) {
      const entry =
        mode === "isolate"
          ? this.isolateNodes(renderer, ids)
          : this.focusNode(renderer, ids, alsoKeep);
      if (!entry) continue;

      this.watchRenderer(renderer);
      this.activeRenderers.set(renderer, entry);
      painted.push(renderer);
      matched++;
    }
    return { matched, renderers: renderers.length, painted };
  }

  highlightFor(intent) {
    const el = intent.el;
    if (el && el.isConnected === false) return;

    const candidates = intent.candidates || this.candidatesFor(intent);
    this.lastLookup = { candidates, matched: 0, renderers: 0 };
    if (!candidates.length) {
      this.clearHighlight();
      return;
    }

    this.releaseFocus();
    const mode = intent.kind === "folder" ? "isolate" : "single";
    // A single-node hover can sit on top of the selection instead of replacing
    // it: the selection keeps its foreground, the hovered node adds its own
    // connections on top.
    const alsoKeep =
      mode === "single" && this.settings.hoverAddsToSelection ? this.baseIds : null;
    const { matched, renderers } = this.applyToGraphs(mode, candidates, alsoKeep);
    this.logEvent("hover.apply", `kind=${intent.kind} matched=${matched} text=${intent.text}`);
    this.transientActive = matched > 0;
    this.appliedMode = matched > 0 ? "transient" : null;
    // Only a hover that did NOT come from the graph takes the peek flag down.
    // A graph-sourced one must keep it, because the renderer's unhover is the
    // only signal that will ever end it.
    if (matched > 0 && !this.transientFromGraph) this.graphPeek = false;

    // A hover that matched nothing should reveal the selection again rather
    // than leave the graph unfocused.
    if (!matched) this.applyBase();

    this.lastLookup.matched = matched;
    this.lastLookup.renderers = renderers;

    this.clearFilterHint();
    if (matched > 0 && this.settings.glowSourceLink && this.wantsOutline(el)) {
      this.setGlow(el);
    } else {
      this.setGlow(null);
    }

    // Resolved to something real, but the graph has no node for it: almost
    // always a graph filter hiding it, so point at the controls rather than
    // silently doing nothing.
    if (!matched && this.shouldHintFilter(intent, candidates)) this.hintGraphFilter();

    // Hovering in the graph points back at the explorer. Only from the graph:
    // in a note the link is already under the cursor, and tinting the sidebar
    // for every link you pass over is the sort of redundant feedback that makes
    // this feel busy.
    if (intent.fromGraph) this.showInExplorer(candidates);
    else this.clearExplorerHover();
    if (this.settings.debug) {
      console.log("[Claude Lab] graph hover", {
        kind: intent.kind,
        text: intent.text,
        candidates,
        renderers,
        matched,
      });
    }
  }

  /**
   * Undo whatever focus is currently painted, without deciding what comes
   * next. Callers either paint something else immediately or fall back to the
   * base layer.
   */
  releaseRenderer(renderer, entry) {
    try {
      // The exemptions are ours alone, so they always come back out.
      if (entry.members) {
        for (const node of entry.members) unexemptNode(node, entry.key);
      }
      // The highlight slot is shared, so only undo it if it is still ours.
      if (renderer.highlightNode === entry.node) {
        renderer.highlightNode = null;
        renderer.changed();
      } else if (entry.members) {
        renderer.changed();
      }
    } catch (err) {
      if (this.settings.debug) console.error("[Claude Lab] clear failed", err);
    }
  }

  releaseFocus() {
    if (this.activeRenderers.size) {
      this.logEvent("releaseFocus", `renderers=${this.activeRenderers.size}`);
    }
    for (const [renderer, entry] of this.activeRenderers) {
      this.releaseRenderer(renderer, entry);
    }
    this.activeRenderers.clear();
    this.appliedMode = null;
  }

  /** End a hover: drop the transient layer and fall back to the selection. */
  clearHighlight() {
    this.clearFilterHint();
    this.clearExplorerHover();
    this.logEvent(
      "clearHighlight",
      `mode=${this.appliedMode || "none"} peek=${this.graphPeek ? 1 : 0}`
    );
    this.setGlow(null);
    this.transientActive = false;
    // If the selection is already what is painted, leave it alone. Tearing it
    // down and rebuilding it on every stray pointer move is visible as a blink.
    if (this.appliedMode === "base" && !this.graphPeek) return;
    this.releaseFocus();
    this.applyBase();
  }

  /* -------------------------------------------------- graph rebuilds
   *
   * setData replaces every node object, which throws away the exemption keys
   * we injected. A hover could shrug that off; a selection cannot, so the
   * focus is repainted from the layers we still hold.
   */

  watchRenderer(renderer) {
    this.wrapNodeHover(renderer);

    if (this.patchedRenderers.has(renderer)) return;
    if (typeof renderer.setData !== "function") return;

    const self = this;
    const original = renderer.setData;
    renderer.setData = function (...args) {
      // setData reads every node's link maps to seed positions and to compute
      // node weight -- which is node size. Our exemptions are fake links, so
      // they have to be out of the way before it looks.
      //
      // Both halves are guarded: this wrapper sits inside Obsidian's own
      // rebuild, and a throw of ours must never stop the graph updating.
      try {
        const entry = self.activeRenderers.get(this);
        if (entry) {
          self.releaseRenderer(this, entry);
          self.activeRenderers.delete(this);
        }
      } catch (err) {
        console.error("[Claude Lab] failed to release before a rebuild", err);
      }
      const result = original.apply(this, args);
      try {
        self.onGraphRebuilt(this);
      } catch (err) {
        console.error("[Claude Lab] failed to repaint after a rebuild", err);
      }
      return result;
    };
    renderer.claudeLabSetData = original;
    this.patchedRenderers.add(renderer);
  }

  /*
   * Hovering a node in the graph is the renderer's own gesture: it writes the
   * node into the slot itself, evicting our marker, and writes null back when
   * the pointer leaves -- which would strand the graph unfocused. onNodeHover /
   * onNodeUnhover are the renderer's designed callbacks for exactly this, so we
   * chain onto them rather than patching internals, and treat a node hover as
   * one more transient peek that pops back to the selection.
   */
  wrapNodeHover(renderer) {
    const self = this;
    const chain = (name, after) => {
      const current = renderer[name];
      if (current && current.claudeLab) return; // already ours
      const wrapper = function (...args) {
        // Ours runs FIRST. The view's own onNodeHover triggers the workspace
        // "hover-link" event, which comes straight back to us through the other
        // channel -- and it has to find graphPeek already set, or the two
        // channels do not recognise each other as one gesture.
        try {
          after();
        } catch (err) {
          console.error("[Claude Lab] node hover handler failed", err);
        }
        if (current) current.apply(this, args);
      };
      wrapper.claudeLab = true;
      wrapper.claudeLabOriginal = current || null;
      renderer[name] = wrapper;
    };
    chain("onNodeHover", () => self.onGraphNodeHover(renderer));
    chain("onNodeUnhover", () => self.onGraphNodeUnhover());
    this.hoverWrappedRenderers.add(renderer);
  }

  /**
   * The renderer has already painted its own highlight and taken the slot. Give
   * the selection the same treatment a hover from a note gets: exempt it using
   * the id of the node now occupying the slot, so it stays in the foreground
   * alongside the hovered node and its connections.
   */
  onGraphNodeHover(renderer) {
    this.logEvent(
      "graph.nodeHover",
      `node=${renderer.highlightNode ? renderer.highlightNode.id : "?"}`
    );
    this.graphPeek = true;
    this.appliedMode = null;

    const entry = this.activeRenderers.get(renderer);
    if (entry) {
      this.releaseRenderer(renderer, entry);
      this.activeRenderers.delete(renderer);
    }

    const node = renderer.highlightNode;
    if (!node || !node.id) return;
    if (!this.settings.hoverAddsToSelection) return;
    if (!this.baseIds || !this.baseIds.length) return;

    const members = [];
    for (const id of this.baseIds) {
      const other = renderer.nodeLookup && renderer.nodeLookup[id];
      if (!other || other === node) continue;
      if (exemptNode(other, node.id)) members.push(other);
    }
    if (!members.length) return;

    this.activeRenderers.set(renderer, { node, members, key: node.id });
    renderer.changed();
  }

  onGraphNodeUnhover() {
    this.logEvent(
      "graph.nodeUnhover",
      `peek=${this.graphPeek ? 1 : 0} hover=${this.transientActive ? 1 : 0}`
    );
    if (!this.graphPeek && !this.transientFromGraph) return;

    // The renderer's unhover ends the whole gesture, including the transient
    // that arrived through the event channel and any hover still counting down.
    window.clearTimeout(this.enterTimer);
    window.clearTimeout(this.leaveTimer);
    this.pending = false;
    this.graphPeek = false;
    this.transientFromGraph = false;
    this.transientActive = false;
    this.hoverEl = null;
    this.hoverIntent = null;
    this.setGlow(null);
    this.clearExplorerHover();
    this.releaseFocus();
    this.applyBase();
  }

  /**
   * Cheap enough to run on every mouse move: it only looks at the renderers we
   * have already written to. If one of them is holding nothing, and a selection
   * should be showing, paint it again. A slot held by someone else -- the
   * graph's own node hover, or another plugin -- is left alone.
   */
  /**
   * Police exactly the graphs the selection was painted into. Not the tracked
   * map -- a graph hover pulls renderers out of that, which is how a graph
   * could stop being watched entirely. And not every open graph either: one
   * that holds none of the selected files can never take the marker, so
   * watching it would mean repainting on every single frame.
   */
  reassertBase() {
    if (!this.baseIds || !this.baseIds.length) return;
    if (!this.baseRenderers || !this.baseRenderers.length) return;

    // Is anything we painted still on screen anywhere?
    let showing = false;
    for (const [renderer, entry] of this.activeRenderers) {
      if (renderer.highlightNode === entry.node) {
        showing = true;
        break;
      }
    }

    // A graph that should be holding the selection but is holding nothing.
    // Anything else in the slot is either ours or on loan, so hands off.
    let empty = null;
    for (const renderer of this.baseRenderers) {
      if (!renderer.highlightNode) {
        empty = renderer;
        break;
      }
    }
    if (!empty) return;

    // Nothing of ours anywhere, yet a hover claims to be running: it is a
    // ghost. That is precisely what a graph hover used to leave behind, since
    // the canvas is one element and never sends a mouseout to tidy up.
    if (!showing && (this.transientActive || this.pending)) {
      this.logEvent("reassert", "stale hover discarded");
      window.clearTimeout(this.enterTimer);
      this.transientActive = false;
      this.transientFromGraph = false;
      this.pending = false;
      this.hoverEl = null;
      this.hoverIntent = null;
    }

    // A hover that IS showing somewhere still owns the foreground.
    if (this.transientActive) return;

    this.logEvent("reassert", "slot was empty");
    this.graphPeek = false;
    this.applyBase();
  }

  /*
   * The renderer empties the slot from several places, some of them after the
   * pointer has already stopped moving -- at which point no input event is
   * coming to prompt a repair, and the graph sits undimmed. Rather than chase
   * each path, the invariant is checked once a frame while a selection is held:
   * cheap (a couple of comparisons over the renderers we already wrote to), and
   * it cannot be outflanked by a path we have not thought of.
   */
  startWatchdog() {
    if (this.watchdogId != null) return;
    if (typeof window.requestAnimationFrame !== "function") return;

    const step = () => {
      this.watchdogId = null;
      if (!this.baseIds || !this.baseIds.length) return; // nothing to hold
      this.reassertBase();
      this.watchdogId = window.requestAnimationFrame(step);
    };
    this.watchdogId = window.requestAnimationFrame(step);
  }

  stopWatchdog() {
    if (this.watchdogId == null) return;
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(this.watchdogId);
    }
    this.watchdogId = null;
  }

  unwatchRenderers() {
    for (const renderer of this.patchedRenderers) {
      const original = renderer.claudeLabSetData;
      if (original) renderer.setData = original;
      delete renderer.claudeLabSetData;
    }
    this.patchedRenderers.clear();

    for (const renderer of this.hoverWrappedRenderers) {
      for (const name of ["onNodeHover", "onNodeUnhover"]) {
        const current = renderer[name];
        if (current && current.claudeLab) renderer[name] = current.claudeLabOriginal;
      }
    }
    this.hoverWrappedRenderers.clear();
  }

  onGraphRebuilt(renderer) {
    // The entry we held refers to nodes that no longer exist.
    this.activeRenderers.delete(renderer);
    if (this.transientActive && this.hoverIntent) {
      const ids = this.hoverIntent.candidates || this.candidatesFor(this.hoverIntent);
      const mode = this.hoverIntent.kind === "folder" ? "isolate" : "single";
      this.applyToGraphs(mode, ids);
    } else {
      this.applyBase();
    }
  }

  /** Only where Obsidian gives no hover feedback of its own. */
  wantsOutline(el) {
    return !!(el && typeof el.closest === "function" && el.closest(OUTLINE_SELECTOR));
  }

  /*
   * A hover that names a real file, tag or folder, in a graph that shows no
   * node for it. The node exists in the vault but not on screen, which means a
   * filter is hiding it -- so nudge the graph's controls. A hover that names
   * nothing real gets no nudge: there would be nothing to go and unhide.
   */
  shouldHintFilter(intent, candidates) {
    if (!this.settings.filterHint || !candidates.length) return false;
    if (intent.kind === "folder") return true; // it has members; none are shown

    for (const id of candidates) {
      if (id.startsWith("#")) return true; // a tag, and tags can be switched off
      const entry = this.app.vault.getAbstractFileByPath(id);
      if (entry && !entry.children) return true;
    }
    return false;
  }

  hintGraphFilter() {
    const types = [];
    if (this.settings.globalGraph) types.push("graph");
    if (this.settings.localGraph) types.push("localgraph");

    for (const type of types) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const container = leaf.view && leaf.view.containerEl;
        const controls = container && container.querySelector(CONTROLS_SELECTOR);
        if (!controls) continue;
        const target = controls.querySelector(".graph-controls-button") || controls;
        target.addClass(FILTER_HINT_CLASS);
        this.hintedControls.add(target);
      }
    }
    if (!this.hintedControls.size) return;
    window.clearTimeout(this.filterHintTimer);
    this.filterHintTimer = window.setTimeout(() => this.clearFilterHint(), 1600);
  }

  clearFilterHint() {
    if (!this.hintedControls.size) return;
    window.clearTimeout(this.filterHintTimer);
    for (const el of this.hintedControls) el.removeClass(FILTER_HINT_CLASS);
    this.hintedControls.clear();
  }

  setGlow(el) {
    if (this.glowEl === el) return;
    if (this.glowEl) this.glowEl.removeClass("claude-lab-graph-linked");
    this.glowEl = el;
    if (el) el.addClass("claude-lab-graph-linked");
  }

  cancelAll() {
    window.clearTimeout(this.enterTimer);
    window.clearTimeout(this.leaveTimer);
    this.pending = false;
    this.hoverEl = null;
    this.hoverIntent = null;
    this.transientActive = false;
    this.releaseFocus();
    this.setGlow(null);
    this.clearFilterHint();
    this.clearExplorerHover();
    // Cancelling a hover does not cancel a selection.
    if (this.settings.enabled) this.applyBase();
  }

  /**
   * Drop links the renderer can no longer reach. A healthy link is always
   * findable as source.forward[target.id]; one that is not has been orphaned,
   * and will keep drawing and keep being sent to the layout worker for as long
   * as the graph view lives, immune to searches and rebuilds. Earlier versions
   * of this plugin created exactly that by writing a flag over a link object.
   */
  repairLinks(renderer) {
    const links = renderer.links;
    if (!Array.isArray(links)) return 0;

    const orphans = links.filter((link) => {
      if (!link || !link.source || !link.target) return true;
      const forward = link.source.forward;
      return !forward || forward[link.target.id] !== link;
    });

    for (const link of orphans) {
      try {
        if (link && typeof link.clearGraphics === "function") link.clearGraphics();
      } catch (err) {
        if (this.settings.debug) console.error("[Claude Lab] clearGraphics failed", err);
      }
      const i = links.indexOf(link);
      if (i >= 0) links.splice(i, 1);
      if (link && link.target && link.target.reverse && link.source) {
        if (link.target.reverse[link.source.id] === link) delete link.target.reverse[link.source.id];
      }
    }
    if (orphans.length) renderer.changed();
    return orphans.length;
  }

  /* -------------------------------------------------- recording
   *
   * A snapshot command is useless for a bug that only exists while the pointer
   * is inside the graph: reaching for the palette ends the very state you are
   * trying to look at. This samples every frame instead, and marks every state
   * transition, so the recording shows what happens between the events rather
   * than what is left over afterwards.
   */

  startRecording(seconds) {
    this.stopRecording(true);
    this.log = [];
    this.recording = true;
    this.recordStart = Date.now();
    this.lastSample = "";
    this.logEvent("recording started");

    const limit = (seconds || 30) * 1000;
    const step = () => {
      this.recordId = null;
      if (!this.recording) return;
      this.sampleState();
      if (Date.now() - this.recordStart > limit) {
        this.saveRecording();
        return;
      }
      this.recordId = window.requestAnimationFrame(step);
    };
    this.recordId = window.requestAnimationFrame(step);
    new Notice(
      `Claude Lab: recording ${seconds || 30}s. Reproduce it now — hover a node, move off it, wait, then leave the graph.`,
      6000
    );
  }

  stopRecording(quiet) {
    this.recording = false;
    if (this.recordId != null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(this.recordId);
    }
    this.recordId = null;
    if (!quiet) this.saveRecording();
  }

  elapsed() {
    return String(Date.now() - this.recordStart).padStart(6, " ");
  }

  logEvent(name, detail) {
    if (!this.recording) return;
    this.log.push(`${this.elapsed()}  EVENT  ${name}${detail ? " " + detail : ""}`);
  }

  /** One line per frame, but only when something changed. */
  sampleState() {
    const parts = [];
    this.targetRenderers().forEach((renderer, i) => {
      const entry = this.activeRenderers.get(renderer);
      const marker = this.markers.get(renderer);
      const held = renderer.highlightNode;
      const slot = !held ? "EMPTY" : held === marker ? "MARKER" : `node:${held.id}`;

      let exempt = 0;
      if (entry && entry.members) {
        for (const node of entry.members) {
          if (Object.prototype.hasOwnProperty.call(node.reverse, entry.key)) exempt++;
        }
      }
      const sample =
        renderer.nodes && renderer.nodes.find
          ? renderer.nodes.find(
              (n) =>
                n.forward &&
                !Object.prototype.hasOwnProperty.call(n.reverse, entry ? entry.key : "__no_focus__")
            )
          : null;
      const fade =
        sample && typeof sample.fadeAlpha === "number" ? sample.fadeAlpha.toFixed(2) : "?";

      parts.push(
        `g${i} slot=${slot} mouse=${renderer.mouseX === null ? "null" : "set"}` +
          ` idle=${renderer.idleFrames} fade=${fade} exempt=${exempt}` +
          ` drag=${renderer.dragNode ? "yes" : "no"}`
      );
    });

    parts.push(
      `| mode=${this.appliedMode || "none"} hover=${this.transientActive ? 1 : 0}` +
        ` peek=${this.graphPeek ? 1 : 0} wd=${this.watchdogId != null ? 1 : 0}` +
        ` base=${this.baseIds ? this.baseIds.length : 0}` +
        ` painted=${this.baseRenderers ? this.baseRenderers.length : 0}`
    );

    const line = parts.join("  ");
    if (line === this.lastSample) return;
    this.lastSample = line;
    this.log.push(`${this.elapsed()}  ${line}`);
  }

  async saveRecording() {
    this.recording = false;
    if (this.recordId != null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(this.recordId);
      this.recordId = null;
    }
    const body =
      "```\n" +
      "Claude Lab graph focus recording\n" +
      "state lines are emitted only when something changed\n\n" +
      (this.log || []).join("\n") +
      "\n```\n";
    const path = "Claude Lab log.md";
    try {
      await this.app.vault.adapter.write(path, body);
      new Notice(`Claude Lab: saved ${this.log.length} lines to "${path}"`, 8000);
    } catch (err) {
      console.error("[Claude Lab] could not save log", err);
      new Notice("Claude Lab: could not write the log, dumped to console instead", 8000);
    }
    console.log(body);
  }

  /* -------------------------------------------------- diagnostics */

  diagnose() {
    const lines = [];
    for (const type of ["graph", "localgraph"]) {
      const leaves = this.app.workspace.getLeavesOfType(type);
      if (!leaves.length) {
        lines.push(`${type}: no view open`);
        continue;
      }
      leaves.forEach((leaf, i) => {
        const renderer = leaf.view && leaf.view.renderer;
        if (!renderer) {
          lines.push(`${type}[${i}]: no renderer (Obsidian internals changed?)`);
          return;
        }
        if (!renderer.nodeLookup) {
          lines.push(`${type}[${i}]: renderer has no nodeLookup`);
          return;
        }
        const count = Object.keys(renderer.nodeLookup).length;
        const tags = Object.keys(renderer.nodeLookup).filter((k) =>
          k.startsWith("#")
        ).length;

        const held = renderer.highlightNode;
        const marker = this.markers.get(renderer);
        const slot = !held
          ? "EMPTY"
          : held === marker
          ? "ours (focus marker)"
          : `node "${held.id}"`;

        // How many of the selected nodes are actually exempt right now: this is
        // what decides whether the fade looks right.
        let exempt = 0;
        const entry = this.activeRenderers.get(renderer);
        if (entry && entry.members) {
          for (const node of entry.members) {
            if (Object.prototype.hasOwnProperty.call(node.reverse, entry.key)) exempt++;
          }
        }
        const wired =
          renderer.onNodeHover && renderer.onNodeHover.claudeLab ? "ours" : "NOT ours";

        // idleFrames > 60 means the renderer has stopped drawing entirely, so a
        // focus written into it would sit there invisible until something wakes
        // it. fadeAlpha on a node that should be dim says whether the fade
        // actually ran.
        const sample = renderer.nodes && renderer.nodes.find
          ? renderer.nodes.find(
              (n) => n.forward && !Object.prototype.hasOwnProperty.call(n.reverse, entry ? entry.key : "__no_focus__")
            )
          : null;
        const faded = sample && typeof sample.fadeAlpha === "number"
          ? sample.fadeAlpha.toFixed(2)
          : "?";

        lines.push(
          `${type}[${i}]: ${count} nodes (${tags} tags)\n` +
            `  slot: ${slot}\n` +
            `  exempt: ${exempt}, mouse: ${renderer.mouseX === null ? "null" : "set"}, callbacks: ${wired}\n` +
            `  idleFrames: ${renderer.idleFrames}, drawing: ${
              renderer.renderCallback ? "yes" : "NO"
            }, sample fadeAlpha: ${faded}`
        );
      });
    }
    const tree = this.fileTree();
    if (!tree) lines.push("file explorer: not open");
    else {
      lines.push(
        `selection: ${tree.selectedDoms ? tree.selectedDoms.size : 0} rows -> ${
          this.baseIds ? this.baseIds.length : 0
        } nodes`
      );
      lines.push(
        `state: painted=${this.appliedMode || "none"}, hover=${
          this.transientActive ? "on" : "off"
        }, graphHover=${this.graphPeek ? "on" : "off"}, watchdog=${
          this.watchdogId != null ? "running" : "stopped"
        }`
      );
    }
    if (this.lastLookup) {
      const ids = this.lastLookup.candidates;
      const shown =
        ids.length > 3
          ? `${ids.length} paths (${ids.slice(0, 3).join(", ")}, ...)`
          : `[${ids.join(", ")}]`;
      lines.push(
        `last hover: ${shown} -> matched ${this.lastLookup.matched}/${this.lastLookup.renderers} graphs`
      );
    } else {
      lines.push("last hover: nothing hovered yet");
    }
    const report = lines.join("\n");
    console.log("[Claude Lab] diagnose\n" + report);
    new Notice(report, 10000);
  }

  /* -------------------------------------------------- settings UI */

  displaySettings(containerEl) {
    const s = this.settings;
    const bind = (key, extra) => async (value) => {
      s[key] = value;
      await this.saveSettings();
      if (extra) extra(value);
    };

    new Setting(containerEl)
      .setName("Enabled")
      .setDesc(
        "Hovering an internal link or a tag highlights the matching node in open graph views, exactly as if you had hovered that node in the graph."
      )
      .addToggle((t) =>
        t.setValue(s.enabled).onChange(
          bind("enabled", (v) => {
            if (!v) this.cancelAll();
          })
        )
      );

    new Setting(containerEl)
      .setName("Highlight in the global graph")
      .addToggle((t) =>
        t.setValue(s.globalGraph).onChange(bind("globalGraph", () => this.cancelAll()))
      );

    new Setting(containerEl)
      .setName("Highlight in local graphs")
      .addToggle((t) =>
        t.setValue(s.localGraph).onChange(bind("localGraph", () => this.cancelAll()))
      );

    new Setting(containerEl)
      .setName("React to internal links")
      .addToggle((t) => t.setValue(s.reactToLinks).onChange(bind("reactToLinks")));

    new Setting(containerEl)
      .setName("React to tags")
      .setDesc(
        'Tags only appear in the graph when "Tags" is switched on in the graph view filters.'
      )
      .addToggle((t) => t.setValue(s.reactToTags).onChange(bind("reactToTags")));

    new Setting(containerEl)
      .setName("Follow the file explorer selection")
      .setDesc(
        "Files selected in the file explorer stay in the foreground while the rest of the graph recedes. The selection persists — hovering something else is a temporary peek that returns to it."
      )
      .addToggle((t) =>
        t.setValue(s.selectionFocus).onChange(
          bind("selectionFocus", () => {
            this.cancelAll();
            this.syncSelection();
          })
        )
      );

    new Setting(containerEl)
      .setName("Hover adds to the selection")
      .setDesc(
        "With a selection active, hovering a link or tag keeps the selection in the foreground and adds the hovered node and its connections on top, rather than replacing it."
      )
      .addToggle((t) =>
        t.setValue(s.hoverAddsToSelection).onChange(bind("hoverAddsToSelection", () => this.cancelAll()))
      );

    new Setting(containerEl)
      .setName("Fade the rest when hovering a folder")
      .setDesc(
        "Hovering a folder in the file explorer keeps everything inside it in the foreground and lets the rest of the graph recede, so you can see where folder structure and link structure agree."
      )
      .addToggle((t) =>
        t.setValue(s.folderFocus).onChange(bind("folderFocus", () => this.cancelAll()))
      );

    new Setting(containerEl)
      .setName("Folder depth")
      .setDesc(
        "How many levels of subfolders count as inside the folder. 0 means every level, 1 means only the folder's own files."
      )
      .addText((t) =>
        t
          .setPlaceholder("0")
          .setValue(String(s.folderDepth))
          .onChange(async (value) => {
            const num = Number(value);
            if (!Number.isNaN(num) && num >= 0) {
              s.folderDepth = num;
              await this.saveSettings();
              this.cancelAll();
            }
          })
      );

    new Setting(containerEl)
      .setName("Match values in properties and Bases")
      .setDesc(
        "Inside the properties block and Bases views, any hovered value is checked against the graph — tags written without a hash, link pills, and plain text that names a note or tag. Values that name nothing do nothing."
      )
      .addToggle((t) =>
        t.setValue(s.matchDataValues).onChange(bind("matchDataValues", () => this.cancelAll()))
      );

    new Setting(containerEl)
      .setName("Only inside notes")
      .setDesc(
        "Confines the feature to note bodies and their properties. When off, links anywhere else highlight the graph too: Bases, search, backlinks, outgoing links, the file explorer and tab headers."
      )
      .addToggle((t) =>
        t.setValue(s.onlyInNotes).onChange(bind("onlyInNotes", () => this.cancelAll()))
      );

    new Setting(containerEl)
      .setName("Outline embeds and Bases rows")
      .setDesc(
        "Draws a thin outline around the hovered embed or Bases value, so you can see which row the graph is answering. Not applied to links and tags — Obsidian already gives those their own hover feedback."
      )
      .addToggle((t) =>
        t.setValue(s.glowSourceLink).onChange(
          bind("glowSourceLink", (v) => {
            if (!v) this.setGlow(null);
          })
        )
      );

    new Setting(containerEl)
      .setName("Show the hovered node in the file explorer")
      .setDesc(
        "Hovering a node in the graph tints its row in the file explorer. Nothing is expanded — if the row sits inside a collapsed folder, the folder you would open is tinted instead."
      )
      .addToggle((t) =>
        t.setValue(s.showInExplorer).onChange(
          bind("showInExplorer", (v) => {
            if (!v) this.clearExplorerHover();
          })
        )
      );

    new Setting(containerEl)
      .setName("Nudge the graph controls for hidden nodes")
      .setDesc(
        "When a hover names a real file, tag or folder that the graph is not showing, the graph's control cluster is briefly outlined — the node almost certainly exists but is hidden by a filter."
      )
      .addToggle((t) =>
        t.setValue(s.filterHint).onChange(
          bind("filterHint", (v) => {
            if (!v) this.clearFilterHint();
          })
        )
      );

    new Setting(containerEl)
      .setName("Hover delay (ms)")
      .setDesc("How long the cursor must rest on a link before the graph reacts.")
      .addText((t) =>
        t
          .setPlaceholder(String(GRAPH_HOVER_DEFAULTS.hoverDelayMs))
          .setValue(String(s.hoverDelayMs))
          .onChange(async (value) => {
            const num = Number(value);
            if (!Number.isNaN(num) && num >= 0) {
              s.hoverDelayMs = num;
              await this.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Linger (ms)")
      .setDesc(
        "How long the highlight stays after the cursor leaves. A little linger stops flicker when crossing between links."
      )
      .addText((t) =>
        t
          .setPlaceholder(String(GRAPH_HOVER_DEFAULTS.lingerMs))
          .setValue(String(s.lingerMs))
          .onChange(async (value) => {
            const num = Number(value);
            if (!Number.isNaN(num) && num >= 0) {
              s.lingerMs = num;
              await this.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Logs every resolution attempt to the developer console.")
      .addToggle((t) => t.setValue(s.debug).onChange(bind("debug")));
  }
}

/* ------------------------------------------------------------------ *
 * Feature: graph selection tools
 * ------------------------------------------------------------------ *
 *
 * Selecting in the graph, writing through to the file explorer:
 *
 *   [alt + click a node]  --\
 *                            >-- toggle / add / remove in the explorer's
 *   [shift + drag a lasso] --/    own selection  -->  the explorer repaints,
 *                                                     and graph focus follows
 *
 * Nothing here paints the graph. It only drives Obsidian's own tree, and the
 * focus feature notices the selection changed and repaints. One source of
 * truth, so right-click, drag, rename and delete all keep working.
 *
 * Modifier keys diverge from the explorer's out of necessity: ctrl is taken by
 * "open in new tab" everywhere in Obsidian, so alt does the toggling that ctrl
 * does in the explorer, and shift draws the lasso -- shift being the explorer's
 * key for "select a run of things" rather than "one thing".
 */

const SELECTION_TOOLS_DEFAULTS = {
  enabled: true,
  altClickToggle: true,
  lasso: true,
  contextMenu: true,
  revealSelection: false,
  folderHints: true,
};

/* A folder holding selected files, marked with the explorer's own hover tint
   rather than its selection colour -- so it reads as "something in here",
   never as "this is selected". */
const FOLDER_HINT_CLASS = "claude-lab-contains-selection";

/** Is a point inside the polygon? Standard ray cast. */
function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const straddles = yi > y !== yj > y;
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

class GraphSelectionTools extends Feature {
  static id = "graphSelectionTools";
  static displayName = "Graph selection tools";
  static defaults = SELECTION_TOOLS_DEFAULTS;

  constructor(plugin) {
    super(plugin);
    this.lasso = null;
    this.wrapped = new Set();
    this.watchedTrees = new Map();
    this.hinted = new Set();
    this.hintTimer = null;
  }

  onload() {
    this.app.workspace.onLayoutReady(() => {
      this.wrapRenderers();
      this.watchExplorer();
    });
    this.plugin.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.wrapRenderers();
        this.watchExplorer();
        this.refreshFolderHints();
      })
    );

    // Capture phase, and pointer events rather than mouse events: PIXI listens
    // for pointerdown on the canvas, and pointerdown fires before mousedown, so
    // this is the only place the gesture can be claimed before the graph starts
    // panning.
    this.plugin.registerDomEvent(
      document,
      "pointerdown",
      (evt) => this.onPointerDown(evt),
      { capture: true }
    );
    this.plugin.registerDomEvent(document, "pointermove", (evt) => this.onPointerMove(evt), {
      capture: true,
    });
    this.plugin.registerDomEvent(document, "pointerup", (evt) => this.onPointerUp(evt), {
      capture: true,
    });
    this.plugin.registerDomEvent(document, "keydown", (evt) => {
      if (evt.key === "Escape" && this.lasso) this.endLasso(true);
    });

    this.plugin.addCommand({
      id: "grow-graph-selection",
      name: "Grow selection along visible links",
      hotkeys: [{ modifiers: ["Alt"], key: "=" }],
      callback: () => this.growSelection(),
    });

    this.plugin.addCommand({
      id: "shrink-graph-selection",
      name: "Shrink selection from its edges",
      hotkeys: [{ modifiers: ["Alt"], key: "-" }],
      callback: () => this.shrinkSelection(),
    });

    this.plugin.addCommand({
      id: "select-connected-graph-selection",
      name: "Select everything connected to the selection",
      hotkeys: [{ modifiers: ["Alt"], key: "l" }],
      callback: () => this.selectConnected(),
    });

    this.plugin.addCommand({
      id: "clear-graph-selection",
      name: "Clear file selection",
      callback: () => {
        const tree = this.fileTree();
        if (tree && tree.clearSelectedDoms) tree.clearSelectedDoms();
      },
    });
  }

  onunload() {
    this.endLasso(true);
    window.clearTimeout(this.hintTimer);
    for (const stop of this.watchedTrees.values()) stop();
    this.watchedTrees.clear();
    this.clearFolderHints();
    for (const renderer of this.wrapped) {
      for (const name of ["onNodeClick", "onNodeRightClick"]) {
        const current = renderer[name];
        if (current && current.claudeLabTools) renderer[name] = current.claudeLabOriginal;
      }
    }
    this.wrapped.clear();
  }

  /* -------------------------------------------------- explorer access */

  explorerView() {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    return (leaf && leaf.view) || null;
  }

  fileTree() {
    const view = this.explorerView();
    return (view && view.tree) || null;
  }

  selectedPaths() {
    const tree = this.fileTree();
    if (!tree || !tree.selectedDoms) return new Set();
    const paths = new Set();
    for (const item of tree.selectedDoms) {
      const file = item && item.file;
      if (file && file.path) paths.add(file.path);
    }
    return paths;
  }

  /* -------------------------------------------------- folder hints
   *
   * Selecting a file inside a collapsed folder works -- the explorer builds a
   * row object for every file in the vault, whether or not it is on screen --
   * but nothing shows for it, so a lasso can look like it did nothing. Every
   * folder above a selected file therefore takes the explorer's own hover tint.
   * Deliberately the hover colour and not the selection colour: it means
   * "something in here", never "this is selected".
   */

  watchExplorer() {
    const tree = this.fileTree();
    if (!tree || this.watchedTrees.has(tree)) return;
    this.watchedTrees.set(tree, watchTreeSelection(tree, () => this.scheduleHints()));
    this.refreshFolderHints();
  }

  scheduleHints() {
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.refreshFolderHints(), 30);
  }

  /** Every folder above a selected file, at any depth. */
  foldersHoldingSelection() {
    const wanted = new Set();
    const tree = this.fileTree();
    if (!tree || !tree.selectedDoms) return wanted;

    for (const item of tree.selectedDoms) {
      const file = item && item.file;
      if (!file) continue;
      for (let parent = file.parent; parent && parent.path && parent.path !== "/"; parent = parent.parent) {
        // Ancestors above one we have already marked are marked too.
        if (wanted.has(parent.path)) break;
        wanted.add(parent.path);
      }
    }
    return wanted;
  }

  markFolder(path, on) {
    const view = this.explorerView();
    const item = view && view.fileItems && view.fileItems[path];
    const el = item && item.selfEl;
    if (!el) return;
    if (on) el.addClass(FOLDER_HINT_CLASS);
    else el.removeClass(FOLDER_HINT_CLASS);
  }

  refreshFolderHints() {
    if (!this.settings.enabled || !this.settings.folderHints) {
      this.clearFolderHints();
      return;
    }
    const wanted = this.foldersHoldingSelection();
    for (const path of this.hinted) {
      if (!wanted.has(path)) this.markFolder(path, false);
    }
    for (const path of wanted) this.markFolder(path, true);
    this.hinted = wanted;
  }

  clearFolderHints() {
    for (const path of this.hinted) this.markFolder(path, false);
    this.hinted = new Set();
  }

  /**
   * A row object exists for every file in the vault, so this normally returns
   * immediately without touching the fold state. Expanding is only a fallback
   * for a file the explorer somehow has no row for, and is off by default.
   */
  ensureItem(path) {
    const view = this.explorerView();
    if (!view || !view.fileItems) return null;
    if (view.fileItems[path]) return view.fileItems[path];
    if (!this.settings.revealSelection) return null;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;

    const chain = [];
    for (let parent = file.parent; parent && parent.path && parent.path !== "/"; parent = parent.parent) {
      chain.unshift(parent);
    }
    for (const folder of chain) {
      const item = view.fileItems[folder.path];
      if (item && item.collapsed && typeof item.toggleCollapsed === "function") {
        item.toggleCollapsed(false);
      }
    }
    return view.fileItems[path] || null;
  }

  select(paths) {
    const tree = this.fileTree();
    if (!tree) return 0;
    let n = 0;
    for (const path of paths) {
      const item = this.ensureItem(path);
      if (item && typeof tree.selectItem === "function") {
        tree.selectItem(item);
        n++;
      }
    }
    return n;
  }

  deselect(paths) {
    const tree = this.fileTree();
    if (!tree || !tree.selectedDoms) return 0;
    const wanted = new Set(paths);
    let n = 0;
    for (const item of [...tree.selectedDoms]) {
      const file = item && item.file;
      if (file && wanted.has(file.path) && typeof tree.deselectItem === "function") {
        tree.deselectItem(item);
        n++;
      }
    }
    return n;
  }

  /* -------------------------------------------------- topology selection
   *
   * Grow and shrink a selection along the graph's edges, the way a mesh editor
   * grows a vertex selection. Physical closeness in the layout is not adjacency
   * -- two nodes can sit on top of each other and share nothing -- so this is
   * the only way to select a cluster by what it actually connects to.
   *
   * "Visible" is taken strictly. Adjacency is read from renderer.links, which
   * is the graph AFTER its filters: tags off, a search query, orphans hidden,
   * all of it. That array is also the only safe source, since the per-node link
   * maps carry our own focus flags and walking those would follow edges that do
   * not exist.
   */

  /** The graph to reason about: one that knows about the current selection. */
  graphForSelection() {
    const renderers = [];
    for (const type of ["graph", "localgraph"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const renderer = leaf.view && leaf.view.renderer;
        if (renderer && renderer.nodeLookup) renderers.push(renderer);
      }
    }
    const selected = this.selectedPaths();
    for (const renderer of renderers) {
      for (const path of selected) {
        if (renderer.nodeLookup[path]) return renderer;
      }
    }
    return renderers[0] || null;
  }

  /** id -> Set of ids, built from the drawn links only. */
  visibleAdjacency(renderer) {
    const adjacency = new Map();
    const links = Array.isArray(renderer.links) ? renderer.links : [];
    const lookup = renderer.nodeLookup || {};

    for (const link of links) {
      const a = link && link.source && link.source.id;
      const b = link && link.target && link.target.id;
      if (!a || !b || a === b) continue;
      // Both ends have to still be part of the graph.
      if (!lookup[a] || !lookup[b]) continue;
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a).add(b);
      adjacency.get(b).add(a);
    }
    return adjacency;
  }

  /** Neighbours that are files, so they can actually be selected. */
  selectableNeighbours(adjacency, id) {
    const out = [];
    const neighbours = adjacency.get(id);
    if (!neighbours) return out;
    for (const other of neighbours) {
      if (this.fileFor(other)) out.push(other);
    }
    return out;
  }

  topologyContext() {
    const renderer = this.graphForSelection();
    if (!renderer) {
      new Notice("Claude Lab: no graph open", 3000);
      return null;
    }
    const selected = this.selectedPaths();
    if (!selected.size) {
      new Notice("Claude Lab: nothing selected", 3000);
      return null;
    }
    return { renderer, selected, adjacency: this.visibleAdjacency(renderer) };
  }

  growSelection() {
    const ctx = this.topologyContext();
    if (!ctx) return;

    const add = new Set();
    for (const path of ctx.selected) {
      for (const other of this.selectableNeighbours(ctx.adjacency, path)) {
        if (!ctx.selected.has(other)) add.add(other);
      }
    }
    if (!add.size) {
      new Notice("Claude Lab: nothing new to reach", 2500);
      return;
    }
    const n = this.select([...add]);
    new Notice(`Grew selection by ${n} file${n === 1 ? "" : "s"}`, 2500);
  }

  /**
   * Drop the edge of the selection, keeping only nodes whose visible
   * neighbours are all selected too -- the inverse of growing. A node with no
   * visible neighbours has no edge to be on, so it stays.
   */
  shrinkSelection() {
    const ctx = this.topologyContext();
    if (!ctx) return;

    const remove = [];
    for (const path of ctx.selected) {
      const neighbours = this.selectableNeighbours(ctx.adjacency, path);
      if (neighbours.some((other) => !ctx.selected.has(other))) remove.push(path);
    }
    if (!remove.length) {
      new Notice("Claude Lab: nothing on the edge to drop", 2500);
      return;
    }
    const n = this.deselect(remove);
    new Notice(`Shrank selection by ${n} file${n === 1 ? "" : "s"}`, 2500);
  }

  /** Grow to exhaustion: the whole connected component, visible links only. */
  selectConnected() {
    const ctx = this.topologyContext();
    if (!ctx) return;

    const seen = new Set(ctx.selected);
    const queue = [...ctx.selected];
    while (queue.length) {
      const path = queue.pop();
      for (const other of this.selectableNeighbours(ctx.adjacency, path)) {
        if (seen.has(other)) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    const add = [...seen].filter((path) => !ctx.selected.has(path));
    if (!add.length) {
      new Notice("Claude Lab: the selection is already a whole cluster", 2500);
      return;
    }
    const n = this.select(add);
    new Notice(`Selected ${n} more file${n === 1 ? "" : "s"} in the cluster`, 3000);
  }

  /* -------------------------------------------------- node clicks */

  wrapRenderers() {
    for (const type of ["graph", "localgraph"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const renderer = leaf.view && leaf.view.renderer;
        if (!renderer) continue;
        this.chainClick(renderer, "onNodeClick", (evt, id, nodeType) =>
          this.onNodeClick(evt, id, nodeType)
        );
        this.chainClick(renderer, "onNodeRightClick", (evt, id, nodeType) =>
          this.onNodeRightClick(evt, id, nodeType)
        );
        this.wrapped.add(renderer);
      }
    }
  }

  /** Ours runs first and can swallow the click, so alt-click never opens. */
  chainClick(renderer, name, handler) {
    const current = renderer[name];
    if (current && current.claudeLabTools) return;
    const wrapper = function (...args) {
      // If our handler throws, fall through to Obsidian's rather than
      // swallowing the click: a broken plugin should degrade to no plugin.
      let consumed = false;
      try {
        consumed = handler(...args);
      } catch (err) {
        console.error("[Claude Lab] node click handler failed", err);
      }
      if (consumed) return;
      if (current) current.apply(this, args);
    };
    wrapper.claudeLabTools = true;
    wrapper.claudeLabOriginal = current || null;
    renderer[name] = wrapper;
  }

  /** A file for this node id, or null for tags, unresolved links and folders. */
  fileFor(id) {
    const entry = this.app.vault.getAbstractFileByPath(id);
    return entry && !entry.children ? entry : null;
  }

  onNodeClick(evt, id) {
    if (!this.settings.enabled || !this.settings.altClickToggle) return false;
    if (!evt || !evt.altKey) return false;

    const file = this.fileFor(id);
    // Consume the click either way: alt-click means "select", so a node with
    // nothing to select should do nothing rather than open a file.
    if (!file) return true;

    if (this.selectedPaths().has(file.path)) this.deselect([file.path]);
    else this.select([file.path]);
    return true;
  }

  onNodeRightClick(evt, id) {
    if (!this.settings.enabled || !this.settings.contextMenu) return false;

    const selected = this.selectedPaths();
    const file = this.fileFor(id);
    // Only take over for a genuine multi-selection that includes this node.
    if (!file || selected.size < 2 || !selected.has(file.path)) return false;

    const files = [...selected]
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter(Boolean);
    const menu = new Menu();
    // Triggering Obsidian's own event means every plugin that contributes
    // multi-file items shows up here too, without knowing about us.
    this.app.workspace.trigger("files-menu", menu, files, "claude-lab-graph-selection");
    menu.showAtMouseEvent(evt);
    return true;
  }

  /* -------------------------------------------------- lasso */

  graphAt(target) {
    for (const type of ["graph", "localgraph"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        const el = view && view.containerEl;
        if (!el || !view.renderer || !el.contains(target)) continue;
        const canvas = el.querySelector("canvas");
        if (canvas) return { view, renderer: view.renderer, canvas };
      }
    }
    return null;
  }

  onPointerDown(evt) {
    if (!this.settings.enabled || !this.settings.lasso) return;
    if (this.lasso || evt.button !== 0 || !evt.shiftKey) return;

    const target = this.graphAt(evt.target);
    if (!target) return;

    // Claim the gesture before the graph can start panning with it.
    evt.preventDefault();
    evt.stopPropagation();

    const rect = target.canvas.getBoundingClientRect();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "claude-lab-lasso");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.appendChild(path);
    (target.canvas.parentElement || target.view.containerEl).appendChild(svg);

    this.lasso = {
      ...target,
      rect,
      svg,
      path,
      points: [[evt.clientX - rect.left, evt.clientY - rect.top]],
      subtract: false,
    };
    this.drawLasso();
  }

  onPointerMove(evt) {
    if (!this.lasso) return;
    evt.preventDefault();
    evt.stopPropagation();

    const { rect, points } = this.lasso;
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    const last = points[points.length - 1];
    // Skip sub-pixel noise; the path stays cheap on long drags.
    if (Math.abs(x - last[0]) + Math.abs(y - last[1]) < 2) return;
    points.push([x, y]);
    this.drawLasso();
  }

  onPointerUp(evt) {
    if (!this.lasso) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.applyLasso();
    this.endLasso();
  }

  drawLasso() {
    const { points, path } = this.lasso;
    if (points.length < 2) return;
    path.setAttribute(
      "d",
      "M " + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ") + " Z"
    );
  }

  endLasso() {
    if (!this.lasso) return;
    if (this.lasso.svg && this.lasso.svg.parentElement) this.lasso.svg.remove();
    this.lasso = null;
  }

  /** Graph nodes whose screen position falls inside the drawn shape. */
  nodesInLasso() {
    const { renderer, points } = this.lasso;
    if (points.length < 3 || !renderer.nodes) return [];

    const dpr = window.devicePixelRatio || 1;
    const scale = renderer.scale || 1;
    const hits = [];
    for (const node of renderer.nodes) {
      if (!node || typeof node.x !== "number") continue;
      const sx = (node.x * scale + renderer.panX) / dpr;
      const sy = (node.y * scale + renderer.panY) / dpr;
      if (pointInPolygon(sx, sy, points)) hits.push(node.id);
    }
    return hits;
  }

  /**
   * Deselection wins. A lasso that catches anything already selected removes
   * just those, and adds nothing; only a lasso landing entirely on unselected
   * nodes adds. Selection outside the lasso is never touched -- so lassoing the
   * same region twice clears it, then fills it.
   */
  applyLasso() {
    const inside = this.nodesInLasso()
      .map((id) => this.fileFor(id))
      .filter(Boolean)
      .map((file) => file.path);
    if (!inside.length) return;

    const selected = this.selectedPaths();
    const already = inside.filter((path) => selected.has(path));

    if (already.length) {
      const n = this.deselect(already);
      new Notice(`Deselected ${n} file${n === 1 ? "" : "s"}`, 2000);
    } else {
      const n = this.select(inside);
      new Notice(`Selected ${n} file${n === 1 ? "" : "s"}`, 2000);
    }
  }

  /* -------------------------------------------------- settings UI */

  displaySettings(containerEl) {
    const s = this.settings;
    const bind = (key) => async (value) => {
      s[key] = value;
      await this.saveSettings();
    };

    new Setting(containerEl)
      .setName("Enabled")
      .setDesc(
        "Select files from the graph. Selection lives in the file explorer, so the graph focus, the context menu and everything else follow from it."
      )
      .addToggle((t) => t.setValue(s.enabled).onChange(bind("enabled")));

    new Setting(containerEl)
      .setName("Alt-click a node to add or remove it")
      .setDesc(
        "Alt is used because ctrl already means “open in a new tab” throughout Obsidian."
      )
      .addToggle((t) => t.setValue(s.altClickToggle).onChange(bind("altClickToggle")));

    new Setting(containerEl)
      .setName("Shift-drag to lasso")
      .setDesc(
        "A lasso that catches anything already selected removes those instead; only a lasso landing entirely on unselected nodes adds. Selection outside the lasso never changes."
      )
      .addToggle((t) => t.setValue(s.lasso).onChange(bind("lasso")));

    new Setting(containerEl)
      .setName("Tint folders holding a selection")
      .setDesc(
        "Folders above a selected file take the explorer's hover tint, so a lasso that selected things inside collapsed folders is visible without expanding anything. It is the hover colour, not the selection colour — those folders are not themselves selected."
      )
      .addToggle((t) =>
        t.setValue(s.folderHints).onChange(async (value) => {
          s.folderHints = value;
          await this.saveSettings();
          this.refreshFolderHints();
        })
      );

    new Setting(containerEl)
      .setName("Expand folders when selecting")
      .setDesc(
        "Off by default, and rarely needed: the explorer keeps a row for every file whether or not its folder is open, so selection reaches them either way."
      )
      .addToggle((t) => t.setValue(s.revealSelection).onChange(bind("revealSelection")));

    new Setting(containerEl)
      .setName("Right-click a selection for the file menu")
      .setDesc(
        "Right-clicking a node that is part of a multi-selection opens Obsidian's own multi-file menu, including items added by other plugins."
      )
      .addToggle((t) => t.setValue(s.contextMenu).onChange(bind("contextMenu")));
  }
}
/* ------------------------------------------------------------------ *
 * Plugin host
 * ------------------------------------------------------------------ */

const FEATURES = [GraphHoverHighlight, GraphSelectionTools];

class ClaudeLabPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.features = FEATURES.map((F) => new F(this));
    for (const feature of this.features) {
      try {
        feature.onload();
      } catch (err) {
        console.error(
          `[Claude Lab] feature "${feature.constructor.id}" failed to load`,
          err
        );
      }
    }

    this.addSettingTab(new ClaudeLabSettingTab(this.app, this));
  }

  onunload() {
    for (const feature of this.features || []) {
      try {
        feature.onunload();
      } catch (err) {
        console.error(
          `[Claude Lab] feature "${feature.constructor.id}" failed to unload`,
          err
        );
      }
    }
  }

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = {};
    for (const F of FEATURES) {
      this.settings[F.id] = Object.assign({}, F.defaults, saved[F.id]);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class ClaudeLabSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    for (const feature of this.plugin.features) {
      new Setting(containerEl)
        .setName(feature.constructor.displayName)
        .setHeading();
      feature.displaySettings(containerEl);
    }
  }
}

module.exports = ClaudeLabPlugin;
module.exports.default = ClaudeLabPlugin;
