// ==========================================
// MARKERS.JS - Marker Management System
// ==========================================

class MarkerManager {
    constructor() {
        this.markers = [];
        this.counter = {
            nest: 0,
            spotter: 0,
            target: 0,
            reference: 0
        };
        this.usedSpotterNumbers = [];
        this.selectedType = 'nest';
        this.listeners = [];
        this.nextTargetNumber = 1;
    }

    /**
     * Parse full grid reference with integer subgrid
     * Supports: A1 5:2 (integer format only)
     * Returns the CENTER of the subgrid cell (x.5:y.5)
     */
    static parseGridRef(ref) {
        // Integer format only: A1 5:3
        const match = ref.match(/^([A-T])([1-9]|10)\s([0-9]):([0-9])$/i);
        if (!match) return null;
        
        const col = match[1].toUpperCase().charCodeAt(0) - 65;
        const row = parseInt(match[2]) - 1;
        const subX = parseFloat(match[3]);
        const subY = parseFloat(match[4]);
        
        if (col < 0 || col > 19 || row < 0 || row > 9) return null;
        if (subX < 0 || subX > 9 || subY < 0 || subY > 9) return null;
        
        // ============================================================
        // FIX: Return the CENTER of the subgrid cell (x.5:y.5)
        // ============================================================
        return { 
            col: col, 
            row: row, 
            subX: subX + 0.5, 
            subY: subY + 0.5 
        };
    }

    /**
     * Convert coordinates to grid reference with whole number display
     * Shows only integer subgrid values for display
     */
    static toGridRef(col, row, subX = 0, subY = 0) {
        if (col < 0 || col > 19 || row < 0 || row > 9) return null;
        
        // Clamp subgrid values
        let displaySubX = Math.min(Math.max(subX, 0), 9.99);
        let displaySubY = Math.min(Math.max(subY, 0), 9.99);
        
        // ============================================================
        // FIX: Display only whole numbers (floor the values)
        // ============================================================
        const subXInt = Math.floor(displaySubX);
        const subYInt = Math.floor(displaySubY);
        
        // Return grid reference (e.g., "A1 5:2")
        return String.fromCharCode(65 + col) + (row + 1) + ' ' + subXInt + ':' + subYInt;
    }

    /**
     * Get full grid reference with decimal precision (for internal use)
     */
    static toGridRefFull(col, row, subX = 0, subY = 0) {
        if (col < 0 || col > 19 || row < 0 || row > 9) return null;
        
        let displaySubX = Math.min(Math.max(subX, 0), 9.99);
        let displaySubY = Math.min(Math.max(subY, 0), 9.99);
        
        displaySubX = Math.round(displaySubX * 100) / 100;
        displaySubY = Math.round(displaySubY * 100) / 100;
        
        const subXStr = Number.isInteger(displaySubX) ? displaySubX.toString() : displaySubX.toFixed(2);
        const subYStr = Number.isInteger(displaySubY) ? displaySubY.toString() : displaySubY.toFixed(2);
        
        return String.fromCharCode(65 + col) + (row + 1) + ' ' + subXStr + ':' + subYStr;
    }

    /**
     * Check if marker is centered in its subgrid cell (x.5:x.5)
     */
    static isCentered(subX, subY) {
        const tolerance = 0.001;
        
        // Get the fractional part
        const fracX = subX - Math.floor(subX);
        const fracY = subY - Math.floor(subY);
        
        // Check if fractional part is close to 0.5
        return Math.abs(fracX - 0.5) < tolerance && Math.abs(fracY - 0.5) < tolerance;
    }

    /**
     * Get display name for marker type
     */
    static getTypeLabel(type) {
        const labels = {
            nest: 'Iron Nest',
            spotter: 'Spotter',
            target: 'Target',
            reference: 'Reference Point'
        };
        return labels[type] || type;
    }

    /**
     * Get color for marker type
     */
    static getTypeColor(type) {
        const colors = {
            nest: '#4a7db5',    // Blue
            spotter: '#4a7db5', // Blue
            target: '#e74c3c',  // Red
            reference: '#2ecc71' // Green
        };
        return colors[type] || '#a8a8a8';
    }

