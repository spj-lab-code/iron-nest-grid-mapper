// ==========================================
// GRID.JS - Complete Grid Controller
// ==========================================

class GridMapper {
    constructor(options) {
        this.canvas = options.canvas;
        this.ctx = this.canvas.getContext('2d');
        this.markerManager = options.markerManager;
        // this.drawingManager = options.drawingManager;
        this.elements = options.elements || {};

        // Render Throttle to 60fps
        this.renderPending = false;
        this.lastRenderTime = 0;
        this.minRenderInterval = 16;
        this.renderRequested = false;
        this.bgCanvas = document.createElement('canvas');
        this.bgCtx = this.bgCanvas.getContext('2d');
        this.bgNeedsRedraw = true;
        
        // Track update
        this.markersChanged = true;
        this.drawingsChanged = true;
        this.intelChanged = true;
        this.hoverChanged = true;
        
        // Cache render
        this.lastHoveredItem = null;
        this.lastHoveredCell = null;
        this.lastMouseX = -1;
        this.lastMouseY = -1;

        // Grid constants
        this.cols = 20;          // A-T
        this.rows = 10;          // 1-10 (1 = bottom, 10 = top)
        this.subGridSize = 10;   // 10x10 subgrid (0:0 bottom-left to 9:9 top-right)

        this.gridFontSize = 10;
        this.minFontSize = 6;
        this.maxFontSize = 20;

        // View state
        this.zoomLevel = 1;
        this.panX = 0;
        this.panY = 0;
        this.minZoom = 1;
        this.maxZoom = 5;
        this.isPanning = false;
        this.panStartX = 0;
        this.panStartY = 0;
        this.panStartPanX = 0;
        this.panStartPanY = 0;
        this.isDraggingMarker = false;
        this.dragMarker = null;
        this.grabOffsetX = -6;
        this.grabOffsetY = -6;


        // Smooth zoom animation state
        this.targetZoom = this.zoomLevel;
        this.targetPanX = this.panX;
        this.targetPanY = this.panY;
        this.isZooming = false;
        
        // Tools
        this.tool = 'select'; // 'select', 'drag', 'intelPen', 'vectorPen'
        this.isDrawingCompass = false;
        this.compassCircle = null;
        this.compassStartGrid = null;
        this.compassEndGrid = null;
        
        // Selection
        this.selectedMarker = null;
        this.hoveredItem = null;
        this.hoveredCell = null;
        this.rightClickedMarker = null;
        this.clickedGridRef = null;
        this.canvas.setAttribute('tabindex', '0');
        this.canvas.style.outline = 'none';

        // Data
        this.intelData = {};
        this.markersWithIntel = new Set();
        this.freeDrawings = [];
        this.autoIntelIds = [];
        this.deletedAutoIntelTargets = new Set();

        // Triangulation state
        this.triangulateItems = [];
        this.triangulateResult = null;

        if (this.drawingManager) {
            this.drawingManager.setGridSize(this.subGridSize);
            this.drawingManager.setMarkers(this.markerManager.getAllMarkers());
        }

        this.bindEvents();
        setTimeout(() => {
            this.addTriangulateItem();
            this.addTriangulateItem();
        }, 50);
        this.resize();
        this.updateZoomDisplay();
        this.setTool('select');
        this.autoGenerateIntel();

        // Try to auto-load saved data
        const hasSavedData = this.autoLoad();
    
        // If no saved data, initialize with defaults
        if (!hasSavedData) {
            setTimeout(() => {
                this.addTriangulateItem();
                this.addTriangulateItem();
            }, 50);
            this.resize();
            this.updateZoomDisplay();
            this.setTool('select');
            this.autoGenerateIntel();
        }

        // Auto-save on page unload
        window.addEventListener('beforeunload', () => {
            this.autoSave();
        });
    }

    // ==========================================
    // COORDINATE SYSTEM
    // ==========================================

    getCanvasInfo() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const padding = 25; // Padding for labels
        
        // Calculate available space for the grid
        const availableWidth = w - padding * 2;
        const availableHeight = h - padding * 2;
        
        const baseCellSize = Math.min(availableWidth / this.cols, availableHeight / this.rows);
        const cellSize = baseCellSize * this.zoomLevel;
        
        // Center the grid within the available space
        const totalGridWidth = cellSize * this.cols;
        const totalGridHeight = cellSize * this.rows;
        
        const offsetX = (w - totalGridWidth) / 2 + this.panX;
        const offsetY = (h - totalGridHeight) / 2 + this.panY;
        
