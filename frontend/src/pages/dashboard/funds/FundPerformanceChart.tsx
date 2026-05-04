import { ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Area } from 'recharts';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { cn } from "../../../lib/utils";
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from "../../../lib/api";

// Realistic Data Simulation
const generateRealisticData = () => {
    let currentLiability = 100000; // Starting Debt (30k + 70k)
    const monthlyInterestRate = 0.005; // ~6% p.a.
    const baseBankPayment = 6700; // Fixed Installment (Sum of loans)

    const months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];

    const data = [];
    const years = [2023, 2024, 2025];

    for (const year of years) {
        for (const month of months) {
            // 1. Calculate Interest for the month
            const interest = currentLiability * monthlyInterestRate;

            // 2. Bank Payment (Outflow) - slightly variable
            const paymentToBank = baseBankPayment;

            // 3. Principal Repayment component
            const principalRepayment = paymentToBank - interest;

            // 4. Reduce Liability (Amortization)
            // Ensure liability doesn't go below 0
            currentLiability = Math.max(0, currentLiability - principalRepayment);

            // 5. Collections (Inflow - Actual) - Variable (Seasonality + Randomness)
            // Expecting ~1.35x of payment (Profit) but with +/- 20% variance
            const variability = 0.8 + Math.random() * 0.4; // 0.8 to 1.2

            // 6. Expected Collection (Target) - consistently higher than outflow
            const expectedCollection = Math.round(paymentToBank * 1.5);

            let collectedFromBorrowers = expectedCollection * variability; // Actual is relative to expected

            // Simulate a "bad month" dip occasionally
            if (Math.random() > 0.8) collectedFromBorrowers *= 0.6;

            data.push({
                name: `${month} ${year}`,
                year,
                liability: Math.round(currentLiability),
                paymentToBank: Math.round(paymentToBank),
                collectedFromBorrowers: Math.round(collectedFromBorrowers),
                expectedCollection: Math.round(expectedCollection),
            });
        }
    }
    return data;
};

const fallbackData = generateRealisticData();

