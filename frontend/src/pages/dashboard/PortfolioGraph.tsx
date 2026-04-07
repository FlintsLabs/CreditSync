import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/Card';
import { Badge } from '../../components/ui/badge';
import { useTheme } from '../../components/theme-provider';
import { Focus, ListFilter } from 'lucide-react';
import * as d3 from 'd3';

// --- Improved Mock Data Generation ---
const BANKS = [
    { id: 'bank-1', name: 'KBank', fullName: 'KBank (Commercial)', color: '#00cc33', type: 'bank', val: 30 },
    { id: 'bank-2', name: 'TTB', fullName: 'TTB (Personal)', color: '#0056ff', type: 'bank', val: 25 },
    { id: 'bank-3', name: 'SCB', fullName: 'SCB (Speedy)', color: '#4e2a84', type: 'bank', val: 28 },
];

const generateGraphData = () => {
    const borrowers = Array.from({ length: 80 }).map((_, i) => {
        const groupIndex = Math.floor(Math.random() * BANKS.length);
        const bank = BANKS[groupIndex];
        const status = Math.random() > 0.8 ? 'Watch' : 'Healthy';
        const debt = Math.floor(Math.random() * 90000) + 10000;

        return {
            id: `borrower-${i}`,
            name: `User ${i + 1}`,
            type: 'borrower',
            val: Math.sqrt(debt) / 20, // Size based on debt
            group: bank.id,
            status: status,
            debt: debt,
            color: status === 'Watch' ? '#f59e0b' : '#3b82f6',
        };
    });

    // Calculate total debt for each bank to scale its size
    const bankDebtMap = borrowers.reduce((acc, b) => {
        acc[b.group] = (acc[b.group] || 0) + b.debt;
        return acc;
    }, {} as Record<string, number>);

    const bankNodes = BANKS.map(bank => {
        const total = bankDebtMap[bank.id] || 0;
        // Scale bank size similar to borrowers (sqrt scaling)
        // Ensure a minimum size so it doesn't disappear if empty
        const size = Math.max(25, Math.sqrt(total) / 20);
        return { ...bank, val: size, debt: total };
    });

    const nodes = [...bankNodes, ...borrowers];
    const links = borrowers.map((b: any) => ({
        source: b.group,
        target: b.id,
        amount: b.debt,
    }));

    return { nodes, links };
};

