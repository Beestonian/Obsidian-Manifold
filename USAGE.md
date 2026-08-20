# Using Manifold

Manifold wires Obsidian's graph view to the rest of the app, in both directions.

- **Point at something anywhere in Obsidian** — a link, a tag, a property value, a
  file in the explorer — and its node lights up in the graph while everything
  unrelated fades back.
- **Select nodes in the graph** — click, lasso, or grow the selection along links —
  and those files become the file explorer's selection, ready to move, rename or
  delete.

The graph stops being a picture you look at and becomes a pane you work in.

> Looking for *why* it's built this way — the signal path, the renderer internals,
> the traps? That's in [README.md](README.md). This file is just how to drive it.

---

## Install

Manifold has no build step. `main.js` is what Obsidian loads.

The clone folder **must be named after the `id` in `manifest.json`**, which is
currently `claude-plugins`. Obsidian silently ignores a plugin folder whose name
doesn't match its id.

```bash
git clone https://github.com/Beestonian/Obsidian-Manifold.git "YOUR_VAULT/.obsidian/plugins/claude-plugins"
```

Then in Obsidian: **Settings → Community plugins → Reload**, and enable the plugin.

> **Note:** the plugin id and display name still read `claude-plugins` / "Claude Lab"
> from before this repo was named Manifold. Renaming both is pending — when it
> lands, the clone folder becomes `manifold` and existing users will need to rename
> their folder and re-enable the plugin once.

To update, `git pull` and use **Reload app without saving** from the command palette.

---

## Sixty-second tour

1. Open the graph view and a note with a few links in it, side by side.
2. **Hover a link in the note.** Its node lights up in the graph; the rest dims.
3. **Hover a tag.** Same thing — tags are nodes too.
4. **Hover a folder in the file explorer.** Everything inside it stays bright and
   the rest of the vault recedes.
5. **Click a file in the explorer, then shift-click another.** Both stay lit, and
   they *stay* lit — this one persists until the selection changes.
6. **Now hover a link while that selection is live.** The selection stays lit *and*
   the hovered node lights up beside it. Move away and you're back to the selection.
7. **Shift-drag a box across the graph.** Those files are now selected in the explorer.
8. **Press `Alt` `=`.** The selection grows one step along the links.

Steps 1–6 are the graph reacting to you. Steps 7–8 are you driving the explorer
from the graph.

---

## Part 1 — Making the graph respond

### Hovering

Rest the pointer on any of these and the matching graph node highlights:

| What you hover | Where it works |
|---|---|
| An internal link | Note bodies (reading view and live preview), search results, backlinks, tab headers |
| A tag | Anywhere a tag renders, including the tag pane |
| A property value | The properties panel — bare values with no link markup still resolve |
| A cell in a Base | Both embedded Bases and full `.base` views |
| An embed | Resolves through its source; hovering *inside* it takes over instead |
| A file or bookmark row | File explorer, bookmarks |

Aliases, heading and block subpaths (`[[Note#Heading]]`), and split tag spans all
resolve to the right node. Broken links highlight their unresolved node.

**Property and Base values are resolved by their text**, because those widgets
often carry no link markup at all. The text is offered to the graph as a file
path, then as `#tag`, then as itself, and whichever one the graph actually holds
wins. Text that names nothing does nothing. Cells holding prose (over 120
characters) or several values at once are skipped, so a long note body in a table
cell won't fire.

### Hovering a folder

Hovering a folder row keeps everything inside it bright and lets the rest recede —
the inverse of a highlight. It's a fast way to see where your folder structure and
your link structure actually agree.

**Folder depth** controls how deep "inside" reaches. `0` (the default) means every
level; `1` means only the folder's own files, not its subfolders'.

### Following the explorer selection

Files selected in the file explorer stay in the foreground and *stay* there — the
same fade as folder focus, but it holds until the selection changes.

This is the base layer. Hovering pushes a temporary layer on top and pops back to
the base when you move away, so **a hover is a peek, not a replacement.** A hover
that resolves to nothing restores the selection rather than leaving the graph blank.