    /**
     * Get the next available spotter number (reuse smallest available)
     */
    getNextSpotterNumber() {
        const used = [...this.usedSpotterNumbers].sort((a, b) => a - b);
        let nextNum = 1;
        for (const num of used) {
            if (num === nextNum) {
                nextNum++;
            } else if (num > nextNum) {
                break;
            }
        }
        return nextNum;
    }

    /**
     * Add a new marker with floating subgrid support
     */
    addMarker(type, col, row, subX = 0, subY = 0) {
        // Validate grid coordinates
        if (col < 0 || col > 19 || row < 0 || row > 9) {
            throw new Error('Grid coordinates must be within A1-T10');
        }
        
        // Allow floating subgrid (0-9.99) with 2 decimal precision
        if (subX < 0 || subX > 9.99 || subY < 0 || subY > 9.99) {
            throw new Error('Sub-grid coordinates must be 0-9.99');
        }
        
        // Round to 2 decimal places for consistency
        subX = Math.round(subX * 100) / 100;
        subY = Math.round(subY * 100) / 100;
        
        // Clamp to valid range (just in case)
        subX = Math.min(Math.max(subX, 0), 9.99);
        subY = Math.min(Math.max(subY, 0), 9.99);
        
        // Generate number and label based on type
        let number;
        let label;
        
        if (type === 'nest') {
            // Only one nest allowed
            number = 0;
            label = 'Iron Nest';
        } else if (type === 'spotter') {
            // Get the next available spotter number
            number = this.getNextSpotterNumber();
            this.usedSpotterNumbers.push(number);
            label = `Spotter #${number}`;
        } else if (type === 'target') {
            // Targets get sequential numbers
            number = this.nextTargetNumber++;
            label = `Target #${number}`;
        } else { // reference
            // Reference points get sequential letters (A, B, C, ...)
            this.counter[type] = (this.counter[type] || 0) + 1;
            number = this.counter[type];
            label = `Reference Point ${String.fromCharCode(64 + number)}`;
        }

        // Create the marker object with floating subgrid
        const marker = {
            id: `${type}-${number}-${Date.now()}`,
            type: type,
            number: number,
            label: label,
            col: col,
            row: row,
            subX: subX,  // Can be 0-9.99 (2 decimal places)
            subY: subY,  // Can be 0-9.99 (2 decimal places)
            gridRef: this.constructor.toGridRef(col, row, subX, subY),
            color: this.constructor.getTypeColor(type),
            createdAt: new Date().toISOString()
        };

        // Add to markers array
        this.markers.push(marker);
        
        // Notify listeners
        this.notifyListeners('add', marker);
        
        return marker;
    }

    /**
     * Update a marker's properties
     */
    updateMarker(id, updates) {
        const marker = this.markers.find(m => m.id === id);
        if (!marker) return null;
        
        // Apply all updates
        if (updates.label !== undefined) marker.label = updates.label;
        if (updates.col !== undefined) marker.col = updates.col;
        if (updates.row !== undefined) marker.row = updates.row;
        if (updates.subX !== undefined) {
            marker.subX = Math.round(updates.subX * 100) / 100;
            marker.subX = Math.min(Math.max(marker.subX, 0), 9.99);
        }
        if (updates.subY !== undefined) {
            marker.subY = Math.round(updates.subY * 100) / 100;
            marker.subY = Math.min(Math.max(marker.subY, 0), 9.99);
        }
        if (updates.number !== undefined) marker.number = updates.number;
        
        // ============================================================
        // CRITICAL FIX: Update color when type changes
        // ============================================================
        if (updates.type !== undefined && updates.type !== marker.type) {
            marker.type = updates.type;
            marker.color = this.constructor.getTypeColor(updates.type);
        } else if (updates.color !== undefined) {
            // Allow direct color updates
            marker.color = updates.color;
        }
        
        // Update grid reference if position changed
        if (updates.col !== undefined || updates.row !== undefined || 
            updates.subX !== undefined || updates.subY !== undefined) {
            marker.gridRef = this.constructor.toGridRef(
                marker.col, marker.row, marker.subX, marker.subY
            );
        }
        
        this.notifyListeners('update', marker);
        return marker;
    }