        return { w, h, cellSize, offsetX, offsetY, subSize: cellSize / this.subGridSize, padding };
    }

    gridToPixel(col, row, subX = 0, subY = 0) {
        const { cellSize, offsetX, offsetY, subSize } = this.getCanvasInfo();
        
        // Row 0 (Row 1) is at the bottom, Row 9 (Row 10) is at the top
        const gridY = (this.rows - 1 - row);
        
        // SubY 0 is at the bottom, SubY 9 is at the top
        const invertedSubY = (this.subGridSize - subY);

        // No centering - subX/subY are exact positions 0-9.99
        return {
            x: offsetX + col * cellSize + subX * subSize,
            y: offsetY + gridY * cellSize + invertedSubY * subSize
        };
    }

     /**
     * Convert grid to pixel WITHOUT centering (for free placement)
     * Use this for marker dragging
     */
    gridToPixelExact(col, row, subX = 0, subY = 0) {
        const { cellSize, offsetX, offsetY, subSize } = this.getCanvasInfo();
        
        // Row 0 (Row 1) is at the bottom, Row 9 (Row 10) is at the top
        const gridY = (this.rows - 1 - row);
        
        // SubY 0 is at the bottom, SubY 9 is at the top
        const invertedSubY = (this.subGridSize - 1 - subY);

        // NO centering - subX/subY are exact positions within the cell
        return {
            x: offsetX + col * cellSize + subX * subSize,
            y: offsetY + gridY * cellSize + invertedSubY * subSize
        };
    }

    pixelToGrid(px, py) {
        const { cellSize, offsetX, offsetY, subSize } = this.getCanvasInfo();
        
        // Calculate position in sub-units (canvas coordinates, Y increases downward)
        const gridX = (px - offsetX) / subSize;
        const gridY = (py - offsetY) / subSize;
        
        const totalSubUnitsX = this.cols * this.subGridSize;
        const totalSubUnitsY = this.rows * this.subGridSize;
        
        // ============================================================
        // FIX: Clamp to grid boundaries with edge detection
        // ============================================================
        let clampedGridX = Math.min(Math.max(gridX, 0), totalSubUnitsX);
        let clampedGridY = Math.min(Math.max(gridY, 0), totalSubUnitsY);
        
        // Check if we're at the right edge
        const atRightEdge = gridX >= totalSubUnitsX;
        // Check if we're at the bottom edge (in canvas coords)
        const atBottomEdge = gridY >= totalSubUnitsY;
        
        // Flip Y so it's measured from bottom
        const gridYFlipped = totalSubUnitsY - clampedGridY;
        
        // Get col/row and subX/subY from the clamped coordinates
        let col = Math.floor(clampedGridX / this.subGridSize);
        let row = Math.floor(gridYFlipped / this.subGridSize);
        let subX = Math.floor(clampedGridX - (col * this.subGridSize));
        let subY = Math.floor(gridYFlipped - (row * this.subGridSize));
        
        // ============================================================
        // FIX: Handle edge cases - if at right edge, subX should be 9
        // ============================================================
        if (atRightEdge && col >= this.cols - 1) {
            col = this.cols - 1;
            subX = this.subGridSize - 1;
        }
        
        // Check if we're at the top edge (in grid coords)
        const atTopEdge = gridY <= 0;
        if (atTopEdge && row >= this.rows - 1) {
            row = this.rows - 1;
            subY = this.subGridSize - 1;
        }
        
        // Handle border crossing
        if (subX >= this.subGridSize) {
            col += 1;
            subX -= this.subGridSize;
        }
        if (subX < 0) {
            col -= 1;
            subX += this.subGridSize;
        }
        if (subY >= this.subGridSize) {
            row += 1;
            subY -= this.subGridSize;
        }
        if (subY < 0) {
            row -= 1;
            subY += this.subGridSize;
        }
        
        // Clamp to valid ranges
        col = Math.min(Math.max(col, 0), this.cols - 1);
        row = Math.min(Math.max(row, 0), this.rows - 1);
        subX = Math.min(Math.max(subX, 0), this.subGridSize - 1);
        subY = Math.min(Math.max(subY, 0), this.subGridSize - 1);
        
        return { col, row, subX, subY };
    }

    /**
     * Convert pixel to grid with free placement (allows floating point subgrid)
     * Values can be 0-9.99 within a cell
     */
    pixelToGridFree(px, py) {
        const { cellSize, offsetX, offsetY, subSize } = this.getCanvasInfo();
        
        // Calculate position in sub-units (canvas coordinates, Y increases downward)
        const gridX = (px - offsetX) / subSize;
        const gridY = (py - offsetY) / subSize;
        
        const totalSubUnitsX = this.cols * this.subGridSize;
        const totalSubUnitsY = this.rows * this.subGridSize;
        
        // ============================================================
        // FIX: Clamp to grid boundaries with edge detection
        // ============================================================
        let clampedGridX = Math.min(Math.max(gridX, 0), totalSubUnitsX);
        let clampedGridY = Math.min(Math.max(gridY, 0), totalSubUnitsY);
        
        // Check if we're at the right edge
        const atRightEdge = gridX >= totalSubUnitsX;
        // Check if we're at the bottom edge (in canvas coords)
        const atBottomEdge = gridY >= totalSubUnitsY;
        
        // Flip Y so it's measured from bottom
        const gridYFlipped = totalSubUnitsY - clampedGridY;
        
        // Now calculate col, row, subX, subY from the clamped coordinates
        let col = Math.floor(clampedGridX / this.subGridSize);
        let row = Math.floor(gridYFlipped / this.subGridSize);
        let subX = clampedGridX - (col * this.subGridSize);
        let subY = gridYFlipped - (row * this.subGridSize);
        
        // ============================================================
        // FIX: Handle edge cases - if at right edge, subX should be 9.99
        // ============================================================
        if (atRightEdge && col >= this.cols - 1) {
            col = this.cols - 1;
            subX = 9.99;
        }
        
        // Check if we're at the top edge (in grid coords)
        const atTopEdge = gridY <= 0;
        if (atTopEdge && row >= this.rows - 1) {
            row = this.rows - 1;
            subY = 9.99;
        }
        
        // Handle border crossing for subX
        if (subX >= this.subGridSize) {
            col += 1;
            subX -= this.subGridSize;
        }
        if (subX < 0) {
            col -= 1;
            subX += this.subGridSize;
        }
        
        // Handle border crossing for subY
        if (subY >= this.subGridSize) {
            row += 1;
            subY -= this.subGridSize;
        }
        if (subY < 0) {
            row -= 1;
            subY += this.subGridSize;
        }
        
        // Clamp to valid ranges
        col = Math.min(Math.max(col, 0), this.cols - 1);
        row = Math.min(Math.max(row, 0), this.rows - 1);
        subX = Math.min(Math.max(subX, 0), 9.99);
        subY = Math.min(Math.max(subY, 0), 9.99);
        
        // Round to 2 decimals
        subX = Math.round(subX * 100) / 100;
        subY = Math.round(subY * 100) / 100;
        
        return { col, row, subX, subY };
    }

    // Get grid reference string from pixel
    getGridRefFromPixel(px, py) {
        const grid = this.pixelToGrid(px, py);
        if (!grid) return null;
        return MarkerManager.toGridRef(grid.col, grid.row, grid.subX, grid.subY);
    }

    gridToSubUnits(col, row, subX, subY) {
        return {
            x: col * this.subGridSize + subX,
            y: row * this.subGridSize + subY
        };
    }

    subUnitsToGrid(x, y) {
        const col = Math.floor(x / this.subGridSize);
        const row = Math.floor(y / this.subGridSize);
        const subX = Math.round(x % this.subGridSize);
        const subY = Math.round(y % this.subGridSize);
        if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return null;
        if (subX < 0 || subX >= this.subGridSize || subY < 0 || subY >= this.subGridSize) return null;
        return { col, row, subX, subY };
    }

    calculateDistance(col1, row1, subX1, subY1, col2, row2, subX2, subY2) {
        const p1 = this.gridToSubUnits(col1, row1, subX1, subY1);
        const p2 = this.gridToSubUnits(col2, row2, subX2, subY2);
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        return Math.sqrt(dx * dx + dy * dy) / 10;
    }

    /**
     * Calculate bearing from point 1 to point 2
     * 0° = North, 90° = East, 180° = South, 270° = West
     */
    calculateBearing(col1, row1, subX1, subY1, col2, row2, subX2, subY2) {
        const p1 = this.gridToSubUnits(col1, row1, subX1, subY1);
        const p2 = this.gridToSubUnits(col2, row2, subX2, subY2);
        
        // Calculate differences
        const dx = p2.x - p1.x;  // East-West (positive = East)
        const dy = p2.y - p1.y;  // North-South (positive = North)
        
        // atan2(dx, dy) gives angle from North
        // but we need to flip the sign because our grid Y increases upward
        let bearing = Math.atan2(dx, dy) * (180 / Math.PI);
        bearing = (bearing + 360) % 360;
        
        return bearing;
    }

    distanceToSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) {
            return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
        }
        let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const nearX = x1 + t * dx;
        const nearY = y1 + t * dy;
        return Math.sqrt((px - nearX) * (px - nearX) + (py - nearY) * (py - nearY));
    }

    // ==========================================
    // ZOOM & PAN
    // ==========================================

    zoomIn(mouseX, mouseY) {
        this.smoothZoomTo(this.zoomLevel * 1.2, mouseX, mouseY);
        this.markBackgroundDirty();
        this.requestRender(false, true);
    }

    zoomOut(mouseX, mouseY) {
        this.smoothZoomTo(this.zoomLevel / 1.2, mouseX, mouseY);
        this.markBackgroundDirty();
        this.requestRender(false, true);
    }
    
    resetZoom() {
        this.smoothZoomTo(1, this.canvas.width / 2, this.canvas.height / 2);
        this.markBackgroundDirty();
        this.requestRender(false, true);
    }

    smoothZoomTo(targetZoom, mouseX, mouseY) {
        let newTarget = Math.min(Math.max(targetZoom, this.minZoom), this.maxZoom);
        
        const focusX = (mouseX !== undefined) ? mouseX : this.canvas.width / 2;
        const focusY = (mouseY !== undefined) ? mouseY : this.canvas.height / 2;

        if (newTarget <= 1) {
            newTarget = 1;
            this.targetZoom = 1;
            this.targetPanX = 0;
            this.targetPanY = 0;
        } else {
            const w = this.canvas.width;
            const h = this.canvas.height;
            const baseCellSize = Math.min(w / this.cols, h / this.rows);
            
            const currentCellSize = baseCellSize * this.zoomLevel;
            const targetCellSize = baseCellSize * newTarget;
            
            const baseOffsetX = (w - currentCellSize * this.cols) / 2;
            const baseOffsetY = (h - currentCellSize * this.rows) / 2;
            
            const gridX = focusX - (baseOffsetX + this.panX);
            const gridY = focusY - (baseOffsetY + this.panY);
            
            const scaleRatio = newTarget / this.zoomLevel;
            const targetGridX = gridX * scaleRatio;
            const targetGridY = gridY * scaleRatio;
            
            const newBaseOffsetX = (w - targetCellSize * this.cols) / 2;
            const newBaseOffsetY = (h - targetCellSize * this.rows) / 2;

            const rawTargetX = focusX - newBaseOffsetX - targetGridX;
            const rawTargetY = focusY - newBaseOffsetY - targetGridY;

            // Clamp calculated zoom target pan to grid edges
            const clampedTarget = this.clampPan(rawTargetX, rawTargetY, newTarget);

            this.targetZoom = newTarget;
            this.targetPanX = clampedTarget.x;
            this.targetPanY = clampedTarget.y;
        }

        if (!this.isZooming) {
            this.isZooming = true;
            this.animateZoom();
        }
    }

    animateZoom() {
        if (!this.isZooming) return;
        
        const ease = 0.18;
        const diffZoom = this.targetZoom - this.zoomLevel;
        const diffPanX = this.targetPanX - this.panX;
        const diffPanY = this.targetPanY - this.panY;
        
        if (Math.abs(diffZoom) < 0.001 && Math.abs(diffPanX) < 0.1 && Math.abs(diffPanY) < 0.1) {
            this.zoomLevel = this.targetZoom;
            this.panX = this.targetPanX;
            this.panY = this.targetPanY;
            this.isZooming = false;
            this.markBackgroundDirty();
            this.updateZoomDisplay();
            this.requestRender(true, true); // Force + Immediate
            return;
        }
        
        this.zoomLevel += diffZoom * ease;
        this.panX += diffPanX * ease;
        this.panY += diffPanY * ease;
        this.markBackgroundDirty();
        this.updateZoomDisplay();
        this.requestRender(false, false); // Throttled
        
        requestAnimationFrame(() => this.animateZoom());
    }

    clampPan(panX, panY, zoomLevel = this.zoomLevel) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const padding = 25;
        
        // Base grid size at scale 1.0
        const baseCellSize = Math.min((w - padding * 2) / this.cols, (h - padding * 2) / this.rows);
        const gridWidth = baseCellSize * zoomLevel * this.cols;
        const gridHeight = baseCellSize * zoomLevel * this.rows;

        const baseOffsetX = (w - gridWidth) / 2;
        const baseOffsetY = (h - gridHeight) / 2;

        let minPanX, maxPanX, minPanY, maxPanY;

        if (gridWidth <= w - padding * 2) {
            minPanX = 0;
            maxPanX = 0;
        } else {
            maxPanX = padding - baseOffsetX;
            minPanX = w - padding - gridWidth - baseOffsetX;
        }

        if (gridHeight <= h - padding * 2) {
            minPanY = 0;
            maxPanY = 0;
        } else {
            maxPanY = padding - baseOffsetY;
            minPanY = h - padding - gridHeight - baseOffsetY;
        }

        return {
            x: Math.min(Math.max(panX, minPanX), maxPanX),
            y: Math.min(Math.max(panY, minPanY), maxPanY)
        };
    }

    pixelToGridRaw(px, py) {
        const { cellSize, offsetX, offsetY } = this.getCanvasInfo();
        return {
            col: (px - offsetX) / cellSize,
            row: (py - offsetY) / cellSize
        };
    }

    gridToPixelRaw(col, row) {
        const { cellSize, offsetX, offsetY } = this.getCanvasInfo();
        return {
            x: offsetX + col * cellSize,
            y: offsetY + row * cellSize
        };
    }

    updateZoomDisplay() {
        const zoomDisplay = document.getElementById('zoomDisplay');
        if (zoomDisplay) {
            zoomDisplay.textContent = Math.round(this.zoomLevel * 100) + '%';
        }
    }

    // ==========================================
    // TOOLS
    // ==========================================

    setTool(tool) {
        this.tool = tool;
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        
        // Cancel any active drawing
        if (this.isDrawingCompass) {
            this.isDrawingCompass = false;
            this.compassCircle = null;
        }
        
        // Update cursor
        let cursor = 'crosshair';
        switch(tool) {
            case 'select':
                cursor = 'crosshair';
                break;
            case 'drag':
                cursor = 'grab';
                break;
            case 'intelPen':
                cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cline x1=\'2\' y1=\'22\' x2=\'10\' y2=\'14\' stroke=\'%23ffd93d\' stroke-width=\'2.5\'/%3E%3Cline x1=\'10\' y1=\'14\' x2=\'22\' y2=\'2\' stroke=\'%23ffd93d\' stroke-width=\'2.5\'/%3E%3Ccircle cx=\'10\' cy=\'14\' r=\'4\' fill=\'%23ffd93d\' stroke=\'%23fff\' stroke-width=\'1\'/%3E%3C/svg%3E") 0 22, crosshair';
                break;
            case 'vectorPen':
                cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cline x1=\'2\' y1=\'22\' x2=\'10\' y2=\'14\' stroke=\'%23ff4444\' stroke-width=\'2.5\'/%3E%3Cline x1=\'10\' y1=\'14\' x2=\'22\' y2=\'2\' stroke=\'%23ff4444\' stroke-width=\'2.5\'/%3E%3Ccircle cx=\'10\' cy=\'14\' r=\'4\' fill=\'%23ff4444\' stroke=\'%23fff\' stroke-width=\'1\'/%3E%3C/svg%3E") 0 22, crosshair';
                break;
            case 'compass':
                // Drafting compass cursor (upside-down V with circle)
                cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Ccircle cx=\'12\' cy=\'12\' r=\'10\' fill=\'none\' stroke=\'%23ffffff\' stroke-width=\'1.5\'/%3E%3Cline x1=\'5\' y1=\'20\' x2=\'12\' y2=\'8\' stroke=\'%23ffffff\' stroke-width=\'2\'/%3E%3Cline x1=\'19\' y1=\'20\' x2=\'12\' y2=\'8\' stroke=\'%23ffffff\' stroke-width=\'2\'/%3E%3Cline x1=\'12\' y1=\'8\' x2=\'12\' y2=\'4\' stroke=\'%23ffffff\' stroke-width=\'2\'/%3E%3Ccircle cx=\'12\' cy=\'3\' r=\'1.5\' fill=\'%23ffffff\'/%3E%3C/svg%3E") 12 12, crosshair';
                break;
        }
        this.canvas.style.cursor = cursor;
        
        const info = document.getElementById('drawingInfo');
        if (info) {
            const labels = {
                select: '<svg class="icon-sm"><use href="images/icons.svg#icon-mouse-pointer"></use></svg> Click to select markers, drag to move them',
                drag: '<svg class="icon-sm"><use href="images/icons.svg#icon-hand"></use></svg> Drag to pan around the map',
                intelPen: '<svg class="icon-sm"><use href="images/icons.svg#icon-pencil-line"></use></svg> Click and drag to draw an Intel arrow',
                vectorPen: '<svg class="icon-sm"><use href="images/icons.svg#icon-pen-line"></use></svg> Click and drag to draw a Vector arrow',
                compass: '<svg class="icon-sm"><use href="images/icons.svg#icon-drafting-compass"></use></svg> Click and drag to draw a distance circle (drafting compass)'
            };
            info.innerHTML = `<p style="color:#88bbff; font-size:0.8rem;">${labels[tool] || ''}</p>`;
        }
    }

    // ==========================================
    // FIND ITEM AT POSITION
    // ==========================================

    findItemAt(px, py) {
        // Check markers
        const markers = this.markerManager.getAllMarkers();
        for (const marker of markers) {
            const pos = this.gridToPixel(marker.col, marker.row, marker.subX, marker.subY);
            const dx = px - pos.x;
            const dy = py - pos.y;
            if (dx * dx + dy * dy < 625) {
                return { type: 'marker', item: marker };
            }
        }
        
        // Check free drawings (including compass circles)
        for (const drawing of this.freeDrawings) {
            // For compass circles
            if (drawing.type === 'compass') {
                const startGrid = drawing.startGrid;
                const endGrid = drawing.endGrid;
                if (!startGrid || !endGrid) continue;
                
                const center = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
                const endPos = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
                
                // Calculate radius from grid coordinates
                const dx = endPos.x - center.x;
                const dy = endPos.y - center.y;
                const radius = Math.sqrt(dx * dx + dy * dy);
                
                if (radius > 0) {
                    // Distance from point to the circle's stroke
                    const distToCenter = Math.sqrt((px - center.x) ** 2 + (py - center.y) ** 2);
                    const distToStroke = Math.abs(distToCenter - radius);
                    
                    // Check if clicked on the circle stroke or center
                    if (distToStroke < 12 || (radius > 0 && distToCenter < 15)) {
                        return { type: 'freeDrawing', item: drawing };
                    }
                }
                continue;
            }
            
            // For arrows
            const startGrid = drawing.startGrid;
            const endGrid = drawing.endGrid;
            if (!startGrid || !endGrid) continue;
            
            const start = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
            const end = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
            
            const dist = this.distanceToSegment(px, py, start.x, start.y, end.x, end.y);
            if (dist < 12) {
                return { type: 'freeDrawing', item: drawing };
            }
        }
        
        // Check drawing manager drawings
        if (this.drawingManager) {
            for (const drawing of this.drawingManager.drawings) {
                if (!drawing.start || !drawing.end) continue;
                const dist = this.distanceToSegment(px, py, drawing.start.x, drawing.start.y, drawing.end.x, drawing.end.y);
                if (dist < 10) {
                    return { type: 'drawing', item: drawing };
                }
            }
        }
        return null;
    }

    // ==========================================
    // FIND INTEL ARROW AT POSITION
    // ==========================================

    findIntelArrowAt(px, py) {
        const markers = this.markerManager.getAllMarkers();
        const { w, h } = this.getCanvasInfo();
        
        for (const marker of markers) {
            const intel = this.getIntel(marker.id);
            if (intel && intel.bearing !== null) {
                const pos = this.gridToPixel(marker.col, marker.row, marker.subX, marker.subY);
                const bearingRad = (intel.bearing - 90) * (Math.PI / 180);
                const maxDistance = Math.max(w, h) * 1.5;
                const endX = pos.x + Math.cos(bearingRad) * maxDistance;
                const endY = pos.y + Math.sin(bearingRad) * maxDistance;
                
                const dist = this.distanceToSegment(px, py, pos.x, pos.y, endX, endY);
                if (dist < 12) {
                    return marker;
                }
            }
        }
        return null;
    }

    // ==========================================
    // FREE DRAWING
    // ==========================================

    startFreeDrawing(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const px = (e.clientX - rect.left) * scaleX;
        const py = (e.clientY - rect.top) * scaleY;

        const isIntel = this.tool === 'intelPen';
        const color = isIntel ? '#ffd93d' : '#ff4444';
        const label = isIntel ? 'Intel' : 'Vector';

        // Store grid coordinates - use pixelToGridFree for floating point positions
        const gridPos = this.pixelToGridFree(px, py);
        
        this.freeDrawing = {
            id: `free-${Date.now()}`,
            type: 'freeDrawing',
            color: color,
            label: label,
            startGrid: gridPos,
            endGrid: null,
            autoIntel: false,
            bearing: null,
            distance: null,
            startRef: null,
            endRef: null
        };
        this.isFreeDrawing = true;
    }

    updateFreeDrawing(e) {
        if (!this.isFreeDrawing || !this.freeDrawing) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const px = (e.clientX - rect.left) * scaleX;
        const py = (e.clientY - rect.top) * scaleY;

        // pixelToGridFree now always returns a valid clamped position
        const grid = this.pixelToGridFree(px, py);
        
        if (grid) {
            this.freeDrawing.endGrid = grid;
            
            if (this.elements.cursorPos) {
                const fullRef = MarkerManager.toGridRefFull(grid.col, grid.row, grid.subX, grid.subY);
                this.elements.cursorPos.textContent = fullRef || '--';
            }
            
            const startGrid = this.freeDrawing.startGrid;
            const endGrid = this.freeDrawing.endGrid;
            if (startGrid && endGrid) {
                this.freeDrawing.bearing = this.calculateBearing(
                    startGrid.col, startGrid.row, startGrid.subX, startGrid.subY,
                    endGrid.col, endGrid.row, endGrid.subX, endGrid.subY
                );
                this.freeDrawing.distance = this.calculateDistance(
                    startGrid.col, startGrid.row, startGrid.subX, startGrid.subY,
                    endGrid.col, endGrid.row, endGrid.subX, endGrid.subY
                );
                this.freeDrawing.startRef = MarkerManager.toGridRef(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
                this.freeDrawing.endRef = MarkerManager.toGridRef(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
            }
        }
        
        this.render();
    }

    endFreeDrawing(e) {
        if (!this.isFreeDrawing || !this.freeDrawing) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const px = (e.clientX - rect.left) * scaleX;
        const py = (e.clientY - rect.top) * scaleY;

        // Store ONLY grid coordinates - use pixelToGridFree for floating point
        this.freeDrawing.endGrid = this.pixelToGridFree(px, py);

        const startGrid = this.freeDrawing.startGrid;
        const endGrid = this.freeDrawing.endGrid;
        
        if (startGrid && endGrid) {
            const startPos = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
            const endPos = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
            const dist = Math.sqrt((endPos.x - startPos.x) ** 2 + (endPos.y - startPos.y) ** 2);
            
            if (dist > 10) {
                this.freeDrawing.bearing = this.calculateBearing(
                    startGrid.col, startGrid.row, startGrid.subX, startGrid.subY,
                    endGrid.col, endGrid.row, endGrid.subX, endGrid.subY
                );
                this.freeDrawing.distance = this.calculateDistance(
                    startGrid.col, startGrid.row, startGrid.subX, startGrid.subY,
                    endGrid.col, endGrid.row, endGrid.subX, endGrid.subY
                );
                this.freeDrawing.startRef = MarkerManager.toGridRef(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
                this.freeDrawing.endRef = MarkerManager.toGridRef(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
                
                this.freeDrawings.push(this.freeDrawing);
                this.drawingsChanged = true;
                this.render(true);

                this.showToast(`Added ${this.freeDrawing.label} arrow`, 'success');

                this.autoSave();
            }
        }

        this.isFreeDrawing = false;
        this.freeDrawing = null;
        this.render();
    }

    deleteFreeDrawing(id) {
        const drawing = this.freeDrawings.find(d => d.id === id);
        if (drawing && drawing.autoIntel) {
            this.showToast('Auto vector is managed automatically', 'info');
            return false;
        }
        const index = this.freeDrawings.findIndex(d => d.id === id);
        if (index > -1) {
            const removed = this.freeDrawings.splice(index, 1)[0];
            const typeLabel = removed.type === 'compass' ? 'Compass circle' : 'Drawing';
            this.showToast(`Deleted ${typeLabel}`, 'success');
            this.hoveredItem = null;
            this.render();
            return true;
        }
        return false;
    }

    // ==========================================
    // COMPASS CIRCLE DRAWING
    // ==========================================

    startCompassDrawing(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const px = (e.clientX - rect.left) * scaleX;
        const py = (e.clientY - rect.top) * scaleY;

        // Get the starting grid position with floating point precision
        const gridPos = this.pixelToGridFree(px, py);
        
        this.compassCircle = {
            id: `compass-${Date.now()}`,
            type: 'compass',
            color: 'rgba(255, 255, 255, 0.8)',
            label: 'Compass Circle',
            startGrid: gridPos,
            endGrid: null,
            radius: 0,
            distance: 0
        };
        this.isDrawingCompass = true;
    }

    updateCompassDrawing(e) {
        if (!this.isDrawingCompass || !this.compassCircle) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const px = (e.clientX - rect.left) * scaleX;
        const py = (e.clientY - rect.top) * scaleY;

        // Store the grid position with floating point precision
        const gridPos = this.pixelToGridFree(px, py);
        this.compassCircle.endGrid = gridPos;
        
        // Calculate radius using grid coordinates
        const startGrid = this.compassCircle.startGrid;
        const endGrid = this.compassCircle.endGrid;
        if (startGrid && endGrid) {
            // Calculate distance in km directly from grid coordinates
            this.compassCircle.distance = this.calculateDistance(
                startGrid.col, startGrid.row, startGrid.subX, startGrid.subY,
                endGrid.col, endGrid.row, endGrid.subX, endGrid.subY
            );
            // Calculate radius in pixels for rendering
            const startPos = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
            const endPos = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
            const dx = endPos.x - startPos.x;
            const dy = endPos.y - startPos.y;
            this.compassCircle.radius = Math.sqrt(dx * dx + dy * dy);
        }
        
        this.render();
    }

    endCompassDrawing(e) {
        if (!this.isDrawingCompass || !this.compassCircle) return;

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const px = (e.clientX - rect.left) * scaleX;
        const py = (e.clientY - rect.top) * scaleY;

        const gridPos = this.pixelToGridFree(px, py);
        this.compassCircle.endGrid = gridPos;
        
        // Calculate final radius and distance using grid coordinates
        const startGrid = this.compassCircle.startGrid;
        const endGrid = this.compassCircle.endGrid;
        if (startGrid && endGrid) {
            this.compassCircle.distance = this.calculateDistance(
                startGrid.col, startGrid.row, startGrid.subX, startGrid.subY,
                endGrid.col, endGrid.row, endGrid.subX, endGrid.subY
            );
            const startPos = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
            const endPos = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
            const dx = endPos.x - startPos.x;
            const dy = endPos.y - startPos.y;
            this.compassCircle.radius = Math.sqrt(dx * dx + dy * dy);
        }
        
        // Only save if radius is significant (in pixels)
        if (this.compassCircle.radius > 10 && this.compassCircle.endGrid) {
            this.freeDrawings.push({
                id: this.compassCircle.id,
                type: 'compass',
                color: this.compassCircle.color,
                label: 'Compass Circle',
                startGrid: this.compassCircle.startGrid,
                endGrid: this.compassCircle.endGrid,
                radius: this.compassCircle.radius,
                distance: this.compassCircle.distance,
                compass: true
            });
            this.showToast(`Compass circle: ${this.compassCircle.distance.toFixed(2)}km radius`, 'success');

            this.autoSave();
        }

        this.isDrawingCompass = false;
        this.compassCircle = null;
        this.render();
    }

    // ==========================================
    // REMOVE ALL MEASUREMENTS
    // ==========================================

    removeAllMeasurements() {
        // Check if there's anything to remove
        const hasIntel = Object.keys(this.intelData).length > 0;
        const hasFreeDrawings = this.freeDrawings.length > 0;
        
        if (!hasIntel && !hasFreeDrawings) {
            this.showToast('No measurements to remove', 'info');
            return;
        }
        
        // Count items for the confirmation message
        let intelCount = 0;
        for (const markerId of Object.keys(this.intelData)) {
            intelCount += this.intelData[markerId].length;
        }
        const drawingCount = this.freeDrawings.length;
        
        // Confirm with user
        if (!confirm(`Remove all measurements?\n\nThis will remove:\n- ${intelCount} intel measurement(s)\n- ${drawingCount} vector/compass drawing(s)\n\nThis will NOT remove markers.`)) {
            return;
        }
        
        // Clear all intel data
        this.intelData = {};
        this.markersWithIntel = new Set();
        
        // Clear all free drawings (vectors, compass circles)
        this.freeDrawings = [];
        this.autoIntelIds = [];
        this.deletedAutoIntelTargets = new Set();
        
        // Clear triangulation preview if any
        this.triangulatePreview = null;
        this.triangulateResult = null;
        this.triangulateResultsAll = null;
        
        // ============================================================
        // FIX: Also clear the triangulate marker dropdowns
        // ============================================================
        this.updateTriangulateDropdowns();
        
        // ============================================================
        // FIX: Clear the intel display in the UI
        // ============================================================
        if (this.selectedMarker) {
            // Update the intel display for the selected marker (now shows "No intel data")
            this.updateIntelDisplay(this.selectedMarker.id);
        } else {
            // If no marker is selected, show the empty state
            const container = document.getElementById('intelDisplay');
            if (container) {
                container.innerHTML = '<p style="color:#666; font-size:0.8rem;">Select a point of interest to see intel</p>';
            }
        }
        
        // Update the marker list to remove intel badges
        this.updateMarkerList();
        this.render();
        
        this.showToast(`Removed ${intelCount} intel measurement(s) and ${drawingCount} drawing(s)`, 'success');
    }
    
    // ==========================================
    // AUTO-GENERATE INTEL
    // ==========================================

    autoGenerateIntel() {
        const nests = this.markerManager.getMarkersByType('nest');
        const targets = this.markerManager.getMarkersByType('target');
        
        // Remove old auto intel that hasn't been manually deleted
        const toRemove = this.freeDrawings.filter(d => 
            d.autoIntel && !this.deletedAutoIntelTargets.has(d.targetId)
        ).map(d => d.id);
        
        for (const id of toRemove) {
            const idx = this.freeDrawings.findIndex(d => d.id === id);
            if (idx > -1) this.freeDrawings.splice(idx, 1);
        }
        this.autoIntelIds = [];
        
        if (nests.length === 0 || targets.length === 0) return;

        const nest = nests[0];
        for (const target of targets) {
            // Skip if this target's auto arrow was manually deleted
            if (this.deletedAutoIntelTargets.has(target.id)) continue;
            
            const bearing = this.calculateBearing(
                nest.col, nest.row, nest.subX, nest.subY,
                target.col, target.row, target.subX, target.subY
            );
            const distance = this.calculateDistance(
                nest.col, nest.row, nest.subX, nest.subY,
                target.col, target.row, target.subX, target.subY
            );

            // Store ONLY grid coordinates - NO pixel positions
            this.freeDrawings.push({
                id: `auto-intel-${Date.now()}-${target.id}`,
                type: 'freeDrawing',
                color: '#ff4444',
                label: `Nest → ${target.label}`,
                startGrid: { col: nest.col, row: nest.row, subX: nest.subX, subY: nest.subY },
                endGrid: { col: target.col, row: target.row, subX: target.subX, subY: target.subY },
                bearing: bearing,
                distance: distance,
                startRef: nest.gridRef,
                endRef: target.gridRef,
                autoIntel: true,
                autoUpdate: true,
                targetId: target.id
            });
        }
        this.render();
    }

    removeAutoIntelForTarget(targetId) {
        // Mark this target as having its auto arrow manually deleted
        this.deletedAutoIntelTargets.add(targetId);
        
        const toRemove = this.freeDrawings.filter(d => d.autoIntel && d.targetId === targetId).map(d => d.id);
        for (const id of toRemove) {
            const idx = this.freeDrawings.findIndex(d => d.id === id);
            if (idx > -1) this.freeDrawings.splice(idx, 1);
        }
        this.hoveredItem = null; // Clear hovered item
    }

    // ==========================================
    // INTEL MANAGEMENT (Multiple entries per marker)
    // ==========================================

    addIntel(markerId, bearing, distance) {
        if (bearing !== null && (isNaN(bearing) || bearing < 0 || bearing > 360)) {
            throw new Error('Bearing must be between 0 and 360');
        }
        if (distance !== null && (isNaN(distance) || distance < 0)) {
            throw new Error('Distance must be a positive number');
        }
        if (bearing === null && distance === null) {
            throw new Error('Please provide a bearing or distance');
        }
        
        if (!this.intelData[markerId]) {
            this.intelData[markerId] = [];
        }
        
        // ============================================================
        // CHECK FOR DUPLICATE INTEL
        // ============================================================
        const existingIntel = this.intelData[markerId];
        const isDuplicate = existingIntel.some(entry => {
            // Check if bearing matches (if both are not null)
            const bearingMatches = (bearing === null && entry.bearing === null) || 
                                (bearing !== null && entry.bearing !== null && 
                                    Math.abs(entry.bearing - bearing) < 0.01);
            // Check if distance matches (if both are not null)
            const distanceMatches = (distance === null && entry.distance === null) || 
                                    (distance !== null && entry.distance !== null && 
                                    Math.abs(entry.distance - distance) < 0.01);
            return bearingMatches && distanceMatches;
        });
        
        if (isDuplicate) {
            // Silent ignore - don't show toast to avoid clutter
            return null;
        }
        
        const entry = { bearing, distance, id: `intel-${Date.now()}` };
        this.intelData[markerId].push(entry);
        this.markersWithIntel.add(markerId);
        this.updateIntelDisplay(markerId);

        this.autoSave();
        return entry;
    }

    removeIntel(markerId, intelId) {
        if (!this.intelData[markerId]) return;
        
        const index = this.intelData[markerId].findIndex(e => e.id === intelId);
        if (index > -1) {
            this.intelData[markerId].splice(index, 1);
            if (this.intelData[markerId].length === 0) {
                delete this.intelData[markerId];
                this.markersWithIntel.delete(markerId);
            }
            this.updateIntelDisplay(markerId);
            this.render();
        }

        this.autoSave();
    }

    getIntel(markerId) {
        return this.intelData[markerId] || [];
    }

    hasIntel(markerId) {
        return this.markersWithIntel.has(markerId);
    }

    clearIntel(markerId) {
        delete this.intelData[markerId];
        this.markersWithIntel.delete(markerId);
        this.updateIntelDisplay(markerId);
        this.render();
    }

    updateIntelDisplay(markerId) {
        const container = document.getElementById('intelDisplay');
        if (!container) return;

        const marker = this.markerManager.getMarkerById(markerId);
        if (!marker) {
            container.innerHTML = '<p style="color:#666; font-size:0.8rem;">Select a point of interest to see intel</p>';
            return;
        }

        const intelEntries = this.getIntel(markerId);
        if (intelEntries.length === 0) {
            container.innerHTML = `
                <div style="color:#8aacce; font-size:0.85rem; margin-bottom:8px;">
                    <strong>${marker.label}</strong> (${marker.gridRef})
                </div>
                <p style="color:#666; font-size:0.8rem;">No intel data</p>
                <button onclick="window.gridMapper.showIntelPanel(window.gridMapper.selectedMarker)" 
                        style="margin-top:8px; padding:4px 12px; background:#1e2a36; color:#4ecdc4; border:1px solid #3a4a5a; border-radius:3px; cursor:pointer;">
                    Add Intel
                </button>
            `;
            return;
        }

        const entriesHtml = intelEntries.map((entry, index) => `
            <div class="intel-entry">
                <div class="intel-entry-header">
                    <span class="intel-label">#${index + 1}</span>
                    <button class="intel-remove-btn" onclick="window.gridMapper.removeIntel('${marker.id}', '${entry.id}')"><svg class="icon-sm"><use href="images/icons.svg#icon-close"></use></svg></button>
                </div>
                <div class="intel-entry-details">
                    ${entry.bearing !== null ? `<span><svg class="icon-sm"><use href="images/icons.svg#icon-angle"></use></svg> ${entry.bearing.toFixed(1)}°</span>` : ''}
                    ${entry.distance !== null ? `<span><svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg> ${entry.distance.toFixed(2)} km</span>` : ''}
                    ${entry.bearing === null && entry.distance === null ? '<span style="color:#666;">(empty)</span>' : ''}
                </div>
            </div>
        `).join('');

        container.innerHTML = `
            <div style="color:#8aacce; font-size:0.85rem; margin-bottom:8px;">
                <strong>${marker.label}</strong> (${marker.gridRef})
                <span style="color:#4ecdc4; font-size:0.7rem; margin-left:8px;">${intelEntries.length} entries</span>
            </div>
            ${entriesHtml}
            <button onclick="window.gridMapper.showIntelPanel(window.gridMapper.selectedMarker)" 
                    style="margin-top:8px; padding:4px 12px; background:#1e2a36; color:#4ecdc4; border:1px solid #3a4a5a; border-radius:3px; cursor:pointer; font-size:0.75rem;">
                + Add Intel
            </button>
        `;
    }

    // ==========================================
    // REMOVE ALL INTEL
    // ==========================================

    removeAllIntel() {
        // Check if there's any intel to remove
        const markerIds = Object.keys(this.intelData);
        if (markerIds.length === 0) {
            this.showToast('No intel to remove', 'info');
            return;
        }
        
        // Confirm with user
        if (!confirm(`Remove all intel measurements from ${markerIds.length} marker(s)?\n\nThis will NOT remove vector arrows.`)) {
            return;
        }
        
        // Count total entries before removal
        let totalEntries = 0;
        for (const markerId of markerIds) {
            totalEntries += this.intelData[markerId].length;
        }
        
        // Clear all intel data
        this.intelData = {};
        this.markersWithIntel = new Set();
        
        // Update the display
        this.updateIntelDisplay(this.selectedMarker ? this.selectedMarker.id : null);
        this.render();
        this.updateMarkerList();
        
        this.showToast(`Removed ${totalEntries} intel measurement(s) from ${markerIds.length} marker(s)`, 'success');
    }

    // ==========================================
    // POPUP HELPERS
    // ==========================================

    closeAllPopups() {
        const ids = ['editPanel', 'intelPanel', 'addMarkerPopup', 'contextMenu'];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.remove();
        }
    }

    closePopupOnOutside(popup) {
        const handler = (e) => {
            if (popup && !popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener('mousedown', handler);
                document.removeEventListener('click', handler);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', handler);
            document.addEventListener('click', handler);
        }, 10);
        return handler;
    }

    // ==========================================
    // CONTEXT MENU
    // ==========================================

    showContextMenu(e, item, grid) {
        this.closeAllPopups();
        this.clickedGridRef = grid;

        const menu = document.createElement('div');
        menu.id = 'contextMenu';
        menu.style.cssText = `
            position: fixed;
            top: ${Math.min(e.clientY, window.innerHeight - 250)}px;
            left: ${Math.min(e.clientX, window.innerWidth - 230)}px;
            background: #1a2a3a;
            border: 1px solid #3a5a6a;
            border-radius: 6px;
            padding: 6px 0;
            z-index: 10001;
            min-width: 200px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
        `;

        let html = '';

        if (item && item.type === 'marker') {
            const marker = item.item;
            this.rightClickedMarker = marker;
            const isNest = marker.type === 'nest';
            const isTarget = marker.type === 'target';
            const hasIntel = this.hasIntel(marker.id);
            const hasAutoIntel = this.freeDrawings.some(d => d.autoIntel && d.targetId === marker.id);
            
            html = `
                <div class="menu-header">${marker.label} (${marker.gridRef})</div>
                <div class="menu-item" data-action="editPosition" style="color:#4ecdc4;"><svg class="icon-sm"><use href="images/icons.svg#icon-pencil-line"></use></svg> Edit Marker</div>
                <div class="menu-item" data-action="intel" style="color:#4ecdc4;">${hasIntel ? '<svg class="icon-sm"><use href="images/icons.svg#icon-information"></use></svg> Edit Intel' : '<svg class="icon-sm"><use href="images/icons.svg#icon-information"></use></svg> Add Intel'}</div>
            `;
            
            // For Target markers: Add "Create Vector from Iron Nest" option
            if (isTarget) {
                const nests = this.markerManager.getMarkersByType('nest');
                if (nests.length > 0) {
                    const label = hasAutoIntel ? '<svg class="icon-sm"><use href="images/icons.svg#icon-times-circle"></use></svg> Recreate Vector' : '<svg class="icon-sm"><use href="images/icons.svg#icon-crosshair"></use></svg> Create Vector from Iron Nest';
                    html += `<div class="menu-item" data-action="createVector" style="color:#ff4444;">${label}</div>`;
                }
            }
            
            if (hasIntel) {
                html += `<div class="menu-item" data-action="removeIntel" style="color:#ff8866;"><svg class="icon-sm"><use href="images/icons.svg#icon-trash"></use></svg> Remove Intel</div>`;
            }
            html += `<div class="menu-item" data-action="delete" style="color:#ff6644;"><svg class="icon-sm"><use href="images/icons.svg#icon-trash"></use></svg> Delete ${isNest ? 'Iron Nest' : 'Marker'}</div>`;

        } else if (item && item.type === 'freeDrawing') {
            // Free drawings are now deleted directly in the contextmenu event listener
            // So this part should never be reached for free drawings
            // But keeping it as fallback
            const drawing = item.item;
            const isAuto = drawing.autoIntel;
            html = `
                <div class="menu-header">${drawing.label} Arrow ${drawing.bearing !== undefined ? ` | Brg: ${drawing.bearing.toFixed(0)}°` : ''}${drawing.distance !== undefined ? ` | Dist: ${drawing.distance.toFixed(2)}km` : ''}${isAuto ? ' <svg class="icon-sm"><use href="images/icons.svg#icon-times-circle"></use></svg>' : ''}</div>
                <div class="menu-item" data-action="deleteDrawing" style="color:#ff6644;"><svg class="icon-sm"><use href="images/icons.svg#icon-trash"></use></svg> Delete Drawing</div>
            `;

        } else if (grid) {
            this.rightClickedMarker = null;
            const ref = MarkerManager.toGridRef(grid.col, grid.row, grid.subX, grid.subY);
            const hasNest = this.markerManager.getMarkersByType('nest').length > 0;
            
            html = `<div class="menu-header highlight">${ref}</div>`;
            // REMOVED: html += `<div class="menu-item" data-action="addMarker" style="color:#4ecdc4;"><svg class="icon-sm"><use href="images/icons.svg#icon-marker"></use></svg> Add Marker at ${ref}</div>`;
            if (hasNest) {
                html += `<div class="menu-item" data-action="moveNest" style="color:#4a7db5;"><svg class="icon-sm"><use href="images/icons.svg#icon-star"></use></svg> Move Iron Nest here</div>`;
            } else {
                html += `<div class="menu-item" data-action="addNest" style="color:#4a7db5;"><svg class="icon-sm"><use href="images/icons.svg#icon-star"></use></svg> Add Iron Nest</div>`;
            }
            html += `
                <div class="menu-item" data-action="addSpotter" style="color:#4a7db5;"><svg class="icon-sm"><use href="images/icons.svg#icon-binoculars"></use></svg> Add Spotter</div>
                <div class="menu-item" data-action="addReference" style="color:#2ecc71;"><svg class="icon-sm"><use href="images/icons.svg#icon-flag"></use></svg> Add Reference</div>
                <div class="menu-item" data-action="addTarget" style="color:#e74c3c;"><svg class="icon-sm"><use href="images/icons.svg#icon-crosshair"></use></svg> Add Target</div>
            `;
        }

        if (!html) return;

        menu.innerHTML = html;
        document.body.appendChild(menu);

        menu.querySelectorAll('.menu-item').forEach(el => {
            el.addEventListener('mouseenter', () => el.style.background = '#2a3a4a');
            el.addEventListener('mouseleave', () => el.style.background = 'transparent');
        });

        // --- Actions ---
        
        menu.querySelector('[data-action="editPosition"]')?.addEventListener('click', () => {
            const m = this.rightClickedMarker || this.selectedMarker;
            if (m) this.showEditPanel(m);
            menu.remove();
        });
        
        menu.querySelector('[data-action="intel"]')?.addEventListener('click', () => {
            const m = this.rightClickedMarker || this.selectedMarker;
            if (m) this.showIntelPanel(m);
            menu.remove();
        });
        
        menu.querySelector('[data-action="createVector"]')?.addEventListener('click', () => {
            const target = this.rightClickedMarker || this.selectedMarker;
            if (!target || target.type !== 'target') { menu.remove(); return; }
            
            const nests = this.markerManager.getMarkersByType('nest');
            if (nests.length === 0) {
                this.showToast('No Iron Nest found!', 'warning');
                menu.remove();
                return;
            }
            
            const nest = nests[0];
            
            // Remove from deleted list so auto generation can work again
            this.deletedAutoIntelTargets.delete(target.id);
            
            // Remove existing auto intel for this target
            this.removeAutoIntelForTarget(target.id);
            
            // Then remove from deleted list again (removeAutoIntelForTarget adds it)
            this.deletedAutoIntelTargets.delete(target.id);
            
            // Create new auto intel
            const startPos = this.gridToPixel(nest.col, nest.row, nest.subX, nest.subY);
            const endPos = this.gridToPixel(target.col, target.row, target.subX, target.subY);
            const bearing = this.calculateBearing(
                nest.col, nest.row, nest.subX, nest.subY,
                target.col, target.row, target.subX, target.subY
            );
            const distance = this.calculateDistance(
                nest.col, nest.row, nest.subX, nest.subY,
                target.col, target.row, target.subX, target.subY
            );

            const newAutoDrawing = {
                id: `auto-intel-${Date.now()}-${target.id}`,
                type: 'freeDrawing',
                color: '#ff4444',
                label: `Nest → ${target.label}`,
                start: { x: startPos.x, y: startPos.y },
                end: { x: endPos.x, y: endPos.y },
                startGrid: { col: nest.col, row: nest.row, subX: nest.subX, subY: nest.subY },
                endGrid: { col: target.col, row: target.row, subX: target.subX, subY: target.subY },
                bearing: bearing,
                distance: distance,
                startRef: nest.gridRef,
                endRef: target.gridRef,
                autoIntel: true,
                autoUpdate: true,
                targetId: target.id
            };
            
            this.freeDrawings.push(newAutoDrawing);
            this.autoIntelIds.push(newAutoDrawing.id);
            this.showToast(`Vector created from Iron Nest to ${target.label}`, 'success');
            this.render();
            menu.remove();
        });
        
        menu.querySelector('[data-action="removeIntel"]')?.addEventListener('click', () => {
            const m = this.rightClickedMarker || this.selectedMarker;
            if (m) {
                const intelEntries = this.getIntel(m.id);
                if (intelEntries.length > 0) {
                    // Remove the most recent intel entry
                    const lastEntry = intelEntries[intelEntries.length - 1];
                    this.removeIntel(m.id, lastEntry.id);
                    this.showToast(`Intel removed from ${m.label}`, 'success');
                    this.render();
                } else {
                    this.showToast('No intel to remove', 'info');
                }
            }
            menu.remove();
        });
        
        menu.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            const m = this.rightClickedMarker || this.selectedMarker;
            if (!m) { menu.remove(); return; }
            const label = m.type === 'nest' ? 'Iron Nest' : m.label;
            if (m.type === 'nest' && !confirm(`Delete Iron Nest at ${m.gridRef}?`)) { menu.remove(); return; }
            
            // If this is a target, remove its auto intel too
            if (m.type === 'target') {
                this.removeAutoIntelForTarget(m.id);
            }
            
            this.removeIntel(m.id);
            this.deleteMarker(m.id);
            this.showToast(`Deleted ${label}`, 'success');
            menu.remove();
        });
        
        menu.querySelector('[data-action="deleteDrawing"]')?.addEventListener('click', () => {
            const d = item?.item;
            if (d) {
                // If it's auto intel, remove the reference and delete
                if (d.autoIntel && d.targetId) {
                    this.removeAutoIntelForTarget(d.targetId);
                    this.showToast('Vector removed', 'success');
                } else {
                    this.deleteFreeDrawing(d.id);
                }
                menu.remove();
            }
        });
        
        menu.querySelector('[data-action="addNest"]')?.addEventListener('click', () => {
            const ref = this.clickedGridRef;
            if (ref) {
                this.markerManager.selectedType = 'nest';
                // Use the floating point values directly from the grid reference
                this.addMarkerAt(ref.col, ref.row, ref.subX, ref.subY);
            }
            menu.remove();
        });

        menu.querySelector('[data-action="addSpotter"]')?.addEventListener('click', () => {
            const ref = this.clickedGridRef;
            if (ref) {
                this.markerManager.selectedType = 'spotter';
                this.addMarkerAt(ref.col, ref.row, ref.subX, ref.subY);
            }
            menu.remove();
        });

        menu.querySelector('[data-action="addReference"]')?.addEventListener('click', () => {
            const ref = this.clickedGridRef;
            if (ref) {
                this.markerManager.selectedType = 'reference';
                this.addMarkerAt(ref.col, ref.row, ref.subX, ref.subY);
            }
            menu.remove();
        });

        menu.querySelector('[data-action="addTarget"]')?.addEventListener('click', () => {
            const ref = this.clickedGridRef;
            if (ref) {
                this.markerManager.selectedType = 'target';
                this.addMarkerAt(ref.col, ref.row, ref.subX, ref.subY);
            }
            menu.remove();
        });
        
        menu.querySelector('[data-action="moveNest"]')?.addEventListener('click', () => {
            const ref = this.clickedGridRef;
            if (ref) {
                const nests = this.markerManager.getMarkersByType('nest');
                if (nests.length > 0) {
                    const nest = nests[0];
                    const existing = this.markerManager.getMarkerAt(ref.col, ref.row, ref.subX, ref.subY);
                    if (existing && existing.id !== nest.id) {
                        this.showToast('Position already has a marker', 'warning');
                        menu.remove();
                        return;
                    }
                    this.markerManager.updateMarker(nest.id, { col: ref.col, row: ref.row, subX: ref.subX, subY: ref.subY });
                    this.render();
                    this.updateMarkerList();
                    this.updateDropdowns();
                    this.showToast(`Iron Nest moved to ${MarkerManager.toGridRef(ref.col, ref.row, ref.subX, ref.subY)}`, 'success');
                    this.autoGenerateIntel();
                }
            }
            menu.remove();
        });

        this.closePopupOnOutside(menu);
    }

    // ==========================================
    // EDIT PANEL
    // ==========================================

    showEditPanel(marker) {
        this.closeAllPopups();
        
        const panel = document.createElement('div');
        panel.id = 'editPanel';

        const isNest = marker.type === 'nest';
        const isSpotter = marker.type === 'spotter';
        const isTarget = marker.type === 'target';
        const isReference = marker.type === 'reference';
        const typeLabels = { nest: 'Iron Nest', spotter: 'Spotter', target: 'Target', reference: 'Reference' };
        const gridParts = marker.gridRef.split(' ');
        const mainRef = gridParts[0] || 'A1';
        const fullRef = MarkerManager.toGridRefFull(marker.col, marker.row, marker.subX, marker.subY);
        const fullParts = fullRef.split(' ');
        const subRef = fullParts[1] || '0.00:0.00';

        // Check if marker type uses a number (#)
        const hasNumber = isSpotter || isTarget || isReference;

        // Build type options
        const typeOptions = ['nest', 'spotter', 'target', 'reference'].map(type => {
            const label = typeLabels[type] || type;
            const selected = type === marker.type ? 'selected' : '';
            return `<option value="${type}" ${selected}>${label}</option>`;
        }).join('');

        panel.innerHTML = `
            <div class="panel-header">
                <h3><svg class="icon-sm"><use href="images/icons.svg#icon-pencil-line"></use></svg> Edit ${typeLabels[marker.type] || marker.type}</h3>
                <button id="closeEditPanel" class="close-btn"><svg class="icon-sm"><use href="images/icons.svg#icon-close"></use></svg></button>
            </div>
            
            <div class="form-group" style="display:flex; gap:8px; align-items:flex-end;">
                <div style="flex:1;">
                    <label style="display:block; color:#8aacce; font-size:0.85rem; margin-bottom:4px;">
                        <span><svg class="icon-sm"><use href="images/icons.svg#icon-marker"></use></svg></span> Marker Type
                    </label>
                    <select id="editType" style="width:100%; height: 36px; padding:6px 10px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:inherit;">
                        ${typeOptions}
                    </select>
                </div>
                ${hasNumber ? `
                <div style="width:20%; min-width:60px;">
                    <label style="display:block; color:#8aacce; font-size:0.85rem; margin-bottom:4px;">&nbsp;#</label>
                    <input type="number" id="editNumber" value="${marker.number}" min="1" max="99" 
                        style="width:100%; padding:6px 10px; height: 36px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:inherit;">
                </div>
                ` : ''}
            </div>
            
            <div class="form-group">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <label style="color:#8aacce; font-size:0.85rem; margin:0;">Grid Reference:</label>
                    <button id="snapToCenterBtn" 
                            style="background: none; color:#88ffaa; border: none; cursor:pointer; font-size:0.7rem; font-family:inherit; transition:background 0.2s;"
                            title="Snap subgrid to center of current cell (x.5:y.5)">
                        Snap to Center
                    </button>
                </div>
                <div class="grid-ref-inputs">
                    <input type="text" id="editMainRef" value="${mainRef}" placeholder="A1">
                    <input type="text" id="editSubRef" value="${subRef}" placeholder="0.00:0.00">
                </div>
                <div id="editGridError" style="color:#ff6644; font-size:0.7rem; margin-top:3px; display:none;"></div>
                <div class="hint-text">Main: A-T + 1-10 | Sub: 0-9.99:0-9.99 (supports decimals)</div>
            </div>
            
            <div class="btn-group">
                <button id="saveEditBtn" class="btn-save"><svg class="icon-sm"><use href="images/icons.svg#icon-save"></use></svg> Save</button>
                <button id="cancelEditBtn" class="btn-cancel">Cancel</button>
            </div>
        `;

        document.body.appendChild(panel);

        // ============================================================
        // FIX: Snap to Center uses the values in the input fields
        // ============================================================
        panel.querySelector('#snapToCenterBtn').addEventListener('click', () => {
            const mainRefInput = document.getElementById('editMainRef');
            const subRefInput = document.getElementById('editSubRef');
            const errorDiv = document.getElementById('editGridError');
            
            // Parse the current main reference
            const mainMatch = mainRefInput.value.trim().toUpperCase().match(/^([A-T])([1-9]|10)$/);
            if (!mainMatch) {
                errorDiv.textContent = '<svg class="icon-sm"><use href="images/icons.svg#icon-alert-triangle"></use></svg> Invalid main grid reference (e.g., A1-T10)';
                errorDiv.style.display = 'block';
                mainRefInput.style.borderColor = '#ff6644';
                setTimeout(() => {
                    mainRefInput.style.borderColor = '#2a3a4a';
                }, 2000);
                return;
            }
            
            // Parse the current subgrid reference
            const subMatch = subRefInput.value.trim().match(/^([0-9.]+):([0-9.]+)$/);
            if (!subMatch) {
                errorDiv.textContent = '<svg class="icon-sm"><use href="images/icons.svg#icon-alert-triangle"></use></svg> Invalid sub-grid reference (e.g., 5.30:2.70)';
                errorDiv.style.display = 'block';
                subRefInput.style.borderColor = '#ff6644';
                setTimeout(() => {
                    subRefInput.style.borderColor = '#2a3a4a';
                }, 2000);
                return;
            }
            
            // Clear any previous errors
            errorDiv.style.display = 'none';
            mainRefInput.style.borderColor = '#2a3a4a';
            subRefInput.style.borderColor = '#2a3a4a';
            
            // Parse subgrid values
            const rawSubX = parseFloat(subMatch[1]);
            const rawSubY = parseFloat(subMatch[2]);
            
            if (isNaN(rawSubX) || isNaN(rawSubY) || rawSubX < 0 || rawSubX > 9.99 || rawSubY < 0 || rawSubY > 9.99) {
                errorDiv.textContent = '<svg class="icon-sm"><use href="images/icons.svg#icon-alert-triangle"></use></svg> Sub-grid values must be between 0 and 9.99';
                errorDiv.style.display = 'block';
                subRefInput.style.borderColor = '#ff6644';
                setTimeout(() => {
                    subRefInput.style.borderColor = '#2a3a4a';
                }, 2000);
                return;
            }
            
            // ============================================================
            // FIX: Snap based on input values, not marker's stored position
            // ============================================================
            const centeredSubX = Math.floor(rawSubX) + 0.5;
            const centeredSubY = Math.floor(rawSubY) + 0.5;
            const centeredSubRef = `${centeredSubX.toFixed(2)}:${centeredSubY.toFixed(2)}`;
            
            subRefInput.value = centeredSubRef;
            subRefInput.style.borderColor = '#88ffaa';
            subRefInput.style.backgroundColor = 'rgba(136, 255, 170, 0.1)';
            setTimeout(() => {
                subRefInput.style.borderColor = '#2a3a4a';
                subRefInput.style.backgroundColor = '#0a121a';
            }, 600);
            this.showToast(`Snapped to center: ${centeredSubRef}`, 'success');
        });

        // Clear error on input change
        document.getElementById('editMainRef').addEventListener('input', () => {
            document.getElementById('editGridError').style.display = 'none';
            document.getElementById('editMainRef').style.borderColor = '#2a3a4a';
        });
        document.getElementById('editSubRef').addEventListener('input', () => {
            document.getElementById('editGridError').style.display = 'none';
            document.getElementById('editSubRef').style.borderColor = '#2a3a4a';
        });

        panel.querySelector('#closeEditPanel').addEventListener('click', () => panel.remove());
        panel.querySelector('#cancelEditBtn').addEventListener('click', () => panel.remove());

        panel.querySelector('#saveEditBtn').addEventListener('click', () => {
            // ============================================================
            // FIX: Validate before saving, show errors without closing
            // ============================================================
            const isValid = this.validateEditChanges(marker.id);
            if (isValid) {
                this.saveEditChanges(marker.id);
                panel.remove();
            }
        });

        // Click on grid to update position
        const moveListener = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const scaleX = this.canvas.width / rect.width;
            const scaleY = this.canvas.height / rect.height;
            const px = (e.clientX - rect.left) * scaleX;
            const py = (e.clientY - rect.top) * scaleY;
            const grid = this.pixelToGridFree(px, py);
            if (grid) {
                const ref = MarkerManager.toGridRef(grid.col, grid.row, grid.subX, grid.subY);
                const parts = ref.split(' ');
                document.getElementById('editMainRef').value = parts[0] || 'A1';
                document.getElementById('editSubRef').value = parts[1] || '0.00:0.00';
                // Clear any errors
                document.getElementById('editGridError').style.display = 'none';
                document.getElementById('editMainRef').style.borderColor = '#2a3a4a';
                document.getElementById('editSubRef').style.borderColor = '#2a3a4a';
            }
        };
        this.canvas.addEventListener('click', moveListener);
        
        // Clean up listener when panel closes
        const cleanup = () => {
            this.canvas.removeEventListener('click', moveListener);
        };
        panel.querySelector('#closeEditPanel').addEventListener('click', cleanup);
        panel.querySelector('#cancelEditBtn').addEventListener('click', cleanup);
        panel.querySelector('#saveEditBtn').addEventListener('click', cleanup);

        this.closePopupOnOutside(panel);
    }

    validateEditChanges(markerId) {
        const mainRefInput = document.getElementById('editMainRef');
        const subRefInput = document.getElementById('editSubRef');
        const errorDiv = document.getElementById('editGridError');
        
        // Clear previous errors
        errorDiv.style.display = 'none';
        mainRefInput.style.borderColor = '#2a3a4a';
        subRefInput.style.borderColor = '#2a3a4a';
        
        const mainRef = mainRefInput ? mainRefInput.value.trim().toUpperCase() : null;
        const subRef = subRefInput ? subRefInput.value.trim() : '0.00:0.00';
        
        // Validate main reference
        if (!mainRef) {
            errorDiv.textContent = '<svg class="icon-sm"><use href="images/icons.svg#icon-alert-triangle"></use></svg> Please enter a main grid reference (e.g., A1)';
            errorDiv.style.display = 'block';
            mainRefInput.style.borderColor = '#ff6644';
            return false;
        }
        
        const mainMatch = mainRef.match(/^([A-T])([1-9]|10)$/);
        if (!mainMatch) {
            errorDiv.textContent = '<svg class="icon-sm"><use href="images/icons.svg#icon-alert-triangle"></use></svg> Invalid main grid reference. Use A-T + 1-10 (e.g., A1, T10)';
            errorDiv.style.display = 'block';
            mainRefInput.style.borderColor = '#ff6644';
            return false;
        }
        
        const col = mainMatch[1].charCodeAt(0) - 65;
        const row = parseInt(mainMatch[2]) - 1;
        
        // Validate subgrid reference
        const subMatch = subRef.match(/^([0-9.]+):([0-9.]+)$/);
        if (!subMatch) {
            errorDiv.textContent = '<svg class="icon-sm"><use href="images/icons.svg#icon-alert-triangle"></use></svg> Invalid sub-grid format. Use X.X:Y.Y (e.g., 5.30:2.70)';
            errorDiv.style.display = 'block';
            subRefInput.style.borderColor = '#ff6644';
            return false;
        }
        
        const rawSubX = parseFloat(subMatch[1]);
        const rawSubY = parseFloat(subMatch[2]);
        
        if (isNaN(rawSubX) || isNaN(rawSubY) || rawSubX < 0 || rawSubX > 9.99 || rawSubY < 0 || rawSubY > 9.99) {
            errorDiv.textContent = '<svg class="icon-sm"><use href="images/icons.svg#icon-alert-triangle"></use></svg> Sub-grid values must be between 0 and 9.99';
            errorDiv.style.display = 'block';
            subRefInput.style.borderColor = '#ff6644';
            return false;
        }
        
        // Check if position is already taken (by another marker)
        const existing = this.markerManager.getMarkerAt(col, row, rawSubX, rawSubY);
        if (existing && existing.id !== markerId) {
            errorDiv.textContent = `<svg class="icon-sm"><use href="images/icons.svg#icon-alert-triangle"></use></svg> Position already occupied by ${existing.label}`;
            errorDiv.style.display = 'block';
            mainRefInput.style.borderColor = '#ff6644';
            subRefInput.style.borderColor = '#ff6644';
            return false;
        }
        
        return true;
    }

    saveEditChanges(markerId) {
        const numberInput = document.getElementById('editNumber');
        const mainRefInput = document.getElementById('editMainRef');
        const subRefInput = document.getElementById('editSubRef');
        const typeSelect = document.getElementById('editType');
        
        const newNumber = numberInput ? parseInt(numberInput.value) : null;
        const mainRef = mainRefInput ? mainRefInput.value.trim().toUpperCase() : null;
        const subRef = subRefInput ? subRefInput.value.trim() : '0.00:0.00';
        const newType = typeSelect ? typeSelect.value : null;
        
        const marker = this.markerManager.getMarkerById(markerId);
        if (!marker) return;
        
        let col = marker.col, row = marker.row, subX = marker.subX, subY = marker.subY;
        
        if (mainRef) {
            const mainMatch = mainRef.match(/^([A-T])([1-9]|10)$/);
            if (mainMatch) {
                col = mainMatch[1].charCodeAt(0) - 65;
                row = parseInt(mainMatch[2]) - 1;
            }
        }
        
        if (subRef) {
            const subMatch = subRef.match(/^([0-9.]+):([0-9.]+)$/);
            if (subMatch) {
                subX = Math.round(parseFloat(subMatch[1]) * 100) / 100;
                subY = Math.round(parseFloat(subMatch[2]) * 100) / 100;
            }
        }
        
        const updates = { col, row, subX, subY };
        let oldType = marker.type;
        
        // --- HANDLE TYPE CHANGE ---
        if (newType && newType !== marker.type) {
            if (newType === 'nest') {
                const existingNests = this.markerManager.getMarkersByType('nest');
                if (existingNests.length > 0 && existingNests[0].id !== marker.id) {
                    return;
                }
            }
            
            updates.type = newType;
            updates.color = MarkerManager.getTypeColor(newType);
            
            let newNumberValue;
            let newLabelValue;
            
            if (oldType === 'spotter') {
                const idx = this.markerManager.usedSpotterNumbers.indexOf(marker.number);
                if (idx > -1) {
                    this.markerManager.usedSpotterNumbers.splice(idx, 1);
                }
            }
            
            if (newType === 'nest') {
                newNumberValue = 0;
                newLabelValue = 'Iron Nest';
            } else if (newType === 'spotter') {
                newNumberValue = this.markerManager.getNextSpotterNumber();
                this.markerManager.usedSpotterNumbers.push(newNumberValue);
                newLabelValue = `Spotter #${newNumberValue}`;
            } else if (newType === 'target') {
                newNumberValue = this.markerManager.nextTargetNumber++;
                newLabelValue = `Target #${newNumberValue}`;
            } else {
                this.markerManager.counter[newType] = (this.markerManager.counter[newType] || 0) + 1;
                newNumberValue = this.markerManager.counter[newType];
                newLabelValue = `Reference ${String.fromCharCode(64 + newNumberValue)}`;
            }
            
            updates.number = newNumberValue;
            updates.label = newLabelValue;
        } else {
            if (newNumber && !isNaN(newNumber) && marker.type !== 'nest') {
                updates.number = newNumber;
                if (marker.type === 'spotter') {
                    updates.label = `Spotter #${newNumber}`;
                } else if (marker.type === 'target') {
                    updates.label = `Target #${newNumber}`;
                } else if (marker.type === 'reference') {
                    updates.label = `Reference ${String.fromCharCode(64 + newNumber)}`;
                }
            }
        }
        
        const updated = this.markerManager.updateMarker(marker.id, updates);
        if (updated) {
            this.showToast(`Updated ${updated.label}`, 'success');
            this.selectedMarker = updated;
            this.updateMarkerList();
            this.updateDropdowns();
            this.updateIntelDisplay(updated.id);
            this.autoGenerateIntel();
            this.render();
        }
    }

    // ==========================================
    // INTEL PANEL
    // ==========================================

    showIntelPanel(marker) {
        this.closeAllPopups();
        
        const panel = document.createElement('div');
        panel.id = 'intelPanel';

        panel.innerHTML = `
            <div class="panel-header">
                <h3><svg class="icon-sm"><use href="images/icons.svg#icon-information"></use></svg> Add Intel for ${marker.label}</h3>
                <button id="closeIntelPanel" class="close-btn"><svg class="icon-sm"><use href="images/icons.svg#icon-close"></use></svg></button>
            </div>
            <div style="margin-bottom:15px;">
                <label style="display:block; color:#8aacce; font-size:0.85rem; margin-bottom:4px;">Grid Reference:</label>
                <!-- ============================================================ -->
                <!-- FIX: Make grid reference look like an inactive input field -->
                <!-- ============================================================ -->
                <div style="padding:6px 10px; background:#0a121a; color:#6a7a8a; border:1px solid #1a2a3a; border-radius:3px; font-family:monospace; cursor:not-allowed; opacity:0.7;">
                    ${marker.gridRef}
                </div>
            </div>
            
            <!-- Two-column layout for bearing and distance - aligned at top -->
            <div style="display:flex; gap:12px; align-items:flex-start;">
                <div class="form-group" style="flex:1; min-width:0; margin-bottom:0;">
                    <label style="display:flex; align-items:center; gap:4px; font-size:0.85rem; color:#8aacce; margin-bottom:4px;">
                        <span><svg class="icon-sm"><use href="images/icons.svg#icon-pencil-line"></use></svg></span> Bearing <span style="color:#6a7a8a; font-size:0.65rem; font-weight:normal;">(0-360°)</span>
                    </label>
                    <input type="number" id="intelBearing" min="0" max="360" step="0.1" placeholder="Optional" 
                        style="width:100%; padding:6px 10px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:inherit;">
                    <div style="color:#6a7a8a; font-size:0.6rem; margin-top:2px;">0° = North, 90° = East</div>
                </div>
                
                <div class="form-group" style="flex:1; min-width:0; margin-bottom:0;">
                    <label style="display:flex; align-items:center; gap:4px; font-size:0.85rem; color:#8aacce; margin-bottom:4px;">
                        <span><svg class="icon-sm"><use href="images/icons.svg#icon-drafting-compass"></use></svg></span> Distance <span style="color:#6a7a8a; font-size:0.65rem; font-weight:normal;">(km)</span>
                    </label>
                    <input type="number" id="intelDistance" min="0" max="999.9" step="0.1" placeholder="Optional" 
                        style="width:100%; padding:6px 10px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:inherit;">
                </div>
            </div>
            
            <div class="info-box" style="margin-top:12px; background:#0a121a; padding:8px; border-radius:3px; font-size:0.8rem; color:#6a7a8a;">
                <svg class="icon-sm"><use href="images/icons.svg#icon-lightbulb"></use></svg> Add a bearing, distance, or both. You can add multiple intel entries per marker.
            </div>
            <div class="btn-group" style="display:flex; gap:10px; margin-top:12px;">
                <button id="saveIntelBtn" class="btn-save" style="flex:1; padding:8px; background:#2a5a3a; color:#88ffaa; border:1px solid #3a8a5a; border-radius:3px; cursor:pointer; font-family:inherit;"><svg class="icon-sm"><use href="images/icons.svg#icon-save"></use></svg> Add Intel</button>
                <button id="cancelIntelBtn" class="btn-cancel" style="flex:1; padding:8px; background:#3a2a2a; color:#ff8866; border:1px solid #8a3a3a; border-radius:3px; cursor:pointer; font-family:inherit;">Cancel</button>
            </div>
        `;

        document.body.appendChild(panel);

        panel.querySelector('#closeIntelPanel').addEventListener('click', () => panel.remove());
        panel.querySelector('#cancelIntelBtn').addEventListener('click', () => panel.remove());

        panel.querySelector('#saveIntelBtn').addEventListener('click', () => {
            const bearingRaw = document.getElementById('intelBearing').value;
            const distanceRaw = document.getElementById('intelDistance').value;
            const bearing = bearingRaw !== '' ? parseFloat(bearingRaw) : null;
            const distance = distanceRaw !== '' ? parseFloat(distanceRaw) : null;
            
            if (bearing !== null && (isNaN(bearing) || bearing < 0 || bearing > 360)) {
                this.showToast('Bearing must be between 0 and 360', 'warning');
                return;
            }
            if (distance !== null && (isNaN(distance) || distance < 0)) {
                this.showToast('Distance must be positive', 'warning');
                return;
            }
            if (bearing === null && distance === null) {
                this.showToast('Please provide a bearing or distance', 'warning');
                return;
            }

            try {
                const result = this.addIntel(marker.id, bearing, distance);
                if (result) {
                    this.showToast(`Intel added to ${marker.label}`, 'success');
                } else {
                    this.showToast(`Duplicate intel already exists for ${marker.label}`, 'info');
                }
                panel.remove();
                this.updateIntelDisplay(marker.id);
                this.render();
            } catch (e) {
                this.showToast(e.message, 'warning');
            }
        });

        this.closePopupOnOutside(panel);
    }

    // ==========================================
    // TRIANGULATION
    // ==========================================

    updateTriangulateDropdowns() {
        const selects = document.querySelectorAll('.triangulate-marker');
        const markers = this.markerManager.getAllMarkers();
        const options = markers.map(m => 
            `<option value="${m.id}">${m.label} (${m.gridRef})</option>`
        ).join('');
        
        selects.forEach(select => {
            const currentVal = select.value;
            select.innerHTML = `<option value="">Select marker...</option>${options}`;
            if (currentVal && markers.some(m => m.id === currentVal)) {
                select.value = currentVal;
            }
        });
    }

    // update triangulate marker positions when markers change
    updateTriangulateData() {
        // Update dropdowns with current markers
        this.updateTriangulateDropdowns();
        
        // Update any existing triangulate items with current marker data
        const items = document.querySelectorAll('.triangulate-item');
        items.forEach((item) => {
            const markerSelect = item.querySelector('.triangulate-marker');
            const bearingInput = item.querySelector('.triangulate-bearing');
            const distanceInput = item.querySelector('.triangulate-distance');
            
            // If the marker exists in the current data, update its display
            const markerId = markerSelect.value;
            if (markerId) {
                const marker = this.markerManager.getMarkerById(markerId);
                if (marker) {
                    // Update the option text to reflect current grid ref
                    const option = markerSelect.querySelector(`option[value="${markerId}"]`);
                    if (option) {
                        option.textContent = `${marker.label} (${marker.gridRef})`;
                    }
                } else {
                    // Marker was deleted, clear the selection
                    markerSelect.value = '';
                }
            }
        });
    }

    addTriangulateItem() {
        const container = document.getElementById('triangulateItems');
        const index = container.children.length;
        
        const item = this.createTriangulateItem(index);
        container.appendChild(item);
        
        // Event listeners for remove button
        item.querySelector('.btn-remove-triangulate').addEventListener('click', () => {
            if (container.children.length > 1) {
                item.remove();
            } else {
                this.showToast('Need at least one intel item', 'warning');
            }
        });
    }

    createTriangulateItem(index) {
        const item = document.createElement('div');
        item.className = 'triangulate-item';
        item.dataset.index = index;
        item.innerHTML = `
            <div class="form-group">
                <label style="display:flex; align-items:center; gap:4px; font-size:0.85rem; color:#8aacce; margin-bottom:4px;">
                    <span><svg class="icon-sm"><use href="images/icons.svg#icon-marker"></use></svg></span> Marker:
                </label>
                <select class="triangulate-marker" data-index="${index}" style="width:100%; padding:6px 10px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:inherit;">
                    <option value="">Select marker...</option>
                    ${this.markerManager.getAllMarkers().map(m => 
                        `<option value="${m.id}">${m.label} (${m.gridRef})</option>`
                    ).join('')}
                </select>
            </div>
            
            <!-- Two-column layout for bearing and distance -->
            <div style="display:flex; gap:8px; align-items:flex-start; margin-top:6px;">
                <div class="form-group" style="flex:1; min-width:0; margin-bottom:0;">
                    <label style="display:flex; align-items:center; gap:4px; font-size:0.75rem; color:#8aacce; margin-bottom:3px;">
                        <span><svg class="icon-sm"><use href="images/icons.svg#icon-pencil-line"></use></svg></span> Bearing <span style="color:#6a7a8a; font-size:0.6rem;">(0-360°)</span>
                    </label>
                    <input type="number" class="triangulate-bearing" data-index="${index}" min="0" max="360" step="0.1" placeholder="Optional" 
                        style="width:100%; padding:4px 8px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:inherit; font-size:0.75rem;">
                </div>
                
                <div class="form-group" style="flex:1; min-width:0; margin-bottom:0;">
                    <label style="display:flex; align-items:center; gap:4px; font-size:0.75rem; color:#8aacce; margin-bottom:3px;">
                        <span><svg class="icon-sm"><use href="images/icons.svg#icon-drafting-compass"></use></svg></span> Distance <span style="color:#6a7a8a; font-size:0.6rem;">(km)</span>
                    </label>
                    <input type="number" class="triangulate-distance" data-index="${index}" min="0" step="0.1" placeholder="Optional" 
                        style="width:100%; padding:4px 8px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:inherit; font-size:0.75rem;">
                </div>
            </div>
            
            <button class="btn btn-sm btn-remove-triangulate" data-index="${index}" style="color:#ff6644; background:none; border:none; cursor:pointer; font-size:0.7rem; padding:4px 6px; border-radius:3px; transition:background 0.2s; margin-top:4px;"><svg class="icon-sm"><use href="images/icons.svg#icon-close"></use></svg> Remove</button>
        `;
        return item;
    }

    // ==========================================
    // FLOATING POINT GRID HELPERS
    // ==========================================

    /**
     * Convert sub-units to grid with FLOATING point subgrid (no snapping)
     */
    subUnitsToGridFloat(x, y) {
        // Allow floating point values for subX and subY
        let col = Math.floor(x / this.subGridSize);
        let row = Math.floor(y / this.subGridSize);
        
        let subX = x - (col * this.subGridSize);
        let subY = y - (row * this.subGridSize);
        
        // Handle edge cases
        if (subX >= this.subGridSize) {
            subX = 0;
            col++;
        }
        if (subY >= this.subGridSize) {
            subY = 0;
            row++;
        }
        
        // Clamp to valid ranges
        if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return null;
        if (subX < -0.01 || subX > this.subGridSize + 0.01) return null;
        if (subY < -0.01 || subY > this.subGridSize + 0.01) return null;
        
        subX = Math.min(Math.max(subX, 0), this.subGridSize - 0.01);
        subY = Math.min(Math.max(subY, 0), this.subGridSize - 0.01);
        
        return { col, row, subX, subY };
    }

    toGridRefFloat(col, row, subX, subY) {
        if (col < 0 || col > 19 || row < 0 || row > 9) return null;
        
        // Round to 2 decimal places
        subX = Math.round(subX * 100) / 100;
        subY = Math.round(subY * 100) / 100;
        
        const subXStr = subX.toFixed(2);
        const subYStr = subY.toFixed(2);
        
        return String.fromCharCode(65 + col) + (row + 1) + ' ' + subXStr + ':' + subYStr;
    }

    /**
     * Parse a grid reference with floating subgrid
     */
    static parseGridRefFloat(ref) {
        // Try decimal format: A1 5.30:2.70
        let match = ref.match(/^([A-T])([1-9]|10)\s([0-9.]+):([0-9.]+)$/i);
        if (!match) return null;
        
        const col = match[1].toUpperCase().charCodeAt(0) - 65;
        const row = parseInt(match[2]) - 1;
        const subX = parseFloat(match[3]);
        const subY = parseFloat(match[4]);
        
        if (col < 0 || col > 19 || row < 0 || row > 9) return null;
        if (subX < 0 || subX > 9.99 || subY < 0 || subY > 9.99) return null;
        
        return { col, row, subX, subY };
    }

    calculateTriangulation() {
        const items = [];
        const itemElements = document.querySelectorAll('.triangulate-item');
        
        console.log('Calculating triangulation with', itemElements.length, 'items');
        
        for (const el of itemElements) {
            const markerSelect = el.querySelector('.triangulate-marker');
            const bearingInput = el.querySelector('.triangulate-bearing');
            const distanceInput = el.querySelector('.triangulate-distance');
            
            const markerId = markerSelect.value;
            if (!markerId) {
                console.log('No marker selected for item');
                continue;
            }
            
            const bearing = bearingInput.value !== '' ? parseFloat(bearingInput.value) : null;
            const distance = distanceInput.value !== '' ? parseFloat(distanceInput.value) : null;
            
            if (bearing === null && distance === null) {
                console.log('No bearing or distance for marker');
                continue;
            }
            
            const marker = this.markerManager.getMarkerById(markerId);
            if (!marker) {
                console.log('Marker not found:', markerId);
                continue;
            }
            
            console.log(`Item: ${marker.label}, bearing: ${bearing}, distance: ${distance}`);
            
            items.push({
                marker: marker,
                bearing: bearing,
                distance: distance
            });
        }
        
        // ============================================================
        // ALLOW SINGLE MARKER WITH BOTH BEARING AND DISTANCE
        // ============================================================
        if (items.length === 0) {
            this.showToast('Please add at least one marker with intel', 'warning');
            return;
        }
        
        if (items.length === 1) {
            const item = items[0];
            // Check if the single marker has both bearing AND distance
            if (item.bearing !== null && item.distance !== null) {
                console.log('Single marker with both bearing and distance - calculating position');
                
                // Calculate the position using bearing and distance from the marker
                const result = this.calculatePositionFromBearingDistance(
                    item.marker, 
                    item.bearing, 
                    item.distance
                );
                
                if (result) {
                    this.displayTriangulateResults([{
                        type: 'bearing-distance-single',
                        item1: item,
                        item2: item,
                        intersection: result,
                        accuracy: 'high'
                    }]);
                    return;
                } else {
                    this.showToast('Could not calculate position from bearing and distance', 'warning');
                    return;
                }
            } else {
                this.showToast('With a single marker, you need both bearing AND distance', 'warning');
                return;
            }
        }
        
        // Original logic for multiple items
        const results = this.findIntersections(items);
        console.log('Triangulation results:', results);
        this.displayTriangulateResults(results);
    }

    findIntersections(items) {
        const results = [];
        
        console.log('Finding intersections for', items.length, 'items');
        
        for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
                const item1 = items[i];
                const item2 = items[j];
                
                console.log(`Checking pair: ${item1.marker.label} (${item1.bearing}, ${item1.distance}) vs ${item2.marker.label} (${item2.bearing}, ${item2.distance})`);
                
                // ==========================================
                // BEARING-BEARING INTERSECTION
                // ==========================================
                if (item1.bearing !== null && item2.bearing !== null) {
                    console.log('  Trying bearing-bearing intersection');
                    const intersection = this.calculateBearingIntersection(
                        item1.marker, item1.bearing,
                        item2.marker, item2.bearing
                    );
                    if (intersection) {
                        console.log('  ✓ Found bearing-bearing intersection:', intersection.gridRef);
                        results.push({
                            type: 'bearing-bearing',
                            item1: item1,
                            item2: item2,
                            intersection: intersection,
                            accuracy: 'high'
                        });
                    } else {
                        console.log('  ✗ No bearing-bearing intersection');
                    }
                }
                
                // ==========================================
                // BEARING-DISTANCE INTERSECTION
                // ==========================================

                // Bearing-Distance intersection (item1 bearing, item2 distance)
                if (item1.bearing !== null && item2.distance !== null) {
                    console.log('  Trying bearing-distance (item1 bearing, item2 distance)');
                    const intersections = this.calculateBearingDistanceIntersection(
                        item1.marker, item1.bearing,
                        item2.marker, item2.distance
                    );
                    if (intersections) {
                        // If it's an array, add each intersection
                        const interArray = Array.isArray(intersections) ? intersections : [intersections];
                        for (const inter of interArray) {
                            console.log('  ✓ Found bearing-distance intersection:', inter.gridRef);
                            results.push({
                                type: 'bearing-distance',
                                item1: item1,
                                item2: item2,
                                intersection: inter,
                                accuracy: 'medium'
                            });
                        }
                    } else {
                        console.log('  ✗ No bearing-distance intersection');
                    }
                }

                // Bearing-Distance intersection (item2 bearing, item1 distance)
                if (item1.distance !== null && item2.bearing !== null) {
                    console.log('  Trying bearing-distance (item2 bearing, item1 distance)');
                    const intersections = this.calculateBearingDistanceIntersection(
                        item2.marker, item2.bearing,
                        item1.marker, item1.distance
                    );
                    if (intersections) {
                        const interArray = Array.isArray(intersections) ? intersections : [intersections];
                        for (const inter of interArray) {
                            console.log('  ✓ Found bearing-distance intersection:', inter.gridRef);
                            results.push({
                                type: 'bearing-distance',
                                item1: item2,
                                item2: item1,
                                intersection: inter,
                                accuracy: 'medium'
                            });
                        }
                    } else {
                        console.log('  ✗ No bearing-distance intersection');
                    }
                }
                
                // ==========================================
                // DISTANCE-DISTANCE INTERSECTION (Two Circles)
                // ==========================================
                if (item1.distance !== null && item2.distance !== null) {
                    console.log('  Trying distance-distance intersection');
                    const intersections = this.calculateDistanceDistanceIntersection(
                        item1.marker, item1.distance,
                        item2.marker, item2.distance
                    );
                    if (intersections && intersections.length > 0) {
                        console.log(`  ✓ Found ${intersections.length} distance-distance intersection(s)`);
                        for (const inter of intersections) {
                            results.push({
                                type: 'distance-distance',
                                item1: item1,
                                item2: item2,
                                intersection: inter,
                                accuracy: 'low'
                            });
                        }
                    } else {
                        console.log('  ✗ No distance-distance intersection');
                    }
                }
            }
        }
        
        console.log('Total intersections found:', results.length);
        return results;
    }

    // ==========================================
    // TRIANGULATION METHODS (FIXED)
    // ==========================================

    calculateBearingIntersection(marker1, bearing1, marker2, bearing2) {
        const p1 = this.gridToSubUnits(marker1.col, marker1.row, marker1.subX, marker1.subY);
        const p2 = this.gridToSubUnits(marker2.col, marker2.row, marker2.subX, marker2.subY);
        
        console.log(`  Bearing intersection: ${marker1.label} @ ${bearing1}° and ${marker2.label} @ ${bearing2}°`);
        console.log(`  p1: (${p1.x}, ${p1.y}), p2: (${p2.x}, ${p2.y})`);
        
        // Convert bearings from 0°=North to radians
        // IMPORTANT: In our grid, Y increases upward, so we use standard math
        const b1Rad = (bearing1 - 90) * (Math.PI / 180);
        const b2Rad = (bearing2 - 90) * (Math.PI / 180);
        
        // Direction vectors - grid Y increases upward
        const d1 = { x: Math.cos(b1Rad), y: -Math.sin(b1Rad) };
        const d2 = { x: Math.cos(b2Rad), y: -Math.sin(b2Rad) };
        
        console.log(`  d1: (${d1.x.toFixed(3)}, ${d1.y.toFixed(3)}), d2: (${d2.x.toFixed(3)}, ${d2.y.toFixed(3)})`);
        
        const denom = d1.x * d2.y - d1.y * d2.x;
        console.log(`  denom: ${denom}`);
        
        if (Math.abs(denom) < 0.0001) {
            console.log('  ✗ Lines are parallel');
            return null;
        }
        
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const t1 = (dx * d2.y - dy * d2.x) / denom;
        const t2 = (dx * d1.y - dy * d1.x) / denom;
        
        console.log(`  t1: ${t1.toFixed(3)}, t2: ${t2.toFixed(3)}`);
        
        // Check if intersection is in front of BOTH markers
        const tolerance = 0.001;
        if (t1 < -tolerance || t2 < -tolerance) {
            console.log(`  ✗ Intersection is behind one or both markers`);
            return null;
        }
        
        // Use the forward intersection
        let intersectX = p1.x + t1 * d1.x;
        let intersectY = p1.y + t1 * d1.y;
        
        // Round to 2 decimal places
        intersectX = Math.round(intersectX * 100) / 100;
        intersectY = Math.round(intersectY * 100) / 100;
        
        console.log(`  Intersection point: (${intersectX}, ${intersectY})`);
        
        const grid = this.subUnitsToGridFloat(intersectX, intersectY);
        if (!grid) {
            console.log('  ✗ Invalid grid position');
            return null;
        }
        
        const dist1 = Math.sqrt((intersectX - p1.x) ** 2 + (intersectY - p1.y) ** 2) / 10;
        const dist2 = Math.sqrt((intersectX - p2.x) ** 2 + (intersectY - p2.y) ** 2) / 10;
        
        if (dist1 > 20 || dist2 > 20) {
            console.log(`  ✗ Intersection too far`);
            return null;
        }
        
        console.log(`  ✓ Valid intersection at ${this.toGridRefFloat(grid.col, grid.row, grid.subX, grid.subY)}`);
        
        return {
            x: intersectX,
            y: intersectY,
            grid: grid,
            distance1: dist1,
            distance2: dist2,
            gridRef: this.toGridRefFloat(grid.col, grid.row, grid.subX, grid.subY)
        };
    }

    calculateBearingDistanceIntersection(marker, bearing, fromMarker, distance) {
        const p1 = this.gridToSubUnits(marker.col, marker.row, marker.subX, marker.subY);
        const p2 = this.gridToSubUnits(fromMarker.col, fromMarker.row, fromMarker.subX, fromMarker.subY);
        
        console.log(`  Bearing-distance: ${marker.label} @ ${bearing}°, distance ${distance}km from ${fromMarker.label}`);
        
        // Convert bearing from 0°=North to radians
        const bearingRad = (bearing - 90) * (Math.PI / 180);
        
        // Direction vector - same flip as bearing-bearing (grid Y increases upward)
        const dir = { x: Math.cos(bearingRad), y: -Math.sin(bearingRad) };
        
        console.log(`  Direction: (${dir.x.toFixed(3)}, ${dir.y.toFixed(3)})`);
        console.log(`  FromMarker position: (${p2.x}, ${p2.y})`);
        
        // ============================================================
        // BEARING-DISTANCE INTERSECTION
        // Find where the bearing line from p1 intersects the circle
        // centered at p2 with radius = distance * 10
        // ============================================================
        
        // Vector from p1 to p2
        const vx = p2.x - p1.x;
        const vy = p2.y - p1.y;
        const distP1ToP2 = Math.sqrt(vx * vx + vy * vy);
        
        console.log(`  Distance from marker to fromMarker: ${(distP1ToP2 / 10).toFixed(2)}km`);
        
        // Project p2 onto the bearing line
        const proj = vx * dir.x + vy * dir.y;
        
        // Distance from p2 to the bearing line (perpendicular)
        const perpDist = Math.sqrt(Math.max(0, distP1ToP2 * distP1ToP2 - proj * proj));
        
        // Radius of the circle in sub-units - preserve 2 decimal precision
        const radius = Math.round(distance * 100) / 100 * 10;
        
        console.log(`  Projection: ${proj.toFixed(3)}, Perpendicular distance: ${perpDist.toFixed(3)}, Radius: ${radius.toFixed(3)}`);
        
        // Check if the bearing line intersects the circle
        if (perpDist > radius) {
            console.log(`  ✗ Bearing line does not intersect circle (perpDist ${perpDist.toFixed(2)} > radius ${radius.toFixed(2)})`);
            return null; // No intersection
        }
        
        // Calculate the distance along the bearing line to the intersection points
        const t = Math.sqrt(Math.max(0, radius * radius - perpDist * perpDist));
        
        // Two intersection points along the bearing line
        let t1 = proj - t;
        let t2 = proj + t;
        
        console.log(`  t1: ${t1.toFixed(3)}, t2: ${t2.toFixed(3)}`);
        
        const results = [];
        
        // Helper function to process each intersection
        const processIntersection = (tVal, label) => {
            // Only consider points in front of the marker (tVal > 0)
            if (tVal < 0) {
                console.log(`  ${label}: Behind marker, skipping`);
                return;
            }
            
            let intersectX = p1.x + tVal * dir.x;
            let intersectY = p1.y + tVal * dir.y;
            
            // Round to 2 decimal places
            intersectX = Math.round(intersectX * 100) / 100;
            intersectY = Math.round(intersectY * 100) / 100;
            
            console.log(`  ${label}: (${intersectX}, ${intersectY})`);
            
            const grid = this.subUnitsToGridFloat(intersectX, intersectY);
            if (!grid) {
                console.log(`  ${label}: Invalid grid position`);
                return;
            }
            
            // Verify the distance from fromMarker matches (with 0.05km tolerance for 2 decimal precision)
            const distFromFromMarker = Math.sqrt((intersectX - p2.x) ** 2 + (intersectY - p2.y) ** 2) / 10;
            const distFromFromMarkerRounded = Math.round(distFromFromMarker * 100) / 100;
            console.log(`  ${label}: Distance from fromMarker: ${distFromFromMarkerRounded.toFixed(2)}km (expected ${Math.round(distance * 100) / 100}km)`);
            
            // Use 0.05km tolerance for 2 decimal precision
            if (Math.abs(distFromFromMarker - distance) > 0.05) {
                console.log(`  ${label}: Distance mismatch`);
                return;
            }
            
            results.push({
                x: intersectX,
                y: intersectY,
                grid: grid,
                gridRef: this.toGridRefFloat(grid.col, grid.row, grid.subX, grid.subY),
                distance: Math.round(distance * 100) / 100,
                bearing: bearing,
                t: tVal,
                label: label
            });
        };
        
        processIntersection(t1, 'Intersection 1');
        processIntersection(t2, 'Intersection 2');
        
        if (results.length === 0) {
            console.log('  ✗ No valid intersections');
            return null;
        }
        
        if (results.length === 2 && Math.abs(results[0].t - results[1].t) < 0.001) {
            console.log('  Tangent - returning one intersection');
            return results[0];
        }
        
        console.log(`  ✓ Found ${results.length} intersection(s)`);
        return results;
    }

    calculateDistanceDistanceIntersection(marker1, distance1, marker2, distance2) {
        const p1 = this.gridToSubUnits(marker1.col, marker1.row, marker1.subX, marker1.subY);
        const p2 = this.gridToSubUnits(marker2.col, marker2.row, marker2.subX, marker2.subY);
        
        const d1 = Math.round(distance1 * 100) / 100;
        const d2 = Math.round(distance2 * 100) / 100;
        
        console.log(`  Distance-distance: ${marker1.label} (${d1}km) and ${marker2.label} (${d2}km)`);
        
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        const r1 = d1 * 10;
        const r2 = d2 * 10;
        
        console.log(`  Distance between markers: ${(dist / 10).toFixed(2)}km, r1: ${r1.toFixed(2)}, r2: ${r2.toFixed(2)}`);
        
        if (dist > r1 + r2 || dist < Math.abs(r1 - r2) || dist === 0) {
            console.log(`  ✗ Circles do not intersect`);
            return null;
        }
        
        const a = (r1 * r1 - r2 * r2 + dist * dist) / (2 * dist);
        const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
        
        const cx = p1.x + a * (dx / dist);
        const cy = p1.y + a * (dy / dist);
        
        let x1 = cx + h * (dy / dist);
        let y1 = cy - h * (dx / dist);
        let x2 = cx - h * (dy / dist);
        let y2 = cy + h * (dx / dist);
        
        x1 = Math.round(x1 * 100) / 100;
        y1 = Math.round(y1 * 100) / 100;
        x2 = Math.round(x2 * 100) / 100;
        y2 = Math.round(y2 * 100) / 100;
        
        const results = [];
        const grid1 = this.subUnitsToGridFloat(x1, y1);
        if (grid1) {
            results.push({
                x: x1,
                y: y1,
                grid: grid1,
                gridRef: this.toGridRefFloat(grid1.col, grid1.row, grid1.subX, grid1.subY),
                distance1: d1,
                distance2: d2
            });
        }
        const grid2 = this.subUnitsToGridFloat(x2, y2);
        if (grid2) {
            results.push({
                x: x2,
                y: y2,
                grid: grid2,
                gridRef: this.toGridRefFloat(grid2.col, grid2.row, grid2.subX, grid2.subY),
                distance1: d1,
                distance2: d2
            });
        }
        
        console.log(`  ✓ Found ${results.length} intersection(s)`);
        return results.length > 0 ? results : null;
    }

    calculatePositionFromBearingDistance(marker, bearing, distance) {
        const p1 = this.gridToSubUnits(marker.col, marker.row, marker.subX, marker.subY);
        
        console.log(`  Calculating position from ${marker.label}: bearing ${bearing}°, distance ${distance}km`);
        
        const bearingRad = (bearing - 90) * (Math.PI / 180);
        const dir = { x: Math.cos(bearingRad), y: -Math.sin(bearingRad) };
        
        const distUnits = distance * 10;
        let intersectX = p1.x + dir.x * distUnits;
        let intersectY = p1.y + dir.y * distUnits;
        
        intersectX = Math.round(intersectX * 100) / 100;
        intersectY = Math.round(intersectY * 100) / 100;
        
        console.log(`  Position: (${intersectX}, ${intersectY})`);
        
        const grid = this.subUnitsToGridFloat(intersectX, intersectY);
        if (!grid) {
            console.log('  ✗ Invalid grid position');
            return null;
        }
        
        console.log(`  ✓ Position at ${this.toGridRefFloat(grid.col, grid.row, grid.subX, grid.subY)}`);
        
        return {
            x: intersectX,
            y: intersectY,
            grid: grid,
            gridRef: this.toGridRefFloat(grid.col, grid.row, grid.subX, grid.subY),
            distance: distance,
            bearing: bearing
        };
    }

    displayTriangulateResults(results) {
        const container = document.getElementById('triangulateResults');
        const details = document.getElementById('triangulateResultDetails');
        
        this.triangulatePreview = null;
        
        if (results.length === 0) {
            container.style.display = 'block';
            details.innerHTML = '<span style="color:#ff8866;">No intersections found. Try adding more intel.</span>';
            document.getElementById('triangulateCreateMarkerBtn').style.display = 'none';
            return;
        }
        
        if (results.length > 1) {
            let html = '<div style="margin-top:4px; margin-bottom:6px; color:#ffd93d; font-weight:bold;">🔍 Multiple intersections found. Click "Create" to add marker:</div>';
            
            results.forEach((result, index) => {
                const inter = result.intersection;
                const typeLabel = {
                    'bearing-bearing': '<svg class="icon-sm"><use href="images/icons.svg#icon-angle"></use></svg> Bearing×Bearing',
                    'bearing-distance': '<svg class="icon-sm"><use href="images/icons.svg#icon-angle"></use></svg><svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg> Bearing×Distance',
                    'distance-distance': '<svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg><svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg> Distance×Distance'
                }[result.type] || 'Intersection';
                
                html += `
                    <div class="triangulate-result-card" 
                        data-index="${index}"
                        style="background:#0a121a; padding:8px 10px; border-radius:3px; margin-top:6px; border-left:3px solid #4ecdc4; cursor:pointer; transition:background 0.2s ease, transform 0.2s ease;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="color:#ffcc00; font-weight:bold; font-family:monospace;">${inter.gridRef}</div>
                                <div style="font-size:0.7rem; color:#6a7a8a;">${typeLabel}</div>
                                <div style="font-size:0.7rem; color:#8aacce; margin-top:2px;">
                                    ${result.item1 ? result.item1.marker.label : '?'} → ${result.item2 ? result.item2.marker.label : '?'}
                                    ${result.item1 && result.item1.bearing !== null ? ` | Brg: ${result.item1.bearing}°` : ''}
                                    ${result.item2 && result.item2.bearing !== null ? ` | Brg: ${result.item2.bearing}°` : ''}
                                </div>
                            </div>
                            <button onclick="window.gridMapper.createMarkerFromTriangulateResult(${index})" 
                                    style="padding:3px 14px; background:#2a5a3a; color:#88ffaa; border:1px solid #3a8a5a; border-radius:3px; cursor:pointer; font-size:0.7rem; font-family:inherit; white-space:nowrap; margin-left:8px;">
                                <svg class="icon-sm"><use href="images/icons.svg#icon-add-circle"></use></svg> Create
                            </button>
                        </div>
                    </div>
                `;
            });
            
            details.innerHTML = html;
            container.style.display = 'block';
            document.getElementById('triangulateCreateMarkerBtn').style.display = 'none';
            
            // ============================================================
            // FIX: Store the results with proper structure
            // ============================================================
            this.triangulateResultsAll = results;
            this.triangulateResult = null;
            
            const cards = container.querySelectorAll('.triangulate-result-card');
            cards.forEach(card => {
                const idx = parseInt(card.dataset.index);
                
                card.addEventListener('mouseenter', () => {
                    card.style.background = 'rgba(255, 217, 61, 0.08)';
                    card.style.transform = 'scale(1.01)';
                    const res = results[idx];
                    if (res) {
                        this.showTriangulatePreview(res.intersection);
                    }
                });
                
                card.addEventListener('mouseleave', () => {
                    card.style.background = '#0a121a';
                    card.style.transform = 'scale(1)';
                    this.clearTriangulatePreview();
                });
            });
            
            return;
        }
        
        // Single result
        const best = results[0];
        const inter = best.intersection;
        
        container.style.display = 'block';
        
        let typeLabel = {
            'bearing-bearing': '<svg class="icon-sm"><use href="images/icons.svg#icon-angle"></use></svg> Bearing × Bearing',
            'bearing-distance': '<svg class="icon-sm"><use href="images/icons.svg#icon-angle"></use></svg><svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg> Bearing × Distance',
            'distance-distance': '<svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg><svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg> Distance × Distance',
            'bearing-distance-single': '<svg class="icon-sm"><use href="images/icons.svg#icon-angle"></use></svg><svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg> Bearing + Distance (Single Marker)'
        }[best.type] || 'Intersection';
        
        const targetType = document.getElementById('triangulateTargetType').value;
        
        details.innerHTML = `
            <div class="triangulate-result-card"
                style="margin-top:4px; background:#0a121a; padding:8px 10px; border-radius:3px; border-left:3px solid #4ecdc4; cursor:pointer; transition:background 0.2s ease;">
                <div style="color:#ffcc00; font-weight:bold; font-size:1.1rem; font-family:monospace;">${inter.gridRef}</div>
                <div style="font-size:0.75rem; color:#6a7a8a; margin-top:2px;">
                    Method: ${typeLabel}
                </div>
                <div style="font-size:0.75rem; color:#6a7a8a; margin-top:2px;">
                    ${best.item1 ? best.item1.marker.label : '?'} → ${best.item2 ? best.item2.marker.label : '?'}
                </div>
                <div style="font-size:0.75rem; color:#8aacce; margin-top:2px;">
                    ${best.item1 && best.item1.bearing !== null ? `<svg class="icon-sm"><use href="images/icons.svg#icon-angle"></use></svg> Brg: ${best.item1.bearing}°` : ''}
                    ${best.item1 && best.item1.distance !== null ? ` <svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg> Dist: ${best.item1.distance}km` : ''}
                    ${best.item2 && best.item2.bearing !== null ? ` | <svg class="icon-sm"><use href="images/icons.svg#icon-angle"></use></svg> Brg: ${best.item2.bearing}°` : ''}
                    ${best.item2 && best.item2.distance !== null ? ` <svg class="icon-sm"><use href="images/icons.svg#icon-radius"></use></svg> Dist: ${best.item2.distance}km` : ''}
                </div>
                <div style="font-size:0.75rem; color:#8aacce; margin-top:2px;">
                    Creating as: ${document.getElementById('triangulateTargetType').selectedOptions[0].text}
                </div>
                <div style="font-size:0.75rem; color:#ffd93d; margin-top:4px;">
                    <svg class="icon-sm"><use href="images/icons.svg#icon-lightbulb"></use></svg> Intel will be added to the reference markers
                </div>
                <div style="font-size:0.7rem; color:#6a7a8a; margin-top:4px;">
                    👆 Hover over this card to preview on grid
                </div>
                <button onclick="window.gridMapper.createMarkerFromTriangulateResult(0)" 
                        style="margin-top:8px; padding:4px 14px; background:#2a5a3a; color:#88ffaa; border:1px solid #3a8a5a; border-radius:3px; cursor:pointer; font-size:0.75rem; font-family:inherit;">
                    <svg class="icon-sm"><use href="images/icons.svg#icon-add-circle"></use></svg> Create Marker
                </button>
            </div>
        `;
        
        // ============================================================
        // FIX: Store the result with proper structure
        // ============================================================
        this.triangulateResult = {
            gridRef: inter.gridRef,
            grid: inter.grid,
            type: best.type,
            items: [best.item1, best.item2].filter(item => item !== undefined),
            targetType: targetType,
            intersection: inter,
            resultIndex: 0
        };
        
        document.getElementById('triangulateCreateMarkerBtn').style.display = 'none';
        this.triangulateResultsAll = null;
        this.render();
        
        const card = container.querySelector('.triangulate-result-card');
        if (card) {
            card.addEventListener('mouseenter', () => {
                card.style.background = 'rgba(255, 217, 61, 0.08)';
                this.showTriangulatePreview(inter);
            });
            
            card.addEventListener('mouseleave', () => {
                card.style.background = '#0a121a';
                this.clearTriangulatePreview();
            });
        }
    }

    showTriangulatePreview(intersection) {
        this.triangulatePreview = intersection;
        this.render();
    }

    createMarkerFromTriangulateResult(index) {
        let result;
        let items = [];
        let intersection = null;
        
        // Check if we have multiple results or a single result
        if (this.triangulateResultsAll && this.triangulateResultsAll.length > 0) {
            // Multiple results - use the index
            if (index >= this.triangulateResultsAll.length) return;
            const selected = this.triangulateResultsAll[index];
            result = selected;
            intersection = selected.intersection;
            // ============================================================
            // FIX: Extract items from the result structure
            // ============================================================
            if (selected.item1 && selected.item2) {
                items = [selected.item1, selected.item2];
            }
        } else if (this.triangulateResult) {
            // Single result
            result = this.triangulateResult;
            intersection = result.intersection || result;
            // ============================================================
            // FIX: Extract items from the result structure
            // ============================================================
            if (result.items && result.items.length > 0) {
                items = result.items;
            }
        } else {
            this.showToast('No triangulation result to create marker from', 'warning');
            return;
        }
        
        // ============================================================
        // FIX: If no items found, try to get them from the result
        // ============================================================
        if (items.length === 0 && result) {
            // Try different property names
            if (result.item1 && result.item2) {
                items = [result.item1, result.item2];
            } else if (result.items && result.items.length > 0) {
                items = result.items;
            } else {
                this.showToast('No source markers found for this intersection', 'warning');
                return;
            }
        }
        
        if (!intersection) {
            this.showToast('No intersection data found', 'warning');
            return;
        }
        
        // Get the target type
        const type = result.targetType || document.getElementById('triangulateTargetType').value;
        if (!type) {
            this.showToast('Please select a target type', 'warning');
            return;
        }
        
        const prevType = this.markerManager.selectedType;
        this.markerManager.selectedType = type;
        
        // ============================================================
        // FIX: Create the marker with the intersection grid position
        // ============================================================
        const grid = intersection.grid;
        if (!grid) {
            this.showToast('Invalid grid position for marker', 'warning');
            this.markerManager.selectedType = prevType;
            return;
        }
        
        const marker = this.addMarkerAt(
            grid.col,
            grid.row,
            grid.subX,
            grid.subY,
            false // Don't center - use exact position
        );
        
        this.markerManager.selectedType = prevType;
        
        if (marker) {
            // ============================================================
            // FIX: ADD USER-ENTERED INTEL TO THE SOURCE MARKERS
            // ============================================================
            let intelAdded = 0;
            for (const item of items) {
                const sourceMarker = item.marker;
                if (sourceMarker && sourceMarker.id) {
                    // Get the bearing and distance from the item
                    const bearing = item.bearing !== undefined ? item.bearing : null;
                    const distance = item.distance !== undefined ? item.distance : null;
                    
                    if (bearing !== null || distance !== null) {
                        const entry = this.addIntel(sourceMarker.id, bearing, distance);
                        if (entry) {
                            intelAdded++;
                            console.log(`Added intel to ${sourceMarker.label}: bearing ${bearing}°, distance ${distance}km`);
                        }
                    }
                }
            }
            
            this.showToast(
                `Created ${marker.label} at ${intersection.gridRef}. Intel added to ${intelAdded} source marker(s).`,
                'success'
            );
            
            // Clear the results
            const container = document.getElementById('triangulateResults');
            if (container) container.style.display = 'none';
            this.triangulateResult = null;
            this.triangulateResultsAll = null;
            this.triangulatePreview = null;
            
            this.selectMarker(marker);
            this.updateMarkerList();
            this.updateDropdowns();
            this.render();
        } else {
            this.showToast('Failed to create marker', 'warning');
        }
    }

    selectTriangulateResult(index) {
        const results = this.triangulateResultsAll;
        if (!results || index >= results.length) return;
        
        const selected = results[index];
        const targetType = document.getElementById('triangulateTargetType').value;
        
        this.triangulateResult = {
            gridRef: selected.intersection.gridRef,
            grid: selected.intersection.grid,
            type: selected.type,
            items: [selected.item1, selected.item2],
            targetType: targetType,
            intersection: selected.intersection,
            resultIndex: index
        };
        
        this.triangulatePreview = null;
        
        // Update the details to show the selected result with Create button
        const details = document.getElementById('triangulateResultDetails');
        details.innerHTML = `
            <div style="margin-top:4px;">
                <div style="color:#ffcc00; font-weight:bold;">${selected.intersection.gridRef}</div>
                <div style="font-size:0.75rem; color:#4ecdc4;">Selected intersection</div>
                <div style="font-size:0.75rem; color:#6a7a8a; margin-top:4px;">
                    ${selected.item1.marker.label} → ${selected.item2.marker.label}
                </div>
                <div style="font-size:0.75rem; color:#8aacce;">
                    ${selected.item1.bearing !== null ? `Brg: ${selected.item1.bearing}°` : ''}
                    ${selected.item1.distance !== null ? ` Dist: ${selected.item1.distance}km` : ''}
                    ${selected.item2.bearing !== null ? ` | Brg: ${selected.item2.bearing}°` : ''}
                    ${selected.item2.distance !== null ? ` Dist: ${selected.item2.distance}km` : ''}
                </div>
                <button onclick="window.gridMapper.createMarkerFromTriangulateResult(0)" 
                        style="margin-top:8px; padding:4px 14px; background:#2a5a3a; color:#88ffaa; border:1px solid #3a8a5a; border-radius:3px; cursor:pointer; font-size:0.75rem; font-family:inherit;">
                    <svg class="icon-sm"><use href="images/icons.svg#icon-add-circle"></use></svg> Create Marker
                </button>
            </div>
        `;
        
        this.triangulateResultsAll = null;
        this.render();
    }

    clearTriangulatePreview() {
        this.triangulatePreview = null;
        this.render();
    }
    
    // ==========================================
    // DRAW FUNCTIONS
    // ==========================================

    drawIntel(ctx, marker) {
        const pos = this.gridToPixel(marker.col, marker.row, marker.subX, marker.subY);
        const isHovered = this.hoveredItem && this.hoveredItem.type === 'marker' && this.hoveredItem.item.id === marker.id;
        const { cellSize } = this.getCanvasInfo();

        // Marker circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, isHovered ? 7 : 5, 0, 2 * Math.PI);
        ctx.fillStyle = marker.color || '#ff4d4d';
        ctx.fill();
        ctx.strokeStyle = isHovered ? '#ffd93d' : '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();

        // Marker label and subgrid
        if (cellSize > 20 && marker.label) {
            ctx.save();
            ctx.fillStyle = isHovered ? '#ffd93d' : '#b0c4de';
            ctx.font = `${this.gridFontSize}px sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(marker.label, pos.x + 8, pos.y - 2);

            ctx.fillStyle = '#4a7a7a';
            ctx.font = `${this.gridFontSize - 2}px monospace`;
            ctx.textBaseline = 'top';
            ctx.fillText(`${marker.subX}:${marker.subY}`, pos.x + 8, pos.y + 2);
            ctx.restore();
        }

        const intelEntries = this.getIntel(marker.id);
        if (!intelEntries || intelEntries.length === 0) {
            return;
        }

        const { w, h } = this.getCanvasInfo();
        const pixelsPerKm = cellSize;

        for (const entry of intelEntries) {
            // --- Draw Distance Circle ---
            if (entry.distance !== null) {
                const radius = entry.distance * pixelsPerKm;
                ctx.save();
                
                if (entry.distance === 0) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, 3, 0, 2 * Math.PI);
                    ctx.stroke();
                    ctx.fillStyle = 'rgba(255,255,255,0.9)';
                    ctx.font = '8px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText('0.00 km', pos.x, pos.y - 8);
                } else if (entry.distance > 0) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                    ctx.lineWidth = 2;
                    ctx.setLineDash([8, 6]);
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, radius, 0, 2 * Math.PI);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = 'rgba(255,255,255,0.9)';
                    ctx.font = '10px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(`${entry.distance.toFixed(2)} km`, pos.x, pos.y - radius - 4);
                }
                ctx.restore();
            }

            // --- Draw Bearing Arrow ---
            if (entry.bearing !== null) {
                const bearingRad = (entry.bearing - 90) * (Math.PI / 180);
                
                const { w, h, cellSize } = this.getCanvasInfo();
                const baseLength = Math.max(w, h) * 1.5;
                const zoomScale = Math.max(1, this.zoomLevel);
                const maxDistance = baseLength * zoomScale;
                
                const endX = pos.x + Math.cos(bearingRad) * maxDistance;
                const endY = pos.y + Math.sin(bearingRad) * maxDistance;
                
                ctx.save();
                
                if (isHovered) {
                    ctx.shadowColor = '#ffd93d';
                    ctx.shadowBlur = 15;
                }
                
                ctx.strokeStyle = '#ffd93d';
                ctx.lineWidth = isHovered ? 3 : 2;
                ctx.beginPath();
                ctx.moveTo(pos.x, pos.y);
                ctx.lineTo(endX, endY);
                ctx.stroke();
                
                const arrowSize = isHovered ? 12 : 10;
                const angle = Math.atan2(endY - pos.y, endX - pos.x);
                ctx.shadowBlur = 0;
                ctx.fillStyle = '#ffd93d';
                ctx.beginPath();
                ctx.moveTo(endX, endY);
                ctx.lineTo(endX - arrowSize * Math.cos(angle - 0.4), endY - arrowSize * Math.sin(angle - 0.4));
                ctx.lineTo(endX - arrowSize * Math.cos(angle + 0.4), endY - arrowSize * Math.sin(angle + 0.4));
                ctx.closePath();
                ctx.fill();
                
                const labelDistance = Math.min(cellSize * 0.6, 30);
                const labelX = pos.x + Math.cos(bearingRad) * labelDistance;
                const labelY = pos.y + Math.sin(bearingRad) * labelDistance;
                
                ctx.shadowBlur = 0;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                
                const text = `${entry.bearing.toFixed(1)}°`;
                ctx.font = isHovered ? 'bold 12px sans-serif' : '11px sans-serif';
                
                const metrics = ctx.measureText(text);
                const pad = 4;
                ctx.fillStyle = 'rgba(13, 21, 32, 0.7)';
                ctx.fillRect(labelX - metrics.width/2 - pad, labelY - 8 - pad, metrics.width + pad*2, 16 + pad*2);
                
                ctx.fillStyle = '#ffd93d';
                ctx.fillText(text, labelX, labelY);
                
                if (entry.distance !== null) {
                    const distLabel = `${entry.distance.toFixed(2)} km`;
                    const distLabelX = endX - Math.cos(bearingRad) * 30;
                    const distLabelY = endY - Math.sin(bearingRad) * 30;
                    
                    ctx.font = '9px sans-serif';
                    const distMetrics = ctx.measureText(distLabel);
                    const distPad = 3;
                    ctx.fillStyle = 'rgba(13, 21, 32, 0.7)';
                    ctx.fillRect(distLabelX - distMetrics.width/2 - distPad, distLabelY - 7 - distPad, distMetrics.width + distPad*2, 14 + distPad*2);
                    
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(distLabel, distLabelX, distLabelY);
                }
                
                ctx.restore();
            }
        }
    }

    drawFreeDrawings(ctx) {
        const { w, h, cellSize } = this.getCanvasInfo();
        
        for (const drawing of this.freeDrawings) {

            // --- DRAW COMPASS CIRCLES ---
            if (drawing.type === 'compass') {
                const startGrid = drawing.startGrid;
                if (!startGrid) continue;
                
                const pos = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
                const endGrid = drawing.endGrid;
                if (!endGrid) continue;
                
                const endPos = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
                const dx = endPos.x - pos.x;
                const dy = endPos.y - pos.y;
                const radius = Math.sqrt(dx * dx + dy * dy);
                
                if (radius > 1) {
                    ctx.save();
                    ctx.strokeStyle = drawing.color || 'rgba(255,255,255,0.8)';
                    ctx.lineWidth = 2;
                    ctx.setLineDash([8, 6]);
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, radius, 0, 2 * Math.PI);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    
                    if (drawing.distance !== undefined && drawing.distance !== null) {
                        // Show with 2 decimal places like the yellow line
                        const label = `${drawing.distance.toFixed(2)} km`;
                        const labelX = endPos.x - 40;
                        const labelY = endPos.y - 5;
                        
                        ctx.font = '10px sans-serif';
                        const metrics = ctx.measureText(label);
                        const pad = 4;
                        ctx.fillStyle = 'rgba(13, 21, 32, 0.7)';
                        ctx.fillRect(labelX - pad, labelY - 8 - pad, metrics.width + pad * 2, 16 + pad * 2);
                        
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(label, labelX, labelY);
                    }
                    
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, 3, 0, 2 * Math.PI);
                    ctx.fill();
                    
                    ctx.restore();
                }
                continue;
            }
            
            // --- DRAW ARROWS ---
            const startGrid = drawing.startGrid;
            const endGrid = drawing.endGrid;
            
            if (!startGrid || !endGrid) continue;

            const start = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
            const end = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
            
            const color = drawing.color || '#ffd93d';
            const isAuto = drawing.autoIntel;
            const isHovered = this.hoveredItem && this.hoveredItem.type === 'freeDrawing' && this.hoveredItem.item.id === drawing.id;

            ctx.save();
            if (isHovered) {
                ctx.shadowColor = color;
                ctx.shadowBlur = 15;
            }
            
            ctx.strokeStyle = color;
            ctx.lineWidth = isHovered ? (isAuto ? 4 : 3.5) : (isAuto ? 3 : 2.5);
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
            
            const angle = Math.atan2(end.y - start.y, end.x - start.x);
            const arrowSize = isHovered ? (isAuto ? 14 : 12) : (isAuto ? 12 : 10);
            ctx.shadowBlur = 0;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(end.x, end.y);
            ctx.lineTo(end.x - arrowSize * Math.cos(angle - 0.4), end.y - arrowSize * Math.sin(angle - 0.4));
            ctx.lineTo(end.x - arrowSize * Math.cos(angle + 0.4), end.y - arrowSize * Math.sin(angle + 0.4));
            ctx.closePath();
            ctx.fill();

            if (drawing.bearing !== undefined && drawing.distance !== undefined) {
                const midX = (start.x + end.x) / 2;
                const midY = (start.y + end.y) / 2;
                
                ctx.shadowBlur = 0;
                ctx.fillStyle = color;
                ctx.font = isHovered ? 'bold 10px sans-serif' : (isAuto ? 'bold 10px sans-serif' : '9px sans-serif');
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                
                const label = `${drawing.bearing.toFixed(1)}° | ${drawing.distance.toFixed(2)}km`;
                
                const metrics = ctx.measureText(label);
                const pad = 4;
                ctx.fillStyle = 'rgba(13, 21, 32, 0.7)';
                ctx.fillRect(midX - metrics.width/2 - pad, midY - 16 - pad, metrics.width + pad*2, 16 + pad*2);
                            
                ctx.fillStyle = color;
                ctx.fillText(label, midX, midY - 4);
                
                ctx.font = '7px monospace';
                ctx.fillStyle = isAuto ? 'rgba(255,68,68,0.7)' : 'rgba(255,255,255,0.5)';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                if (drawing.startRef) ctx.fillText(drawing.startRef, start.x + 4, start.y + 4);
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                if (drawing.endRef) ctx.fillText(drawing.endRef, end.x - 4, end.y - 4);
            }
            ctx.restore();
        }
    }

    drawFreeDrawingPreview(ctx) {
        if (!this.isFreeDrawing || !this.freeDrawing || !this.freeDrawing.endGrid) return;

        const drawing = this.freeDrawing;
        const startGrid = drawing.startGrid;
        const endGrid = drawing.endGrid;
        
        if (!startGrid || !endGrid) return;
        
        const start = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
        const end = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
        
        const color = drawing.color || '#ffd93d';

        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
        
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const arrowSize = 10;
        ctx.shadowBlur = 0;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - arrowSize * Math.cos(angle - 0.4), end.y - arrowSize * Math.sin(angle - 0.4));
        ctx.lineTo(end.x - arrowSize * Math.cos(angle + 0.4), end.y - arrowSize * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fill();

        if (drawing.bearing !== undefined && drawing.distance !== undefined) {
            const midX = (start.x + end.x) / 2;
            const midY = (start.y + end.y) / 2;
            ctx.shadowBlur = 0;
            ctx.fillStyle = color;
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`${drawing.bearing.toFixed(0)}° | ${drawing.distance.toFixed(2)}km`, midX, midY - 4);
            
            ctx.font = '7px monospace';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            if (drawing.startRef) ctx.fillText(drawing.startRef, start.x + 4, start.y + 4);
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            if (drawing.endRef) ctx.fillText(drawing.endRef, end.x - 4, end.y - 4);
        }
        ctx.restore();
    }

    drawIntersections(ctx, intersections) {
        for (const inter of intersections) {
            const pos = this.gridToPixel(
                inter.intersection.grid.col,
                inter.intersection.grid.row,
                inter.intersection.grid.subX,
                inter.intersection.grid.subY
            );
            ctx.save();
            ctx.shadowColor = '#ff0066';
            ctx.shadowBlur = 20;
            ctx.strokeStyle = '#ff0066';
            ctx.lineWidth = 2;
            const size = 8;
            ctx.beginPath();
            ctx.moveTo(pos.x - size, pos.y);
            ctx.lineTo(pos.x + size, pos.y);
            ctx.moveTo(pos.x, pos.y - size);
            ctx.lineTo(pos.x, pos.y + size);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#ff0066';
            ctx.font = '8px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText('TARGET', pos.x, pos.y + 10);
            ctx.restore();
        }
    }

    drawMeasurement(fromMarker, toMarker, result) {
        const ctx = this.ctx;
        const fromPos = this.gridToPixel(fromMarker.col, fromMarker.row, fromMarker.subX, fromMarker.subY);
        const toPos = this.gridToPixel(toMarker.col, toMarker.row, toMarker.subX, toMarker.subY);
        
        ctx.save();
        ctx.strokeStyle = '#ffd93d';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(fromPos.x, fromPos.y);
        ctx.lineTo(toPos.x, toPos.y);
        ctx.stroke();
        ctx.setLineDash([]);
        
        const midX = (fromPos.x + toPos.x) / 2;
        const midY = (fromPos.y + toPos.y) / 2;
        const label = `${result.distance.toFixed(2)} km  ${result.bearing.toFixed(0)}°`;
        ctx.font = '10px sans-serif';
        const metrics = ctx.measureText(label);
        const padding = 4;
        const labelWidth = metrics.width + padding * 2;
        const labelHeight = 16 + padding * 2;
        
        ctx.fillStyle = 'rgba(13,21,32,0.85)';
        ctx.fillRect(midX - labelWidth/2, midY - labelHeight/2, labelWidth, labelHeight);
        ctx.fillStyle = '#ffd93d';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, midX, midY);
        
        ctx.fillStyle = '#ffd93d';
        ctx.beginPath();
        ctx.arc(fromPos.x, fromPos.y, 4, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(toPos.x, toPos.y, 4, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
    }

    drawCompassPreview(ctx) {
        if (!this.isDrawingCompass || !this.compassCircle) return;

        const startGrid = this.compassCircle.startGrid;
        const endGrid = this.compassCircle.endGrid;
        
        if (!startGrid || !endGrid) return;
        
        const startPos = this.gridToPixel(startGrid.col, startGrid.row, startGrid.subX, startGrid.subY);
        const endPos = this.gridToPixel(endGrid.col, endGrid.row, endGrid.subX, endGrid.subY);
        
        const dx = endPos.x - startPos.x;
        const dy = endPos.y - startPos.y;
        const radius = Math.sqrt(dx * dx + dy * dy);
        
        if (radius > 1) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 6]);
            ctx.beginPath();
            ctx.arc(startPos.x, startPos.y, radius, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.setLineDash([]);
            
            if (this.compassCircle.distance !== undefined && this.compassCircle.distance !== null) {
                // Show with 2 decimal places like the yellow line
                const label = `${this.compassCircle.distance.toFixed(2)} km`;
                const labelX = endPos.x - 40;
                const labelY = endPos.y - 10;
                
                ctx.font = '10px sans-serif';
                const metrics = ctx.measureText(label);
                const pad = 4;
                ctx.fillStyle = 'rgba(13, 21, 32, 0.7)';
                ctx.fillRect(labelX - pad, labelY - 8 - pad, metrics.width + pad * 2, 16 + pad * 2);
                
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, labelX, labelY);
            }
            
            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.beginPath();
            ctx.arc(startPos.x, startPos.y, 3, 0, 2 * Math.PI);
            ctx.fill();
            
            ctx.restore();
        }
    }

    updateDrawings() {
        this.drawingsChanged = true;
        this.requestRender();
    }

    updateIntel() {
        this.intelChanged = true;
        this.requestRender();
    }

    // ==========================================
    // RENDER
    // ==========================================

    requestRender(force = false, immediate = false) {
        // If immediate, render right now
        if (immediate) {
            this.renderRequested = false;
            this.lastRenderTime = performance.now();
            this.doRender();
            return;
        }
        
        // Otherwise, use throttled rendering
        if (this.renderRequested) return;
        
        this.renderRequested = true;
        requestAnimationFrame(() => {
            this.renderRequested = false;
            
            const now = performance.now();
            if (now - this.lastRenderTime < this.minRenderInterval && !force) {
                this.renderPending = true;
                requestAnimationFrame(() => {
                    this.renderPending = false;
                    this.lastRenderTime = performance.now();
                    this.doRender();
                });
                return;
            }
            
            this.lastRenderTime = now;
            this.doRender();
        });
    }

    doRender() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;
        
        // Clear the entire canvas
        ctx.clearRect(0, 0, w, h);
        
        // LAYER 1: Background (cached)
        this.renderBackground(ctx);
        
        // LAYER 2: Markers + Intel + Drawings (all drawn together)
        this.renderAllOverlays(ctx);
        
        // LAYER 3: Hover effects (always render)
        this.renderHoverEffects(ctx);
    }

    renderBackground(ctx) {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const { cellSize, offsetX, offsetY, subSize, padding } = this.getCanvasInfo();
        
        // Check if background needs redrawing
        if (!this.bgNeedsRedraw) {
            ctx.drawImage(this.bgCanvas, 0, 0);
            return;
        }
        
        // Draw background from scratch
        const bgCtx = this.bgCtx;
        this.bgCanvas.width = w;
        this.bgCanvas.height = h;
        
        bgCtx.fillStyle = '#0d1520';
        bgCtx.fillRect(0, 0, w, h);
        
        bgCtx.save();
        bgCtx.beginPath();
        bgCtx.rect(padding, padding, w - padding * 2, h - padding * 2);
        bgCtx.clip();
        
        // Grid lines
        bgCtx.strokeStyle = 'rgba(100, 140, 170, 0.35)';
        bgCtx.lineWidth = 1;
        for (let i = 0; i <= this.cols; i++) {
            bgCtx.beginPath();
            bgCtx.moveTo(offsetX + i * cellSize, offsetY);
            bgCtx.lineTo(offsetX + i * cellSize, offsetY + this.rows * cellSize);
            bgCtx.stroke();
        }
        for (let i = 0; i <= this.rows; i++) {
            bgCtx.beginPath();
            bgCtx.moveTo(offsetX, offsetY + i * cellSize);
            bgCtx.lineTo(offsetX + this.cols * cellSize, offsetY + i * cellSize);
            bgCtx.stroke();
        }
        
        // Sub-grid
        if (subSize >= 3) {
            bgCtx.strokeStyle = 'rgba(100, 140, 170, 0.2)';
            bgCtx.lineWidth = 0.5;
            for (let col = 0; col < this.cols; col++) {
                for (let row = 0; row < this.rows; row++) {
                    const cellLeft = offsetX + col * cellSize;
                    const cellTop = offsetY + (this.rows - 1 - row) * cellSize;
                    for (let sub = 1; sub < this.subGridSize; sub++) {
                        const subXPos = cellLeft + sub * subSize;
                        bgCtx.beginPath();
                        bgCtx.moveTo(subXPos, cellTop);
                        bgCtx.lineTo(subXPos, cellTop + cellSize);
                        bgCtx.stroke();
                        const subYPos = cellTop + sub * subSize;
                        bgCtx.beginPath();
                        bgCtx.moveTo(cellLeft, subYPos);
                        bgCtx.lineTo(cellLeft + cellSize, subYPos);
                        bgCtx.stroke();
                    }
                }
            }
        }
        
        bgCtx.strokeStyle = '#3a5a6a';
        bgCtx.lineWidth = 2;
        bgCtx.strokeRect(offsetX, offsetY, this.cols * cellSize, this.rows * cellSize);
        bgCtx.restore();
        
        // Cell labels
        if (cellSize > 30) {
            bgCtx.fillStyle = 'rgba(100, 140, 170, 0.8)';
            bgCtx.font = `${this.gridFontSize}px monospace`;
            bgCtx.textAlign = 'left';
            bgCtx.textBaseline = 'top';
            for (let col = 0; col < this.cols; col++) {
                for (let row = 0; row < this.rows; row++) {
                    const pos = this.gridToPixel(col, row, 0.5, 8.5);
                    bgCtx.fillText(`${String.fromCharCode(65 + col)}${row + 1}`, pos.x, pos.y);
                }
            }
        }
        
        // Column labels
        bgCtx.fillStyle = '#4a7a8a';
        bgCtx.font = `${this.gridFontSize + 1}px monospace`;
        bgCtx.textAlign = 'center';
        bgCtx.textBaseline = 'top';
        for (let i = 0; i < this.cols; i++) {
            const x = offsetX + (i + 0.5) * cellSize;
            const y = offsetY + this.rows * cellSize + 4;
            if (y < h - 2) {
                bgCtx.fillText(String.fromCharCode(65 + i), x, y);
            }
        }
        
        // Row labels
        bgCtx.textAlign = 'right';
        bgCtx.textBaseline = 'middle';
        bgCtx.font = `${this.gridFontSize + 1}px monospace`;
        for (let i = 0; i < this.rows; i++) {
            const rowNum = i + 1;
            const x = offsetX - 6;
            const y = offsetY + (this.rows - 1 - i + 0.5) * cellSize;
            if (x > 2) {
                bgCtx.fillText(rowNum.toString(), x, y);
            }
        }
        
        this.bgNeedsRedraw = false;
        ctx.drawImage(this.bgCanvas, 0, 0);
    }

    renderAllOverlays(ctx) {
        // Draw all markers with their intel
        const markers = this.markerManager ? this.markerManager.getAllMarkers() : [];
        for (const marker of markers) {
            this.drawIntel(ctx, marker);
        }
        
        // Draw free drawings (arrows, compass circles)
        this.drawFreeDrawings(ctx);
        
        // Draw drawing previews (if actively drawing)
        if (this.isFreeDrawing) {
            this.drawFreeDrawingPreview(ctx);
        }
        if (this.isDrawingCompass) {
            this.drawCompassPreview(ctx);
        }
        
        // Draw triangulation preview
        if (this.triangulatePreview) {
            this.drawTriangulationPreview(ctx);
        }
    }

    drawTriangulationPreview(ctx) {
        const preview = this.triangulatePreview;
        const pos = this.gridToPixel(
            preview.grid.col,
            preview.grid.row,
            preview.grid.subX,
            preview.grid.subY
        );
        
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 255, 136, 0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 16, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
        
        ctx.strokeStyle = 'rgba(0, 255, 136, 0.9)';
        ctx.lineWidth = 2;
        const size = 10;
        ctx.beginPath();
        ctx.moveTo(pos.x - size, pos.y);
        ctx.lineTo(pos.x + size, pos.y);
        ctx.moveTo(pos.x, pos.y - size);
        ctx.lineTo(pos.x, pos.y + size);
        ctx.stroke();
        
        ctx.fillStyle = 'rgba(0, 255, 136, 0.9)';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 3, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(0, 255, 136, 0.8)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('Preview', pos.x, pos.y - 22);
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.font = '7px monospace';
        ctx.textBaseline = 'top';
        ctx.fillText(preview.gridRef, pos.x, pos.y + 22);
        ctx.restore();
    }

    renderHoverEffects(ctx) {
        // Hovered cell highlight
        if (this.hoveredCell) {
            const cell = this.hoveredCell;
            const { subSize } = this.getCanvasInfo();
            const pos = this.gridToPixelExact(cell.col, cell.row, cell.subX, cell.subY);
            ctx.save();
            ctx.fillStyle = 'rgba(78, 205, 196, 0.25)';
            ctx.fillRect(pos.x, pos.y, subSize, subSize);
            ctx.restore();
        }
        
        // Hovered item glow
        if (this.hoveredItem) {
            ctx.save();
            ctx.strokeStyle = '#ffd93d';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            
            if (this.hoveredItem.type === 'marker') {
                const m = this.hoveredItem.item;
                const pos = this.gridToPixel(m.col, m.row, m.subX, m.subY);
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 16, 0, 2 * Math.PI);
                ctx.stroke();
            } else if (this.hoveredItem.type === 'freeDrawing') {
                const d = this.hoveredItem.item;
                if (d.startGrid && d.endGrid) {
                    const start = this.gridToPixel(d.startGrid.col, d.startGrid.row, d.startGrid.subX, d.startGrid.subY);
                    const end = this.gridToPixel(d.endGrid.col, d.endGrid.row, d.endGrid.subX, d.endGrid.subY);
                    ctx.beginPath();
                    ctx.moveTo(start.x, start.y);
                    ctx.lineTo(end.x, end.y);
                    ctx.stroke();
                }
            }
            ctx.restore();
        }
    }

    markBackgroundDirty() {
        this.bgNeedsRedraw = true;
    }
    
    // Override zoom methods
    zoomIn(mouseX, mouseY) {
        this.smoothZoomTo(this.zoomLevel * 1.2, mouseX, mouseY);
        this.markBackgroundDirty();
        this.requestRender();
    }
    
    zoomOut(mouseX, mouseY) {
        this.smoothZoomTo(this.zoomLevel / 1.2, mouseX, mouseY);
        this.markBackgroundDirty();
        this.requestRender();
    }
    
    resetZoom() {
        this.smoothZoomTo(1, this.canvas.width / 2, this.canvas.height / 2);
        this.markBackgroundDirty();
        this.requestRender();
    }
    
    render(immediate = true) {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const { cellSize, offsetX, offsetY, subSize, padding } = this.getCanvasInfo();
        
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0d1520';
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.beginPath();
        ctx.rect(padding, padding, w - padding * 2, h - padding * 2);
        ctx.clip();
        
        ctx.strokeStyle = 'rgba(100, 140, 170, 0.35)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= this.cols; i++) {
            ctx.beginPath();
            ctx.moveTo(offsetX + i * cellSize, offsetY);
            ctx.lineTo(offsetX + i * cellSize, offsetY + this.rows * cellSize);
            ctx.stroke();
        }
        for (let i = 0; i <= this.rows; i++) {
            ctx.beginPath();
            ctx.moveTo(offsetX, offsetY + i * cellSize);
            ctx.lineTo(offsetX + this.cols * cellSize, offsetY + i * cellSize);
            ctx.stroke();
        }

        if (subSize >= 3) {
            ctx.strokeStyle = 'rgba(100, 140, 170, 0.2)';
            ctx.lineWidth = 0.5;

            for (let col = 0; col < this.cols; col++) {
                for (let row = 0; row < this.rows; row++) {
                    const cellLeft = offsetX + col * cellSize;
                    const cellTop = offsetY + (this.rows - 1 - row) * cellSize;

                    for (let sub = 1; sub < this.subGridSize; sub++) {
                        const subXPos = cellLeft + sub * subSize;
                        ctx.beginPath();
                        ctx.moveTo(subXPos, cellTop);
                        ctx.lineTo(subXPos, cellTop + cellSize);
                        ctx.stroke();

                        const subYPos = cellTop + sub * subSize;
                        ctx.beginPath();
                        ctx.moveTo(cellLeft, subYPos);
                        ctx.lineTo(cellLeft + cellSize, subYPos);
                        ctx.stroke();
                    }
                }
            }
        }

        ctx.strokeStyle = '#3a5a6a';
        ctx.lineWidth = 2;
        ctx.strokeRect(offsetX, offsetY, this.cols * cellSize, this.rows * cellSize);
        ctx.restore();

        if (cellSize > 30) {
            ctx.fillStyle = 'rgba(100, 140, 170, 0.8)';
            ctx.font = `${this.gridFontSize}px monospace`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            for (let col = 0; col < this.cols; col++) {
                for (let row = 0; row < this.rows; row++) {
                    const pos = this.gridToPixel(col, row, 0.5, 8.5);
                    ctx.fillText(`${String.fromCharCode(65 + col)}${row + 1}`, pos.x, pos.y);
                }
            }
        }

        ctx.fillStyle = '#4a7a8a';
        ctx.font = `${this.gridFontSize + 1}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i < this.cols; i++) {
            const x = offsetX + (i + 0.5) * cellSize;
            const y = offsetY + this.rows * cellSize + 4;
            if (y < h - 2) {
                ctx.fillText(String.fromCharCode(65 + i), x, y);
            }
        }

        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = `${this.gridFontSize + 1}px monospace`;
        for (let i = 0; i < this.rows; i++) {
            const rowNum = i + 1;
            const x = offsetX - 6;
            const y = offsetY + (this.rows - 1 - i + 0.5) * cellSize;
            if (x > 2) {
                ctx.fillText(rowNum.toString(), x, y);
            }
        }

        if (this.hoveredCell) {
            const cell = this.hoveredCell;
            ctx.save();
            ctx.fillStyle = 'rgba(78, 205, 196, 0.25)';
            
            const pos = this.gridToPixelExact(cell.col, cell.row, cell.subX, cell.subY);
            ctx.fillRect(pos.x, pos.y, subSize, subSize);
            ctx.restore();
        }

        if (typeof this.drawFreeDrawings === 'function') {
            this.drawFreeDrawings(ctx);
        }
        if (typeof this.drawFreeDrawingPreview === 'function') {
            this.drawFreeDrawingPreview(ctx);
        }
        if (typeof this.drawCompassPreview === 'function') {
            this.drawCompassPreview(ctx);
        }

        const markers = this.markerManager ? this.markerManager.getAllMarkers() : [];
        
        for (const marker of markers) {
            if (typeof this.drawIntel === 'function') {
                this.drawIntel(ctx, marker);
            }
        }

        for (const marker of markers) {
            const pos = this.gridToPixel(marker.col, marker.row, marker.subX, marker.subY);
            const isHovered = this.hoveredItem && this.hoveredItem.type === 'marker' && this.hoveredItem.item.id === marker.id;

            ctx.beginPath();
            ctx.arc(pos.x, pos.y, isHovered ? 7 : 5, 0, 2 * Math.PI);
            ctx.fillStyle = marker.color || '#ff4d4d';
            ctx.fill();
            ctx.strokeStyle = isHovered ? '#ffd93d' : '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            
            if (cellSize > 20 && marker.label) {
                ctx.fillStyle = isHovered ? '#ffd93d' : '#b0c4de';
                ctx.font = `${this.gridFontSize}px sans-serif`;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                ctx.fillText(marker.label, pos.x + 8, pos.y - 2);

                ctx.fillStyle = '#4a7a7a';
                ctx.font = `${this.gridFontSize - 2}px monospace`;
                ctx.textBaseline = 'top';
                ctx.fillText(`${marker.subX}:${marker.subY}`, pos.x + 8, pos.y + 2);
            }
        }

        if (this.triangulatePreview) {
            const preview = this.triangulatePreview;
            const pos = this.gridToPixel(
                preview.grid.col,
                preview.grid.row,
                preview.grid.subX,
                preview.grid.subY
            );
            
            ctx.save();
            
            ctx.strokeStyle = 'rgba(0, 255, 136, 0.7)';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 16, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.setLineDash([]);
            
            ctx.strokeStyle = 'rgba(0, 255, 136, 0.9)';
            ctx.lineWidth = 2;
            const size = 10;
            ctx.beginPath();
            ctx.moveTo(pos.x - size, pos.y);
            ctx.lineTo(pos.x + size, pos.y);
            ctx.moveTo(pos.x, pos.y - size);
            ctx.lineTo(pos.x, pos.y + size);
            ctx.stroke();
            
            ctx.fillStyle = 'rgba(0, 255, 136, 0.9)';
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 3, 0, 2 * Math.PI);
            ctx.fill();
            
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(0, 255, 136, 0.8)';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText('<svg class="icon-sm"><use href="images/icons.svg#icon-marker"></use></svg> Preview', pos.x, pos.y - 22);
            
            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.font = '7px monospace';
            ctx.textBaseline = 'top';
            ctx.fillText(preview.gridRef, pos.x, pos.y + 22);
            
            ctx.restore();
        }

        if (this.hoveredItem) {
            ctx.save();
            ctx.strokeStyle = '#ffd93d';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            
            if (this.hoveredItem.type === 'marker') {
                const m = this.hoveredItem.item;
                const pos = this.gridToPixel(m.col, m.row, m.subX, m.subY);
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 16, 0, 2 * Math.PI);
                ctx.stroke();
            } else if (this.hoveredItem.type === 'freeDrawing') {
                const d = this.hoveredItem.item;
                if (d.startGrid && d.endGrid) {
                    const start = this.gridToPixel(d.startGrid.col, d.startGrid.row, d.startGrid.subX, d.startGrid.subY);
                    const end = this.gridToPixel(d.endGrid.col, d.endGrid.row, d.endGrid.subX, d.endGrid.subY);
                    ctx.beginPath();
                    ctx.moveTo(start.x, start.y);
                    ctx.lineTo(end.x, end.y);
                    ctx.stroke();
                } else if (d.start && d.end) {
                    ctx.beginPath();
                    ctx.moveTo(d.start.x, d.start.y);
                    ctx.lineTo(d.end.x, d.end.y);
                    ctx.stroke();
                }
            }
            ctx.restore();
        }

        this.requestRender(false, immediate);
    }

    // ==========================================
    // BEARING INTERSECTIONS
    // ==========================================

    findBearingIntersections() {
        const intersections = [];
        const markers = this.markerManager.getAllMarkers();
        const bearingMarkers = markers.filter(m => this.intelData[m.id] && this.intelData[m.id].bearing !== null);
        
        for (let i = 0; i < bearingMarkers.length; i++) {
            for (let j = i + 1; j < bearingMarkers.length; j++) {
                const m1 = bearingMarkers[i];
                const m2 = bearingMarkers[j];
                const b1 = this.intelData[m1.id].bearing;
                const b2 = this.intelData[m2.id].bearing;
                
                const p1 = this.gridToSubUnits(m1.col, m1.row, m1.subX, m1.subY);
                const p2 = this.gridToSubUnits(m2.col, m2.row, m2.subX, m2.subY);
                const b1Rad = (b1 - 90) * (Math.PI / 180);
                const b2Rad = (b2 - 90) * (Math.PI / 180);
                const d1 = { x: Math.cos(b1Rad), y: Math.sin(b1Rad) };
                const d2 = { x: Math.cos(b2Rad), y: Math.sin(b2Rad) };
                const denom = d1.x * d2.y - d1.y * d2.x;
                if (Math.abs(denom) < 0.0001) continue;
                
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const t1 = (dx * d2.y - dy * d2.x) / denom;
                const intersectX = p1.x + t1 * d1.x;
                const intersectY = p1.y + t1 * d1.y;
                const dist1 = Math.sqrt((intersectX - p1.x) ** 2 + (intersectY - p1.y) ** 2) / 10;
                const dist2 = Math.sqrt((intersectX - p2.x) ** 2 + (intersectY - p2.y) ** 2) / 10;
                if (dist1 > 20 || dist2 > 20) continue;
                
                const grid = this.subUnitsToGrid(intersectX, intersectY);
                if (grid) {
                    intersections.push({
                        marker1: m1, marker2: m2,
                        bearing1: b1, bearing2: b2,
                        intersection: { x: intersectX, y: intersectY, distance1: dist1, distance2: dist2, grid: grid },
                        gridRef: MarkerManager.toGridRef(grid.col, grid.row, grid.subX, grid.subY)
                    });
                }
            }
        }
        return intersections;
    }

    // ==========================================
    // MARKER MANAGEMENT
    // ==========================================

    addMarkerAt(col, row, subX, subY, centered = false) {
        const type = this.markerManager.selectedType || 'spotter';
        
        if (type === 'nest') {
            const existingNests = this.markerManager.getMarkersByType('nest');
            if (existingNests.length > 0) {
                this.showToast('Iron Nest already exists!', 'warning');
                return null;
            }
        }
        
        let finalCol = col;
        let finalRow = row;
        let finalSubX = subX;
        let finalSubY = subY;
        
        // ============================================================
        // FIX: If centered is true, place at x.5:y.5 (center of subgrid cell)
        // ============================================================
        if (centered && Number.isInteger(subX) && Number.isInteger(subY)) {
            finalSubX = subX + 0.5;
            finalSubY = subY + 0.5;
        }
        
        // Handle border crossing
        if (finalSubX > 9.99) {
            finalCol = finalCol + 1;
            finalSubX = finalSubX - 10;
        }
        if (finalSubX < 0) {
            finalCol = finalCol - 1;
            finalSubX = finalSubX + 10;
        }
        if (finalSubY > 9.99) {
            finalRow = finalRow + 1;
            finalSubY = finalSubY - 10;
        }
        if (finalSubY < 0) {
            finalRow = finalRow - 1;
            finalSubY = finalSubY + 10;
        }
        
        finalCol = Math.min(Math.max(finalCol, 0), this.cols - 1);
        finalRow = Math.min(Math.max(finalRow, 0), this.rows - 1);
        finalSubX = Math.min(Math.max(finalSubX, 0), 9.99);
        finalSubY = Math.min(Math.max(finalSubY, 0), 9.99);
        finalSubX = Math.round(finalSubX * 100) / 100;
        finalSubY = Math.round(finalSubY * 100) / 100;
        
        const existing = this.markerManager.getMarkerAt(finalCol, finalRow, finalSubX, finalSubY);
        if (existing) {
            this.showToast(`Cell already has: ${existing.label}`, 'warning');
            return null;
        }
        
        const marker = this.markerManager.addMarker(type, finalCol, finalRow, finalSubX, finalSubY);
        this.render();
        this.updateMarkerList();
        this.updateDropdowns();
        
        const typeNames = { nest: 'Iron Nest', spotter: 'Spotter', target: 'Target', reference: 'Reference Point' };
        this.showToast(`Added ${typeNames[type] || 'Marker'} at ${marker.gridRef}`, 'success');
        
        this.selectMarker(marker);
        this.autoGenerateIntel();
        
        this.autoSave();
        this.render(true);
        return marker;
    }

    deleteMarker(markerId) {
        const marker = this.markerManager.getMarkerById(markerId);
        if (!marker) return;
        
        if (this.hoveredItem && this.hoveredItem.type === 'marker' && this.hoveredItem.item.id === markerId) {
            this.hoveredItem = null;
        }
        
        if (marker.type === 'target') {
            this.removeAutoIntelForTarget(markerId);
            this.deletedAutoIntelTargets.delete(markerId);
        }
        this.removeIntel(markerId);
        this.markerManager.removeMarker(markerId);
        
        if (this.selectedMarker && this.selectedMarker.id === markerId) {
            this.selectedMarker = null;
            this.updateIntelDisplay(null);
        }
        
        this.updateMarkerList();
        this.updateDropdowns();
        this.render();
        this.autoGenerateIntel();

        this.autoSave();
        this.render(true);
    }

    selectMarker(marker) {
        this.selectedMarker = marker;
        if (this.elements.selectedInfo) {
            this.elements.selectedInfo.textContent = marker ? `${marker.label} (${marker.gridRef})` : '--';
        }
        if (this.elements.fromSelect && marker) {
            this.elements.fromSelect.value = marker.id;
        }
        this.updateIntelDisplay(marker ? marker.id : null);

        this.render(true);
    }

    // ==========================================
    // UI UPDATES
    // ==========================================

    updateMarkerList() {
        const list = this.elements.markerList;
        if (!list) return;
        
        const markers = this.markerManager.getAllMarkers();
        if (markers.length === 0) {
            list.innerHTML = '<p style="color:#666; font-size:0.8rem;">No markers yet. Right-click on grid to add.</p>';
            return;
        }
        
        const scrollTop = list.scrollTop;
        const scrollHeight = list.scrollHeight;
        const clientHeight = list.clientHeight;
        
        const existingItems = list.querySelectorAll('.marker-item');
        const hasExistingItems = existingItems.length > 0;
        
        let html = '';
        markers.forEach((m, index) => {
            const hasIntelData = this.hasIntel(m.id);
            const isCentered = MarkerManager.isCentered(m.subX, m.subY);
            const offCenterLabel = isCentered ? '' : ' <span style="color:#ff8866; font-size:0.6rem;">(OC)</span>';
            const icon = '';
            let label = m.label;
            if (m.type === 'reference') {
                label = label.replace('Reference Point', 'Reference');
            }
            html += `
                <div class="marker-item" data-id="${m.id}" data-index="${index}">
                    <span class="marker-info">
                        <span class="marker-drag-handle" data-id="${m.id}" title="Drag to reorder">⠿</span>
                        <span class="marker-dot" style="color:${m.color}">●</span>
                        <span class="marker-label">${label}</span>
                        <span class="marker-grid-ref" data-id="${m.id}" title="Click to edit position">${m.gridRef}${offCenterLabel}</span>
                        ${hasIntelData ? '<span class="marker-intel-badge"><svg class="icon-sm"><use href="images/icons.svg#icon-information"></use></svg></span>' : ''}
                    </span>
                    <span class="marker-actions">
                        <button class="edit-btn" data-id="${m.id}" title="Edit marker details">Edit</button>
                        <button class="delete-btn" data-id="${m.id}" title="Delete marker"><svg class="icon-sm"><use href="images/icons.svg#icon-close"></use></svg></button>
                    </span>
                </div>
            `;
        });
        
        if (hasExistingItems) {
            const currentOrder = [];
            existingItems.forEach(el => {
                currentOrder.push(el.dataset.id);
            });
            
            const newOrder = markers.map(m => m.id);
            const orderChanged = JSON.stringify(currentOrder) !== JSON.stringify(newOrder);
            
            if (orderChanged) {
                const oldPositions = {};
                existingItems.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    const listRect = list.getBoundingClientRect();
                    oldPositions[el.dataset.id] = rect.top - listRect.top;
                });
                
                const scrollRatio = scrollTop / (scrollHeight - clientHeight || 1);
                
                list.innerHTML = html;
                
                const newScrollHeight = list.scrollHeight;
                const newScrollTop = scrollRatio * (newScrollHeight - clientHeight);
                list.scrollTop = Math.max(0, Math.min(newScrollTop, newScrollHeight - clientHeight));
                
                const newItems = list.querySelectorAll('.marker-item');
                
                newItems.forEach(el => {
                    const id = el.dataset.id;
                    if (oldPositions[id] !== undefined) {
                        const currentRect = el.getBoundingClientRect();
                        const listRect = list.getBoundingClientRect();
                        const currentPos = currentRect.top - listRect.top;
                        const deltaY = oldPositions[id] - currentPos;
                        el.style.transform = `translateY(${deltaY}px)`;
                        el.style.transition = 'none';
                    }
                });
                
                void list.offsetHeight;
                
                newItems.forEach(el => {
                    el.style.transition = 'transform 0.35s ease-in-out';
                    el.style.transform = 'translateY(0)';
                });
            } else {
                list.innerHTML = html;
            }
        } else {
            list.innerHTML = html;
        }
        
        // --- Drag and Drop Functionality ---
        let dragStartIndex = null;
        let dragStartId = null;
        let dragElement = null;
        let dragOverElement = null;
        let isDragging = false;
        let allItems = [];
        let dragStartY = 0;
        
        list.querySelectorAll('.marker-drag-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const item = handle.closest('.marker-item');
                if (!item) return;
                
                dragStartId = item.dataset.id;
                dragStartIndex = parseInt(item.dataset.index);
                dragElement = item;
                isDragging = true;
                dragStartY = e.clientY;
                
                allItems = list.querySelectorAll('.marker-item');
                
                item.classList.add('dragging');
                item.style.opacity = '0.5';
                item.style.border = '2px dashed #ffd93d';
                item.style.backgroundColor = 'rgba(255, 217, 61, 0.05)';
                item.style.transform = 'scale(0.95)';
                item.style.zIndex = '10';
                item.style.position = 'relative';
                item.style.transition = 'transform 0.15s ease, opacity 0.15s ease, border-color 0.15s ease, background-color 0.15s ease';
                
                const rect = list.getBoundingClientRect();
                
                const onMouseMove = (ev) => {
                    if (!isDragging) return;
                    
                    const deltaY = ev.clientY - dragStartY;
                    dragElement.style.transform = `scale(0.95) translateY(${deltaY}px)`;
                    
                    const y = ev.clientY - rect.top;
                    let targetIndex = 0;
                    let closestDist = Infinity;
                    
                    allItems.forEach((el, idx) => {
                        if (el === dragElement) return;
                        const elRect = el.getBoundingClientRect();
                        const centerY = elRect.top + elRect.height / 2 - rect.top;
                        const dist = Math.abs(y - centerY);
                        if (dist < closestDist) {
                            closestDist = dist;
                            targetIndex = idx;
                        }
                    });
                    
                    allItems.forEach(el => {
                        if (el !== dragElement) {
                            el.style.border = '2px solid transparent';
                            el.style.backgroundColor = '';
                            el.style.transform = '';
                        }
                    });
                    
                    if (targetIndex !== dragStartIndex && targetIndex >= 0) {
                        const targetItem = allItems[targetIndex];
                        if (targetItem && targetItem !== dragElement) {
                            targetItem.style.border = '2px solid #ffd93d';
                            targetItem.style.backgroundColor = 'rgba(255, 217, 61, 0.08)';
                            const direction = targetIndex > dragStartIndex ? 'down' : 'up';
                            targetItem.style.transform = `translateY(${direction === 'down' ? '-4px' : '4px'})`;
                        }
                        dragOverElement = targetItem;
                    } else {
                        dragOverElement = null;
                    }
                };
                
                const onMouseUp = (ev) => {
                    isDragging = false;
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    
                    if (dragElement) {
                        dragElement.classList.remove('dragging');
                        dragElement.style.opacity = '';
                        dragElement.style.border = '';
                        dragElement.style.backgroundColor = '';
                        dragElement.style.transform = '';
                        dragElement.style.zIndex = '';
                        dragElement.style.position = '';
                        dragElement.style.transition = '';
                    }
                    allItems.forEach(el => {
                        el.style.border = '2px solid transparent';
                        el.style.backgroundColor = '';
                        el.style.transform = '';
                    });
                    
                    if (dragOverElement && dragStartIndex !== null) {
                        const targetId = dragOverElement.dataset.id;
                        const targetIndex = parseInt(dragOverElement.dataset.index);
                        
                        if (dragStartIndex !== targetIndex) {
                            const allMarkers = this.markerManager.getAllMarkers();
                            const startIdx = allMarkers.findIndex(m => m.id === dragStartId);
                            const targetIdx = allMarkers.findIndex(m => m.id === targetId);
                            
                            if (startIdx !== -1 && targetIdx !== -1) {
                                const [removed] = allMarkers.splice(startIdx, 1);
                                allMarkers.splice(targetIdx, 0, removed);
                                
                                this.markerManager.markers = allMarkers;
                                this.updateMarkerList();
                                this.render();
                                this.showToast(`Reordered markers`, 'success');
                            }
                        }
                    }
                    
                    dragStartIndex = null;
                    dragStartId = null;
                    dragElement = null;
                    dragOverElement = null;
                    allItems = [];
                };
                
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });
        
        // --- Hover and click handlers ---
        list.querySelectorAll('.marker-item').forEach(item => {
            const markerId = item.dataset.id;
            const marker = this.markerManager.getMarkerById(markerId);
            
            item.addEventListener('mouseenter', () => {
                if (marker) {
                    this.hoveredItem = { type: 'marker', item: marker };
                    this.render();
                }
            });
            
            item.addEventListener('mouseleave', () => {
                if (this.hoveredItem && this.hoveredItem.type === 'marker' && this.hoveredItem.item.id === markerId) {
                    this.hoveredItem = null;
                    this.render();
                }
            });
            
            item.addEventListener('click', (e) => {
                if (e.target.closest('.delete-btn') || e.target.closest('.edit-btn') || e.target.closest('.marker-grid-ref') || e.target.closest('.marker-drag-handle')) return;
                if (marker) this.selectMarker(marker);
            });
            
            const editBtn = item.querySelector('.edit-btn');
            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (marker) {
                        this.selectMarker(marker);
                        this.showEditPanel(marker);
                    }
                });
            }
            
            const gridRefEl = item.querySelector('.marker-grid-ref');
            if (gridRefEl) {
                gridRefEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (marker) {
                        this.selectMarker(marker);
                        this.showEditPanel(marker);
                    }
                });
            }
            
            const deleteBtn = item.querySelector('.delete-btn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (marker) {
                        if (marker.type === 'nest' && !confirm(`Delete Iron Nest at ${marker.gridRef}?`)) return;
                        this.removeIntel(marker.id);
                        this.deleteMarker(marker.id);
                        this.showToast(`Deleted ${marker.label}`, 'success');
                    }
                });
            }
        });
        
        if (this.elements.totalMarkers) {
            this.elements.totalMarkers.textContent = markers.length;
        }

        this.markersChanged = true;
        this.render(true);
    }

    updateDropdowns() {
        const fromSelect = this.elements.fromSelect;
        const toSelect = this.elements.toSelect;
        if (!fromSelect || !toSelect) return;
        
        const markers = this.markerManager.getAllMarkers();
        const options = markers.map(m => `<option value="${m.id}">${m.label} (${m.gridRef})</option>`).join('');
        const fromVal = fromSelect.value;
        const toVal = toSelect.value;
        fromSelect.innerHTML = `<option value="">Select point...</option>${options}`;
        toSelect.innerHTML = `<option value="">Select point...</option>${options}`;
        if (markers.some(m => m.id === fromVal)) fromSelect.value = fromVal;
        if (markers.some(m => m.id === toVal)) toSelect.value = toVal;
    }

    // ==========================================
    // ADD MARKER SUBSECTION
    // ==========================================

    showAddMarkerSection() {
        const container = document.getElementById('addMarkerSection');
        if (!container) return;
        
        container.innerHTML = `
            <div style="margin-bottom:10px;">
                <div style="color:#8aacce; font-size:0.8rem; margin-bottom:6px;">Add marker with intel:</div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <select id="addMarkerType" style="flex:1; min-width:80px; padding:4px 6px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:inherit; font-size:0.75rem;">
                        <option value="nest"><svg class="icon-sm"><use href="images/icons.svg#icon-star"></use></svg> Iron Nest</option>
                        <option value="spotter"><svg class="icon-sm"><use href="images/icons.svg#icon-binoculars"></use></svg> Spotter</option>
                        <option value="reference"><svg class="icon-sm"><use href="images/icons.svg#icon-flag"></use></svg> Reference</option>
                        <option value="target"><svg class="icon-sm"><use href="images/icons.svg#icon-crosshair"></use></svg> Target</option>
                    </select>
                    <input type="text" id="addMarkerMainRef" placeholder="A1" style="flex:1; min-width:50px; padding:4px 6px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:monospace; font-size:0.75rem;">
                    <input type="text" id="addMarkerSubRef" placeholder="0:0" style="flex:1; min-width:50px; padding:4px 6px; background:#0a121a; color:#b0c4de; border:1px solid #2a3a4a; border-radius:3px; font-family:monospace; font-size:0.75rem;">
                    <button id="addMarkerByPosBtn" style="padding:4px 10px; background:#2a5a3a; color:#88ffaa; border:1px solid #3a8a5a; border-radius:3px; cursor:pointer; font-size:0.75rem; font-family:inherit;"><svg class="icon-sm"><use href="images/icons.svg#icon-add-circle"></use></svg> Add</button>
                </div>
                <div style="color:#6a7a8a; font-size:0.6rem; margin-top:3px;">Main-Grid: A-T + 1-10 | Sub-Grid: 0:0 (OC = Off-Centered)</div>
            </div>
        `;
        
        const addBtn = document.getElementById('addMarkerByPosBtn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const type = document.getElementById('addMarkerType').value;
                const mainRef = document.getElementById('addMarkerMainRef').value;
                const subRef = document.getElementById('addMarkerSubRef').value;
                this.addMarkerByPosition(type, mainRef, subRef);
            });
        }
        
        ['addMarkerMainRef', 'addMarkerSubRef'].forEach(id => {
            const input = document.getElementById(id);
            if (input) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        const addBtn = document.getElementById('addMarkerByPosBtn');
                        if (addBtn) addBtn.click();
                    }
                });
            }
        });
    }

    addMarkerByPosition(type, mainRef, subRef) {
        if (!mainRef || mainRef.trim() === '') {
            this.showToast('Please enter a main grid reference (e.g., A1)', 'warning');
            return null;
        }
        
        const mainMatch = mainRef.trim().toUpperCase().match(/^([A-T])([1-9]|10)$/);
        if (!mainMatch) {
            this.showToast('Invalid main grid reference (e.g., A1-T10)', 'warning');
            return null;
        }
        
        let col = mainMatch[1].charCodeAt(0) - 65;
        let row = parseInt(mainMatch[2]) - 1;
        let subX = 0, subY = 0;
        let centered = false;
        
        if (subRef && subRef.trim() !== '') {
            const subMatch = subRef.trim().match(/^([0-9]+):([0-9]+)$/);
            if (subMatch) {
                subX = parseFloat(subMatch[1]);
                subY = parseFloat(subMatch[2]);
                if (isNaN(subX) || isNaN(subY) || subX < 0 || subX > 9 || subY < 0 || subY > 9) {
                    this.showToast('Sub-grid values must be between 0 and 9', 'warning');
                    return null;
                }
                // ============================================================
                // FIX: Center the marker at x.5:y.5
                // ============================================================
                centered = true;
            } else {
                // Allow decimal input for advanced users
                const decimalMatch = subRef.trim().match(/^([0-9.]+):([0-9.]+)$/);
                if (decimalMatch) {
                    subX = parseFloat(decimalMatch[1]);
                    subY = parseFloat(decimalMatch[2]);
                    if (isNaN(subX) || isNaN(subY) || subX < 0 || subX > 9.99 || subY < 0 || subY > 9.99) {
                        this.showToast('Sub-grid values must be between 0 and 9.99', 'warning');
                        return null;
                    }
                    centered = false;
                } else {
                    this.showToast('Invalid sub-grid reference (e.g., 5:3 or 5.30:2.70)', 'warning');
                    return null;
                }
            }
        }
        
        const prevType = this.markerManager.selectedType;
        this.markerManager.selectedType = type;
        
        const marker = this.addMarkerAt(col, row, subX, subY, centered);
        
        this.markerManager.selectedType = prevType;
        
        return marker;
    }

    // ==========================================
    // ADD MARKER POPUP
    // ==========================================

    showAddMarkerPopup(gridPos, mouseX, mouseY) {
        const existing = document.getElementById('addMarkerPopup');
        if (existing) existing.remove();

        // Get the display string for the popup
        const ref = MarkerManager.toGridRef(gridPos.col, gridPos.row, gridPos.subX, gridPos.subY);
        const fullRef = MarkerManager.toGridRefFull(gridPos.col, gridPos.row, gridPos.subX, gridPos.subY);

        const popup = document.createElement('div');
        popup.id = 'addMarkerPopup';
        popup.style.cssText = `
            position: fixed;
            top: ${Math.min(mouseY, window.innerHeight - 200)}px;
            left: ${Math.min(mouseX, window.innerWidth - 280)}px;
            background: #1a2a3a;
            border: 2px solid #3a5a6a;
            border-radius: 8px;
            padding: 20px;
            z-index: 10002;
            min-width: 260px;
            max-width: 320px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
        `;

        popup.innerHTML = `
            <div class="panel-header">
                <h3><svg class="icon-sm"><use href="images/icons.svg#icon-marker"></use></svg> Add Marker</h3>
                <button id="closePopupBtn" class="close-btn"><svg class="icon-sm"><use href="images/icons.svg#icon-close"></use></svg></button>
            </div>
            <div class="position-display">Position: <strong>${fullRef}</strong></div>
            <div style="margin-bottom:12px;">
                <label>Marker Type:</label>
                <select id="popupMarkerType">
                    <option value="nest"><svg class="icon-sm"><use href="images/icons.svg#icon-star"></use></svg> Iron Nest</option>
                    <option value="spotter"><svg class="icon-sm"><use href="images/icons.svg#icon-binoculars"></use></svg> Spotter</option>
                    <option value="reference"><svg class="icon-sm"><use href="images/icons.svg#icon-flag"></use></svg> Reference Point</option>
                    <option value="target"><svg class="icon-sm"><use href="images/icons.svg#icon-crosshair"></use></svg> Target</option>
                </select>
            </div>
            <div class="btn-group">
                <button id="popupAddBtn" class="btn-add"><svg class="icon-sm"><use href="images/icons.svg#icon-add-circle"></use></svg> Add Marker</button>
                <button id="popupCancelBtn" class="btn-cancel">Cancel</button>
            </div>
        `;

        document.body.appendChild(popup);

        // ============================================================
        // FIX: Store the exact grid position
        // ============================================================
        const exactGridPos = gridPos;

        popup.querySelector('#closePopupBtn').addEventListener('click', () => {
            popup.remove();
        });

        popup.querySelector('#popupCancelBtn').addEventListener('click', () => {
            popup.remove();
        });

        popup.querySelector('#popupAddBtn').addEventListener('click', () => {
            const type = document.getElementById('popupMarkerType').value;
            const prevType = this.markerManager.selectedType;
            this.markerManager.selectedType = type;
            // ============================================================
            // FIX: Use the exact grid position directly
            // ============================================================
            this.addMarkerAt(exactGridPos.col, exactGridPos.row, exactGridPos.subX, exactGridPos.subY, false);
            this.markerManager.selectedType = prevType;
            popup.remove();
        });

        const closeOnOutside = (e) => {
            if (!popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener('click', closeOnOutside);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeOnOutside);
        }, 10);

        popup.querySelector('#popupMarkerType').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                popup.querySelector('#popupAddBtn').click();
            }
        });
    }

    // ==========================================
    // TOAST
    // ==========================================

    showToast(message, type = 'info') {
        const existing = document.querySelector('.toast-notification');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            padding: 12px 24px;
            border-radius: 4px;
            font-family: 'Segoe UI', sans-serif;
            font-size: 14px;
            z-index: 10000;
            color: #fff;
            background: ${type === 'success' ? '#1a3a2a' : type === 'warning' ? '#3a2a1a' : '#1a2a3a'};
            border: 1px solid ${type === 'success' ? '#3a8a5a' : type === 'warning' ? '#8a7a3a' : '#3a5a8a'};
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            opacity: 0;
            transition: opacity 0.3s ease;
            pointer-events: none;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.style.opacity = '1');
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
        }, 2000);
    }

    // ==========================================
    // RESIZE, CLEAR, EXPORT, IMPORT
    // ==========================================

    resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        const containerWidth = rect.width || 800;
        const aspectRatio = 20 / 10;
        const width = containerWidth;
        const height = width / aspectRatio;
        this.canvas.width = width;
        this.canvas.height = height;
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';
        this.markBackgroundDirty();
        this.render(true);
    }

    clearAll() {
        this.markerManager.clearAll();
        if (this.drawingManager) this.drawingManager.clearAll();
        this.freeDrawings = [];
        this.intelData = {};
        this.markersWithIntel = new Set();
        this.selectedMarker = null;
        this.hoveredItem = null;
        this.panX = 0;
        this.panY = 0;
        this.zoomLevel = 1;
        this.updateZoomDisplay();
        this.autoIntelIds = [];
        this.closeAllPopups();
        this.render();
        this.updateMarkerList();
        this.updateDropdowns();
        if (this.elements.selectedInfo) this.elements.selectedInfo.textContent = '--';
        if (this.elements.gridRefResult) this.elements.gridRefResult.textContent = '--';
        if (this.elements.distanceResult) this.elements.distanceResult.textContent = '--';
        if (this.elements.bearingResult) this.elements.bearingResult.textContent = '--';
        if (this.elements.subgridResult) this.elements.subgridResult.textContent = '--';
        this.updateIntelDisplay(null);
        this.showToast('All cleared', 'info');

        this.autoSave();
    }

    exportData() {
        const nonAutoDrawings = this.freeDrawings.filter(d => !d.autoIntel);
        return JSON.stringify({
            markers: this.markerManager.markers,
            counters: this.markerManager.counter,
            usedSpotterNumbers: this.markerManager.usedSpotterNumbers,
            nextTargetNumber: this.markerManager.nextTargetNumber,
            intelData: this.intelData,
            freeDrawings: nonAutoDrawings.map(d => ({ 
                ...d, 
                start: undefined, 
                end: undefined 
            })),
            // ============================================================
            // FIX: Save zoom and pan state
            // ============================================================
            viewState: {
                zoomLevel: this.zoomLevel,
                panX: this.panX,
                panY: this.panY
            },
            exportedAt: new Date().toISOString()
        }, null, 2);
    }

    importData(jsonData) {
        try {
            const data = JSON.parse(jsonData);
            if (!data.markers || !Array.isArray(data.markers)) {
                throw new Error('Invalid data format');
            }
            this.markerManager.markers = data.markers;
            this.markerManager.counter = data.counters || { nest: 0, spotter: 0, target: 0, reference: 0 };
            this.markerManager.usedSpotterNumbers = data.usedSpotterNumbers || [];
            this.markerManager.nextTargetNumber = data.nextTargetNumber || 1;
            this.intelData = data.intelData || {};
            this.markersWithIntel = new Set(Object.keys(this.intelData));
            
            this.freeDrawings = (data.freeDrawings || []).map(d => {
                const { startGrid, endGrid, ...rest } = d;
                return {
                    ...rest,
                    startGrid: startGrid,
                    endGrid: endGrid
                };
            });
            
            // ============================================================
            // FIX: Restore view state
            // ============================================================
            if (data.viewState) {
                this.zoomLevel = data.viewState.zoomLevel || 1;
                this.panX = data.viewState.panX || 0;
                this.panY = data.viewState.panY || 0;
                this.targetZoom = this.zoomLevel;
                this.targetPanX = this.panX;
                this.targetPanY = this.panY;
                this.updateZoomDisplay();
            }
            
            this.autoIntelIds = [];
            if (this.drawingManager) {
                this.drawingManager.setMarkers(this.markerManager.getAllMarkers());
            }
            this.render();
            this.updateMarkerList();
            this.updateDropdowns();
            this.autoGenerateIntel();
            this.showToast('Data imported successfully', 'success');
            return true;
        } catch (e) {
            this.showToast('Import failed: ' + e.message, 'error');
            return false;
        }
    }

    // ==========================================
    // BIND EVENTS
    // ==========================================

    bindEvents() {
        const canvas = this.canvas;

        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const px = (e.clientX - rect.left) * scaleX;
            const py = (e.clientY - rect.top) * scaleY;
            
            const item = this.findItemAt(px, py);
            const intelArrowMarker = this.findIntelArrowAt(px, py);
            
            if (intelArrowMarker) {
                const marker = intelArrowMarker;
                const intel = this.getIntel(marker.id);
                if (intel && intel.length > 0) {
                    const lastEntry = intel[intel.length - 1];
                    if (lastEntry && lastEntry.bearing !== null) {
                        this.removeIntel(marker.id, lastEntry.id);
                        this.showToast(`Intel removed from ${marker.label}`, 'success');
                        this.hoveredItem = null;
                        this.render();
                        return;
                    }
                }
            }
            
            if (item && item.type === 'freeDrawing') {
                const drawing = item.item;
                const gridPos = this.pixelToGridFree(px, py);
                const ref = gridPos ? MarkerManager.toGridRef(gridPos.col, gridPos.row, gridPos.subX, gridPos.subY) : null;
                
                const menu = document.createElement('div');
                menu.id = 'contextMenu';
                menu.style.cssText = `
                    position: fixed;
                    top: ${Math.min(e.clientY, window.innerHeight - 150)}px;
                    left: ${Math.min(e.clientX, window.innerWidth - 230)}px;
                    background: #1a2a3a;
                    border: 1px solid #3a5a6a;
                    border-radius: 6px;
                    padding: 6px 0;
                    z-index: 10001;
                    min-width: 200px;
                    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
                `;
                
                const isAuto = drawing.autoIntel;
                const typeLabel = drawing.type === 'compass' ? 'Compass Circle' : `${drawing.label} Arrow`;
                
                let html = `
                    <div class="menu-header">${typeLabel} ${drawing.bearing !== undefined ? `| Brg: ${drawing.bearing.toFixed(0)}°` : ''}${drawing.distance !== undefined ? ` | Dist: ${drawing.distance.toFixed(2)}km` : ''}${isAuto ? ' <svg class="icon-sm"><use href="images/icons.svg#icon-times-circle"></use></svg>' : ''}</div>
                `;
                
                if (gridPos) {
                    html += `<div class="menu-item" data-action="addMarkerAtPosition" style="color:#4ecdc4;"><svg class="icon-sm"><use href="images/icons.svg#icon-marker"></use></svg> Add Marker at ${ref}</div>`;
                }
                
                if (isAuto) {
                    html += `<div class="menu-item" data-action="deleteDrawing" style="color:#ff6644;"><svg class="icon-sm"><use href="images/icons.svg#icon-trash"></use></svg> Remove Auto Vector</div>`;
                } else {
                    html += `<div class="menu-item" data-action="deleteDrawing" style="color:#ff6644;"><svg class="icon-sm"><use href="images/icons.svg#icon-trash"></use></svg> Delete Measurement</div>`;
                }
                
                html += `<div class="menu-item" data-action="cancel" style="color:#6a7a8a;">Cancel</div>`;
                
                menu.innerHTML = html;
                document.body.appendChild(menu);
                
                menu.querySelector('[data-action="addMarkerAtPosition"]')?.addEventListener('click', () => {
                    if (gridPos) {
                        this.showAddMarkerPopup(gridPos, e.clientX, e.clientY);
                    }
                    menu.remove();
                });
                
                menu.querySelector('[data-action="deleteDrawing"]')?.addEventListener('click', () => {
                    if (drawing.autoIntel && drawing.targetId) {
                        this.removeAutoIntelForTarget(drawing.targetId);
                        this.showToast('Auto vector removed', 'success');
                    } else {
                        this.deleteFreeDrawing(drawing.id);
                    }
                    this.hoveredItem = null;
                    menu.remove();
                });
                
                menu.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
                    menu.remove();
                });
                
                this.closePopupOnOutside(menu);
                return;
            }
            
            const grid = this.pixelToGridFree(px, py);
            this.showContextMenu(e, item, grid);
            return false;
        });

        document.addEventListener('contextmenu', (e) => {
            if (e.target.closest('#grid-canvas-wrapper') || e.target.closest('.grid-container')) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });

        canvas.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            
            const panSpeed = 20;
            let moved = false;
            
            if (document.activeElement !== canvas) {
                canvas.focus();
                return;
            }
            
            switch(e.key) {
                case 'w':
                case 'W':
                case 'ArrowUp':
                    this.panY += panSpeed;
                    moved = true;
                    break;
                case 's':
                case 'S':
                case 'ArrowDown':
                    this.panY -= panSpeed;
                    moved = true;
                    break;
                case 'a':
                case 'A':
                case 'ArrowLeft':
                    this.panX += panSpeed;
                    moved = true;
                    break;
                case 'd':
                case 'D':
                case 'ArrowRight':
                    this.panX -= panSpeed;
                    moved = true;
                    break;
            }
            
            if (moved) {
                e.preventDefault();
                e.stopPropagation();
                const clamped = this.clampPan(this.panX, this.panY);
                this.panX = clamped.x;
                this.panY = clamped.y;
                this.targetPanX = this.panX;
                this.targetPanY = this.panY;
                this.render();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (document.activeElement !== canvas) return;
            
            const panSpeed = 20;
            let moved = false;
            
            switch(e.key) {
                case 'w':
                case 'W':
                case 'ArrowUp':
                    this.panY += panSpeed;
                    moved = true;
                    break;
                case 's':
                case 'S':
                case 'ArrowDown':
                    this.panY -= panSpeed;
                    moved = true;
                    break;
                case 'a':
                case 'A':
                case 'ArrowLeft':
                    this.panX += panSpeed;
                    moved = true;
                    break;
                case 'd':
                case 'D':
                case 'ArrowRight':
                    this.panX -= panSpeed;
                    moved = true;
                    break;
            }
            
            if (moved) {
                e.preventDefault();
                e.stopPropagation();
                const clamped = this.clampPan(this.panX, this.panY);
                this.panX = clamped.x;
                this.panY = clamped.y;
                this.targetPanX = this.panX;
                this.targetPanY = this.panY;
                this.render();
            }
        });

        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 2) return;
            
            canvas.focus();
            
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const px = (e.clientX - rect.left) * scaleX;
            const py = (e.clientY - rect.top) * scaleY;

            if (this.tool === 'compass') {
                this.startCompassDrawing(e);
                return;
            }

            if (this.tool === 'intelPen' || this.tool === 'vectorPen') {
                this.startFreeDrawing(e);
                return;
            }

            const item = this.findItemAt(px, py);

            if (item && item.type === 'marker') {
                if (this.tool === 'drag') {
                    this.isDraggingMarker = true;
                    this.dragMarker = item.item;
                    const pos = this.gridToPixel(
                        this.dragMarker.col, this.dragMarker.row,
                        this.dragMarker.subX, this.dragMarker.subY
                    );
                    const cursorGrid = this.pixelToGridFree(px, py);
                    if (cursorGrid) {
                        const updates = {
                            col: cursorGrid.col,
                            row: cursorGrid.row,
                            subX: cursorGrid.subX,
                            subY: cursorGrid.subY
                        };
                        this.markerManager.updateMarker(this.dragMarker.id, updates);
                        this.dragMarker = this.markerManager.getMarkerById(this.dragMarker.id);
                    }
                    this.grabOffsetX = 0;
                    this.grabOffsetY = 0;
                    canvas.style.cursor = 'grabbing';
                    this.selectMarker(item.item);
                    return;
                } else {
                    this.selectMarker(item.item);
                    return;
                }
            }

            if (item && item.type === 'freeDrawing') {
                return;
            }

            if (this.tool === 'drag' || (this.tool === 'select' && !item)) {
                this.isPanning = true;
                this.panStartPanX = this.panX;
                this.panStartPanY = this.panY;
                this.panStartX = px;
                this.panStartY = py;
                canvas.style.cursor = 'grabbing';
                return;
            }

        });

        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const px = (e.clientX - rect.left) * scaleX;
            const py = (e.clientY - rect.top) * scaleY;

            // ============================================================
            // 1. UPDATE CURSOR POSITION DISPLAY (always update, cheap)
            // ============================================================
            const grid = this.pixelToGrid(px, py);
            const cellChanged = JSON.stringify(this.hoveredCell) !== JSON.stringify(grid);

            if (cellChanged) {
                this.hoveredCell = grid || null;
                this.requestRender(true, true);
            }

            if (grid && this.elements.cursorPos) {
                const ref = MarkerManager.toGridRef(grid.col, grid.row, grid.subX, grid.subY);
                this.elements.cursorPos.textContent = ref || '--';
            } else {
                this.elements.cursorPos.textContent = '--';
            }

            // ============================================================
            // 2. TOOLTIP POSITION (always update, cheap)
            // ============================================================
            if (this.elements.tooltip) {
                this.elements.tooltip.style.left = (e.clientX - rect.left + 10) + 'px';
                this.elements.tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
            }

            // ============================================================
            // 3. CHECK IF MOUSE MOVED SIGNIFICANTLY (throttle)
            // ============================================================
            const dx = px - this.lastMouseX;
            const dy = py - this.lastMouseY;
            const moved = Math.sqrt(dx * dx + dy * dy);

            if (moved < 0.5) {
                // Mouse barely moved, skip expensive operations
                return;
            }

            this.lastMouseX = px;
            this.lastMouseY = py;

            // ============================================================
            // 4. UPDATE TOOLTIP TEXT (only if grid ref changed)
            // ============================================================
            if (grid && this.elements.tooltip) {
                const fullRef = MarkerManager.toGridRefFull(grid.col, grid.row, grid.subX, grid.subY);
                const displayRef = MarkerManager.toGridRef(grid.col, grid.row, grid.subX, grid.subY);
                const marker = this.markerManager.getMarkerAt(grid.col, grid.row, grid.subX, grid.subY);
                let tipText = displayRef || '--';
                if (marker) {
                    tipText += ` | ${marker.label}`;
                    const intel = this.getIntel(marker.id);
                    if (intel && intel.length > 0) {
                        const firstIntel = intel[0];
                        if (firstIntel.bearing !== null) tipText += ` | Brg: ${firstIntel.bearing}°`;
                        if (firstIntel.distance !== null) tipText += ` | Dist: ${firstIntel.distance}km`;
                    }
                } else {
                    tipText = fullRef || displayRef || '--';
                }
                this.elements.tooltip.textContent = tipText;
                this.elements.tooltip.style.display = 'block';
            }

            // ============================================================
            // 5. FIND HOVERED ITEM (only if mouse moved enough)
            // ============================================================
            const item = this.findItemAt(px, py);
            
            if (item !== this.lastHoveredItem) {
                this.hoveredItem = item;
                this.lastHoveredItem = item;
                this.requestRender(true, true);
            }

            // ============================================================
            // 6. CURSOR STYLE (update based on hover/tool)
            // ============================================================
            if (this.isPanning) {
                canvas.style.cursor = 'grabbing';
            } else if (item) {
                if (item.type === 'marker') {
                    canvas.style.cursor = this.tool === 'select' ? 'pointer' : 
                                        this.tool === 'drag' ? 'grab' : 'crosshair';
                } else {
                    canvas.style.cursor = 'pointer';
                }
            } else if (this.tool === 'drag') {
                canvas.style.cursor = 'grab';
            } else if (this.tool === 'intelPen') {
                canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cline x1=\'2\' y1=\'22\' x2=\'10\' y2=\'14\' stroke=\'%23ffd93d\' stroke-width=\'2.5\'/%3E%3Cline x1=\'10\' y1=\'14\' x2=\'22\' y2=\'2\' stroke=\'%23ffd93d\' stroke-width=\'2.5\'/%3E%3Ccircle cx=\'10\' cy=\'14\' r=\'4\' fill=\'%23ffd93d\' stroke=\'%23fff\' stroke-width=\'1\'/%3E%3C/svg%3E") 0 22, crosshair';
            } else if (this.tool === 'vectorPen') {
                canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Cline x1=\'2\' y1=\'22\' x2=\'10\' y2=\'14\' stroke=\'%23ff4444\' stroke-width=\'2.5\'/%3E%3Cline x1=\'10\' y1=\'14\' x2=\'22\' y2=\'2\' stroke=\'%23ff4444\' stroke-width=\'2.5\'/%3E%3Ccircle cx=\'10\' cy=\'14\' r=\'4\' fill=\'%23ff4444\' stroke=\'%23fff\' stroke-width=\'1\'/%3E%3C/svg%3E") 0 22, crosshair';
            } else if (this.tool === 'compass') {
                canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'%3E%3Ccircle cx=\'12\' cy=\'12\' r=\'10\' fill=\'none\' stroke=\'%23ffffff\' stroke-width=\'1.5\'/%3E%3Cline x1=\'5\' y1=\'20\' x2=\'12\' y2=\'8\' stroke=\'%23ffffff\' stroke-width=\'2\'/%3E%3Cline x1=\'19\' y1=\'20\' x2=\'12\' y2=\'8\' stroke=\'%23ffffff\' stroke-width=\'2\'/%3E%3Cline x1=\'12\' y1=\'8\' x2=\'12\' y2=\'4\' stroke=\'%23ffffff\' stroke-width=\'2\'/%3E%3Ccircle cx=\'12\' cy=\'3\' r=\'1.5\' fill=\'%23ffffff\'/%3E%3C/svg%3E") 12 12, crosshair';
            } else {
                canvas.style.cursor = 'crosshair';
            }

            // ============================================================
            // 7. DRAWING TOOL UPDATES (continuous rendering needed)
            // ============================================================
            if (this.isFreeDrawing && (this.tool === 'intelPen' || this.tool === 'vectorPen')) {
                this.updateFreeDrawing(e);
                // Throttled render (drawing preview needs updates)
                this.requestRender(false, false);
            }

            if (this.isDrawingCompass && this.tool === 'compass') {
                this.updateCompassDrawing(e);
                this.requestRender(false, false);
            }

            // ============================================================
            // 8. PANNING (continuous rendering needed)
            // ============================================================
            if (this.isPanning) {
                const dx = px - this.panStartX;
                const dy = py - this.panStartY;
                const rawPanX = this.panStartPanX + dx;
                const rawPanY = this.panStartPanY + dy;
                const clamped = this.clampPan(rawPanX, rawPanY);
                this.panX = clamped.x;
                this.panY = clamped.y;
                this.targetPanX = this.panX;
                this.targetPanY = this.panY;
                this.bgNeedsRedraw = true;
                this.requestRender(false, false);
            }

            // ============================================================
            // 9. DRAGGING MARKER (continuous rendering needed)
            // ============================================================
            if (this.isDraggingMarker && this.dragMarker && this.tool === 'drag') {
                const cursorX = px - this.grabOffsetX;
                const cursorY = py - this.grabOffsetY;
                const newPos = this.pixelToGridFree(cursorX, cursorY);
                
                if (newPos) {
                    let finalCol = newPos.col;
                    let finalRow = newPos.row;
                    let finalSubX = newPos.subX;
                    let finalSubY = newPos.subY;
                    
                    // Handle border crossing
                    if (finalSubX > 9) {
                        finalCol = finalCol + 1;
                        finalSubX = finalSubX - 10;
                    }
                    if (finalSubX < 0) {
                        finalCol = finalCol - 1;
                        finalSubX = finalSubX + 10;
                    }
                    if (finalSubY > 9) {
                        finalRow = finalRow + 1;
                        finalSubY = finalSubY - 10;
                    }
                    if (finalSubY < 0) {
                        finalRow = finalRow - 1;
                        finalSubY = finalSubY + 10;
                    }
                    
                    finalCol = Math.min(Math.max(finalCol, 0), this.cols - 1);
                    finalRow = Math.min(Math.max(finalRow, 0), this.rows - 1);
                    finalSubX = Math.min(Math.max(finalSubX, 0), 9.99);
                    finalSubY = Math.min(Math.max(finalSubY, 0), 9.99);
                    finalSubX = Math.round(finalSubX * 100) / 100;
                    finalSubY = Math.round(finalSubY * 100) / 100;
                    
                    const existing = this.markerManager.getMarkerAt(finalCol, finalRow, finalSubX, finalSubY);
                    if (!existing || existing.id === this.dragMarker.id) {
                        const updates = {
                            col: finalCol,
                            row: finalRow,
                            subX: finalSubX,
                            subY: finalSubY
                        };
                        this.markerManager.updateMarker(this.dragMarker.id, updates);
                        this.dragMarker = this.markerManager.getMarkerById(this.dragMarker.id);
                        
                        if (this.elements.tooltip) {
                            const ref = MarkerManager.toGridRef(finalCol, finalRow, finalSubX, finalSubY);
                            const markerLabel = this.dragMarker ? this.dragMarker.label : '';
                            const intel = this.dragMarker ? this.getIntel(this.dragMarker.id) : null;
                            let tipText = ref || '--';
                            if (markerLabel) {
                                tipText += ` | ${markerLabel}`;
                                if (intel && intel.length > 0) {
                                    const firstIntel = intel[0];
                                    if (firstIntel.bearing !== null) tipText += ` | Brg: ${firstIntel.bearing}°`;
                                    if (firstIntel.distance !== null) tipText += ` | Dist: ${firstIntel.distance}km`;
                                }
                            }
                            this.elements.tooltip.textContent = tipText;
                            this.elements.tooltip.style.display = 'block';
                        }
                        
                        this.markersChanged = true;
                        this.requestRender(false, false);
                        this.updateMarkerList();
                        this.updateDropdowns();
                        if (this.selectedMarker) {
                            this.updateIntelDisplay(this.selectedMarker.id);
                        }
                        this.autoGenerateIntel();
                    }
                }
            }

            // ============================================================
            // 10. DRAWING MANAGER (if used)
            // ============================================================
            if (this.drawingManager) {
                this.drawingManager.onMouseMove(e);
            }
        });

        canvas.addEventListener('mouseup', (e) => {
            if (this.isDrawingCompass && this.tool === 'compass') {
                this.endCompassDrawing(e);
                return;
            }
            
            if (this.isPanning) {
                this.isPanning = false;
                this.canvas.style.cursor = this.tool === 'drag' ? 'grab' : 'crosshair';
            }
            if (this.isDraggingMarker && this.tool === 'drag') {
                this.isDraggingMarker = false;
                this.dragMarker = null;
                this.grabOffsetX = 0;
                this.grabOffsetY = 0;
                this.canvas.style.cursor = 'crosshair';
            }
            if (this.isFreeDrawing && (this.tool === 'intelPen' || this.tool === 'vectorPen')) {
                this.endFreeDrawing(e);
            }
            if (this.drawingManager) {
                this.drawingManager.onMouseUp(e);
            }
        });

        canvas.addEventListener('mouseleave', () => {
            if (this.elements.tooltip) {
                this.elements.tooltip.style.display = 'none';
            }
            this.hoveredItem = null;
            this.hoveredCell = null;
            this.canvas.style.cursor = 'crosshair';
            this.isPanning = false;
            this.isDraggingMarker = false;
            this.dragMarker = null;
            this.render();
        });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const now = Date.now();
            if (now - this.lastWheelTime < 80) return;
            this.lastWheelTime = now;
            
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const mouseX = (e.clientX - rect.left) * scaleX;
            const mouseY = (e.clientY - rect.top) * scaleY;
            
            if (e.deltaY < 0) {
                this.zoomIn(mouseX, mouseY);
            } else {
                this.zoomOut(mouseX, mouseY);
            }
        }, { passive: false });

        this.markerManager.subscribe(() => this.autoGenerateIntel());

        window.addEventListener('resize', () => {
            this.resize();
        });
    }

    // ==========================================
    // FONT SIZE CONTROLS
    // ==========================================

    increaseFontSize() {
        if (this.gridFontSize < this.maxFontSize) {
            this.gridFontSize += 1;
            this.updateFontSizeDisplay();
            this.render();
        }
    }

    decreaseFontSize() {
        if (this.gridFontSize > this.minFontSize) {
            this.gridFontSize -= 1;
            this.updateFontSizeDisplay();
            this.render();
        }
    }

    updateFontSizeDisplay() {
        const display = document.getElementById('fontSizeDisplay');
        if (display) {
            display.textContent = this.gridFontSize;
        }
    }

    resetFontSize() {
        this.gridFontSize = 10;
        this.updateFontSizeDisplay();
        this.render();
    }

    // ==========================================
    // AUTO-SAVE & AUTO-LOAD
    // ==========================================

    autoSave() {
        try {
            const data = this.exportData();
            localStorage.setItem('gridMapperData', data);
        } catch (e) {
            console.warn('Auto-save failed:', e);
        }
    }

    autoLoad() {
        try {
            const saved = localStorage.getItem('gridMapperData');
            if (saved) {
                this.importData(saved);
                this.showToast('Data restored from previous session', 'success');
                return true;
            }
        } catch (e) {
            console.warn('Auto-load failed:', e);
        }
        return false;
    }

    clearSavedData() {
        localStorage.removeItem('gridMapperData');
        this.showToast('Saved data cleared', 'info');
    }

}

// Make GridMapper globally available
if (typeof window !== 'undefined') {
    window.GridMapper = GridMapper;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GridMapper };
}