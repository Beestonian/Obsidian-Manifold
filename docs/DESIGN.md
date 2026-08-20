# Manifold Graph — how it works

Binds Obsidian's graph view to the rest of the app, in both directions. Pointing at
anything that names a note highlights its node in the graph; selecting nodes in the
graph drives the file explorer's selection. The explorer's selection is the single
source of truth — the graph is a view onto it that can also write to it.

Features are self-contained modules on a shared host, so each owns its settings and
can be switched off without touching the other.

No build step. `main.js` is plain CommonJS and is exactly what Obsidian loads —
edit it and hit **Reload app without saving** (or toggle the plugin off/on).

> **Just want to use it?** See the **[README](../README.md)** — install, what each
> gesture does, the settings reference and troubleshooting. This file is the design
> document: what the signal path looks like and why it's shaped that way.

## Features

### 1. Graph hover highlight

Hover an internal link or a tag in a note, and the matching node lights up in the
graph view — the same lighting Obsidian uses when you hover that node in the graph
itself: highlight fill on the node, highlight colour on its links, everything that
isn't a direct neighbour fades back.

The signal path. Two input channels, one resolver, one output:

```
  [ DOM mouseover ]  -----\           sees tags, table values and embeds
                           \
                            >--- hover intent {el, kind, text, sourcePath?}
                           /                  |
  [ "hover-link" event ] -/                   |
    fired by note bodies, properties,         |
    Bases, search, backlinks, file            |
    explorer, tab headers                     v
                                    resolve to a graph node id
                                      link  -> vault path ("Notes/Alpha.md")
                                      tag   -> "#project/alpha"
                                      value -> whichever of those the graph has
                                      broken link -> the raw link text
                                              |
                                              v
                                    for each open graph renderer
                                      global graph  <- own on/off switch
                                      local graphs  <- own on/off switch
                                              |
                                              v
                                    renderer.highlightNode = node
                                    renderer.changed()
```

The output step writes to the same port Obsidian's own graph writes to on hover,
which is why the effect matches exactly rather than approximating it.

The two input channels exist because neither covers everything: `hover-link` is
Obsidian's own universal "the pointer is over a link" signal and carries the link
text and source note already resolved, but it never fires for tags. The DOM
channel handles tags and anything that renders a link without going through that
event. They converge on the same hover intent immediately, so nothing downstream
knows or cares which one fired — and adding a view that Obsidian supports needs no
new code here.

Both channels can fire for the same pointer move (a link in a note body does fire
both). Two hovers count as the same hover when they *resolve to the same node* —
not when their elements overlap. That distinction matters: an embedded `.base`
contains its own rows, so element-overlap would pin the highlight to the base and
never let a row inside take over.

**Values in properties and Bases.** Inside `.metadata-property`, `.bases-view` and
`.bases-embed`, the hovered chip or cell is resolved by its text even when it
carries no link markup at all — property pills have none, and Bases renders a tag
as `<a class="tag">` with the hash stripped and no href. Rather than encode which
widget means what, the text is offered to the graph as a file path, then as
`#text`, then as itself, and whichever the graph actually holds wins. Values that
name nothing do nothing. Cells that swallowed several chips (multi-line) or hold
prose (>120 chars) are skipped.

**Embeds are links.** An `.internal-embed` resolves through its `src`, so an
embedded note, image or base highlights itself — while anything hovered inside it
takes over, per the resolution-based dedup above.

**Anything that declares a file.** Obsidian stamps `data-path` on file explorer
rows, folder rows and bookmark items, so one selector covers all of them rather
than one rule per pane. Which of the two a row is comes from the vault, not the
markup: if the path names a folder, the hover becomes a folder focus instead.

### Selection focus

Files selected in the file explorer stay in the foreground while the rest of the
graph recedes — the same fade as folder focus, but persistent.

Focus has two layers. The **base** layer is the explorer's selection and holds
until the selection changes. A hover pushes a **transient** layer on top and pops
back to the base when the pointer leaves — so hovering is a peek, not a
replacement. Only one is ever written, because there is only one slot to write to.
A hover that resolves to nothing restores the base rather than leaving the graph
unfocused.

