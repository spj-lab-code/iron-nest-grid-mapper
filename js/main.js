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

    // --- Ballistic Calculator ---
    function updateBallisticCalculator() {
        const rangeInput = document.getElementById('ballisticRange');
        const chargeSelect = document.getElementById('ballisticCharge');
        const elevationDisplay = document.getElementById('ballisticElevation');
        const flightTimeDisplay = document.getElementById('ballisticFlightTime');
        const maxRangeDisplay = document.getElementById('ballisticMaxRange');
        const infoDisplay = document.getElementById('ballisticInfo');

        if (!rangeInput || !chargeSelect) return;

        const range = parseFloat(rangeInput.value) || 0;
        const charge = parseInt(chargeSelect.value) || 6;
        const maxRange = getMaxRange(charge);

        // Clamp range to max
        let clampedRange = Math.min(range, maxRange);
        if (clampedRange !== range) {
            rangeInput.value = clampedRange.toFixed(1);
        }

        // Calculate
        const elevation = calculateElevation(clampedRange, charge);
        const flightTime = calculateFlightTime(elevation, charge);

        // Update displays
        elevationDisplay.textContent = elevation.toFixed(2) + '°';
        flightTimeDisplay.textContent = flightTime.toFixed(2) + ' s';
        maxRangeDisplay.textContent = maxRange.toFixed(1) + ' km';

        // Update info with range status
        const isMax = Math.abs(clampedRange - maxRange) < 0.01;
        const infoMsg = isMax 
            ? '<i data-lucide="zap" class="icon-sm"></i> At maximum range! Elevation = 60° (forced by game)'
            : `<i data-lucide="lightbulb" class="icon-sm"></i> Elevation = (${clampedRange.toFixed(1)} × 12) / ${charge} = ${elevation.toFixed(2)}°`;
        infoDisplay.textContent = infoMsg;
        infoDisplay.style.borderLeftColor = isMax ? '#ffd93d' : '#4a7a8a';
    }

    // --- Flight Time Calculator (Reverse: Time + Range → Charge) ---
    function updateFlightTimeReverse() {
        const timeInput = document.getElementById('flightTargetTime');
        const rangeInput = document.getElementById('flightTargetRange');
        const elevationDisplay = document.getElementById('reverseElevation');
        const chargeDisplay = document.getElementById('reverseCharge');
        const flightTimeDisplay = document.getElementById('reverseFlightTime');
        const maxRangeDisplay = document.getElementById('reverseMaxRangeDisplay');
        const t60Display = document.getElementById('reverseT60Display');
        const feasibleDisplay = document.getElementById('reverseFeasibleDisplay');
        const infoDisplay = document.getElementById('flightReverseInfo');

        if (!timeInput || !rangeInput) return;

        const targetTime = parseFloat(timeInput.value) || 0;
        const targetRange = parseFloat(rangeInput.value) || 0;

        // Run reverse calculation
        const result = reverseCalculateCharge(targetTime, targetRange);

        if (result.chargeFound && result.elevation !== null) {
            // Show results
            elevationDisplay.textContent = result.elevation.toFixed(2) + '°';
            chargeDisplay.textContent = result.charge;
            flightTimeDisplay.textContent = result.flightTime.toFixed(2) + ' s';
            maxRangeDisplay.textContent = result.maxRange.toFixed(1) + ' km';
            t60Display.textContent = result.t60.toFixed(2) + ' s';

            // Feasibility status
            if (result.feasible) {
                feasibleDisplay.textContent = '<i data-lucide="circle-check-big" class="icon-sm"></i> Yes';
                feasibleDisplay.className = 'feasible-yes';
                infoDisplay.textContent = `<i data-lucide="circle-check-big" class="icon-sm"></i> Optimal: Charge ${result.charge}, Elevation ${result.elevation.toFixed(2)}°, Actual flight time ${result.flightTime.toFixed(2)}s (target: ${targetTime.toFixed(1)}s, error: ${(result.error * 100).toFixed(0)}ms)`;
                infoDisplay.style.borderLeftColor = '#88ffaa';
            } else {
                feasibleDisplay.textContent = '<i data-lucide="triangle-alert" class="icon-sm"></i> Approx';
                feasibleDisplay.className = 'feasible-maybe';
                infoDisplay.textContent = `<i data-lucide="triangle-alert" class="icon-sm"></i> Closest match: Charge ${result.charge}, Elevation ${result.elevation.toFixed(2)}°, Actual flight time ${result.flightTime.toFixed(2)}s (target: ${targetTime.toFixed(1)}s, error: ${(result.error * 100).toFixed(0)}ms) - Try adjusting time or range`;
                infoDisplay.style.borderLeftColor = '#ffd93d';
            }

            // Color the results
            elevationDisplay.style.color = result.feasible ? '#88ffaa' : '#ffd93d';
            chargeDisplay.style.color = result.feasible ? '#88ffaa' : '#ffd93d';
            
        } else {
            // No charge can achieve this combination
            elevationDisplay.textContent = '—';
            chargeDisplay.textContent = '—';
            flightTimeDisplay.textContent = '—';
            maxRangeDisplay.textContent = '—';
            t60Display.textContent = '—';
            feasibleDisplay.textContent = '<i data-lucide="circle-x" class="icon-sm"></i> No';
            feasibleDisplay.className = 'feasible-no';
            infoDisplay.textContent = '<i data-lucide="circle-x" class="icon-sm"></i> No powder charge can achieve this combination of flight time and range. Try adjusting values.';
            infoDisplay.style.borderLeftColor = '#ff6644';
            
            elevationDisplay.style.color = '#ff6644';
            chargeDisplay.style.color = '#ff6644';
        }
    }

    // --- Event Listeners for Calculators ---

    // Ballistic calculator inputs
    document.getElementById('ballisticRange')?.addEventListener('input', updateBallisticCalculator);
    document.getElementById('ballisticCharge')?.addEventListener('change', updateBallisticCalculator);

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

    // --- Initial calculator updates ---
    setTimeout(() => {
        updateBallisticCalculator();
        updateFlightTimeReverse();
    }, 100);

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
                select: '🖱️ Click to select markers, drag to move them',
                drag: '<i data-lucide="hand" class="icon-sm"></i> Drag to pan around the map',
                intelPen: '<i data-lucide="pencil" class="icon-sm"></i> Click and drag to draw an Intel arrow',
                vectorPen: '<i data-lucide="pen-tool" class="icon-sm"></i> Click and drag to draw a Vector arrow',
                compass: '<i data-lucide="drafting-compass" class="icon-sm"></i> Click and drag to draw a distance circle'
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
    document.querySelectorAll('.intel-tab').forEach(tab => {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.intel-tab').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            
            document.querySelectorAll('.intel-tab-content').forEach(c => c.style.display = 'none');
            const target = document.getElementById(this.dataset.tab === 'marker' ? 'intelTabMarker' : 'intelTabTriangulate');
            if (target) target.style.display = 'block';
            
            if (this.dataset.tab === 'triangulate') {
                gridMapper.updateTriangulateDropdowns();
            }
        });
    });

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

});