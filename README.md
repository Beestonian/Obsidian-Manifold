# Manifold Graph

An Obsidian plugin that connects the graph to the rest of the app.

Point at a note. The graph shows you where it is.
Select notes in the graph. The file explorer selects the same notes.

![A link in a note is under the pointer. The graph highlights that note and dims the other notes.](docs/images/hover-link.png)

---

## Find a note in the graph

Move the pointer onto a link in a note. The graph highlights that note. The graph
dims all other notes. Move the pointer away. The graph returns to normal.

This also works when you point at:

- a tag
- a value in the properties panel
- a row in a Base
- a file in the file explorer
- a result in the search panel
- a link in the backlinks panel

![A tag is under the pointer. The graph highlights the tag and all notes that use it.](docs/images/hover-tag.png)

---

## See the notes in a folder

Move the pointer onto a folder in the file explorer. The graph highlights all notes
in that folder. The graph dims all other notes.

Use this to compare your folders with your links.

![A folder is under the pointer. The graph highlights all notes in that folder.](docs/images/hover-folder.png)

---

## Keep notes highlighted while you work

Select one or more files in the file explorer. The graph highlights them. This
highlight stays until you change the selection.

Now move the pointer onto a link. The graph highlights that note **and** keeps your
selection highlighted. Move the pointer away. The graph shows your selection again.

![Three files are selected in the file explorer. The graph highlights the same three notes.](docs/images/selection.png)

---

## Select notes from the graph

| To do this | Do this |
|---|---|
| Add or remove one note | Hold `Alt` and click the note |
| Select an area | Hold `Shift` and drag a box |
| Open the file menu | Right-click a note in the selection |

The file explorer selects the same notes. You can then move, rename or delete them.

If your box touches a note that is already selected, the plugin removes that note.
Drag the same box two times to first clear an area, then fill it.

![A box is drawn over part of the graph. The file explorer selects the notes inside the box.](docs/images/lasso.png)

---

## Select more notes along the links

Select one or more notes first. Then use these keys.

| Keys | Result |
|---|---|
| `Alt` `=` | Add the notes that connect to your selection |
| `Alt` `-` | Remove the notes at the edge of your selection |
| `Alt` `L` | Add all notes in the same group |
| `Alt` `I` | Select the notes that are not selected |

`Alt` `I` uses only the notes that you can see. Notes that a filter hides stay as
they are.

`Alt` `-` removes only the notes at the edge. If you select a full group, that group
has no edge. Then `Alt` `-` does nothing. This is correct.

The plugin uses only the links that you can see. If you hide tags, or you type a
search, the plugin obeys that.

![A selection in the graph grows to include the connected notes.](docs/images/grow.png)

You do not need to remember the keys. Every command is also in a menu:

- Click the **⋮** button on the graph tab. Then click **Select**.
- Or right-click a note in a selection. Then click **Select**.

![The Select menu is open on the graph tab. It lists the selection commands.](docs/images/select-menu.png)

---

## Install

This plugin has no build step.

1. Clone this repository into your vault.

   ```bash
   git clone https://github.com/Beestonian/Obsidian-Manifold.git "YOUR_VAULT/.obsidian/plugins/manifold-graph"
   ```

   The folder name must be `manifold-graph`. Obsidian ignores a plugin folder with
   a different name, and shows no error.

2. Open Obsidian.
3. Go to **Settings → Community plugins**.
4. Click **Reload**.
5. Turn on **Manifold Graph**.

To update the plugin, run `git pull`. Then use the **Reload app without saving**
command.

---

## Settings

Open **Settings → Manifold Graph**. You can turn off each part of the plugin.

### Highlighting

| Setting | Default | What it does |
|---|---|---|
| Enabled | on | Turns the highlighting on or off |
| Highlight in the global graph | on | Highlights in the main graph |
| Highlight in local graphs | on | Highlights in local graphs |
| React to internal links | on | Points at links |
| React to tags | on | Points at tags |
| Follow the file explorer selection | on | Keeps selected files highlighted |
| Hover adds to the selection | on | Keeps the selection highlighted when you point at a note |
| Fade the rest when hovering a folder | on | Highlights the notes in a folder |
| Folder depth | `0` | `0` uses all subfolders. `1` uses only the files in the folder |
| Match values in properties and Bases | on | Points at values with no link |
| Only inside notes | off | Uses only notes. Ignores the file explorer and the panels |
| Outline embeds and Bases rows | on | Draws an outline on the item under the pointer |
| Show the hovered node in the file explorer | on | Shows the note in the file explorer |
| Nudge the graph controls for hidden nodes | on | Tells you when a filter hides the note |
| Hover delay (ms) | `50` | The time before the graph reacts |
| Linger (ms) | `120` | The time the highlight stays after you move away |
| Debug logging | off | Writes messages to the developer console |

### Selecting

| Setting | Default | What it does |
|---|---|---|
| Enabled | on | Turns the selection tools on or off |
| Alt-click a node to add or remove it | on | `Alt` and click |
| Shift-drag to lasso | on | `Shift` and drag |
| Tint folders holding a selection | on | Colours the folders that hold a selected file |
| Expand folders when selecting | off | Opens folders to show the selected files |
| Right-click a selection for the file menu | on | Right-click menu |
| Show a Select menu on the graph | on | Adds the **Select** menu to the graph tab and the right-click menu |

---

## If something does not work

| Problem | What to do |
|---|---|
| Nothing highlights | Open a graph. The plugin needs an open graph. |
| A link works but a tag does not | Turn on **React to tags**. |
| The file explorer does not react | Turn off **Only inside notes**. |
| A note never highlights | A graph filter hides it. Check your search and your filters. |
| `Alt` `=` adds nothing | The plugin uses only the links that you can see. It does not use tags. |
| The graph stays dim | Run the **Repair orphaned graph links** command. |

If the graph stays dim again, run the **Record graph focus log (20s)** command. Do
the steps that cause the problem. Then run **Stop recording and save graph focus
log**. Attach the log file to your bug report.

---

## More

- [How it works](docs/DESIGN.md) — for people who want to change the code.

Obsidian does not give plugins an official way to control the graph. This plugin
uses the graph directly. An Obsidian update can stop it. Tested with Obsidian
**1.13.7**.