**Hovering adds rather than replaces.** With a selection live, hovering a link or
tag keeps the selection in the foreground *and* lights up the hovered node with
its own connections. This works because the exemption test reads the id of
whatever occupies the slot — it was never specific to the marker. Put the real
hovered node in the slot and it gets the full native treatment (highlight fill,
ring, coloured edges, bright neighbours); write *that node's* id into the
selection's link maps and the selection stays lit underneath it. Two focus sets,
one slot. Switchable via "Hover adds to the selection".

Two further exceptions keep the layers from fighting each other:

- **Navigation rows don't peek while a selection is live.** Building a selection
  means dragging the pointer across rows you never meant to inspect, and each one
  would otherwise hijack the graph. So with a selection active, hovering a file
  explorer or bookmark row leaves it alone — that's aiming, not asking. Hovering
  *content* (a link, a tag, a table value) still peeks. With no selection,
  explorer hover behaves as it always did.
- **The graph's own node hover is a peek too.** The renderer writes the hovered
  node into the slot itself and writes `null` back on pointer-out, which would
  strand the graph unfocused. `onNodeHover` / `onNodeUnhover` — the renderer's own
  callbacks, chained rather than patched — hand the slot back to the selection
  when the pointer leaves the node.

Crossing the canvas with a selection painted does not repaint it. Tearing the
focus down and rebuilding it on every stray pointer move is visible as a blink.

**Re-asserting rather than chasing.** The renderer has several ways to empty the
slot — its own pointer handlers, and a per-frame check that evicts whatever the
cursor is not touching — and some of them fire *after* the pointer has stopped
moving, when no input event is coming to prompt a repair. So while a selection is
held, the invariant is checked once a frame: if the slot is empty, repaint it. It
only inspects renderers already written to, costing a couple of comparisons, and a
slot held by someone else is left alone. The event-driven paths are still wired,
so the common case repairs instantly and the watchdog is only a backstop.

Hovering a node **in the graph** gets the same additive treatment as hovering a
link in a note: `onNodeHover` re-keys the selection's exemptions to the node the
renderer just highlighted, so the selection stays lit beside it, and `onNodeUnhover`
hands them back.

**One graph hover arrives through both channels.** The renderer calls
`onNodeHover`, and the graph view *also* triggers `hover-link` with
`source: "graph"` for the same gesture. They must be recognised as one thing, for
a reason that is easy to miss: the canvas is a **single DOM element**, so moving
the pointer around inside it fires no further mouseover or mouseout. The renderer's
`onNodeUnhover` is the only teardown signal that will ever arrive. Letting the
event channel take ownership therefore strands the hover permanently — the graph
stays lit until the pointer leaves the canvas altogether. So a graph-sourced hover
is flagged `fromGraph`, keeps `graphPeek` raised, and is torn down by the renderer.
Our chain also runs *before* the view's handler, so the flag is set by the time the
event comes back around.

As a backstop, the watchdog treats a hover with nothing of ours on screen anywhere
as a ghost and discards it. Being wedged by stale hover state is what made this bug
survive three earlier fixes.

**Injected keys are fake links, and `setData` reads real ones** — it seeds node
positions from them and computes node *weight*, which is node size. So the
wrapper releases every injection before calling through, and repaints after.
Otherwise a selection held during a rebuild would quietly resize its own nodes.

The explorer owns the selection; this only mirrors it. Driving Obsidian's own tree
rather than keeping a parallel one means right-click, drag, rename and delete keep
working untouched, and a graph rebuild costs a repaint rather than losing state.
The tree fires no event when its selection changes, so `selectItem`,
`deselectItem` and `clearSelectedDoms` are wrapped on the instance and restored on
unload. A selected folder row stands for its files, at the configured depth.

Because `setData` replaces every node object — discarding the injected exemption
keys — renderers are wrapped too, and the current focus is repainted after a
rebuild.

### Folder focus

Hovering a folder keeps everything inside it in the foreground and lets the rest
of the graph recede — the inverse of a highlight, and a way to see where folder
structure and link structure agree.