// ... CustomTooltip component remains same ...
const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        return (
            <div className="rounded-xl border border-border/50 bg-background/95 p-4 shadow-xl backdrop-blur-md ring-1 ring-black/5">
                <p className="mb-2 text-sm font-semibold text-foreground">{label}</p>
                <div className="space-y-1">
                    {payload.map((entry: any, index: number) => (
                        <div key={index} className="flex items-center gap-2 text-xs">
                            <div
                                className="h-2 w-2 rounded-full shadow-[0_0_8px_currentColor]"
                                style={{ backgroundColor: entry.color, color: entry.color }}
                            />
                            <span className="text-muted-foreground w-28">{entry.name}:</span>
                            <span className="font-mono font-medium text-foreground">
                                ฿{entry.value.toLocaleString()}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    return null;
};

export function FundPerformanceChart() {
    const { t } = useTranslation();
    const [selectedYears, setSelectedYears] = useState<number[]>([2024]);
    const [allData, setAllData] = useState(fallbackData);
    const availableYears = [2023, 2024, 2025];

    useEffect(() => {
        api.get("/analytics/fund-performance")
            .then((res) => {
                if (Array.isArray(res.data) && res.data.length > 0) {
                    setAllData(res.data);
                }
            })
            .catch((error) => {
                console.error("Failed to load fund performance data", error);
            });
    }, []);

    const handleYearToggle = (year: number) => {
        setSelectedYears(prev =>
            prev.includes(year)
                ? prev.filter(y => y !== year)
                : [...prev, year].sort()
        );
    };

    const filteredData = allData.filter(d => selectedYears.includes(d.year));

    return (
        <Card className="col-span-4 overflow-hidden border-border/40 shadow-sm transition-all hover:shadow-md">
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div className="space-y-1">
                        <CardTitle className="text-xl font-semibold tracking-tight">{t("chart.financial_performance")}</CardTitle>
                        <CardDescription>
                            {t("chart.subtitle")}
                        </CardDescription>
                    </div>
                    <div className="flex gap-2">
                        {availableYears.map(year => (
                            <Badge
                                key={year}
                                variant={selectedYears.includes(year) ? "default" : "outline"}
                                className={cn(
                                    "cursor-pointer transition-all hover:opacity-80",
                                    selectedYears.includes(year)
                                        ? "bg-primary text-primary-foreground shadow-md"
                                        : "text-muted-foreground hover:bg-muted"
                                )}
                                onClick={() => handleYearToggle(year)}
                            >
                                {year}
                            </Badge>
                        ))}
                    </div>
                </div>
            </CardHeader>
            <CardContent className="pl-0 pb-2">
                <div className="h-[400px] w-full mt-4">
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={filteredData} margin={{ top: 10, right: 30, left: 20, bottom: 0 }}>
                            <defs>
                                {/* Gradient for Liability Area */}
                                <linearGradient id="colorLiability" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.2} />
                                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                                </linearGradient>

                                {/* Gradient for Collections Bar */}
                                <linearGradient id="colorCollections" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.9} />
                                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.4} />
                                </linearGradient>

                                {/* Gradient for Payment Line Shadow (Simulated) */}
                                <filter id="glow" height="130%">
                                    <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
                                    <feOffset dx="0" dy="0" result="offsetblur" />
                                    <feFlood floodColor="#f59e0b" floodOpacity="0.5" />
                                    <feComposite in2="offsetblur" operator="in" />
                                    <feMerge>
                                        <feMergeNode />
                                        <feMergeNode in="SourceGraphic" />
                                    </feMerge>
                                </filter>
                            </defs>

                            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--muted-foreground))" opacity={0.1} />

                            <XAxis
                                dataKey="name"
                                stroke="hsl(var(--muted-foreground))"
                                fontSize={12}
                                tickLine={false}
                                axisLine={false}
                                dy={10}
                            />

                            <YAxis
                                yAxisId="left"
                                stroke="hsl(var(--muted-foreground))"
                                fontSize={11}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(value) => `฿${value / 1000}k`}
                                dx={-10}
                            />

                            <YAxis
                                yAxisId="right"
                                orientation="right"
                                stroke="hsl(var(--muted-foreground))"
                                fontSize={11}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(value) => `฿${value / 1000}k`}
                                dx={10}
                            />

                            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--muted)/0.2)' }} />

                            {/* 1. Liability (Area + Line) */}
                            <Area
                                yAxisId="right"
                                type="monotone"
                                dataKey="liability"
                                name={t("chart.liability")}
                                stroke="#f43f5e"
                                strokeWidth={2}
                                fillOpacity={1}
                                fill="url(#colorLiability)"
                            />

                            {/* 2. Collections (Bar) */}
                            <Bar
                                yAxisId="left"
                                dataKey="collectedFromBorrowers"
                                name={t("chart.collections")}
                                fill="url(#colorCollections)"
                                radius={[6, 6, 0, 0]}
                                barSize={32}
                            />

                            {/* 3. Expected Collection (Dashed Line) */}
                            <Line
                                yAxisId="left"
                                type="step"
                                dataKey="expectedCollection"
                                name={t("chart.expected")}
                                stroke="#3b82f6"
                                strokeWidth={2}
                                strokeDasharray="4 4"
                                dot={false}
                            />

                            {/* 4. Payment to Bank (Solid Line) */}
                            <Line
                                yAxisId="left"
                                type="monotone"
                                dataKey="paymentToBank"
                                name={t("chart.bank_payment")}
                                stroke="#f59e0b"
                                strokeWidth={3}
                                dot={{ r: 4, fill: "#f59e0b", strokeWidth: 2, stroke: "hsl(var(--background))" }}
                                activeDot={{ r: 6, fill: "#f59e0b" }}
                                filter="url(#glow)"
                            />

                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
            <div className="border-t bg-muted/20 p-4">
                <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                        <span className="text-muted-foreground">
                            <span className="font-semibold text-foreground">{t("chart.collections")}</span>: {t("chart.inflow_desc")}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"></div>
                        <span className="text-muted-foreground">
                            <span className="font-semibold text-foreground">{t("chart.liability")}</span>: {t("chart.liability_desc")}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"></div>
                        <span className="text-muted-foreground">
                            <span className="font-semibold text-foreground">{t("chart.bank_payment")}</span>: {t("chart.outflow_desc")}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-blue-500"></div>
                        <span className="text-muted-foreground">
                            <span className="font-semibold text-foreground">{t("chart.expected")} (Target)</span>: {t("chart.expected_desc")}
                        </span>
                    </div>
                </div>
            </div>
        </Card >
    );
}