With **Hover adds to the selection** on (the default), hovering while a selection
is live keeps the selection lit *and* lights the hovered node with its own
connections — two focus sets at once.

Two deliberate exceptions stop the layers fighting:

- **Explorer and bookmark rows don't peek while a selection is live.** Building a
  selection means dragging the pointer across rows you never meant to look at, and
  each one would otherwise hijack the graph. That's aiming, not asking. Hovering
  *content* — a link, a tag, a table value — still peeks. With nothing selected,
  explorer hover behaves normally.
- **Hovering a node in the graph is also a peek.** Move off the node and the
  selection comes back.

---

## Part 2 — Selecting from the graph

Everything here drives the file explorer's own selection. Nothing paints the graph
directly — the focus feature notices the selection changed and repaints. One source
of truth, so right-click, drag, rename and delete all keep working, and the graph
can never disagree with the explorer.

### Clicking and lassoing

| Gesture | Result |
|---|---|
| `Alt` **click a node** | Adds it to the selection, or removes it if already there |
| `Shift` **drag** | Lassos a region |
| **Right-click** a node in a multi-selection | Obsidian's own multi-file menu |

`Alt` rather than `Ctrl`, because `Ctrl` already means "open in a new tab"
everywhere else in Obsidian.

**The lasso rule: deselection wins.** A lasso that catches anything already
selected removes just those and adds nothing. Only a lasso landing entirely on
unselected nodes adds. Selection *outside* the lasso is never touched.

The useful consequence: lasso the same region twice and you clear it, then fill it.

The right-click menu is triggered through Obsidian's `files-menu` event, so items
added by your other plugins show up there too.

### Growing and shrinking along links

Physical closeness in the layout is not adjacency — two nodes can sit on top of
each other and share nothing. These walk the *edges* instead, the way a mesh
editor grows a vertex selection.

| Hotkey | Command | What it does |
|---|---|---|
| `Alt` `=` | Grow selection along visible links | Adds every neighbour of the selection |
| `Alt` `-` | Shrink selection from its edges | Keeps only nodes whose visible neighbours are *all* selected |
| `Alt` `L` | Select everything connected to the selection | Grows to exhaustion — the whole connected component |

**Shrink is not an undo for grow.** It removes nodes on the *boundary* of the
selection. A fully selected connected component has no boundary, so shrinking it
does nothing at all. That's the same rule mesh editors use, and it's the behaviour
to expect rather than a bug.

**"Visible" is taken strictly.** Adjacency comes from the graph *after* its filters —
tags switched off, a search query, orphans hidden, all of it. Nothing is ever
selected through an edge you can't see.

Tag and unresolved nodes are visible but not selectable, and growth does **not**
travel through them. Otherwise one step through a shared tag would swallow every
note carrying it.

### Folder tinting

Every folder holding a selected file takes the explorer's own **hover** tint, at
any depth.

It's deliberately the hover colour and not the selection colour: it means
"something in here", never "this is selected", and a real selection outranks it.

Nothing is expanded to make this work — the explorer already knows about files
inside collapsed folders, so a lasso selects them correctly, it just leaves nothing
visible. (There's an off-by-default **Expand folders when selecting** fallback for
the rare file the explorer has no row for.)

---

## Commands

All available from the command palette. Only the three topology commands ship with
default hotkeys; bind the rest yourself in **Settings → Hotkeys**.

| Command | Default hotkey |
|---|---|
| Grow selection along visible links | `Alt` `=` |
| Shrink selection from its edges | `Alt` `-` |
| Select everything connected to the selection | `Alt` `L` |
| Clear file selection | — |
| Toggle graph hover highlight | — |
| Diagnose graph hover highlight | — |
| Repair orphaned graph links | — |
| Record graph focus log (20s) | — |
| Stop recording and save graph focus log | — |

---

## Settings

Each feature has its own section in the plugin's settings tab, and can be switched
off entirely without affecting the other.

### Graph hover highlight

