// ==========================================
// MAIN.JS - Application Entry Point
// ==========================================


document.addEventListener('DOMContentLoaded', function() {
    // --- DOM References ---
    const elements = {
        canvas: document.getElementById('gridCanvas'),
        tooltip: document.getElementById('tooltip'),
        markerList: document.getElementById('markerList'),
        cursorPos: document.getElementById('cursorPos'),
        selectedInfo: document.getElementById('selectedInfo'),
        totalMarkers: document.getElementById('totalMarkers'),
        drawingInfo: document.getElementById('drawingInfo')
    };

    // --- Initialize Managers ---
    const markerManager = new MarkerManager();

    // --- Initialize Grid Mapper ---
    const gridMapper = new GridMapper({
        canvas: elements.canvas,
        markerManager: markerManager,
        elements: elements
    });

    // Make gridMapper globally accessible for inline onclick handlers
    window.gridMapper = gridMapper;

    // ============================================================
    // TOAST NOTIFICATION
    // ============================================================

    function showToast(message, type = 'info') {
        const existing = document.querySelector('.toast-notification');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast-notification ' + type;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
        }, 2000);
    }

    // Make showToast globally available
    window.showToast = showToast;

    // ============================================================
    // CALCULATOR LOGIC
    // ============================================================

    // Flight time slopes per charge (seconds per degree)
    const FLIGHT_SLOPES = {
        1: 0.3967,
        2: 0.5412,
        3: 0.6158,
        4: 0.6613,
        5: 0.6920,
        6: 0.7143
    };

    // T60 values (time at 60° elevation) per charge
    const T60_VALUES = {
        1: 23.80,
        2: 32.47,
        3: 36.95,
        4: 39.68,
        5: 41.52,
        6: 42.86
    };

    /**
     * Calculate elevation from range and charge
     * E = (R * 12) / C
     */
    function calculateElevation(range, charge) {
        return (range * 12) / charge;
    }

    /**
     * Calculate flight time from elevation and charge
     * t = slope * E
     */
    function calculateFlightTime(elevation, charge) {
        const slope = FLIGHT_SLOPES[charge] || 0.7143;
        return slope * elevation;
    }

    /**
     * Calculate T60 (time at 60°) for a given charge
     */
    function calculateT60(charge) {
        return T60_VALUES[charge] || 42.86;
    }

    /**
     * Get max range for a charge
     * R_max = 5 * C
     */
    function getMaxRange(charge) {
        return 5 * charge;
    }

    /**
     * REVERSE CALCULATION: Time + Range → Charge + Elevation
     * 
     * Given a desired flight time and range, find the optimal powder charge
     * and required elevation.
     * 
     * @param {number} targetTime - Desired flight time in seconds
     * @param {number} targetRange - Desired range in km
     * @returns {object} { elevation, charge, flightTime, t60, maxRange, feasible, chargeFound }
     */
    function reverseCalculateCharge(targetTime, targetRange) {
        // Clamp inputs
        const time = Math.max(0.1, Math.min(targetTime, 60));
        const range = Math.max(0, Math.min(targetRange, 30));
        
        // Try all charges from 1 to 6
        const candidates = [];
        
        for (let c = 1; c <= 6; c++) {
            const maxRange = getMaxRange(c);
            
            // Check if range is within max for this charge
            if (range > maxRange) {
                continue; // This charge can't reach this range
            }
            
            // Calculate required elevation for this range and charge
            const requiredElevation = calculateElevation(range, c);
            
            // Check if elevation is within valid range (0-60°)
            if (requiredElevation < 0 || requiredElevation > 60) {
                continue;
            }
            
            // Calculate flight time at this elevation with this charge
            const flightTime = calculateFlightTime(requiredElevation, c);
            
            // Calculate error between target and actual flight time
            const error = Math.abs(flightTime - time);
            
            candidates.push({
                charge: c,
                elevation: requiredElevation,
                flightTime: flightTime,
                t60: T60_VALUES[c],
                maxRange: maxRange,
                error: error,
                // Score: lower error is better, prefer higher charges
                score: error * 100 + (6 - c) * 0.01
            });
        }
        
        if (candidates.length === 0) {
            // No charge can achieve this combination
            return {
                elevation: null,
                charge: null,
                flightTime: null,
                t60: null,
                maxRange: null,
                feasible: false,
                chargeFound: false
            };
        }
        
        // Sort by error (lowest first), then by charge (highest first)
        candidates.sort((a, b) => {
            if (Math.abs(a.error - b.error) < 0.001) {
                return b.charge - a.charge; // Prefer higher charge
            }
            return a.error - b.error;
        });
        
        const best = candidates[0];
        
        // Check if the best candidate is actually close enough (within 0.5s tolerance)
        const feasible = best.error < 0.5;
        
        return {
            elevation: best.elevation,
            charge: best.charge,
            flightTime: best.flightTime,
            t60: best.t60,
            maxRange: best.maxRange,
            feasible: feasible,
            chargeFound: true,
            error: best.error,
            allCandidates: candidates
        };
    }

    // ============================================================
    // CHARGE SELECTOR - Visual Powder Charge
    // ============================================================

    let selectedCharge = 6; // Default to 6 charges

    function updateChargeSelector(range) {
        const buttons = document.querySelectorAll('.charge-btn');
        const maxRange = parseFloat(range) || 0;
        
        buttons.forEach(btn => {
            const charge = parseInt(btn.dataset.charge);
            const chargeMaxRange = getMaxRange(charge);
            
            // Remove all state classes
            btn.classList.remove('charge-available', 'charge-active', 'charge-unavailable');
            
            // Check if this charge can reach the current range
            const canReach = maxRange <= chargeMaxRange;
            
            if (!canReach) {
                // Cannot reach the range -> UNAVAILABLE (red)
                btn.classList.add('charge-unavailable');
            } else if (charge <= selectedCharge) {
                // Can reach AND is <= selected charge -> ACTIVE (green)
                btn.classList.add('charge-active');
            } else {
                // Can reach AND is > selected charge -> AVAILABLE (white)
                btn.classList.add('charge-available');
            }
        });
    }

    /**
     * Initialize charge selector event listeners
     */
    function initChargeSelector() {
        const buttons = document.querySelectorAll('.charge-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', function() {
                const charge = parseInt(this.dataset.charge);
                const rangeInput = document.getElementById('ballisticRange');
                const currentRange = parseFloat(rangeInput.value) || 0;
                const maxRange = getMaxRange(charge);
                
                // Check if this charge is available for the current range
                if (currentRange > maxRange) {
                    // Show a brief flash to indicate unavailable
                    this.style.transform = 'scale(0.9)';
                    setTimeout(() => {
                        this.style.transform = '';
                    }, 200);
                    // Show toast notification
                    showToast(`Charge ${charge} cannot reach ${currentRange.toFixed(1)}km (max: ${maxRange.toFixed(1)}km)`, 'warning');
                    return;
                }
                
                // Update selected charge
                selectedCharge = charge;
                updateChargeSelector(currentRange);
                
                // Recalculate ballistic
                updateBallisticCalculator();
            });
        });
    }

    // --- Ballistic Calculator ---
    function updateBallisticCalculator() {
        const rangeInput = document.getElementById('ballisticRange');
        const elevationDisplay = document.getElementById('ballisticElevation');
        const flightTimeDisplay = document.getElementById('ballisticFlightTime');
        const bearingDisplay = document.getElementById('ballisticBearing');

        if (!rangeInput) return;

        // Preserve the bearing value
        let currentBearingValue = null;
        if (bearingDisplay) {
            const text = bearingDisplay.textContent;
            if (text !== '—' && text !== '') {
                currentBearingValue = text;
            }
        }

        const range = parseFloat(rangeInput.value) || 0;
        
        let minCharge = 6;
        for (let c = 1; c <= 6; c++) {
            if (range <= getMaxRange(c)) {
                minCharge = c;
                break;
            }
        }
        
        if (range > getMaxRange(selectedCharge)) {
            selectedCharge = minCharge;
            updateChargeSelector(range);
        }
        
        const charge = selectedCharge;
        const elevation = calculateElevation(range, charge);
        const flightTime = calculateFlightTime(elevation, charge);

        // Display with 2 decimals for elevation and flight time
        if (elevationDisplay) elevationDisplay.textContent = elevation.toFixed(2) + '°';
        if (flightTimeDisplay) flightTimeDisplay.textContent = flightTime.toFixed(2) + ' s';

        // Restore the bearing value
        if (bearingDisplay && currentBearingValue) {
            bearingDisplay.textContent = currentBearingValue;
            bearingDisplay.style.color = 'var(--accent-amber)';
        }

        updateChargeSelector(range);
    }

    function updateFlightTimeReverse() {
        const timeInput = document.getElementById('flightTargetTime');
        const rangeInput = document.getElementById('flightTargetRange');
        const elevationDisplay = document.getElementById('reverseElevation');
        const chargeDisplay = document.getElementById('reverseCharge');
        const flightTimeDisplay = document.getElementById('reverseFlightTime');
        const bearingDisplay = document.getElementById('flightBearing');

        if (!timeInput || !rangeInput) return;

        // Preserve the bearing value
        let currentBearingValue = null;
        if (bearingDisplay) {
            const text = bearingDisplay.textContent;
            if (text !== '—' && text !== '') {
                currentBearingValue = text;
            }
        }

        const targetTime = parseFloat(timeInput.value) || 0;
        const targetRange = parseFloat(rangeInput.value) || 0;

        const result = reverseCalculateCharge(targetTime, targetRange);

        if (result.chargeFound && result.elevation !== null) {
            // Display with 2 decimals
            if (elevationDisplay) elevationDisplay.textContent = result.elevation.toFixed(2) + '°';
            if (chargeDisplay) chargeDisplay.textContent = result.charge;
            if (flightTimeDisplay) flightTimeDisplay.textContent = result.flightTime.toFixed(2) + ' s';
            
            if (elevationDisplay) elevationDisplay.style.color = result.feasible ? '#88ffaa' : '#ffd93d';
            if (chargeDisplay) chargeDisplay.style.color = result.feasible ? '#88ffaa' : '#ffd93d';
            
        } else {
            if (elevationDisplay) elevationDisplay.textContent = '—';
            if (chargeDisplay) chargeDisplay.textContent = '—';
            if (flightTimeDisplay) flightTimeDisplay.textContent = '—';
            
            if (elevationDisplay) elevationDisplay.style.color = '#ff6644';
            if (chargeDisplay) chargeDisplay.style.color = '#ff6644';
        }

        // Restore the bearing value
        if (bearingDisplay && currentBearingValue) {
            bearingDisplay.textContent = currentBearingValue;
            bearingDisplay.style.color = 'var(--accent-amber)';
        }
    }

    let currentBearing = null;

    function setCurrentBearing(bearing) {
        currentBearing = bearing;
    }
    window.setCurrentBearing = setCurrentBearing;
    
    // --- Event Listeners for Calculators ---



    document.getElementById('ballisticRange')?.addEventListener('input', updateBallisticCalculator);

    // ============================================================
    // FIRING SOLUTIONS
    // ============================================================

    let firingSolutions = [];
    let selectedSolutionId = null;

    /**
     * Generate a firing solution card from current calculator state
     */
    function generateFiringSolution(source = 'ballistic') {
        let range, shellType, charge, elevation, flightTime, bearing;
        
        if (source === 'ballistic') {
            const rangeInput = document.getElementById('ballisticRange');
            const shellSelect = document.getElementById('shellType');
            const elevationDisplay = document.getElementById('ballisticElevation');
            const flightTimeDisplay = document.getElementById('ballisticFlightTime');
            const bearingDisplay = document.getElementById('ballisticBearing');
            
            range = parseFloat(rangeInput?.value) || 0;
            shellType = shellSelect?.value || 'HE';
            elevation = parseFloat(elevationDisplay?.textContent) || 0;
            flightTime = parseFloat(flightTimeDisplay?.textContent) || 0;
            charge = selectedCharge;
            
            // Get bearing from display or currentBearing
            if (bearingDisplay) {
                const bearingText = bearingDisplay.textContent;
                const cleanBearing = parseFloat(bearingText.replace(/[^0-9.\-]/g, ''));
                bearing = !isNaN(cleanBearing) ? cleanBearing : currentBearing;
            } else {
                bearing = currentBearing;
            }
        } else {
            const rangeInput = document.getElementById('flightTargetRange');
            const shellSelect = document.getElementById('flightShellType');
            const elevationDisplay = document.getElementById('reverseElevation');
            const flightTimeDisplay = document.getElementById('reverseFlightTime');
            const chargeDisplay = document.getElementById('reverseCharge');
            const bearingDisplay = document.getElementById('flightBearing');
            
            range = parseFloat(rangeInput?.value) || 0;
            shellType = shellSelect?.value || 'HE';
            elevation = parseFloat(elevationDisplay?.textContent) || 0;
            flightTime = parseFloat(flightTimeDisplay?.textContent) || 0;
            charge = parseInt(chargeDisplay?.textContent) || 0;
            
            // Get bearing from display or currentBearing
            if (bearingDisplay) {
                const bearingText = bearingDisplay.textContent;
                const cleanBearing = parseFloat(bearingText.replace(/[^0-9.\-]/g, ''));
                bearing = !isNaN(cleanBearing) ? cleanBearing : currentBearing;
            } else {
                bearing = currentBearing;
            }
        }
        
        // Create solution object
        const solution = {
            id: Date.now(),
            range: range,
            shellType: shellType,
            charge: charge,
            elevation: elevation,
            flightTime: flightTime,
            bearing: bearing,
            source: source,
            done: false,
            createdAt: new Date().toISOString()
        };
        
        firingSolutions.push(solution);
        renderFiringSolutions();
        showToast(`Firing solution generated: ${shellType} @ ${range.toFixed(1)}km`, 'success');
    }

    /**
     * Render firing solution cards
     */
    function renderFiringSolutions() {
        const container = document.getElementById('firingCardsContainer');
        if (!container) return;
        
        if (firingSolutions.length === 0) {
            container.innerHTML = `<p class="empty-message" style="grid-column:1/-1; text-align:center; padding:20px 0;">No firing solutions yet. Generate a card from the calculator above.</p>`;
            return;
        }
        
        let html = '';
        firingSolutions.forEach((solution, index) => {
            const isDone = solution.done;
            const chargeBlocks = [];
            for (let i = 1; i <= 6; i++) {
                const active = i <= solution.charge;
                chargeBlocks.push(`<span class="card-charge-block ${active ? 'active' : 'inactive'}">${i}</span>`);
            }
            
            html += `
                <div class="firing-card ${isDone ? 'done' : ''}" data-id="${solution.id}" data-index="${index}">
                    ${isDone ? '<div class="done-overlay">✓</div>' : ''}
                    <div class="card-header">
                        <span class="card-shell-type">${solution.shellType}</span>
                        <div class="card-actions">
                            <button class="done-btn" onclick="toggleSolutionDone(${solution.id})" title="${isDone ? 'Mark as not done' : 'Mark as done'}">
                                <svg class="icon-sm"><use href="images/icons.svg#icon-check-circle"></use></svg>
                            </button>
                            <button class="delete-btn" onclick="deleteSolution(${solution.id})" title="Delete">
                                <svg class="icon-sm"><use href="images/icons.svg#icon-close"></use></svg>
                            </button>
                        </div>
                    </div>
                    <div class="card-details">
                        <span class="detail-item">
                            <span class="label">Range:</span>
                            <span class="value">${solution.range.toFixed(2)} km</span>
                        </span>
                        <span class="detail-item">
                            <span class="label">Elevation:</span>
                            <span class="value">${solution.elevation.toFixed(1)}°</span>
                        </span>
                        <span class="detail-item">
                            <span class="label">Flight Time:</span>
                            <span class="value">${solution.flightTime.toFixed(1)}s</span>
                        </span>
                        ${solution.bearing !== null ? `
                        <span class="detail-item">
                            <span class="label">Bearing:</span>
                            <span class="value">${solution.bearing.toFixed(1)}°</span>
                        </span>
                        ` : ''}
                    </div>
                    <div class="card-charge-display">
                        ${chargeBlocks.join('')}
                        <span style="font-size:0.7rem; color:var(--text-muted); margin-left:4px;">(${solution.charge} charges)</span>
                    </div>
                </div>
            `;
        });
        
        container.innerHTML = html;
    }

    /**
     * Toggle done status of a firing solution
     */
    function toggleSolutionDone(id) {
        const solution = firingSolutions.find(s => s.id === id);
        if (solution) {
            solution.done = !solution.done;
            renderFiringSolutions();
            showToast(solution.done ? 'Solution marked as done' : 'Solution unmarked', 'info');
        }
    }

    /**
     * Delete a firing solution
     */
    function deleteSolution(id) {
        const index = firingSolutions.findIndex(s => s.id === id);
        if (index > -1) {
            firingSolutions.splice(index, 1);
            renderFiringSolutions();
            showToast('Firing solution deleted', 'success');
        }
    }

    /**
     * Clear all firing solutions
     */
    function clearAllSolutions() {
        if (firingSolutions.length === 0) {
            showToast('No firing solutions to clear', 'info');
            return;
        }
        if (confirm('Clear all firing solutions?')) {
            firingSolutions = [];
            renderFiringSolutions();
            showToast('All firing solutions cleared', 'success');
        }
    }

    // Make functions globally accessible
    window.toggleSolutionDone = toggleSolutionDone;
    window.deleteSolution = deleteSolution;

    // Flight time calculator (reverse) inputs
    document.getElementById('flightTargetTime')?.addEventListener('input', updateFlightTimeReverse);
    document.getElementById('flightTargetRange')?.addEventListener('input', updateFlightTimeReverse);

    // --- Calculator Tab Switching ---
    document.querySelectorAll('.calculator-tab').forEach(tab => {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.calculator-tab').forEach(t => t.classList.remove('active'));
            this.classList.add('active');

            document.querySelectorAll('.calculator-tab-content').forEach(c => c.style.display = 'none');
            const target = document.getElementById(this.dataset.tab === 'ballistic' ? 'calcTabBallistic' : 'calcTabFlightTime');
            if (target) target.style.display = 'block';

            // Recalculate when switching tabs
            if (this.dataset.tab === 'ballistic') {
                updateBallisticCalculator();
            } else {
                updateFlightTimeReverse();
            }
        });
    });

    // --- Setup UI Events ---

    // Marker type buttons
    document.querySelectorAll('.btn-marker').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.btn-marker').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            markerManager.selectedType = this.dataset.type;
        });
    });

    // Tool buttons
    document.querySelectorAll('.btn-tool').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.btn-tool').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            gridMapper.setTool(this.dataset.tool);
            
            const toolLabels = {
                select: 'Click to select markers, drag to move them',
                drag: 'Drag to pan around the map',
                intelPen: 'Click and drag to draw an Intel arrow',
                vectorPen: 'Click and drag to draw a Vector arrow',
                compass: 'Click and drag to draw a distance circle'
            };
            if (elements.drawingInfo) {
                elements.drawingInfo.innerHTML = `<p style="color:#88bbff; font-size:0.8rem;">${toolLabels[this.dataset.tool] || ''}</p>`;
            }
        });
    });

    // Zoom buttons
    document.getElementById('zoomInBtn').addEventListener('click', () => {
        gridMapper.zoomIn();
    });
    document.getElementById('zoomOutBtn').addEventListener('click', () => {
        gridMapper.zoomOut();
    });
    document.getElementById('resetZoomBtn').addEventListener('click', () => {
        gridMapper.resetZoom();
    });

    // Clear all button
    document.getElementById('clearAllBtn').addEventListener('click', function() {
        if (confirm('Clear all markers, drawings, and intel?')) {
            gridMapper.clearAll();
        }
    });

    // Export button
    document.getElementById('exportBtn').addEventListener('click', function() {
        const data = gridMapper.exportData();
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `grid_data_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // Import button
    document.getElementById('importBtn').addEventListener('click', function() {
        document.getElementById('importFile').click();
    });

    document.getElementById('importFile').addEventListener('change', function(e) {
        const file = this.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(event) {
            gridMapper.importData(event.target.result);
        };
        reader.readAsText(file);
        this.value = '';
    });

    // Close panels on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const intelPanel = document.getElementById('intelPanel');
            if (intelPanel) intelPanel.style.display = 'none';
            const editPanel = document.getElementById('editPanel');
            if (editPanel) editPanel.style.display = 'none';
            const contextMenu = document.getElementById('contextMenu');
            if (contextMenu) contextMenu.remove();
        }
    });

    // Initialize Add Marker section
    gridMapper.showAddMarkerSection();

    // --- Initial Render ---
    setTimeout(() => {
        gridMapper.resize();
        gridMapper.updateMarkerList();
        gridMapper.updateDropdowns();
        gridMapper.updateIntelDisplay(null);
    }, 100);

    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => { gridMapper.resize(); }, 250);
    });

    // Font size buttons
    document.getElementById('fontSizeUpBtn').addEventListener('click', () => {
        gridMapper.increaseFontSize();
    });

    document.getElementById('fontSizeDownBtn').addEventListener('click', () => {
        gridMapper.decreaseFontSize();
    });

    // Update font size display on init
    gridMapper.updateFontSizeDisplay();

    // Triangulation Tab
    gridMapper.updateTriangulateDropdowns();


    // Add triangulate item
    document.getElementById('addTriangulateItemBtn').addEventListener('click', () => {
        gridMapper.addTriangulateItem();
    });

    // Calculate triangulation
    document.getElementById('calculateTriangulateBtn').addEventListener('click', () => {
        gridMapper.calculateTriangulation();
    });

    // Create marker from triangulation
    document.getElementById('triangulateCreateMarkerBtn').addEventListener('click', () => {
        const result = gridMapper.triangulateResult;
        if (!result) return;
        
        const type = result.targetType || document.getElementById('triangulateTargetType').value;
        
        const prevType = markerManager.selectedType;
        markerManager.selectedType = type;
        
        const marker = gridMapper.addMarkerAt(
            result.grid.col, 
            result.grid.row, 
            result.grid.subX, 
            result.grid.subY
        );
        
        markerManager.selectedType = prevType;
        
        if (marker) {
            for (const item of result.items) {
                const sourceMarker = item.marker;
                gridMapper.addIntel(sourceMarker.id, item.bearing, item.distance);
                console.log(`Added user intel to ${sourceMarker.label}: bearing ${item.bearing}°, distance ${item.distance}km`);
            }
            
            gridMapper.showToast(
                `Created ${marker.label} at ${result.gridRef}. Intel added to ${result.items.length} source marker(s).`, 
                'success'
            );
            
            document.getElementById('triangulateResults').style.display = 'none';
            gridMapper.triangulateResult = null;
            gridMapper.triangulatePreview = null;
            gridMapper.selectMarker(marker);
            gridMapper.updateMarkerList();
            gridMapper.updateDropdowns();
            gridMapper.render();
        }
    });

    document.getElementById('removeAllIntelBtn').addEventListener('click', () => {
        gridMapper.removeAllIntel();
    });

    document.getElementById('removeAllMeasurementsBtn').addEventListener('click', () => {
        gridMapper.removeAllMeasurements();
    });

    // ============================================================
    // INITIALIZE CHARGE SELECTOR
    // ============================================================

    // Initialize charge selector
    initChargeSelector();

    // Set initial charge to 6
    selectedCharge = 6;
    updateChargeSelector(5);

    // --- Initial calculator updates ---
    setTimeout(() => {
        updateBallisticCalculator();
        updateFlightTimeReverse();
    }, 100);

    // Close triangulation results
    document.getElementById('closeTriangulationResults')?.addEventListener('click', () => {
        gridMapper.closeTriangulationResults();
    });

    // Generate card buttons
    document.getElementById('generateCardBtn')?.addEventListener('click', () => {
        generateFiringSolution('ballistic');
    });

    document.getElementById('generateFlightCardBtn')?.addEventListener('click', () => {
        generateFiringSolution('flighttime');
    });

    // Clear all cards
    document.getElementById('clearAllCardsBtn')?.addEventListener('click', clearAllSolutions);

    // Initial render of firing solutions
    renderFiringSolutions();
});