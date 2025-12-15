const { Plugin, FileView, PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = {
  hexmapsFolder: 'hexmaps'
};

const VIEW_TYPE_HEXMAP = "hexmap-view";

class HexmapPlugin extends Plugin {
  async onload() {
    console.log("Hexmap Plugin loaded");

    await this.loadSettings();

    // Add settings tab
    this.addSettingTab(new HexmapSettingTab(this.app, this));

    // Register custom view type
    this.registerView(
      VIEW_TYPE_HEXMAP,
      (leaf) => {
        const view = new HexmapView(leaf);
        // Link the view to its source file for proper highlighting
        if (leaf.view instanceof HexmapView && leaf.view.file) {
          view.file = leaf.view.file;
        }
        return view;
      }
    );

    // Register command palette command to create a new hexmap
    this.addCommand({
      id: "new-hexmap",
      name: "New Hexmap",
      callback: async () => {
        // Create hexmaps folder if it doesn't exist (configurable)
        const hexmapsFolder = this.settings?.hexmapsFolder || DEFAULT_SETTINGS.hexmapsFolder;
        if (!this.app.vault.getAbstractFileByPath(hexmapsFolder)) {
          await this.app.vault.createFolder(hexmapsFolder);
        }

        // Create a new .hexmap file with default JSON structure
        const defaultData = {
          title: "New Hexmap",
          zoom: 1,
          offset: { x: 0, y: 0 },
          hexes: [],
          hexNotes: {},
          hexLabels: {},
          hexLabels2: {}, // NEW: Secondary label for each hex
          hexRivers: {},  // new: river data per hex ("q,r" -> array of face numbers)
          hexRoads: {}    // new: road data per hex ("q,r" -> array of face numbers)
        };
        
        const fileName = `${hexmapsFolder}/New Hexmap ${new Date().getTime()}.hexmap`;
        try {
          await this.app.vault.create(fileName, JSON.stringify(defaultData, null, 2));
          this.app.workspace.openLinkText(fileName, "", true);
        } catch (error) {
          console.error("Error creating new hexmap file:", error);
        }
      }
    });

    // Associate .hexmap files with the custom view.
    this.registerExtensions(["hexmap"], VIEW_TYPE_HEXMAP);

    // Register event handlers for file operations
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.handleFileRename(file, oldPath))
    );
    
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.handleFileDelete(file))
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    console.log("Hexmap Plugin unloaded");
    this.app.workspace.detachLeavesOfType(HexmapView.VIEW_TYPE);
  }

  async handleFileRename(file, oldPath) {
    if (file.extension !== 'md') return;
    const hexmapFiles = this.app.vault.getFiles().filter(f => f.extension === 'hexmap');
    for (const hexmapFile of hexmapFiles) {
      try {
        const content = await this.app.vault.read(hexmapFile);
        const hexData = JSON.parse(content);
        let hasChanges = false;
        if (hexData.hexNotes) {
          for (const [hexKey, hexNote] of Object.entries(hexData.hexNotes)) {
            // Support both object form ({ notePath }) and string form
            const currentPath = (typeof hexNote === 'string') ? hexNote : hexNote?.notePath;
            if (!currentPath) continue;
            // Normalize simple leading './' differences
            const normalize = p => p.replace(/^\.\//, '');
            const basename = file.path.split('/').pop();
            if (normalize(currentPath) === normalize(oldPath) || normalize(currentPath).endsWith(basename) || normalize(currentPath) === basename) {
              if (typeof hexNote === 'string') {
                hexData.hexNotes[hexKey] = file.path;
              } else {
                hexData.hexNotes[hexKey].notePath = file.path;
              }
              hasChanges = true;
            }
          }
        }
        if (hasChanges) {
          await this.app.vault.modify(hexmapFile, JSON.stringify(hexData, null, 2));
          // If a hexmap view is open for this file, reload it so UI updates immediately
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_HEXMAP);
          for (const leaf of leaves) {
            if (leaf.view && leaf.view.file && leaf.view.file.path === hexmapFile.path) {
              try {
                await leaf.view.loadHexData();
              } catch (e) {
                console.error('Failed to reload hexmap view after rename update:', e);
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error updating references in ${hexmapFile.path}:`, error);
      }
    }
  }

  async handleFileDelete(file) {
    if (file.extension !== 'md') return;
    const hexmapFiles = this.app.vault.getFiles().filter(f => f.extension === 'hexmap');
    for (const hexmapFile of hexmapFiles) {
      try {
        const content = await this.app.vault.read(hexmapFile);
        const hexData = JSON.parse(content);
        let hasChanges = false;
        if (hexData.hexNotes) {
          for (const [hexKey, hexNote] of Object.entries(hexData.hexNotes)) {
            if (hexNote.notePath === file.path) {
              delete hexData.hexNotes[hexKey];
              hasChanges = true;
            }
          }
        }
        if (hasChanges) {
          await this.app.vault.modify(hexmapFile, JSON.stringify(hexData, null, 2));
        }
      } catch (error) {
        console.error(`Error updating references in ${hexmapFile.path}:`, error);
      }
    }
  }
}

// Plugin settings tab
class HexmapSettingTab extends PluginSettingTab {
  /** @param {import('obsidian').App} app */
  /** @param {HexmapPlugin} plugin */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Hexmap Plugin Settings' });

    new Setting(containerEl)
      .setName('Hexmaps folder')
      .setDesc('Folder where new hexmaps and per-map note folders will be created (e.g. `hexmaps`)')
      .addText(text =>
        text
          .setPlaceholder('hexmaps')
          .setValue(this.plugin.settings.hexmapsFolder)
          .onChange(async (value) => {
            this.plugin.settings.hexmapsFolder = value || DEFAULT_SETTINGS.hexmapsFolder;
            await this.plugin.saveSettings();
          })
      );
  }
}

// Custom view class for hexmap
class HexmapView extends FileView {
  static VIEW_TYPE = "hexmap-view";
  /** @type {import('obsidian').TFile|null} */
  file;
  constructor(leaf) {
    super(leaf);
    this.selectedHex = null;
    // Support multi-selection
    this.selectedHexes = new Set(); // stores "q,r" strings
    this.coloredHexes = new Map();
    this.currentColor = "#ff0000";
    this.canvas = null;
    this.canvasContainer = null;
    this.offset = { x: 0, y: 0 };
    this.zoom = 1;
    this.contextMenu = null;
    this.showCoordinates = true;
    this.isDragging = false;
    this.tokens = [];
    this.draggedToken = null;
    this.selectedToken = null;
    this.selectedTokens = new Set(); // stores token ids
    this.selectionMode = null; // 'hex' | 'token' | null
    this.tokenColors = new Map();
    this.tokenLabels = new Map();
    this.targetZoom = 1;
    this.zoomAnimation = null;
    
    // Add these new properties
    this.riverAmplitude = 3;  // Reduced amplitude for subtler curves
    this.riverFrequency = 2;  // Controls number of waves

    // Add this
    this.showLabel1 = true;  // Add this
    this.showLabel2 = true;  // Add this

    // Bind event handlers
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleContextMenu = this.handleContextMenu.bind(this);
  }

  getViewType() {
    return HexmapView.VIEW_TYPE;
  }

  getDisplayText() {
    return this.file?.basename || "Hexmap Viewer";
  }

  getViewData() {
    return this.file?.path || "";
  }

  getState() {
    return { file: this.file ? this.file.path : null };
  }

  async setState(state, result) {
    this.hexData = null;
    this.coloredHexes = new Map();
    this.offset = { x: 0, y: 0 };
    this.zoom = 1;
    if (state.file) {
      this.file = this.app.vault.getAbstractFileByPath(state.file);
    }
    await this.onOpen();
  }

  async onOpen() {
    await super.onOpen();
    this.initializeCanvas();
    if (this.file) {
        try {
            const content = await this.app.vault.read(this.file);
            this.hexData = JSON.parse(content);
            
            // Initialize all required maps and arrays
            this.coloredHexes = new Map(Object.entries(this.hexData.coloredHexes || {}));
            this.tokens = this.hexData.tokens || [];
            this.tokenColors = new Map(Object.entries(this.hexData.tokenColors || {}));
            this.tokenLabels = new Map(Object.entries(this.hexData.tokenLabels || {}));
            
            // Load visibility states
            this.showCoordinates = this.hexData.showCoordinates ?? true;
            this.showLabel1 = this.hexData.showLabel1 ?? true;      // Add this
            this.showLabel2 = this.hexData.showLabel2 ?? true;      // Add this
            
            // Ensure required properties exist
            this.hexData.hexRivers = this.hexData.hexRivers || {};
            this.hexData.hexRoads = this.hexData.hexRoads || {};
            this.hexData.hexLabels = this.hexData.hexLabels || {};
            this.hexData.hexLabels2 = this.hexData.hexLabels2 || {};
        } catch (error) {
            console.error("Error loading hexmap file:", error);
            this.hexData = {
                title: "New Hexmap",
                zoom: 1,
                offset: { x: 0, y: 0 },
                hexes: [],
                hexNotes: {},
                hexLabels: {},
                hexLabels2: {}, // NEW: default Label 2
                hexRivers: {},
                hexRoads: {}
            };
        }
    } else {
        this.hexData = {
            title: "New Hexmap",
            zoom: 1,
            offset: { x: 0, y: 0 },
            hexes: [],
            hexNotes: {},
            hexLabels: {},
            hexLabels2: {}, // NEW: default Label 2
            hexRivers: {},
            hexRoads: {}
        };
    }
    this.registerCanvasEvents();
    this.renderCanvas();
    this.registerEvent(
      this.app.vault.on('modify', (modifiedFile) => {
        if (this.file && modifiedFile.path === this.file.path) {
          this.loadHexData();
        }
      })
    );
  }

  async loadHexData() {
    if (!this.file) return;
    try {
        const content = await this.app.vault.read(this.file);
        this.hexData = JSON.parse(content);
        
        // Initialize core data
        this.zoom = this.hexData.zoom || 1;
        this.offset = this.hexData.offset || { x: 0, y: 0 };
        this.coloredHexes = new Map(Object.entries(this.hexData.coloredHexes || {}));
        this.showCoordinates = this.hexData.showCoordinates ?? true;
        this.showLabel1 = this.hexData.showLabel1 ?? true;      // Add this
        this.showLabel2 = this.hexData.showLabel2 ?? true;      // Add this
        
        // Initialize token data
        this.tokens = this.hexData.tokens || [];
        this.tokenColors = new Map(Object.entries(this.hexData.tokenColors || {}));
        this.tokenLabels = new Map(Object.entries(this.hexData.tokenLabels || {}));
        
        // Initialize hex features
        this.hexData.hexRivers = this.hexData.hexRivers || {};
        this.hexData.hexRoads = this.hexData.hexRoads || {};
        
        this.renderCanvas();
    } catch (error) {
        console.error("Failed to reload hexmap file:", error);
    }
}

  onClose() {
    window.removeEventListener("resize", this.handleResize);
    this.unregisterCanvasEvents();
    if (this.zoomAnimation) {
      cancelAnimationFrame(this.zoomAnimation);
    }
  }

  handleResize() {
    if (!this.canvas || !this.canvasContainer) return;
    const rect = this.canvasContainer.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.updateColorPickerPosition();
    this.renderCanvas();
  }

  registerCanvasEvents() {
    this.canvas.addEventListener("mousedown", this.handleMouseDown);
    this.canvas.addEventListener("mousemove", this.handleMouseMove);
    this.canvas.addEventListener("mouseup", this.handleMouseUp);
    this.canvas.addEventListener("mouseleave", this.handleMouseUp);
    this.canvas.addEventListener("wheel", this.handleWheel);
    this.canvas.addEventListener("click", this.handleClick);
    this.canvas.addEventListener("contextmenu", this.handleContextMenu);
  }

  unregisterCanvasEvents() {
    this.canvas.removeEventListener("mousedown", this.handleMouseDown);
    this.canvas.removeEventListener("mousemove", this.handleMouseMove);
    this.canvas.removeEventListener("mouseup", this.handleMouseUp);
    this.canvas.removeEventListener("mouseleave", this.handleMouseUp);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("click", this.handleClick);
    this.canvas.removeEventListener("contextmenu", this.handleContextMenu);
  }

  // Converts world coordinates to axial coordinates (flat–top)
  pixelToHex(x, y) {
    const s = 30;
    // Cube coordinate conversion for flat–top hexes
    const q = (2.0 * x) / (3.0 * s);
    const r = ((-1.0 * x) / (3.0 * s) + (Math.sqrt(3.0)/3.0 * y) / s);
    const x_cube = q;
    const z_cube = r;
    const y_cube = -x_cube - z_cube;
    let rx = Math.round(x_cube);
    let ry = Math.round(y_cube);
    let rz = Math.round(z_cube);
    const x_diff = Math.abs(rx - x_cube);
    const y_diff = Math.abs(ry - y_cube);
    const z_diff = Math.abs(rz - z_cube);
    if (x_diff > y_diff && x_diff > z_diff) {
      rx = -ry - rz;
    } else if (y_diff > z_diff) {
      ry = -rx - rz;
    } else {
      rz = -rx - ry;
    }
    return { q: rx, r: rz };
  }

  hexToPixel(q, r) {
    const s = 30;
    return {
      x: s * (3/2 * q),
      y: s * (Math.sqrt(3) * (r + q/2))
    };
  }

  // Helper to get the center of a given edge (face) for hex (q, r)
  // Faces are numbered 1 (north) through 6 clockwise.
  getFaceCenter(q, r, face) {
    const center = this.hexToPixel(q, r);
    const corners = this.getHexCorners(center.x, center.y);
    // face 1 corresponds to edge between corner0 and corner1, etc.
    const idx = (face - 1) % 6;
    const next = (idx + 1) % 6;
    return {
      x: (corners[idx].x + corners[next].x) / 2,
      y: (corners[idx].y + corners[next].y) / 2
    };
  }

  // Helper: returns an array of the six corners of a hex centered at (centerX, centerY)
  getHexCorners(centerX, centerY) {
    const corners = [];
    const s = 30; // hex size
    for (let i = 0; i < 6; i++) {
        // Offset by 180 degrees (3 positions) to start from bottom
        const angleDeg = 60 * ((i + 4) % 6);
        const angleRad = Math.PI / 180 * angleDeg;
        corners.push({
            x: centerX + s * Math.cos(angleRad),
            y: centerY + s * Math.sin(angleRad)
        });
    }
    return corners;
  }

  addToken(x, y) {
    const hex = this.pixelToHex(x, y);
    const center = this.hexToPixel(hex.q, hex.r);
    const token = {
      id: crypto.randomUUID(),
      x: center.x,
      y: center.y,
      color: '#ff0000'
    };
    this.tokens.push(token);
    this.saveHexmapData();
    this.renderCanvas();
    // Select the new token so user can edit it immediately
    this.selectedToken = token;
    this.selectedHex = null;
    this.updateSelectionUI();
  }

  handleClick(e) {
    if (this.isDragging) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - this.offset.x) / this.zoom;
    const y = (e.clientY - rect.top - this.offset.y) / this.zoom;
    const clickedToken = this.findTokenAt(x, y);
    if (clickedToken) {
      // Token clicked: support shift-multi-select
      if (e.shiftKey) {
        if (this.selectionMode !== 'token') {
          // switch to token selection mode
          this.selectedHex = null;
          this.selectedHexes.clear();
          this.selectedTokens.clear();
          this.selectionMode = 'token';
        }
        const tokenId = clickedToken.id;
        if (this.selectedTokens.has(tokenId)) this.selectedTokens.delete(tokenId);
        else this.selectedTokens.add(tokenId);
        this.selectedToken = clickedToken; // last clicked
      } else {
        // single selection
        this.selectedTokens.clear();
        this.selectedTokens.add(clickedToken.id);
        this.selectedToken = clickedToken;
        this.selectedHex = null;
        this.selectedHexes.clear();
        this.selectionMode = 'token';
      }

      // Update UI
      this.updateSelectionUI();
      this.renderCanvas();
      return;
    }

    // Clicked on map -> hex selection
    const hex = this.pixelToHex(x, y);
    const key = `${hex.q},${hex.r}`;
    if (e.shiftKey) {
      if (this.selectionMode !== 'hex') {
        this.selectedTokens.clear(); this.selectedToken = null;
        this.selectedHexes.clear();
        this.selectionMode = 'hex';
      }
      if (this.selectedHexes.has(key)) this.selectedHexes.delete(key);
      else this.selectedHexes.add(key);
      this.selectedHex = hex;
    } else {
      // single selection
      this.selectedHexes.clear();
      this.selectedHexes.add(key);
      this.selectedHex = hex;
      this.selectedToken = null;
      this.selectedTokens.clear();
      this.selectionMode = 'hex';
    }

    this.updateFaceControlPanel();
    this.updateSelectionUI();
    this.renderCanvas();
  }

  findTokenAt(x, y) {
    const tokenRadius = 20;
    return this.tokens.find(token => {
      const dx = token.x - x;
      const dy = token.y - y;
      return (dx * dx + dy * dy) <= tokenRadius * tokenRadius;
    });
  }

  handleMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - this.offset.x) / this.zoom;
    const y = (e.clientY - rect.top - this.offset.y) / this.zoom;
    this.draggedToken = this.findTokenAt(x, y);
    if (this.draggedToken) {
      e.preventDefault();
      return;
    }
    this.isPanning = true;
    this.isDragging = false;
    this.panStart = { x: e.clientX, y: e.clientY };
  }

  handleMouseMove(e) {
    if (this.draggedToken) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - this.offset.x) / this.zoom;
      const y = (e.clientY - rect.top - this.offset.y) / this.zoom;
      this.draggedToken.x = x;
      this.draggedToken.y = y;
      this.renderCanvas();
      return;
    }
    if (!this.isPanning) return;
    const dx = e.clientX - this.panStart.x;
    const dy = e.clientY - this.panStart.y;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      this.isDragging = true;
    }
    this.panStart = { x: e.clientX, y: e.clientY };
    this.offset.x += dx;
    this.offset.y += dy;
    this.renderCanvas();
  }

  handleMouseUp(e) {
    if (this.draggedToken) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - this.offset.x) / this.zoom;
      const y = (e.clientY - rect.top - this.offset.y) / this.zoom;
      const hex = this.pixelToHex(x, y);
      const center = this.hexToPixel(hex.q, hex.r);
      this.draggedToken.x = center.x;
      this.draggedToken.y = center.y;
      this.draggedToken = null;
      this.isDragging = false;
      this.saveHexmapData();
      this.renderCanvas();
      return;
    }
    this.isPanning = false;
    this.saveHexmapData();
    // Update UI in case dragging cleared selection or moved token
    this.updateSelectionUI();
  }

  handleWheel(e) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.05 : 0.95;
    this.targetZoom = this.zoom * delta;
    if (!this.zoomAnimation) {
      this.animateZoom();
    }
  }

  animateZoom() {
    const SMOOTHING = 0.3;
    const diff = this.targetZoom - this.zoom;
    if (Math.abs(diff) < 0.001) {
      this.zoom = this.targetZoom;
      this.zoomAnimation = null;
      this.saveHexmapData();
      return;
    }
    this.zoom += diff * SMOOTHING;
    this.renderCanvas();
    this.zoomAnimation = requestAnimationFrame(() => this.animateZoom());
  }

  handleContextMenu(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - this.offset.x) / this.zoom;
    const y = (e.clientY - rect.top - this.offset.y) / this.zoom;
    const hex = this.pixelToHex(x, y);
    this.showContextMenu(e.clientX, e.clientY, hex.q, hex.r);
  }

  async showContextMenu(x, y, q, r) {
    this.removeContextMenu();
    this.contextMenu = document.createElement("div");
    this.contextMenu.className = "hexmap-context-menu";
    
    const hexKey = `${q},${r}`;
    const hexData = this.hexData.hexNotes?.[hexKey];
    
    const createOrOpenNote = document.createElement("div");
    createOrOpenNote.className = "hexmap-context-menu-item";
    createOrOpenNote.textContent = hexData?.notePath ? "Open Note" : "Create Note";
    createOrOpenNote.addEventListener("click", () => {
      if (hexData?.notePath) {
        const existingFile = this.app.vault.getAbstractFileByPath(hexData.notePath);
        if (existingFile) {
          this.app.workspace.openLinkText(hexData.notePath, "", true);
          this.removeContextMenu();
          return;
        }
      }
      this.createHexNote(q, r);
      this.removeContextMenu();
    });
    this.contextMenu.appendChild(createOrOpenNote);

    const addToken = document.createElement("div");
    addToken.className = "hexmap-context-menu-item";
    addToken.textContent = "Add Token";
    addToken.addEventListener("click", () => {
      const center = this.hexToPixel(q, r);
      this.addToken(center.x, center.y);
      this.removeContextMenu();
    });
    this.contextMenu.appendChild(addToken);
    const tokensInHex = this.findTokensInHex(q, r);
    if (tokensInHex.length > 0) {
      const deleteTokens = document.createElement("div");
      deleteTokens.className = "hexmap-context-menu-item";
      deleteTokens.textContent = `Delete Token${tokensInHex.length > 1 ? 's' : ''}`;
      deleteTokens.addEventListener("click", () => {
        if (confirm(`Delete ${tokensInHex.length} token${tokensInHex.length > 1 ? 's' : ''}?`)) {
          this.deleteTokensInHex(q, r);
        }
        this.removeContextMenu();
      });
      this.contextMenu.appendChild(deleteTokens);
    }

    if (this.hasCustomData(q, r)) {
      const resetHex = document.createElement("div");
      resetHex.className = "hexmap-context-menu-item";
      resetHex.textContent = "Reset Hex";
      resetHex.addEventListener("click", () => {
        if (confirm("Reset this hex to default state?")) {
          const clickedKey = `${q},${r}`;
          if (this.selectionMode === 'hex' && this.selectedHexes.size > 0 && this.selectedHexes.has(clickedKey)) {
            for (const hk of Array.from(this.selectedHexes)) {
              const [qq, rr] = hk.split(',').map(Number);
              this.resetHexData(qq, rr);
            }
          } else {
            this.resetHexData(q, r);
          }
        }
        this.removeContextMenu();
      });
      this.contextMenu.appendChild(resetHex);
    }

    // Toggle River option
    const toggleRiver = document.createElement("div");
    toggleRiver.className = "hexmap-context-menu-item";
    toggleRiver.textContent = "Toggle River";
    toggleRiver.addEventListener("click", () => {
      // If multiple hexes selected and the clicked hex is part of selection, toggle for all selected
      const targetHexes = (this.selectionMode === 'hex' && this.selectedHexes.size > 0 && this.selectedHexes.has(hexKey)) ? Array.from(this.selectedHexes) : [hexKey];
      for (const hk of targetHexes) {
        if (!this.hexData.hexRivers) this.hexData.hexRivers = {};
        if (!this.hexData.hexRivers[hk]) {
          this.hexData.hexRivers[hk] = [1];
        } else {
          delete this.hexData.hexRivers[hk];
        }
      }
      this.saveHexmapData();
      this.renderCanvas();
      this.updateFaceControlPanel();
      this.removeContextMenu();
    });
    this.contextMenu.appendChild(toggleRiver);

    // Toggle Road option
    const toggleRoad = document.createElement("div");
    toggleRoad.className = "hexmap-context-menu-item";
    toggleRoad.textContent = "Toggle Road";
    toggleRoad.addEventListener("click", () => {
      const targetHexes = (this.selectionMode === 'hex' && this.selectedHexes.size > 0 && this.selectedHexes.has(hexKey)) ? Array.from(this.selectedHexes) : [hexKey];
      for (const hk of targetHexes) {
        if (!this.hexData.hexRoads) this.hexData.hexRoads = {};
        if (!this.hexData.hexRoads[hk]) {
          this.hexData.hexRoads[hk] = [2];
        } else {
          delete this.hexData.hexRoads[hk];
        }
      }
      this.saveHexmapData();
      this.renderCanvas();
      this.updateFaceControlPanel();
      this.removeContextMenu();
    });
    this.contextMenu.appendChild(toggleRoad);

    const copyHex = document.createElement("div");
    copyHex.className = "hexmap-context-menu-item";
    copyHex.textContent = "Copy Hex Data";
    copyHex.addEventListener("click", () => {
      this.copyHexData(q, r);
      this.removeContextMenu();
    });
    
    const pasteHex = document.createElement("div");
    pasteHex.className = "hexmap-context-menu-item";
    pasteHex.textContent = "Paste Hex Data";
    pasteHex.addEventListener("click", () => {
      this.pasteHexData(q, r);
      this.removeContextMenu();
    });
    
    this.contextMenu.appendChild(copyHex);
    this.contextMenu.appendChild(pasteHex);
    
    this.contextMenu.style.left = `${x}px`;
    this.contextMenu.style.top = `${y}px`;
    
    document.body.appendChild(this.contextMenu);
    
    setTimeout(() => {
      document.addEventListener("click", this.removeContextMenu.bind(this), { once: true });
    }, 0);
  }

  async copyHexData(q, r) {
    const hexKey = `${q},${r}`;
    // Create object with all possible hex data
    const hexData = {
      position: { q, r },
      // Only include properties that exist for this hex
      ...(this.coloredHexes.has(hexKey) && { 
        color: this.coloredHexes.get(hexKey) 
      }),
      ...(this.hexData.hexLabels?.[hexKey] && { 
        label: this.hexData.hexLabels[hexKey] 
      }),
      ...(this.hexData.hexLabels2?.[hexKey] && { 
        label2: this.hexData.hexLabels2[hexKey] 
      }),
      ...(this.hexData.hexNotes?.[hexKey] && { 
        note: this.hexData.hexNotes[hexKey] 
      }),
      ...(this.hexData.hexRivers?.[hexKey] && { 
        rivers: this.hexData.hexRivers[hexKey] 
      }),
      ...(this.hexData.hexRoads?.[hexKey] && { 
        roads: this.hexData.hexRoads[hexKey] 
      })
    };
  
    try {
      await navigator.clipboard.writeText(JSON.stringify(hexData));
    } catch (error) {
      console.error("Failed to copy hex data:", error);
    }
  }
  
  async pasteHexData(q, r) {
    try {
      const text = await navigator.clipboard.readText();
      let hexData;
      try {
        hexData = JSON.parse(text);
      } catch {
        console.warn("Clipboard content is not valid hex data");
        return;
      }
      
      if (!hexData || typeof hexData !== 'object') return;
      
      const hexKey = `${q},${r}`;
      
      // Handle each possible property
      if (hexData.color) {
        this.coloredHexes.set(hexKey, hexData.color);
      }
      
      if (hexData.label) {
        if (!this.hexData.hexLabels) this.hexData.hexLabels = {};
        this.hexData.hexLabels[hexKey] = hexData.label;
      }
      
      if (hexData.label2) {
        if (!this.hexData.hexLabels2) this.hexData.hexLabels2 = {};
        this.hexData.hexLabels2[hexKey] = hexData.label2;
      }
      
      if (hexData.note) {
        if (!this.hexData.hexNotes) this.hexData.hexNotes = {};
        this.hexData.hexNotes[hexKey] = hexData.note;
      }
      
      if (hexData.rivers) {
        if (!this.hexData.hexRivers) this.hexData.hexRivers = {};
        this.hexData.hexRivers[hexKey] = hexData.rivers;
      }
      
      if (hexData.roads) {
        if (!this.hexData.hexRoads) this.hexData.hexRoads = {};
        this.hexData.hexRoads[hexKey] = hexData.roads;
      }
      
      await this.saveHexmapData();
      this.renderCanvas();
      this.updateFaceControlPanel();
    } catch (error) {
      console.error("Failed to paste hex data:", error);
    }
  }

  async createHexNote(q, r) {
    const hexKey = `${q},${r}`;
    if (this.hexData.hexNotes?.[hexKey]?.notePath) {
      const existingPath = this.hexData.hexNotes[hexKey].notePath;
      const existingFile = this.app.vault.getAbstractFileByPath(existingPath);
      if (existingFile) {
        this.app.workspace.openLinkText(existingPath, "", true);
        return;
      }
    }
    const hexmapName = this.file?.basename;
    if (!hexmapName) {
      console.error("No hexmap file open");
      return;
    }
    const noteName = `Hex ${q},${r}`;

    // Put per-map notes next to the hexmap file (same folder as the .hexmap file)
    const hexmapPath = this.file?.path || null;
    const parentFolder = hexmapPath && hexmapPath.includes('/') ? hexmapPath.substring(0, hexmapPath.lastIndexOf('/')) : null;
    const mapFolderName = hexmapName;
    const folderPath = parentFolder ? `${parentFolder}/${mapFolderName}` : `${mapFolderName}`;
    const notePath = `${folderPath}/${noteName}.md`;

    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }
    try {
      await this.app.vault.create(notePath, `# ${noteName}\n\n`);
      if (!this.hexData.hexNotes) this.hexData.hexNotes = {};
      this.hexData.hexNotes[hexKey] = { notePath };
      await this.saveHexmapData();
      this.app.workspace.openLinkText(notePath, "", true);
    } catch (error) {
      console.error("Error creating hex note:", error);
    }
  }

  removeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  // NEW: Face Control Panel UI (below colorpicker)
  updateFaceControlPanel() {
    if (!this.faceControlPanel) return;
    this.faceControlPanel.innerHTML = "";

    const selectedHexKeys = Array.from(this.selectedHexes || []);
    if (!selectedHexKeys || selectedHexKeys.length === 0) {
      this.faceControlPanel.style.display = "none";
      return;
    }

    // Determine whether any selected hexes actually have rivers or roads
    const anyHasRiver = selectedHexKeys.some(hk => this.hexData.hexRivers && this.hexData.hexRivers[hk] && this.hexData.hexRivers[hk].length > 0);
    const anyHasRoad = selectedHexKeys.some(hk => this.hexData.hexRoads && this.hexData.hexRoads[hk] && this.hexData.hexRoads[hk].length > 0);

    // If neither rivers nor roads are present on selected hexes, hide the panel
    if (!anyHasRiver && !anyHasRoad) {
      this.faceControlPanel.style.display = "none";
      return;
    }

    this.faceControlPanel.style.display = "flex";
    this.faceControlPanel.style.flexDirection = "column";

    if (anyHasRiver) {
      // Show river editor for selected hexes
      const riverSection = document.createElement("div");
      riverSection.className = "face-editor-section";
      const riverLabel = document.createElement("span");
      riverLabel.textContent = "River Faces:";
      riverSection.appendChild(riverLabel);
      for (let i = 1; i <= 6; i++) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.face = i;

        // Determine checked/indeterminate across all selected hexes
        let count = 0;
        for (const hk of selectedHexKeys) {
          if (this.hexData.hexRivers && this.hexData.hexRivers[hk] && this.hexData.hexRivers[hk].includes(i)) count++;
        }
        checkbox.checked = (count === selectedHexKeys.length);
        checkbox.indeterminate = (count > 0 && count < selectedHexKeys.length);

        checkbox.addEventListener("change", (e) => {
          const face = parseInt(e.target.dataset.face);
          const shouldHave = e.target.checked;
          for (const hk of selectedHexKeys) {
            if (!this.hexData.hexRivers) this.hexData.hexRivers = {};
            let faces = this.hexData.hexRivers[hk] || [];
            if (shouldHave) {
              if (!faces.includes(face)) faces.push(face);
            } else {
              faces = faces.filter(f => f !== face);
            }
            this.hexData.hexRivers[hk] = faces;
          }
          this.saveHexmapData();
          this.renderCanvas();
          this.updateFaceControlPanel();
        });
        riverSection.appendChild(checkbox);
        const faceLabel = document.createElement("label");
        faceLabel.textContent = i;
        riverSection.appendChild(faceLabel);
      }
      this.faceControlPanel.appendChild(riverSection);
    }

    if (anyHasRoad) {
      // Show road editor for selected hexes
      const roadSection = document.createElement("div");
      roadSection.className = "face-editor-section";
      const roadLabel = document.createElement("span");
      roadLabel.textContent = "Road Faces:";
      roadSection.appendChild(roadLabel);
      for (let i = 1; i <= 6; i++) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.face = i;

        let count = 0;
        for (const hk of selectedHexKeys) {
          if (this.hexData.hexRoads && this.hexData.hexRoads[hk] && this.hexData.hexRoads[hk].includes(i)) count++;
        }
        checkbox.checked = (count === selectedHexKeys.length);
        checkbox.indeterminate = (count > 0 && count < selectedHexKeys.length);

        checkbox.addEventListener("change", (e) => {
          const face = parseInt(e.target.dataset.face);
          const shouldHave = e.target.checked;
          for (const hk of selectedHexKeys) {
            if (!this.hexData.hexRoads) this.hexData.hexRoads = {};
            let faces = this.hexData.hexRoads[hk] || [];
            if (shouldHave) {
              if (!faces.includes(face)) faces.push(face);
            } else {
              faces = faces.filter(f => f !== face);
            }
            this.hexData.hexRoads[hk] = faces;
          }
          this.saveHexmapData();
          this.renderCanvas();
          this.updateFaceControlPanel();
        });
        roadSection.appendChild(checkbox);
        const faceLabel = document.createElement("label");
        faceLabel.textContent = i;
        roadSection.appendChild(faceLabel);
      }
      this.faceControlPanel.appendChild(roadSection);
      this.updateColorPickerPosition();
    }
  }

  // Rendering: draw hex grid, then rivers, then roads, then tokens.
  renderCanvas() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.translate(this.offset.x, this.offset.y);
    ctx.scale(this.zoom, this.zoom);
    this.drawHexGrid(ctx);
    this.drawRivers(ctx);
    this.drawRoads(ctx);
    this.tokens.forEach(token => {
      ctx.beginPath();
      const tokenRadius = 20;
      ctx.arc(token.x, token.y, tokenRadius, 0, Math.PI * 2);
      const tokenKey = `${token.id}`;
      ctx.fillStyle = this.tokenColors.get(tokenKey) || token.color || '#ff0000';
      ctx.fill();
      if (this.selectedTokens && this.selectedTokens.has(token.id)) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
      }
      ctx.stroke();
      const label = this.tokenLabels.get(tokenKey);
      if (label) {
        ctx.fillStyle = '#000000';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, token.x, token.y);
      }
    });
    ctx.restore();
    this.updateColorPickerPosition();
  }

  // NEW: Draw rivers as curves.
  // If only one face is selected, draw a curve from that face center to the hex center.
  drawRivers(ctx) {
    if (!this.hexData?.hexRivers) return;
    ctx.save();
    ctx.lineWidth = 3; // Increase this value to make rivers thicker
    ctx.strokeStyle = "#0000ff";
    ctx.lineWidth = 3;
    for (const hexKey in this.hexData.hexRivers) {
        const [q, r] = hexKey.split(",").map(Number);
        const center = this.hexToPixel(q, r);
        const faces = this.hexData.hexRivers[hexKey];

        // Process pairs
        for (let i = 0; i < faces.length - 1; i += 2) {
            const faceA = this.getFaceCenter(q, r, faces[i]);
            const faceB = this.getFaceCenter(q, r, faces[i + 1]);
            const center = this.hexToPixel(q, r);

            ctx.beginPath();
            ctx.moveTo(faceA.x, faceA.y);
            
            // Add points along the curved path with sine wave distortion
            const steps = 20;
            for (let t = 0; t <= steps; t++) {
                const progress = t / steps;
                
                // Calculate point along quadratic curve through center
                const t1 = 1 - progress;
                const t2 = progress;
                const baseX = t1 * t1 * faceA.x + 2 * t1 * t2 * center.x + t2 * t2 * faceB.x;
                const baseY = t1 * t1 * faceA.y + 2 * t1 * t2 * center.y + t2 * t2 * faceB.y;
                
                // Modified envelope function - flat sections at start/end
                const buffer = 0.2;
                let envelope = 0;
                if (progress > buffer && progress < (1 - buffer)) {
                    const adjustedProgress = (progress - buffer) / (1 - 2 * buffer);
                    envelope = Math.sin(adjustedProgress * Math.PI);
                }
                
                const adjustedAmplitude = this.riverAmplitude * envelope;
                const distortion = Math.sin(progress * Math.PI * this.riverFrequency) * adjustedAmplitude;
                
                // Calculate perpendicular offset direction
                const dx = -(faceB.y - faceA.y);
                const dy = faceB.x - faceA.x;
                const len = Math.sqrt(dx * dx + dy * dy);
                
                // Apply distortion perpendicular to the curve
                const offsetX = baseX + (dx / len) * distortion;
                const offsetY = baseY + (dy / len) * distortion;
                
                if (t === 0) ctx.moveTo(offsetX, offsetY);
                else ctx.lineTo(offsetX, offsetY);
            }
            ctx.stroke();
        }

        // Handle single face or odd number of faces
        if (faces.length % 2 === 1) {
            const lastFace = faces[faces.length - 1];
            const faceCenter = this.getFaceCenter(q, r, lastFace);
            ctx.beginPath();
            ctx.moveTo(faceCenter.x, faceCenter.y);
            
            // Add sine wave to center path
            const steps = 10;
            for (let t = 0; t <= steps; t++) {
                const progress = t / steps;
                const x = faceCenter.x + (center.x - faceCenter.x) * progress;
                const y = faceCenter.y + (center.y - faceCenter.y) * progress;
                
                const amplitude = 3; // Smaller amplitude for center paths
                const frequency = 2;
                const distortion = Math.sin(progress * Math.PI * frequency) * amplitude;
                
                const dx = -(center.y - faceCenter.y);
                const dy = center.x - faceCenter.x;
                const len = Math.sqrt(dx * dx + dy * dy);
                
                const offsetX = x + (dx / len) * distortion;
                const offsetY = y + (dy / len) * distortion;
                
                if (t === 0) ctx.moveTo(offsetX, offsetY);
                else ctx.lineTo(offsetX, offsetY);
            }
            ctx.stroke();
        }
    }
    ctx.restore();
  }

  // NEW: Draw roads as curves (above rivers).
  // Same logic applies as with rivers.
  drawRoads(ctx) {
    if (!this.hexData?.hexRoads) return;
    ctx.save();
    ctx.strokeStyle = "#804000";
    ctx.lineWidth = 4;
    for (const hexKey in this.hexData.hexRoads) {
      const [q, r] = hexKey.split(",").map(Number);
      const center = this.hexToPixel(q, r);
      const faces = this.hexData.hexRoads[hexKey];
      for (let i = 0; i < faces.length - 1; i += 2) {
        const faceA = this.getFaceCenter(q, r, faces[i]);
        const faceB = this.getFaceCenter(q, r, faces[i + 1]);
        ctx.beginPath();
        ctx.moveTo(faceA.x, faceA.y);
        ctx.quadraticCurveTo(center.x, center.y, faceB.x, faceB.y);
        ctx.stroke();
      }
      if (faces.length % 2 === 1) {
        const lastFace = faces[faces.length - 1];
        const faceCenter = this.getFaceCenter(q, r, lastFace);
        ctx.beginPath();
        ctx.moveTo(faceCenter.x, faceCenter.y);
        ctx.quadraticCurveTo(center.x, center.y, center.x, center.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawHexGrid(ctx) {
    const s = 30;
    const worldWidth = this.canvas.width / this.zoom;
    const worldHeight = this.canvas.height / this.zoom;
    const minX = -this.offset.x / this.zoom - s;
    const minY = -this.offset.y / this.zoom - s;
    const maxX = minX + worldWidth + s;
    const maxY = minY + worldHeight + s;
    const qMin = Math.floor((2 * minX) / (3 * s)) - 1;
    const qMax = Math.ceil((2 * maxX) / (3 * s)) + 1;
    for (let q = qMin; q <= qMax; q++) {
      const rMin = Math.floor((minY / (Math.sqrt(3) * s)) - (q / 2)) - 1;
      const rMax = Math.ceil((maxY / (Math.sqrt(3) * s)) - (q / 2)) + 1;
      for (let r = rMin; r <= rMax; r++) {
        const centerX = s * (3/2 * q);
        const centerY = s * (Math.sqrt(3) * (r + q/2));
        this.drawHex(ctx, centerX, centerY, s, q, r, this.showCoordinates);
      }
    }
  }

  drawHex(ctx, centerX, centerY, s, q, r, showCoords = true) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle_deg = 60 * i;
      const angle_rad = Math.PI / 180 * angle_deg;
      const x = centerX + s * Math.cos(angle_rad);
      const y = centerY + s * Math.sin(angle_rad);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const hexKey = `${q},${r}`; // Changed from 'key' to 'hexKey'
    if (this.coloredHexes.has(hexKey)) {
      ctx.fillStyle = this.coloredHexes.get(hexKey);
      ctx.fill();
    }
    const isSelectedHex = this.selectedHexes && this.selectedHexes.has(hexKey);
    if (isSelectedHex) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#0066ff";
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#555";
    }
    ctx.stroke();
    ctx.save();
    ctx.fillStyle = "#555";
    ctx.font = "10px Arial";
    ctx.textAlign = "center";
    
    if (showCoords && this.showCoordinates) {
      const coordsY = centerY + s * 0.5;
      ctx.fillText(`${q},${r}`, centerX, coordsY);
    }
    
    // Use hexKey instead of declaring 'key' again
    if (this.showLabel1) {
      const label = this.hexData?.hexLabels?.[hexKey];
      if (label) {
        ctx.font = "12px Arial";
        ctx.fillText(label, centerX, centerY);
      }
    }
    
    if (this.showLabel2) {
      const label2 = this.hexData?.hexLabels2?.[hexKey];
      if (label2) {
        ctx.font = "10px Arial";
        ctx.fillText(label2, centerX, centerY - s * 0.5);
      }
    }
    
    ctx.restore();
  }

  colorHex(q, r, color) {
    const key = `${q},${r}`;
    this.coloredHexes.set(key, color);
    this.saveHexmapData();
    this.renderCanvas();
  }

  async saveHexmapData() {
    if (!this.hexData) {
        this.hexData = {
            coloredHexes: {},
            hexLabels: {},
            hexLabels2: {},
            hexNotes: {},
            zoom: this.zoom,
            offset: { x: 0, y: 0 },
            tokens: [],
            tokenColors: {},
            tokenLabels: {},
            hexRivers: {},
            hexRoads: {},
            showCoordinates: this.showCoordinates,
            showLabel1: this.showLabel1,      // Add this
            showLabel2: this.showLabel2       // Add this
        };
    }

    // Save all state data
    this.hexData.zoom = this.zoom;
    this.hexData.offset = this.offset;
    this.hexData.title = this.getDisplayText();
    this.hexData.coloredHexes = Object.fromEntries(this.coloredHexes);
    this.hexData.showCoordinates = this.showCoordinates;
    this.hexData.showLabel1 = this.showLabel1;      // Add this
    this.hexData.showLabel2 = this.showLabel2;      // Add this
    this.hexData.tokens = this.tokens;
    this.hexData.tokenColors = Object.fromEntries(this.tokenColors);
    this.hexData.tokenLabels = Object.fromEntries(this.tokenLabels);

    if (this.file) {
        try {
            await this.app.vault.modify(this.file, JSON.stringify(this.hexData, null, 2));
        } catch (error) {
            console.error("Error saving hexmap file:", error);
        }
    }
}

  resetView() {
    this.zoom = 1;
    this.offset = { x: 0, y: 0 };
    this.renderCanvas();
    this.saveHexmapData();
  }

  initializeCanvas() {
    if (this.canvasContainer) return;
    this.canvasContainer = document.createElement("div");
    this.canvasContainer.style.position = "relative";
    this.canvasContainer.style.width = "100%";
    this.canvasContainer.style.height = "100%";
    this.containerEl.children[1].appendChild(this.canvasContainer);
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvasContainer.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Create the color picker container
    this.colorPickerContainer = document.createElement("div");
    this.colorPickerContainer.className = "hexmap-color-picker";
    
    const labelContainer = document.createElement("span");
    labelContainer.style.marginRight = "8px";
    const labelText = document.createElement("span");
    labelText.textContent = "Label";
    labelText.style.marginRight = "4px";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.placeholder = "Label";
    labelInput.className = "label-input";
    labelInput.addEventListener("input", (e) => {
      // Apply label change to all selected tokens or hexes
      const value = e.target.value;
      if (this.selectedTokens && this.selectedTokens.size > 0) {
        for (const tokenId of this.selectedTokens) {
          this.tokenLabels.set(tokenId, value);
        }
      } else if (this.selectedHexes && this.selectedHexes.size > 0) {
        if (!this.hexData.hexLabels) this.hexData.hexLabels = {};
        for (const hexKey of this.selectedHexes) {
          if (value) this.hexData.hexLabels[hexKey] = value;
          else delete this.hexData.hexLabels[hexKey];
        }
      }
      this.saveHexmapData();
      this.renderCanvas();
    });
    labelContainer.appendChild(labelText);
    labelContainer.appendChild(labelInput);
    this.labelInput = labelInput;
    this.labelContainer = labelContainer;
    
    // NEW: Create Label 2 input, next to the current label UI
    const label2Container = document.createElement("span");
    label2Container.style.marginRight = "8px";
    const label2Text = document.createElement("span");
    label2Text.textContent = "Label 2";
    label2Text.style.marginRight = "4px";
    const label2Input = document.createElement("input");
    label2Input.type = "text";
    label2Input.placeholder = "Label 2";
    label2Input.className = "label2-input";
    label2Input.addEventListener("input", (e) => {
      // Apply Label2 change to all selected hexes
      const value = e.target.value;
      if (this.selectedHexes && this.selectedHexes.size > 0) {
        if (!this.hexData.hexLabels2) this.hexData.hexLabels2 = {};
        for (const hexKey of this.selectedHexes) {
          if (value) this.hexData.hexLabels2[hexKey] = value;
          else delete this.hexData.hexLabels2[hexKey];
        }
        this.saveHexmapData();
        this.renderCanvas();
      }
    });
    label2Container.appendChild(label2Text);
    label2Container.appendChild(label2Input);
    this.label2Input = label2Input;
    this.label2Container = label2Container;
    
    this.colorPickerContainer.appendChild(labelContainer);
    this.colorPickerContainer.appendChild(label2Container);
    this.colorPickerContainer.appendChild(document.createTextNode(" | "));
    
    const colorLabel = document.createElement("span");
    colorLabel.textContent = "Color";
    this.colorLabel = colorLabel;
    this.colorPickerContainer.appendChild(colorLabel);
    
    this.colorPicker = document.createElement("input");
    this.colorPicker.type = "color";
    this.colorPicker.className = "color-input";
    this.colorPicker.value = this.currentColor;
    this.colorPicker.addEventListener("input", (e) => {
      const value = e.target.value;
      if (this.selectedTokens && this.selectedTokens.size > 0) {
        for (const tokenId of this.selectedTokens) {
          this.tokenColors.set(tokenId, value);
        }
      } else if (this.selectedHexes && this.selectedHexes.size > 0) {
        for (const hexKey of this.selectedHexes) {
          this.coloredHexes.set(hexKey, value);
        }
      }
      this.renderCanvas();
      this.saveHexmapData();
    });
    
    const resetButton = document.createElement("button");
    resetButton.className = "hexmap-button";
    resetButton.textContent = "Reset View";
    resetButton.addEventListener("click", () => this.resetView());
    
    this.colorPickerContainer.appendChild(this.colorPicker);
    this.colorPickerContainer.appendChild(resetButton);
    this.canvasContainer.appendChild(this.colorPickerContainer);

    // Initially hide label/color fields until a selection is made
    this.updateSelectionUI();

    // NEW: Create face control panel below the color picker container.
    this.faceControlPanel = document.createElement("div");
    this.faceControlPanel.className = "face-control-panel";
    this.faceControlPanel.style.display = "none";
    this.canvasContainer.appendChild(this.faceControlPanel);

    // Create a new settings panel
    this.settingsPanel = document.createElement("div");
    this.settingsPanel.className = "hexmap-color-picker"; // Reuse existing styles for consistency

    // Create toggles container with horizontal flex layout
    const togglesContainer = document.createElement("div");
    togglesContainer.style.display = "flex";
    togglesContainer.style.flexDirection = "row";  // Changed from column to row
    togglesContainer.style.gap = "12px";          // Increased gap for horizontal spacing
    togglesContainer.style.alignItems = "center";  // Center items vertically
    togglesContainer.style.padding = "4px 8px";    // Add some padding

    // Coordinates toggle
    const coordToggle = document.createElement("input");
    coordToggle.type = "checkbox";
    coordToggle.id = "hexCoordToggle";
    coordToggle.checked = this.showCoordinates;
    coordToggle.addEventListener("change", (e) => {
      this.showCoordinates = e.target.checked;
      this.renderCanvas();
      this.saveHexmapData();
    });
    const coordLabel = document.createElement("label");
    coordLabel.htmlFor = "hexCoordToggle";
    coordLabel.appendChild(coordToggle);
    coordLabel.appendChild(document.createTextNode(" Coordinates"));

    // Label 1 toggle
    const label1Toggle = document.createElement("input");
    label1Toggle.type = "checkbox";
    label1Toggle.id = "hexLabel1Toggle";
    label1Toggle.checked = this.showLabel1;
    label1Toggle.addEventListener("change", (e) => {
      this.showLabel1 = e.target.checked;
      this.renderCanvas();
      this.saveHexmapData();
    });
    const label1Label = document.createElement("label");
    label1Label.htmlFor = "hexLabel1Toggle";
    label1Label.appendChild(label1Toggle);
    label1Label.appendChild(document.createTextNode(" Label 1"));

    // Label 2 toggle
    const label2Toggle = document.createElement("input");
    label2Toggle.type = "checkbox";
    label2Toggle.id = "hexLabel2Toggle";
    label2Toggle.checked = this.showLabel2;
    label2Toggle.addEventListener("change", (e) => {
      this.showLabel2 = e.target.checked;
      this.renderCanvas();
      this.saveHexmapData();
    });
    const label2Label = document.createElement("label");
    label2Label.htmlFor = "hexLabel2Toggle";
    label2Label.appendChild(label2Toggle);
    label2Label.appendChild(document.createTextNode(" Label 2"));

    togglesContainer.appendChild(coordLabel);
    togglesContainer.appendChild(label1Label);
    togglesContainer.appendChild(label2Label);
    this.settingsPanel.appendChild(togglesContainer);
    this.canvasContainer.appendChild(this.settingsPanel);

    this.registerCanvasEvents();
    this.handleResize();

    if (!this.hexData) {
      this.hexData = {
        coloredHexes: {}, // Changed from hexColors
        hexLabels: {},
        hexLabels2: {}, // NEW: default Label 2
        hexNotes: {},
        zoom: 1,
        offset: { x: 0, y: 0 },
        hexRivers: {},
        hexRoads: {}
      };
    }
    
    this.hexData.hexLabels = this.hexData.hexLabels || {};
    this.hexData.coloredHexes = this.hexData.coloredHexes || {}; // Changed from hexColors
    this.hexData.hexNotes = this.hexData.hexNotes || {};
  }

  updateColorPickerPosition() {
    if (!this.canvas || !this.colorPickerContainer) return;
    const padding = 10;
    const rect = this.canvasContainer.getBoundingClientRect();
    
    // Position color picker at the far left of the UI bar to avoid clipping on the right
    // ensure container won't exceed available width
    const availableWidth = Math.max(50, rect.width - padding * 2);
    this.colorPickerContainer.style.maxWidth = `${availableWidth}px`;
    // Recompute the picker's rect after maxWidth is applied so measurements are accurate
    const pickerRect = this.colorPickerContainer.getBoundingClientRect();
    let left = padding; // always align to left padding (far left of UI bar)
    // If the picker is wider than available space, maxWidth will reduce it; keep it left-aligned
    let top = padding;
    // clamp vertical position
    if (top + pickerRect.height > rect.height - padding) top = Math.max(padding, rect.height - pickerRect.height - padding);
    this.colorPickerContainer.style.left = `${left}px`;
    this.colorPickerContainer.style.top = `${top}px`;
    
    // Position settings panel relative to the color picker (compact horizontal layout when possible)
    if (this.settingsPanel) {
      const settingsRect = this.settingsPanel.getBoundingClientRect();
      this.settingsPanel.style.maxWidth = `${availableWidth}px`;
      const colorPickerHeight = this.colorPickerContainer.getBoundingClientRect().height || 0;
      const gap = 6; // compact gap between elements
      // Try compact top-row layout: colorPicker -> settings -> facePanel
      let sLeft = left + pickerRect.width + gap; // place settings to the right of color picker
      let sTop = padding;
      if (sLeft + settingsRect.width > rect.width - padding) {
        // Not enough horizontal room — stack settings under the color picker
        sLeft = padding;
        sTop = padding + colorPickerHeight + gap;
      }
      if (sTop + settingsRect.height > rect.height - padding) sTop = Math.max(padding, rect.height - settingsRect.height - padding);
      this.settingsPanel.style.left = `${sLeft}px`;
      this.settingsPanel.style.top = `${sTop}px`;
    }
    
    // Position face control panel below settings panel
    if (this.faceControlPanel && this.faceControlPanel.style.display !== "none") {
      const faceRect = this.faceControlPanel.getBoundingClientRect();
      this.faceControlPanel.style.maxWidth = `${availableWidth}px`;
      // If the panel is taller than the available height, allow scrolling
      const availableHeight = Math.max(50, rect.height - padding * 2);
      this.faceControlPanel.style.maxHeight = `${availableHeight}px`;
      this.faceControlPanel.style.overflowY = 'auto';
      const colorPickerHeight = this.colorPickerContainer.getBoundingClientRect().height || 0;
      const settingsPanelHeight = this.settingsPanel ? this.settingsPanel.getBoundingClientRect().height : 0;
      // Ensure face-control panel appears BELOW the main UI bar (color picker + settings)
      // and does not overlap the top-row UI elements.
      const gap = 6;
      const settingsRect2 = this.settingsPanel ? this.settingsPanel.getBoundingClientRect() : { width: 0, height: 0, top: padding };

      // Determine whether the settings panel is in the top row (sTop === padding) or stacked below
      const settingsInTopRow = this.settingsPanel && (parseFloat(this.settingsPanel.style.top || 0) === padding);

      // Compute top-row height
      let topRowHeight = colorPickerHeight;
      if (this.settingsPanel) {
        if (settingsInTopRow) {
          topRowHeight = Math.max(colorPickerHeight, settingsRect2.height);
        } else {
          // settings stacked beneath the color picker
          topRowHeight = colorPickerHeight + gap + settingsRect2.height;
        }
      }

      // Place face panel left-aligned under the top UI bar, with a small gap
      let fLeft = padding;
      let fTop = padding + topRowHeight + gap;

      // Clamp horizontally so it doesn't overflow the container
      if (fLeft + faceRect.width > rect.width - padding) fLeft = Math.max(padding, rect.width - faceRect.width - padding);
      // Clamp vertically to keep within viewport
      if (fTop + faceRect.height > rect.height - padding) fTop = Math.max(padding, rect.height - faceRect.height - padding);

      this.faceControlPanel.style.left = `${fLeft}px`;
      this.faceControlPanel.style.top = `${fTop}px`;
    }
  }

  onResize() {
    super.onResize();
    this.handleResize();
  }

  onUnload() {
    this.canvas = null;
    this.canvasContainer = null;
    super.onUnload();
  }

  findTokensInHex(q, r) {
    const center = this.hexToPixel(q, r);
    const tokenRadius = 20;
    return this.tokens.filter(token => {
      const dx = token.x - center.x;
      const dy = token.y - center.y;
      return (dx * dx + dy * dy) <= tokenRadius * tokenRadius;
    });
  }

  deleteTokensInHex(q, r) {
    const tokensToDelete = this.findTokensInHex(q, r);
    const idsToDelete = new Set(tokensToDelete.map(t => t.id));
    this.tokens = this.tokens.filter(token => !idsToDelete.has(token.id));
    // Remove deleted tokens from selection
    for (const id of idsToDelete) {
      if (this.selectedTokens && this.selectedTokens.has(id)) this.selectedTokens.delete(id);
      if (this.selectedToken && this.selectedToken.id === id) this.selectedToken = null;
    }
    this.saveHexmapData();
    this.renderCanvas();
  }

  hasCustomData(q, r) {
    const hexKey = `${q},${r}`;
    return !!(
      this.coloredHexes.get(hexKey) ||
      (this.hexData?.hexLabels && this.hexData.hexLabels[hexKey]) ||
      (this.hexData?.hexNotes && this.hexData.hexNotes[hexKey])
    );
  }

  resetHexData(q, r) {
    const hexKey = `${q},${r}`;
    this.coloredHexes.delete(hexKey);
    if (this.hexData.hexLabels) delete this.hexData.hexLabels[hexKey];
    if (this.hexData.hexNotes) delete this.hexData.hexNotes[hexKey];
    this.saveHexmapData();
    this.renderCanvas();

    // If this hex was part of the current selection, remove it and update UI
    if (this.selectedHexes && this.selectedHexes.has(hexKey)) {
      this.selectedHexes.delete(hexKey);
      if (this.selectedHex && this.selectedHex.q === q && this.selectedHex.r === r) {
        this.selectedHex = null;
      }
      if (this.selectedHexes.size === 0) this.selectionMode = null;
      this.updateSelectionUI();
      this.updateFaceControlPanel();
    }
  }

  // Update visibility and values of label & color UI elements based on current selection
  updateSelectionUI() {
    const hasHex = !!(this.selectedHexes && this.selectedHexes.size > 0);
    const hasToken = !!(this.selectedTokens && this.selectedTokens.size > 0);

    // Label 1: show for either hex or token
    if (this.labelContainer) this.labelContainer.style.display = (hasHex || hasToken) ? 'inline-block' : 'none';

    // Label 2: only for hexes
    if (this.label2Container) this.label2Container.style.display = hasHex ? 'inline-block' : 'none';

    // Color label and input: show for either hex or token
    if (this.colorLabel) this.colorLabel.style.display = (hasHex || hasToken) ? 'inline-block' : 'none';
    if (this.colorPicker) this.colorPicker.style.display = (hasHex || hasToken) ? 'inline-block' : 'none';

    // Populate values when visible
    if (hasToken) {
      if (this.selectedTokens.size === 1) {
        const onlyId = Array.from(this.selectedTokens)[0];
        if (this.labelInput) this.labelInput.value = this.tokenLabels.get(onlyId) || '';
        if (this.colorPicker) this.colorPicker.value = this.tokenColors.get(onlyId) || (this.tokens.find(t => t.id === onlyId)?.color) || '#ff0000';
      } else {
        if (this.labelInput) this.labelInput.value = '';
        if (this.colorPicker) this.colorPicker.value = '#ff0000';
      }
      if (this.label2Input) this.label2Input.value = '';
    } else if (hasHex) {
      if (this.selectedHexes.size === 1) {
        const hk = Array.from(this.selectedHexes)[0];
        if (this.labelInput) this.labelInput.value = (this.hexData?.hexLabels && this.hexData.hexLabels[hk]) || '';
        if (this.label2Input) this.label2Input.value = (this.hexData?.hexLabels2 && this.hexData.hexLabels2[hk]) || '';
        if (this.colorPicker) this.colorPicker.value = this.coloredHexes.get(hk) || '#ff0000';
      } else {
        if (this.labelInput) this.labelInput.value = '';
        if (this.label2Input) this.label2Input.value = '';
        if (this.colorPicker) this.colorPicker.value = '#ff0000';
      }
      // Ensure face control panel reflects hex selection
      this.updateFaceControlPanel();
    } else {
      // clear values when nothing selected
      if (this.labelInput) this.labelInput.value = '';
      if (this.label2Input) this.label2Input.value = '';
      if (this.faceControlPanel) this.faceControlPanel.style.display = 'none';
    }
  }
}

module.exports = HexmapPlugin;