// --- Minimap Component ---
const GraphMinimap = ({ graphRef, data, width = 120, height = 120, className }: { graphRef: React.RefObject<ForceGraphMethods>, data: { nodes: any[], links: any[] }, width?: number, height?: number, className?: string }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const { theme } = useTheme();

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;

        const render = () => {
            // Clear
            ctx.clearRect(0, 0, width, height);

            // Safety checks
            if (!graphRef.current || !data.nodes.length) {
                animationFrameId = requestAnimationFrame(render);
                return;
            }

            // 1. Calculate World Bounds (Nodes)
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            // Scan mostly active nodes (or all). For performance, checking all is fine for <100 nodes.
            // If huge, we might cache this, but this is a small graph.
            data.nodes.forEach((n: any) => {
                if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
                    minX = Math.min(minX, n.x);
                    maxX = Math.max(maxX, n.x);
                    minY = Math.min(minY, n.y);
                    maxY = Math.max(maxY, n.y);
                }
            });

            // Add some padding to world bounds
            const padding = 50;
            minX -= padding; maxX += padding;
            minY -= padding; maxY += padding;
            const worldW = maxX - minX || 1;
            const worldH = maxY - minY || 1;

            // Scale to Minimap
            const scaleX = width / worldW;
            const scaleY = height / worldH;
            const scale = Math.min(scaleX, scaleY) * 0.8; // fit inside 80%

            const offsetX = (width - worldW * scale) / 2;
            const offsetY = (height - worldH * scale) / 2;

            const toMinimap = (x: number, y: number) => ({
                x: (x - minX) * scale + offsetX,
                y: (y - minY) * scale + offsetY
            });

            // 2. Draw Nodes
            data.nodes.forEach((n: any) => {
                if (!Number.isFinite(n.x)) return;
                const pos = toMinimap(n.x, n.y);
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, n.type === 'bank' ? 2 : 1, 0, 2 * Math.PI);
                ctx.fillStyle = n.type === 'bank' ? n.color : (theme === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)');
                ctx.fill();
            });

            // 3. Draw Viewport Rect
            try {
                // Get current view transform
                // const k = graphRef.current.zoom(); // Removed unused var
                // @ts-ignore
                const center = graphRef.current.centerAt(); // {x, y} center of view in graph coords

                // Assuming the graph container size. We need to pass this or approximate.
                // Let's assume passed via props or context, or use a fixed reference frame if consistent.
                // Actually, k = screenPixels / graphUnits.
                // viewportWidthInGraph = screenWidth / k
                // viewportHeightInGraph = screenHeight / k
                // We can try to access the canvas element dimensions from the graphRef? 
                // Or just assume a standard aspect or get it from parent props.
                // For now let's use a rough estimate if sizing isn't passed, 
                // BUT better to get the actual canvas dims if possible.
                // We can't easily get canvas dims from `graphRef` directly in all versions.
                // We'll rely on the parent updating us? Or just use a fixed assumption for now.
                // Let's parse the container dimensions if passed.

                // Let's try to get simple BoundingBox of view using screen2GraphCoords if available
                const topLeft = graphRef.current.screen2GraphCoords ? graphRef.current.screen2GraphCoords(0, 0) : null;
                const botRight = graphRef.current.screen2GraphCoords ? graphRef.current.screen2GraphCoords(window.innerWidth, window.innerHeight) : null;
                // Using window.innerWidth is risky if not full screen. 
                // Let's use `graphRef.current.centerAt()` approach with a "guessed" canvas size for now or improve later.
                // Since `centerAt` gives the center, we need the "radius" of the view.

                if (topLeft && botRight) {
                    const tl = toMinimap(topLeft.x, topLeft.y);
                    const br = toMinimap(botRight.x, botRight.y);

                    ctx.strokeStyle = theme === 'dark' ? '#3b82f6' : '#2563eb';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

                    // Semi-transparent fill
                    ctx.fillStyle = theme === 'dark' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(37, 99, 235, 0.1)';
                    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
                } else {
                    // Fallback if screen2Graph not avail: use center point + zoom
                    // This is harder without exact container size. 
                    // Let's draw a crosshair at center at least.
                    const c = toMinimap(center.x, center.y);
                    ctx.strokeStyle = 'red';
                    ctx.beginPath();
                    ctx.moveTo(c.x - 5, c.y); ctx.lineTo(c.x + 5, c.y);
                    ctx.moveTo(c.x, c.y - 5); ctx.lineTo(c.x, c.y + 5);
                    ctx.stroke();
                }

            } catch (e) {
                // Ignore during init
            }

            animationFrameId = requestAnimationFrame(render);
        };

        render();

        return () => {
            cancelAnimationFrame(animationFrameId);
        };
    }, [data, graphRef, width, height, theme]);

    return (
        <canvas
            ref={canvasRef}
            width={width}
            height={height}
            className={`border rounded bg-black/5 dark:bg-white/5 backdrop-blur shadow-sm ${className}`}
        />
    );
};

