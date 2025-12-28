# Copilot / AI agent Instructions — Obsidian Hexmap Plugin

Quick orientation (what matters):

- This is a single-file Obsidian plugin: most logic lives in `main.js` and styles live in `styles.css`.
- The plugin implements a custom FileView (`VIEW_TYPE_HEXMAP` / `hexmap-view`) and registers a `.hexmap` extension.
- Data is stored as a JSON blob inside `.hexmap` files (see `defaultData` in the `New Hexmap` command). Key properties: `coloredHexes`, `hexLabels`, `hexLabels2`, `hexNotes`, `hexRivers`, `hexRoads`, `tokens`, `tokenColors`, `tokenLabels`, `zoom`, `offset`, `showCoordinates`, `showLabel1`, `showLabel2`.

Project-specific conventions & patterns (do not assume defaults):

- Hex coordinates are axial (q,r) using a flat-top hex grid. Hex keys are strings like `"q,r"` (see e.g. `const hexKey = `${q},${r}``).
- Face numbering is 1..6 starting at North and increasing clockwise. Rivers/roads store arrays of face numbers (e.g. `[1,4]`).
- UI element classnames used by JS/CSS: `.hexmap-color-picker`, `.face-control-panel`, `.hexmap-context-menu`, `.hexmap-button`.
- UI element classnames used by JS/CSS: `.hexmap-color-picker`, `.face-control-panel`, `.hexmap-context-menu`, `.hexmap-button`.
- The plugin creates a `hexmaps` folder and per-map note folders: when creating a note for hex `q,r` it writes to `hexmaps/<hexmapFileBasename>/Hex q,r.md`.
 - The plugin creates a `hexmaps` folder and per-map note folders: when creating a note for hex `q,r` it writes to `hexmaps/<hexmapFileBasename>/Hex q,r.md`. This parent folder is configurable in the plugin settings (`Hexmaps folder`).
 - The plugin creates per-map note folders next to the hexmap file: when creating a note for hex `q,r` it writes to `<hexmap-folder>/<hexmapFileBasename>/Hex q,r.md`. Previously notes were always created under `hexmaps/` — the plugin now places them beside the `.hexmap` file.

Important code touchpoints (examples of existing patterns):

- New file creation & defaults: see `this.addCommand({ id: "new-hexmap" ... })` — update the `defaultData` there whenever you add a top-level field.
- Loading & fallback: `onOpen()` and `loadHexData()` parse JSON and defensively set missing properties (`this.hexData.hexRivers = this.hexData.hexRivers || {}`), follow this pattern on schema changes.
- Persistence: `saveHexmapData()` converts Maps to plain objects and calls `this.app.vault.modify(this.file, JSON.stringify(...))` — keep this canonical flow when adding derived state.
- File ops: `handleFileRename()` and `handleFileDelete()` update `hexNotes` references; rename uses `oldPath` matching. When changing how note paths are stored, update these handlers.
 - File ops: `handleFileRename()` and `handleFileDelete()` update `hexNotes` references; rename uses `oldPath` matching and now also normalizes/compares basenames as a fallback. Open `handleFileRename` when changing how note paths are stored or if you need to support additional matching heuristics.

How to test changes quickly (manual flow):

1. Edit `main.js` directly (no build step required). 2. Reload Obsidian or toggle the plugin in Settings → Community plugins. 3. Use Command Palette → **New Hexmap** to create a `.hexmap` file and open it. 4. Interact: context menu (right-click) to create notes, add tokens, toggle rivers/roads, edit labels and colors.

Notes for contributors / AI agents:

- When adding new persistent fields, update three places: `defaultData` (new map creation), `onOpen()`/`loadHexData()` (initialization & migrations), and `saveHexmapData()` (serialization).
- UI changes often require a matching CSS class change in `styles.css` (see existing class names above).
- Avoid changing the `VIEW_TYPE` string or the `.hexmap` registration unless you're intentionally renaming the view (that impacts saved view state and existing files).
- Be conservative with public API assumptions: the plugin relies on Obsidian's Vault API (`create`, `modify`, `read`, `createFolder`) and Workspace methods (`openLinkText`). Keep these usages consistent.

Examples that are safe-to-copy:

- Toggle a river on a hex (current pattern): set `this.hexData.hexRivers[hexKey] = [1]` or `delete this.hexData.hexRivers[hexKey]` and call `saveHexmapData()` + `renderCanvas()`.
- Copy/paste hex data uses clipboard JSON with keys `{ position, color, label, label2, note, rivers, roads }` — follow that shape for interoperability.

Interactions & shortcuts:

- Shift-click on the canvas to create a multi-selection of hexes or tokens (they are mutually exclusive). Changes to color, labels (Label 1 and Label 2 for hexes), rivers and roads will apply to all selected items.

- Face control UI (river/road faces) only appears when at least one selected hex has a river or road set; checkboxes reflect per-face agreement across the selection (checked = all selected have it, indeterminate = some).

If anything above is unclear or you need examples for a specific change, ask for the exact function/file you want to modify and I will provide focused guidance or a code patch. ✅