This uses the renderer's own fade rather than repainting anything. Each frame, a
node stays at full brightness if there is no highlight node, if it *is* the
highlight node, or if the highlight node's id appears in its own forward/reverse
link maps; otherwise it eases down to the faded value. So:

- `highlightNode` is pointed at a marker object that is in nobody's link maps —
  which fades the whole graph, nodes, labels and links alike;
- the marker's id is then added to the `reverse` map of each file in the folder,
  which exempts exactly those.

**Why `reverse`, never `forward`.** Both maps are `id -> link object`, not
`id -> flag`. `setData` walks `forward` to work out which links have gone, handing
anything it finds there that the new data doesn't describe to a routine that calls
`clearGraphics()` on it. A flag written into `forward` therefore either overwrites
a real link object — orphaning it inside `renderer.links`, where it keeps drawing
and being sent to the layout worker forever, immune to searches and rebuilds — or
it crashes the rebuild half-way, which strands duplicate nodes. `reverse` is
written by `setData` but never walked by it, so an extra key there is inert. And a
node that already has a real link to the target is skipped entirely: it's a
genuine neighbour, so it's already bright.

The **Repair orphaned graph links** command cleans up after the version that got
this wrong. A healthy link is always findable as `source.forward[target.id]`; any
link in the list that isn't has been orphaned.

The folder's nodes therefore keep their **normal** colours and sizes rather than
being tinted — they are simply the ones that didn't recede — and the transition is
eased by the renderer itself. Clearing deletes the injected keys and releases the
slot. The marker is shaped like a node so any code path that reaches for one finds
something sane, and it is never rendered, since nothing holds it in
`renderer.nodes`.

Depth is configurable: 1 is the folder's own files, 2 adds one level of
subfolders, 0 (the default) is every level. A folder whose files are all absent
from the graph does nothing at all.

**Sharing the graph with other plugins.** `renderer.highlightNode` is a single
slot, and other plugins write to it too (graph-search-sync does). This plugin
remembers the node it wrote and only clears that — if the slot has changed hands,
it leaves it alone.

Two things worth knowing:

- Tags are only nodes when **Tags** is switched on in the graph view's filter
  panel. If tag hover does nothing, that's usually why.
- The renderer re-checks every frame whether the cursor is still on top of the
  highlighted node, and drops the highlight if not. Since the cursor is over the
  note and not the canvas, the feature nulls `renderer.mouseX/mouseY` first. Don't
  remove those two lines.

**The outline is only drawn where Obsidian gives no feedback of its own.** Links
and tags already have a hover style, so outlining them was redundant — and a
blurred shadow over text is an expensive repaint, which is where the lag came
from. Embeds and Bases rows have no such feedback, and there the outline earns its
place by saying which row the graph is answering. It's a drawn ring now: no blur,
no transition.

**Hovering a node in the graph tints its row in the file explorer** — the same
brush, running the other way. Nothing is expanded to make that possible, because
expanding the tree on hover would be unbearable. Instead the answer adapts: walk
the ancestor chain from the root down, and the first *collapsed* folder is both
the deepest row still on screen and the single thing you'd have to click. If none
are collapsed, the row itself is visible, so that gets the tint.

It's deliberately limited to hovers that came from the graph. In a note the link
is already under the cursor, and tinting the sidebar for every link you pass over
is the kind of redundant feedback that makes the whole thing feel busy.

**A hover that names something the graph isn't showing nudges the graph controls.**
If the thing under the cursor resolves to a real file, tag or folder and no node
matches, the node exists but is hidden — almost always by a filter. Rather than
doing nothing, the graph's control cluster is briefly outlined, pointing at the
thing that would unhide it. A hover that names nothing real gets no nudge, since
there'd be nothing to go and find.

Settings: independent switches for global and local graphs, for links, for tags,
for value matching in properties and Bases, for folder focus (plus its depth), an
"only inside notes" switch (off by default — when on, it confines the
feature to note bodies and their properties; when off, Bases, search, backlinks,
the file explorer and tab headers drive the graph too), hover delay, linger time,
and a glow on the hovered link that only appears when the link actually matched a
node in an open graph.