export default function PortfolioGraph() {
    const graphRef = useRef<ForceGraphMethods>(null as any);
    const [allData, setAllData] = useState<{ nodes: any[], links: any[] }>({ nodes: [], links: [] });
    const [dimensions, setDimensions] = useState({ w: 800, h: 600 });
    const containerRef = useRef<HTMLDivElement>(null);
    const { theme } = useTheme();
    const [isMounted, setIsMounted] = useState(false);

    // Filters
    const [filterSource, setFilterSource] = useState<string>('all');
    const [filterStatus, setFilterStatus] = useState<string>('all');
    const [minDebt, setMinDebt] = useState<number>(0);
    const [isFilterOpen, setIsFilterOpen] = useState(false);

    // Auto-open filters on desktop
    useEffect(() => {
        if (window.innerWidth >= 768) {
            setIsFilterOpen(true);
        }
    }, []);

    useEffect(() => {
        setIsMounted(true);
        setAllData(generateGraphData());
    }, []);

    useEffect(() => {
        const handleResize = () => {
            if (containerRef.current) {
                setDimensions({
                    w: containerRef.current.clientWidth,
                    h: containerRef.current.clientHeight || 700
                });
            }
        };
        window.addEventListener('resize', handleResize);
        setTimeout(handleResize, 100);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Adjust Physics Forces when data or graph connects
    useEffect(() => {
        if (graphRef.current) {
            // Repulsion Force (Charge) - Low repulsion for high density
            graphRef.current.d3Force('charge')?.strength(-20);

            // Link Force - Very tight
            graphRef.current.d3Force('link')?.distance(30);

            // Center Force - Pull everything to center
            // graphRef.current.d3Force('center')?.strength(1.0); // Disable standard center to allow box filling

            // Collision Force - The "Bubble" effect
            graphRef.current.d3Force('collide', d3.forceCollide((node: any) => {
                if (node.type === 'bank') return (node.val || 25) + 5;
                return (node.val || 5) + 1;
            }).strength(1));

            // --- Custom Boundary Force (The "Frame") ---
            // Keeps nodes inside the visible canvas area with a "bounce" effect
            const forceBoundary = (w: number, h: number) => {
                let nodes: any[] = [];
                const padding = 60; // Keep away from very edges
                const minX = -w / 2 + padding;
                const maxX = w / 2 - padding;
                const minY = -h / 2 + padding;
                const maxY = h / 2 - padding;

                function force(alpha: number) {
                    for (const node of nodes) {
                        // "Rubber Wall" effect: push back strongly if out of bounds
                        if (node.x < minX) node.vx += (minX - node.x) * 1 * alpha;
                        if (node.x > maxX) node.vx += (maxX - node.x) * 1 * alpha;
                        if (node.y < minY) node.vy += (minY - node.y) * 1 * alpha;
                        if (node.y > maxY) node.vy += (maxY - node.y) * 1 * alpha;
                    }
                }
                force.initialize = (n: any[]) => { nodes = n; };
                return force;
            };

            // Register the box force
            graphRef.current.d3Force('box', forceBoundary(dimensions.w, dimensions.h));

            // Adjust center force to be weaker since we have a box now
            // Or keep it to ensure centering, but the box is better for "filling"
            graphRef.current.d3Force('center')?.strength(0.1);
        }
    }, [isMounted, allData, dimensions]);

    // Filter Logic
    const filteredData = useMemo(() => {
        if (!allData.nodes.length) return { nodes: [], links: [] };

        let activeNodes = allData.nodes.filter(node => {
            if (node.type === 'bank') {
                if (filterSource !== 'all' && node.id !== filterSource) return false;
                return true;
            }
            // Borrower filters
            if (filterSource !== 'all' && node.group !== filterSource) return false;
            if (filterStatus !== 'all' && node.status !== filterStatus) return false;
            if (node.debt < minDebt) return false;
            return true;
        });

        // Re-link valid nodes
        const activeNodeIds = new Set(activeNodes.map(n => n.id));
        const activeLinks = allData.links.filter(link =>
            activeNodeIds.has(typeof link.source === 'object' ? link.source.id : link.source) &&
            activeNodeIds.has(typeof link.target === 'object' ? link.target.id : link.target)
        );

        return { nodes: activeNodes, links: activeLinks };
    }, [allData, filterSource, filterStatus, minDebt]);

    const handleResetView = useCallback(() => {
        if (graphRef.current) {
            // Updated Zoom Fit for tighter view
            graphRef.current.zoomToFit(800, 20);
        }
    }, []);


    if (!isMounted) {
        return (
            <Card className="col-span-4 h-full border-zinc-800 bg-zinc-950/50 backdrop-blur-xl">
                <CardContent className="p-10 flex items-center justify-center min-h-[500px]">
                    <div className="flex flex-col items-center gap-2">
                        <span className="relative flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                        </span>
                        <span className="text-zinc-500 text-sm animate-pulse">Initializing Visualization Engine...</span>
                    </div>
                </CardContent>
            </Card>
        )
    }

    return (
        <Card className="col-span-4 h-full border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-950/50 backdrop-blur-xl overflow-hidden relative group">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 z-10 relative pointer-events-none">
                <div>
                    <CardTitle className="text-xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:via-indigo-400 dark:to-purple-500 bg-clip-text text-transparent">
                        Portfolio Network
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">Real-time force-directed graph</p>
                </div>
                <div className="flex gap-2 pointer-events-auto">
                    <Badge variant="outline" className="text-foreground border-border bg-background/40 backdrop-blur">
                        {filteredData.nodes.filter(n => n.type === 'borrower').length} Borrowers
                    </Badge>
                    <Badge variant="outline" className="text-foreground border-border bg-background/40 backdrop-blur">
                        {filteredData.links.length} Connections
                    </Badge>
                </div>
            </CardHeader>

            <CardContent className="p-0 relative min-h-[700px]" ref={containerRef}>

                {/* === GLASSMORPHISM CONTROL PANEL === */}
                {/* Toggle Button (Visible always, but useful mainly on mobile) */}
                <button
                    onClick={() => setIsFilterOpen(!isFilterOpen)}
                    className="absolute top-4 right-4 z-30 p-2 bg-white/80 dark:bg-zinc-900/60 backdrop-blur-xl rounded-full border border-zinc-200 dark:border-white/10 shadow-lg transition-all hover:scale-105 active:scale-95 text-foreground"
                >
                    <ListFilter size={20} />
                </button>

                {/* Filter Panel */}
                <div className={`absolute top-16 right-4 z-20 w-64 bg-white/80 dark:bg-zinc-900/60 backdrop-blur-xl border border-zinc-200 dark:border-white/10 p-4 rounded-xl shadow-2xl transition-all duration-300 origin-top-right ${isFilterOpen ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 -translate-y-4 pointer-events-none'}`}>
                    <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
                        <span className="text-sm font-semibold text-foreground">Filters</span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Config</span>
                    </div>

                    <div className="space-y-4">
                        {/* Source Filter */}
                        <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground flex items-center gap-1">
                                🏦 Source Fund
                            </label>
                            <select
                                value={filterSource}
                                onChange={(e) => setFilterSource(e.target.value)}
                                className="w-full bg-background border border-input rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                            >
                                <option value="all">All Sources</option>
                                {BANKS.map(b => (
                                    <option key={b.id} value={b.id}>{b.name}</option>
                                ))}
                            </select>
                        </div>

                        {/* Status Filter */}
                        <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground flex items-center gap-1">
                                ⚡ Borrower Status
                            </label>
                            <div className="grid grid-cols-3 gap-1">
                                {['all', 'Healthy', 'Watch'].map((status) => (
                                    <button
                                        key={status}
                                        onClick={() => setFilterStatus(status)}
                                        className={`text-[10px] px-2 py-1 rounded border transition-all ${filterStatus === status
                                            ? 'bg-primary/10 border-primary/50 text-primary shadow-sm'
                                            : 'bg-transparent border-input text-muted-foreground hover:border-primary/30'
                                            }`}
                                    >
                                        {status}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Debt Slider */}
                        <div className="space-y-2">
                            <div className="flex justify-between text-xs text-muted-foreground">
                                <label className="flex items-center gap-1">🔍 Min Debt</label>
                                <span className="text-primary font-mono">฿{minDebt.toLocaleString()}</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="100000"
                                step="5000"
                                value={minDebt}
                                onChange={(e) => setMinDebt(Number(e.target.value))}
                                className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary hover:accent-primary/80"
                            />
                        </div>
                    </div>
                </div>

                {/* === GRAPH ENGINE === */}
                {allData.nodes.length > 0 && typeof window !== 'undefined' && (
                    <ForceGraph2D
                        ref={graphRef}
                        width={dimensions.w}
                        height={dimensions.h}
                        graphData={filteredData}
                        nodeLabel="name"
                        nodeRelSize={8}
                        linkColor={() => theme === 'dark' ? '#334155' : '#cbd5e1'}
                        linkWidth={1}
                        linkDirectionalParticles={1}
                        linkDirectionalParticleSpeed={0.005}
                        linkDirectionalParticleWidth={1.5}
                        d3VelocityDecay={0.1} // Lower friction to let bounds work
                        warmupTicks={50} // Shorter warmup
                        backgroundColor={theme === 'dark' ? '#09090b' : '#ffffff'}
                        onEngineStop={() => {
                            if (filteredData.nodes.length > 0) {
                                graphRef.current?.zoomToFit(400, 50);
                            }
                        }}
                        onNodeClick={(node: any) => {
                            if (node.x && node.y) {
                                graphRef.current?.centerAt(node.x, node.y, 1000);
                                graphRef.current?.zoom(3, 2000);
                            }
                        }}
                        nodeCanvasObject={(node: any, ctx, globalScale) => {
                            // Safety check for coordinates
                            if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;

                            const label = node.name;
                            const fontSize = 12 / globalScale;
                            ctx.font = `${fontSize}px Sans-Serif`;

                            if (node.type === 'bank') {
                                // Drawing Bank Node (Dynamic Size)
                                const radius = node.val || 25;

                                // 1. Large Ambient Aura (Background Gradient)
                                try {
                                    const auraSize = radius * 4; // Large area
                                    // Start from center (0) to ensure visibility, fading out to 4x radius
                                    const aura = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, auraSize);
                                    aura.addColorStop(0, `${node.color}40`); // Increased opacity ~25%
                                    aura.addColorStop(1, 'transparent');
                                    ctx.fillStyle = aura;
                                    ctx.beginPath();
                                    ctx.arc(node.x, node.y, auraSize, 0, 2 * Math.PI);
                                    ctx.fill();
                                } catch (e) { }

                                // 2. Inner Glow (Highlight)
                                const glowSize = radius * 1.4;
                                try {
                                    const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowSize);
                                    gradient.addColorStop(0, `${node.color}80`); // 50% opacity
                                    gradient.addColorStop(1, 'transparent');
                                    ctx.fillStyle = gradient;
                                    ctx.beginPath();
                                    ctx.arc(node.x, node.y, glowSize, 0, 2 * Math.PI);
                                    ctx.fill();
                                } catch (e) { }

                                // 3. Core Node Circle
                                ctx.beginPath();
                                ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
                                ctx.fillStyle = node.color;
                                ctx.fill();

                                // Text (Label)
                                ctx.fillStyle = theme === 'dark' ? '#fff' : '#000';
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'middle';
                                // Position text below the node
                                const fontSize = Math.max(12, radius * 0.4);
                                ctx.font = `bold ${fontSize}px Sans-Serif`;
                                ctx.fillText(label, node.x, node.y);

                                // Optional: Show total debt inside or below?
                                // Let's keep it simple with just Name inside for now, or Name centered.
                                // Re-centering name to middle of bubble (like borrowers)
                                // ctx.fillText(label, node.x, node.y + radius + 14); // Old behavior
                            } else {
                                // Drawing Borrower Node
                                ctx.beginPath();
                                ctx.arc(node.x, node.y, node.val, 0, 2 * Math.PI, false);
                                ctx.fillStyle = node.color;
                                ctx.fill();

                                // Status Ring for Watch
                                if (node.status === 'Watch') {
                                    ctx.strokeStyle = '#ef4444';
                                    ctx.lineWidth = 1 / globalScale;
                                    ctx.stroke();
                                }

                                // Draw Value (Debt)
                                // Format: 10k, 1.5M etc.
                                const valStr = new Intl.NumberFormat('en-US', {
                                    notation: "compact",
                                    maximumFractionDigits: 1
                                }).format(node.debt);

                                // Font size proportional to radius (0.4x radius usually fits 4-5 chars)
                                const fontSize = node.val * 0.4;

                                // Only draw if text would be visible on screen
                                // globalScale represents pixels per graph-unit
                                if (fontSize * globalScale > 2.5) {
                                    ctx.font = `500 ${fontSize}px Sans-Serif`;
                                    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                                    ctx.textAlign = 'center';
                                    ctx.textBaseline = 'middle';
                                    ctx.fillText(valStr, node.x, node.y);
                                }
                            }
                        }}
                    />
                )}

                {/* Simple Legend */}
                <div className="absolute bottom-4 left-4 flex flex-col gap-2 p-3 bg-white/80 dark:bg-zinc-900/60 backdrop-blur rounded-lg border border-zinc-200 dark:border-white/5 shadow-xl transition-all hover:bg-white/90 dark:hover:bg-zinc-900/80">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">Source Nodes</div>
                    {BANKS.map(b => (
                        <div key={b.id} className="flex items-center gap-2 text-xs text-foreground">
                            <span className="w-2 h-2 rounded-full shadow-[0_0_8px]" style={{ backgroundColor: b.color, boxShadow: `0 0 8px ${b.color}` }}></span>
                            {b.name}
                        </div>
                    ))}
                    <div className="h-px bg-border my-1"></div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-1">Status</div>
                    <div className="flex items-center gap-2 text-xs text-foreground">
                        <span className="w-2 h-2 rounded-full bg-blue-500"></span> Healthy
                    </div>
                    <div className="flex items-center gap-2 text-xs text-foreground">
                        <span className="w-2 h-2 rounded-full bg-amber-500"></span> Watch List
                    </div>
                </div>

                {/* Minimap */}
                <GraphMinimap
                    graphRef={graphRef}
                    data={filteredData}
                    className="absolute bottom-4 right-4 z-20 pointer-events-none"
                />

                {/* Reset View Button */}
                <button
                    onClick={handleResetView}
                    className="absolute bottom-36 right-4 z-30 p-2 bg-white/80 dark:bg-zinc-800/80 hover:bg-white dark:hover:bg-zinc-700 backdrop-blur rounded-full border border-zinc-200 dark:border-white/10 text-foreground shadow-lg transition-all transform hover:scale-105 active:scale-95"
                    title="Reset View"
                >
                    <Focus size={18} />
                </button>

                {/* Add Borrower Button */}


            </CardContent>
        </Card>
    );
}