    /**
     * Remove a marker by ID
     */
    removeMarker(id) {
        const index = this.markers.findIndex(m => m.id === id);
        if (index === -1) return false;
        const removed = this.markers.splice(index, 1)[0];
        
        if (removed.type === 'spotter') {
            const numIndex = this.usedSpotterNumbers.indexOf(removed.number);
            if (numIndex > -1) {
                this.usedSpotterNumbers.splice(numIndex, 1);
            }
        }
        
        if (removed.type === 'nest') {
            this.counter.nest = 0;
        }
        
        this.notifyListeners('remove', removed);
        return true;
    }

    /**
     * Get all markers
     */
    getAllMarkers() {
        return [...this.markers];
    }

    /**
     * Get markers by type
     */
    getMarkersByType(type) {
        return this.markers.filter(m => m.type === type);
    }

    /**
     * Get marker at grid position (with floating point tolerance)
     */
    getMarkerAt(col, row, subX, subY) {
        // Handle border crossing - normalize the position
        let normalizedCol = col;
        let normalizedRow = row;
        let normalizedSubX = subX;
        let normalizedSubY = subY;
        
        // Handle subX going beyond 9
        if (subX > 9) {
            normalizedCol = col + 1;
            normalizedSubX = subX - 10;
        }
        if (subX < 0) {
            normalizedCol = col - 1;
            normalizedSubX = subX + 10;
        }
        
        // Handle subY going beyond 9
        if (subY > 9) {
            normalizedRow = row + 1;
            normalizedSubY = subY - 10;
        }
        if (subY < 0) {
            normalizedRow = row - 1;
            normalizedSubY = subY + 10;
        }
        
        // Clamp
        normalizedCol = Math.min(Math.max(normalizedCol, 0), 19);
        normalizedRow = Math.min(Math.max(normalizedRow, 0), 9);
        normalizedSubX = Math.min(Math.max(normalizedSubX, 0), 9.99);
        normalizedSubY = Math.min(Math.max(normalizedSubY, 0), 9.99);
        
        // Use a small tolerance for floating point comparison
        const tolerance = 0.005;
        return this.markers.find(m => 
            m.col === normalizedCol && 
            m.row === normalizedRow && 
            Math.abs(m.subX - normalizedSubX) < tolerance && 
            Math.abs(m.subY - normalizedSubY) < tolerance
        );
    }

    /**
     * Get marker by ID
     */
    getMarkerById(id) {
        return this.markers.find(m => m.id === id);
    }

    /**
     * Clear all markers
     */
    clearAll() {
        this.markers = [];
        this.counter = { nest: 0, spotter: 0, target: 0, reference: 0 };
        this.usedSpotterNumbers = [];
        this.nextTargetNumber = 1;
        this.notifyListeners('clear', null);
    }

    /**
     * Subscribe to marker changes
     */
    subscribe(callback) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(cb => cb !== callback);
        };
    }

    notifyListeners(action, data) {
        this.listeners.forEach(cb => {
            try {
                cb(action, data, this);
            } catch (e) {
                console.error('Listener error:', e);
            }
        });
        // Update triangulate dropdowns if gridMapper exists
        if (window.gridMapper && typeof window.gridMapper.updateTriangulateData === 'function') {
            setTimeout(() => {
                window.gridMapper.updateTriangulateData();
            }, 10);
        }
    }

    /**
     * Parse a grid reference with floating subgrid
     * Supports: A1 5.30:2.70 or A1 5:3
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
}

// Make MarkerManager globally available
if (typeof window !== 'undefined') {
    window.MarkerManager = MarkerManager;
}

// Export for Node.js/Modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MarkerManager };
}