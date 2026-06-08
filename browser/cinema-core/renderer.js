/**
 * Infrix Cinema — canonical scene renderer.
 *
 * This is THE single Cinema renderer. Every Cinema surface (standalone full,
 * Nexus-mounted, embed widget, portable proof) draws through this class; no
 * surface ships its own scene renderer. It draws the SceneGraph
 * (pkg/cinema/scene) on a Canvas 2D context with pan/zoom, node selection,
 * hover, animated edge particles, and a translucent ghost overlay.
 *
 * Moved here from tools/cinema-viewer/js/renderer.js as part of Priority 05
 * (one canonical Cinema product surface). The old path is a deprecation shim.
 *
 * Loaded as a classic script; attaches CinemaRenderer to window.InfrixCinema.
 */
(function (root) {
  'use strict';

class CinemaRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.sceneGraph = null;
        this.camera = { x: 0, y: 0, zoom: 1.0 };
        this.selectedNode = null;
        this.hoveredNode = null;
        this.hoveredEdge = null;
        this.animationFrame = null;
        this.ghostGraph = null;
        this.isDragging = false;
        this.lastMouse = { x: 0, y: 0 };
        this.particlePhase = 0;
        this.eventHandlers = new Map();
        this.frameCount = 0;
        this.lastFPSTime = (typeof performance !== 'undefined' ? performance.now() : 0);
        this.fps = 0;
        this.nodeEntryTimes = new Map();  // nodeId -> performance.now()
        this.edgeEntryTimes = new Map();  // "from→to" -> performance.now()

        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
        this.setupInteraction();
        this.startAnimationLoop();
    }

    resizeCanvas() {
        this.canvas.width = this.canvas.parentElement.clientWidth;
        this.canvas.height = this.canvas.parentElement.clientHeight;
        this.requestRender();
    }

    setSceneGraph(graph) {
        const isFirst = !this.sceneGraph;
        const now = performance.now();

        // Track node entries for animation
        let nodes = graph.nodes || graph.Nodes || {};
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        const currentNodeIds = new Set(nodes.map(n => n.id));
        currentNodeIds.forEach(id => {
            if (!this.nodeEntryTimes.has(id)) this.nodeEntryTimes.set(id, now);
        });
        for (const id of this.nodeEntryTimes.keys()) {
            if (!currentNodeIds.has(id)) this.nodeEntryTimes.delete(id);
        }

        // Track edge entries
        let edges = graph.edges || graph.Edges || {};
        if (!Array.isArray(edges)) edges = Object.values(edges);
        const currentEdgeKeys = new Set();
        (Array.isArray(edges) ? edges : Object.values(edges)).forEach(e => {
            currentEdgeKeys.add((e.fromNodeId || '') + '→' + (e.toNodeId || ''));
        });
        currentEdgeKeys.forEach(key => {
            if (!this.edgeEntryTimes.has(key)) this.edgeEntryTimes.set(key, now);
        });
        for (const key of this.edgeEntryTimes.keys()) {
            if (!currentEdgeKeys.has(key)) this.edgeEntryTimes.delete(key);
        }

        this.sceneGraph = graph;
        if (isFirst) this.fitToView();
        this.requestRender();
    }

    fitToView() {
        if (!this.sceneGraph) return;
        let nodes = this.sceneGraph.nodes || this.sceneGraph.Nodes || [];
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        if (nodes.length === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        nodes.forEach(n => {
            if (!n.position) return;
            const r = (n.size || 10) + 20;
            if (n.position.x - r < minX) minX = n.position.x - r;
            if (n.position.y - r < minY) minY = n.position.y - r;
            if (n.position.x + r > maxX) maxX = n.position.x + r;
            if (n.position.y + r > maxY) maxY = n.position.y + r;
        });

        const graphW = maxX - minX || 1;
        const graphH = maxY - minY || 1;
        const padded = 0.85; // leave 15% padding
        const zoomX = (this.canvas.width * padded) / graphW;
        const zoomY = (this.canvas.height * padded) / graphH;
        this.camera.zoom = Math.min(zoomX, zoomY, 2.0);
        // Center on graph midpoint
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        this.camera.x = -cx * this.camera.zoom;
        this.camera.y = -cy * this.camera.zoom;
    }

    applyUpdate(update) {
        if (!this.sceneGraph) return;

        // Handle both camelCase and Go PascalCase field names
        const added = update.nodesAdded || update.NodesAdded || update.addedNodes || [];
        const removed = update.nodesRemoved || update.NodesRemoved || update.removedNodeIds || [];
        const addedEdges = update.edgesAdded || update.EdgesAdded || update.addedEdges || [];
        const removedEdges = update.edgesRemoved || update.EdgesRemoved || update.removedEdgeIds || [];

        // Ensure nodes is an object (map) -- the Go SceneGraph uses map[string]*SceneNode
        if (!this.sceneGraph.nodes) this.sceneGraph.nodes = {};
        if (Array.isArray(this.sceneGraph.nodes)) {
            // Convert array to map if needed
            const map = {};
            this.sceneGraph.nodes.forEach(n => { map[n.id || n.ID] = n; });
            this.sceneGraph.nodes = map;
        }

        added.forEach(n => { this.sceneGraph.nodes[n.id || n.ID] = n; });
        removed.forEach(id => { delete this.sceneGraph.nodes[id]; });

        if (!this.sceneGraph.edges) this.sceneGraph.edges = {};
        if (Array.isArray(this.sceneGraph.edges)) {
            const map = {};
            this.sceneGraph.edges.forEach(e => { map[e.id || e.ID] = e; });
            this.sceneGraph.edges = map;
        }

        addedEdges.forEach(e => { this.sceneGraph.edges[e.id || e.ID] = e; });
        removedEdges.forEach(id => { delete this.sceneGraph.edges[id]; });

        this.requestRender();
    }

    setGhostGraph(ghostGraph) {
        this.ghostGraph = ghostGraph;
        this.requestRender();
    }

    clearGhostGraph() {
        this.ghostGraph = null;
        this.requestRender();
    }

    resetView() {
        this.camera = { x: 0, y: 0, zoom: 1.0 };
        this.requestRender();
    }

    requestRender() {
        // Rendering happens in the animation loop
    }

    startAnimationLoop() {
        const loop = () => {
            this.render();
            this.particlePhase += 0.02;
            this.frameCount++;
            const now = performance.now();
            if (now - this.lastFPSTime > 1000) {
                this.fps = Math.round(this.frameCount * 1000 / (now - this.lastFPSTime));
                this.frameCount = 0;
                this.lastFPSTime = now;
            }
            this.animationFrame = requestAnimationFrame(loop);
        };
        loop();
    }

    render() {
        const { ctx, canvas, camera } = this;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Background gradient
        const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0, '#0a0a1a');
        grad.addColorStop(1, '#0e0e24');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        ctx.translate(canvas.width / 2 + camera.x, canvas.height / 2 + camera.y);
        ctx.scale(camera.zoom, camera.zoom);

        // Ghost overlay (translucent)
        if (this.ghostGraph) {
            ctx.globalAlpha = 0.25;
            this.drawGraph(this.ghostGraph, true);
            ctx.globalAlpha = 1.0;
        }

        // Main graph
        if (this.sceneGraph) {
            this.drawGraph(this.sceneGraph, false);
        }

        ctx.restore();
        this.drawHUD();
    }

    drawGraph(graph, isGhost) {
        const { ctx } = this;
        // Nodes/edges may be arrays or objects (Go maps serialize as JSON objects)
        let nodes = graph.nodes || graph.Nodes || [];
        let edges = graph.edges || graph.Edges || [];
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        if (!Array.isArray(edges)) edges = Object.values(edges);

        // Index nodes by ID for edge lookup
        const nodeMap = new Map();
        nodes.forEach(n => nodeMap.set(n.id, n));

        // Aggregate edges between same node pairs for traffic visualization
        const edgeTraffic = {};  // "from→to" → { count, totalGas, latestLabel, animated, color }
        edges.forEach(edge => {
            const key = (edge.fromNodeId || '') + '→' + (edge.toNodeId || '');
            if (!edgeTraffic[key]) {
                edgeTraffic[key] = { count: 0, totalGas: 0, label: '', animated: false, color: null, fromId: edge.fromNodeId, toId: edge.toNodeId };
            }
            edgeTraffic[key].count++;
            edgeTraffic[key].totalGas += (edge.gasCost || 0);
            edgeTraffic[key].label = edge.label || edge.function || edgeTraffic[key].label;
            if (edge.animated) edgeTraffic[key].animated = true;
            if (edge.color) edgeTraffic[key].color = edge.color;
        });

        // Draw aggregated edges -- one line per pair, thickness = traffic volume
        const now_e = performance.now();
        Object.values(edgeTraffic).forEach(traffic => {
            const from = nodeMap.get(traffic.fromId);
            const to = nodeMap.get(traffic.toId);
            if (!from || !to) return;
            if (!from.position || !to.position) return;

            // Edge entry animation (300ms grow from source to target)
            const edgeKey = (traffic.fromId || '') + '→' + (traffic.toId || '');
            const edgeEntry = this.edgeEntryTimes.get(edgeKey) || 0;
            const edgeAge = now_e - edgeEntry;
            const edgeT = Math.min(1, edgeAge / 300);

            const c = traffic.color || { r: 100, g: 150, b: 255, a: 200 };

            // Edge thickness grows with call count (min 2, max 12)
            const thickness = Math.min(12, 2 + traffic.count * 1.5);

            // Interpolated endpoint for entry animation
            const tx = from.position.x + (to.position.x - from.position.x) * edgeT;
            const ty = from.position.y + (to.position.y - from.position.y) * edgeT;

            // Edge glow based on traffic
            const glowSize = thickness + 6;
            ctx.beginPath();
            ctx.moveTo(from.position.x, from.position.y);
            ctx.lineTo(tx, ty);
            ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${0.15 * edgeT})`;
            ctx.lineWidth = glowSize;
            ctx.stroke();

            // Main edge line
            ctx.beginPath();
            ctx.moveTo(from.position.x, from.position.y);
            ctx.lineTo(tx, ty);
            ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${0.7 * edgeT})`;
            ctx.lineWidth = thickness;
            ctx.stroke();

            // Edge label with call count
            const midX = (from.position.x + to.position.x) / 2;
            const midY = (from.position.y + to.position.y) / 2 - thickness - 6;
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'center';
            const callLabel = traffic.count > 1
                ? `${traffic.label} (×${traffic.count})`
                : traffic.label;
            ctx.fillText(callLabel, midX, midY);

            // Gas cost label
            if (traffic.totalGas > 0) {
                ctx.fillStyle = '#f0a030';
                ctx.font = '9px monospace';
                ctx.fillText(`${traffic.totalGas.toLocaleString()} gas`, midX, midY + 14);
            }

            // Animated particles -- more particles for higher traffic
            if (traffic.animated && !isGhost) {
                const particleEdge = {
                    particleCount: Math.min(8, 2 + traffic.count),
                    particleSpeed: 1.5 + traffic.count * 0.3,
                    particleSize: Math.min(7, 3 + traffic.count * 0.5),
                };
                this.drawFlowParticle(from.position, to.position, particleEdge, c);
            }
        });

        // Count incoming edges per node for activity-based sizing
        const nodeActivity = {};
        Object.values(edgeTraffic).forEach(t => {
            nodeActivity[t.toId] = (nodeActivity[t.toId] || 0) + t.count;
            nodeActivity[t.fromId] = (nodeActivity[t.fromId] || 0) + t.count;
        });

        // Store computed data for hit testing and details panel
        if (!isGhost) {
            this._edgeTraffic = edgeTraffic;
            this._nodeActivity = nodeActivity;
            this._nodeMap = nodeMap;
        }

        // Draw nodes
        const now = performance.now();
        nodes.forEach(node => {
            if (!node.position) return;
            const activity = nodeActivity[node.id] || 0;

            // Entry animation (500ms scale-up + fade-in)
            const entryTime = this.nodeEntryTimes.get(node.id) || 0;
            const entryAge = now - entryTime;
            const entryT = Math.min(1, entryAge / 500);
            // Ease-out-back for overshoot bounce: t * (2.7*t - 1.7)
            const entryScale = entryT < 1 ? entryT * (2.7 * entryT * entryT - 1.7 * entryT + 1) : 1;
            const entryAlpha = Math.min(1, entryT * 2);

            // Pulse effect: size oscillates based on activity + time
            const pulseAmount = activity > 0 ? Math.sin(this.particlePhase * 3) * (2 + activity * 0.5) : 0;
            const activityBonus = Math.min(15, activity * 2);
            const baseSize = (node.size || 10) + activityBonus;
            const radius = (baseSize + pulseAmount) * entryScale * (this.selectedNode === node.id ? 1.3 : 1.0);

            const c = node.color || { r: 80, g: 200, b: 120, a: 255 };
            const alpha = (node.opacity || 1) * (c.a || 255) / 255 * entryAlpha;

            // Quarantine shake offset
            let sx = 0, sy = 0;
            if (node.quarantined && !isGhost) {
                sx = 3 * Math.sin(this.particlePhase * 20) * Math.cos(this.particlePhase * 7);
                sy = 3 * Math.sin(this.particlePhase * 23) * Math.sin(this.particlePhase * 11);
            }
            const nx = node.position.x + sx;
            const ny = node.position.y + sy;

            // Anomaly glow (pulsing red radial gradient)
            if (node.anomalyScore > 0 && !isGhost) {
                const glowR = radius + 20 * node.anomalyScore;
                const ga = 0.25 + 0.15 * Math.sin(this.particlePhase * 4);
                const grad = ctx.createRadialGradient(nx, ny, radius, nx, ny, glowR);
                grad.addColorStop(0, `rgba(255,87,34,${ga})`);
                grad.addColorStop(1, 'rgba(255,87,34,0)');
                ctx.beginPath();
                ctx.arc(nx, ny, glowR, 0, Math.PI * 2);
                ctx.fillStyle = grad;
                ctx.fill();
            }

            // Circuit breaker ring
            if (node.breakerState && !isGhost) {
                const ringR = radius + 6;
                let ringColor, ringPulse;
                if (node.breakerState === 'throttled') {
                    ringPulse = 0.4 + 0.3 * Math.sin(this.particlePhase * 2);
                    ringColor = `rgba(255,193,7,${ringPulse})`;
                } else if (node.breakerState === 'paused') {
                    ringPulse = 0.5 + 0.3 * Math.sin(this.particlePhase * 4);
                    ringColor = `rgba(255,152,0,${ringPulse})`;
                } else if (node.breakerState === 'frozen') {
                    ringPulse = 0.6 + 0.4 * Math.abs(Math.sin(this.particlePhase * 8));
                    ringColor = `rgba(244,67,54,${ringPulse})`;
                }
                if (ringColor) {
                    ctx.beginPath();
                    ctx.arc(nx, ny, ringR, 0, Math.PI * 2);
                    ctx.strokeStyle = ringColor;
                    ctx.lineWidth = 3;
                    ctx.setLineDash([4, 4]);
                    ctx.lineDashOffset = this.particlePhase * 20;
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            }

            // Activity glow ring
            const glow = node.glow || 0;
            if (activity > 0 || glow > 0) {
                const glowRadius = radius + 8 + activity * 2;
                const glowAlpha = Math.min(0.4, 0.1 + activity * 0.05 + glow * 0.3) * entryAlpha;
                ctx.beginPath();
                ctx.arc(nx, ny, glowRadius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${glowAlpha})`;
                ctx.fill();
            }

            // Hover/select glow
            if (this.hoveredNode === node.id || this.selectedNode === node.id) {
                ctx.beginPath();
                ctx.arc(nx, ny, radius + 6, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.2)`;
                ctx.fill();
            }

            // Node shape
            ctx.beginPath();
            if (node.shape === 'hexagon') {
                this.drawHexagon(ctx, nx, ny, radius);
            } else if (node.shape === 'diamond') {
                this.drawDiamond(ctx, nx, ny, radius);
            } else if (node.shape === 'rectangle') {
                ctx.rect(nx - radius, ny - radius * 0.6, radius * 2, radius * 1.2);
            } else {
                ctx.arc(nx, ny, radius, 0, Math.PI * 2);
            }
            ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
            ctx.fill();

            // Plan nodes get dashed borders
            if (node.kind === 'plan_timeline' || node.kind === 'plan_step') {
                ctx.setLineDash([4, 3]);
                ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${Math.min(alpha + 0.4, 1)})`;
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.setLineDash([]);
            } else {
                ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${Math.min(alpha + 0.3, 1)})`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // Quarantine dashed border
            if (node.quarantined) {
                ctx.beginPath();
                if (node.shape === 'hexagon') {
                    this.drawHexagon(ctx, nx, ny, radius + 3);
                } else {
                    ctx.arc(nx, ny, radius + 3, 0, Math.PI * 2);
                }
                ctx.strokeStyle = '#ff4444';
                ctx.lineWidth = 2;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Lock glyph for redacted/encrypted (disclosure-aware) nodes
            if ((node.redacted || node.zkIndicator) && !isGhost) {
                ctx.fillStyle = `rgba(230,230,240,${entryAlpha})`;
                ctx.font = `${Math.max(10, radius)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('\u{1F512}', nx, ny); // 🔒
                ctx.textBaseline = 'alphabetic';
            }

            // Label
            if (node.label && entryAlpha > 0.5) {
                ctx.fillStyle = `rgba(204,204,204,${entryAlpha})`;
                ctx.font = `${Math.max(9, 10 / this.camera.zoom)}px monospace`;
                ctx.textAlign = 'center';
                const label = node.label.length > 20 ? node.label.slice(0, 18) + '..' : node.label;
                ctx.fillText(label, nx, ny + radius + 14);
            }
        });
    }

    drawFlowParticle(from, to, edge, color) {
        const count = edge.particleCount || 3;
        const speed = edge.particleSpeed || 2;
        const size = edge.particleSize || 5;

        for (let i = 0; i < count; i++) {
            const t = ((this.particlePhase * speed + i / count) % 1);
            const x = from.x + (to.x - from.x) * t;
            const y = from.y + (to.y - from.y) * t;

            // Outer glow
            this.ctx.beginPath();
            this.ctx.arc(x, y, size + 4, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},0.2)`;
            this.ctx.fill();

            // Inner bright particle
            this.ctx.beginPath();
            this.ctx.arc(x, y, size, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(255,255,255,0.9)`;
            this.ctx.fill();

            // Core color
            this.ctx.beginPath();
            this.ctx.arc(x, y, size - 1, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},1.0)`;
            this.ctx.fill();
        }
    }

    drawHexagon(ctx, x, y, r) {
        ctx.moveTo(x + r, y);
        for (let i = 1; i <= 6; i++) {
            const angle = (Math.PI / 3) * i;
            ctx.lineTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
        }
        ctx.closePath();
    }

    drawDiamond(ctx, x, y, r) {
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
    }

    drawHUD() {
        // FPS counter (top-left, not affected by camera)
        this.ctx.fillStyle = '#444';
        this.ctx.font = '10px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(`${this.fps} FPS`, 8, 14);
    }

    setupInteraction() {
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            this.camera.zoom = Math.max(0.05, Math.min(20, this.camera.zoom * factor));
        });

        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.lastMouse = { x: e.clientX, y: e.clientY };
            const node = this.hitTestNode(e.clientX, e.clientY);
            if (node) {
                this.selectedNode = node.id;
                this.emit('nodeSelected', node);
            } else {
                this.selectedNode = null;
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                this.camera.x += e.clientX - this.lastMouse.x;
                this.camera.y += e.clientY - this.lastMouse.y;
                this.lastMouse = { x: e.clientX, y: e.clientY };
            } else {
                const node = this.hitTestNode(e.clientX, e.clientY);
                this.hoveredNode = node ? node.id : null;
                if (node) {
                    this.hoveredEdge = null;
                    this.emit('nodeHovered', node);
                } else {
                    const edge = this.hitTestEdge(e.clientX, e.clientY);
                    this.hoveredEdge = edge;
                    if (edge) this.emit('edgeHovered', edge);
                }
            }
        });

        this.canvas.addEventListener('mouseup', () => { this.isDragging = false; });
        this.canvas.addEventListener('mouseleave', () => { this.isDragging = false; });
    }

    hitTestNode(clientX, clientY) {
        if (!this.sceneGraph || !this.sceneGraph.nodes) return null;
        const rect = this.canvas.getBoundingClientRect();
        const cx = (clientX - rect.left - this.canvas.width / 2 - this.camera.x) / this.camera.zoom;
        const cy = (clientY - rect.top - this.canvas.height / 2 - this.camera.y) / this.camera.zoom;

        let nodes = this.sceneGraph.nodes;
        if (!Array.isArray(nodes)) nodes = Object.values(nodes);
        for (const node of nodes) {
            if (!node.position) continue;
            const dx = cx - node.position.x;
            const dy = cy - node.position.y;
            const r = (node.size || 10) + 5;
            if (dx * dx + dy * dy <= r * r) return node;
        }
        return null;
    }

    hitTestEdge(clientX, clientY) {
        if (!this._edgeTraffic || !this._nodeMap) return null;
        const rect = this.canvas.getBoundingClientRect();
        const mx = (clientX - rect.left - this.canvas.width / 2 - this.camera.x) / this.camera.zoom;
        const my = (clientY - rect.top - this.canvas.height / 2 - this.camera.y) / this.camera.zoom;
        const threshold = 10 / this.camera.zoom;

        let closest = null, closestDist = threshold;
        for (const traffic of Object.values(this._edgeTraffic)) {
            const from = this._nodeMap.get(traffic.fromId);
            const to = this._nodeMap.get(traffic.toId);
            if (!from || !to || !from.position || !to.position) continue;

            const d = this._distToSegment(mx, my,
                from.position.x, from.position.y,
                to.position.x, to.position.y);
            if (d < closestDist) {
                closestDist = d;
                closest = traffic;
            }
        }
        return closest;
    }

    _distToSegment(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
        return Math.sqrt((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2);
    }

    getNodeStats(nodeId) {
        const activity = this._nodeActivity ? (this._nodeActivity[nodeId] || 0) : 0;
        let inbound = 0, outbound = 0, totalGas = 0;
        if (this._edgeTraffic) {
            Object.values(this._edgeTraffic).forEach(t => {
                if (t.toId === nodeId) { inbound += t.count; totalGas += t.totalGas; }
                if (t.fromId === nodeId) { outbound += t.count; totalGas += t.totalGas; }
            });
        }
        return { activity, inbound, outbound, totalGas };
    }

    on(event, callback) {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
        this.eventHandlers.get(event).push(callback);
    }

    emit(event, data) {
        (this.eventHandlers.get(event) || []).forEach(cb => cb(data));
    }

    getStats() {
        let nodeCount = 0, edgeCount = 0;
        if (this.sceneGraph) {
            const n = this.sceneGraph.nodes || this.sceneGraph.Nodes;
            const e = this.sceneGraph.edges || this.sceneGraph.Edges;
            nodeCount = n ? (Array.isArray(n) ? n.length : Object.keys(n).length) : 0;
            edgeCount = e ? (Array.isArray(e) ? e.length : Object.keys(e).length) : 0;
        }
        return { nodes: nodeCount, edges: edgeCount, fps: this.fps, zoom: this.camera.zoom.toFixed(2) };
    }

    destroy() {
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    }
}

  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  ns.CinemaRenderer = CinemaRenderer;
  if (typeof module !== 'undefined' && module.exports) module.exports = { CinemaRenderer };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