| Setting | Default | What it does |
|---|---|---|
| Enabled | on | Master switch for this feature |
| Highlight in the global graph | on | React in the full graph view |
| Highlight in local graphs | on | React in local graph panes |
| React to internal links | on | Hovering links highlights |
| React to tags | on | Hovering tags highlights |
| Follow the file explorer selection | on | Selected files stay lit persistently |
| Hover adds to the selection | on | Hovering keeps the selection lit underneath |
| Fade the rest when hovering a folder | on | Folder focus |
| Folder depth | `0` | `0` = every level below the folder, `1` = its own files only |
| Match values in properties and Bases | on | Resolve bare values by text |
| Only inside notes | off | Restrict to note bodies, ignoring explorer, search and backlinks |
| Outline embeds and Bases rows | on | Outlines the thing you're hovering |
| Show the hovered node in the file explorer | on | Reveals the file in the explorer tree |
| Nudge the graph controls for hidden nodes | on | Hints when the node exists but a filter is hiding it |
| Hover delay (ms) | `50` | How long the cursor must rest before the graph reacts |
| Linger (ms) | `120` | How long the highlight survives after leaving. Stops flicker when crossing between links |
| Debug logging | off | Logs every resolution attempt to the developer console |

### Graph selection tools

| Setting | Default | What it does |
|---|---|---|
| Enabled | on | Master switch for this feature |
| Alt-click a node to add or remove it | on | Toggle nodes into the selection |
| Shift-drag to lasso | on | Lasso select |
| Tint folders holding a selection | on | Hover tint on ancestor folders |
| Expand folders when selecting | **off** | Fallback for files the explorer has no row for |
| Right-click a selection for the file menu | on | Obsidian's multi-file menu |

---

## Troubleshooting

**Nothing highlights.** Check a graph view is actually open — the plugin writes to
open renderers and does nothing if there are none. Then check **Enabled** and the
global/local graph switches.

**A link highlights but a tag doesn't** (or vice versa). Those arrive through two
different channels. Check **React to internal links** and **React to tags**
separately.

**Hovering does nothing in the file explorer.** **Only inside notes** may be on,
which restricts hovering to note bodies. Also expected if a selection is live —
explorer rows deliberately don't peek then (see above).

**The node exists but never lights up.** A graph filter is probably hiding it —
tags off, orphans hidden, or an active search query. With **Nudge the graph
controls for hidden nodes** on, the graph controls flag this.

**Grow selects nothing.** Adjacency is read from *visible* links only, and growth
won't travel through tag or unresolved nodes. If your links run through tags, grow
stops there by design.

**The graph stays dim after the pointer leaves.** Run **Repair orphaned graph
links** from the palette. If it recurs, run **Record graph focus log (20s)**,
reproduce it, then **Stop recording and save graph focus log** — that writes a
frame-by-frame log of the focus state, which is what to attach to a bug report.

**Diagnose graph hover highlight** prints the current resolution state to the
console and is the first thing to try for anything that resolves to the wrong node.

---

## Running the tests

Tests stub the `obsidian` module, a minimal DOM and the timers, so they run under
plain Node with no Obsidian instance:

```bash
node test/hover.test.js
```

```bash
node test/selection.test.js
```

Any Node will do. If you don't have a standalone `node` on PATH, any Electron app
that bundles one works with `ELECTRON_RUN_AS_NODE=1` set — see [README.md](README.md)
for the invocation used during development.

`hover.test.js` covers link and tag resolution (reading view, live preview,
aliases, subpaths, split tag spans, broken links, Bases and property payloads), the
full hover lifecycle on both input channels, and the write into a fake renderer.
`selection.test.js` covers alt-click toggling, the lasso rules including
deselect-wins, folder expansion, and the multi-file menu.

---

## Known limits

- The graph view is **not** a public Obsidian API. Manifold drives the real
  renderer, which is why the highlight matches the native one exactly — and also
  why an Obsidian update could break it. Verified against **1.13.7**.
- Tag and unresolved nodes can be highlighted but not *selected*, because there's
  no file behind them to hand to the explorer.
- Everything is scoped to open graph panes. Closed graphs aren't tracked.