Commands: **Toggle graph hover highlight**, and **Diagnose graph hover highlight**
which reports how many nodes each open graph holds and what the last hover
resolved to.

## 2. Graph selection tools

Selecting files *from* the graph:

- **Alt-click a node** — adds it to the file explorer's selection, or removes it
  if it's already there. Alt rather than ctrl, because ctrl already means "open in
  a new tab" throughout Obsidian.
- **Shift-drag** — draws a lasso. On release: **deselection wins.** A lasso that
  catches anything already selected removes just those and adds nothing; only a
  lasso landing entirely on unselected nodes adds. Selection outside the lasso is
  never touched — so lassoing the same region twice clears it, then fills it.
- **Right-click a node in a multi-selection** — opens Obsidian's own multi-file
  menu, triggered through the `files-menu` event so that items added by other
  plugins appear too.

### Topology selection

Physical closeness in the layout is not adjacency — two nodes can sit on top of
each other and share nothing — so a lasso alone can't isolate a cluster in a dense
region. These grow and shrink a selection along the edges instead, the way a mesh
editor grows a vertex selection:

- **Grow selection along visible links** (`Alt` `=`) — adds every neighbour of
  the selection.
- **Shrink selection from its edges** (`Alt` `-`) — keeps only nodes whose visible
  neighbours are *all* selected. Note the consequence: a fully selected connected
  component has no edge, so shrinking it does nothing. That's the same rule mesh
  editors use, and it's why shrink is not an undo for grow.
- **Select everything connected to the selection** (`Alt` `L`) — grows to
  exhaustion: the whole connected component.

**"Visible" is taken strictly.** Adjacency is read from `renderer.links`, which is
the graph *after* its filters — tags off, a search query, orphans hidden, all of
it. Nothing is ever selected through an edge you can't see. That array is also the
only safe source: the per-node link maps carry this plugin's own focus flags, and
walking those would follow edges that don't exist.

Tag and unresolved nodes are visible but not selectable, so growth doesn't travel
through them — otherwise one step through a shared tag would swallow everything
carrying it.

Nothing here paints the graph. It only drives the explorer's own tree; the focus
feature notices the selection changed and repaints. One source of truth, so
right-click, drag, rename and delete keep working, and the graph never disagrees
with the explorer.

Two mechanics worth knowing:

- The gesture is claimed on **`pointerdown` in the capture phase**. PIXI listens
  for `pointerdown` on the canvas, and pointer events fire before mouse events, so
  this is the only point at which the drag can be taken before the graph starts
  panning with it.
- Hit testing converts nodes to screen space with `(x × scale + panX) / dpr` —
  the inverse of the renderer's own transform — and ray-casts against the drawn
  polygon. Tags, unresolved links and folders have no file, so they're skipped.

**Folders holding a selection are tinted.** The explorer builds a row object for
every file in the vault as it loads, open or collapsed — so a lasso selects files
inside collapsed folders perfectly well, it just leaves nothing to see. Every
folder above a selected file therefore takes the explorer's own **hover** tint,
at any depth. Deliberately the hover colour and not the selection colour: it means
"something in here", never "this is selected", and real selection outranks it.

Nothing is expanded to make that work. (There's an off-by-default "expand folders
when selecting" fallback for a file the explorer somehow has no row for.)

## Tests

`test/hover.test.js` stubs the `obsidian` module, a minimal DOM and the timers,
then checks link/tag resolution (reading view, live preview, aliases, subpaths,
split tag spans, broken links, Bases and property payloads), the full hover
lifecycle on both channels including their interaction, and the write into a fake
renderer. Run it with the Node bundled inside NodeGX:

```bash
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/noodl-editor/NodeGX.exe" test/hover.test.js
```

`test/selection.test.js` covers the selection tools: alt-click toggling, the lasso
rules (including deselect-wins and leaving outside selection alone), expanding
collapsed folders to reach what was lassoed, and the multi-file menu.

```bash
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/noodl-editor/NodeGX.exe" test/selection.test.js
```

