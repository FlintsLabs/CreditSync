import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/Card";
import { Badge } from "../../components/ui/badge";
import {
    ComposedChart,
    Area,
    Bar,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer
} from 'recharts';

// Multi-select year filter Component placeholder (for Shadcn styling)
// In a real app we would use Checkbox or a MultiSelect component
const AVAILABLE_YEARS = [2023, 2024, 2025];

// Mock Data matching the requirements:
// 1. Inflow (Collections) - Bar
// 2. Outflow (Payment) - Line
// 3. Liability (Debt) - Area (Amortization)
const RAW_DATA = [
    { year: 2023, month: 'Jan', inflow: 15000, outflow: 8000, liability: 150000 },
    { year: 2023, month: 'Feb', inflow: 16000, outflow: 8000, liability: 145000 },
    { year: 2023, month: 'Mar', inflow: 15500, outflow: 8000, liability: 138000 },
    { year: 2023, month: 'Apr', inflow: 17000, outflow: 8000, liability: 130000 },
    { year: 2023, month: 'May', inflow: 18000, outflow: 8000, liability: 121000 },
    { year: 2023, month: 'Jun', inflow: 18500, outflow: 8000, liability: 110000 },

    { year: 2024, month: 'Jan', inflow: 20000, outflow: 9000, liability: 100000 },
    { year: 2024, month: 'Feb', inflow: 21000, outflow: 9000, liability: 90000 },
    { year: 2024, month: 'Mar', inflow: 22000, outflow: 9000, liability: 78000 },
    { year: 2024, month: 'Apr', inflow: 20500, outflow: 9000, liability: 68000 },
    { year: 2024, month: 'May', inflow: 23000, outflow: 9000, liability: 54000 },
    { year: 2024, month: 'Jun', inflow: 24000, outflow: 9000, liability: 40000 },

    { year: 2025, month: 'Jan', inflow: 25000, outflow: 10000, liability: 35000 },
    { year: 2025, month: 'Feb', inflow: 26000, outflow: 10000, liability: 25000 },
    { year: 2025, month: 'Mar', inflow: 27000, outflow: 10000, liability: 15000 },
    { year: 2025, month: 'Apr', inflow: 28000, outflow: 10000, liability: 8000 },
    { year: 2025, month: 'May', inflow: 29000, outflow: 10000, liability: 0 },
    { year: 2025, month: 'Jun', inflow: 30000, outflow: 10000, liability: 0 },
];

export default function FundPerformance() {
    const [selectedYears, setSelectedYears] = useState<number[]>([2024, 2025]);

    const toggleYear = (year: number) => {
        if (selectedYears.includes(year)) {
            if (selectedYears.length > 1) {
                setSelectedYears(selectedYears.filter(y => y !== year));
            }
        } else {
            setSelectedYears([...selectedYears, year].sort());
        }
    };

    const filteredData = useMemo(() => {
        return RAW_DATA
            .filter(d => selectedYears.includes(d.year))
            .map(d => ({
                ...d,
                name: `${d.month} '${String(d.year).slice(2)}` // e.g., "Jan '24"
            }));
    }, [selectedYears]);

    const formatCurrency = (value: number) => {
        if (value >= 1000000) return `฿${(value / 1000000).toFixed(1)}M`;
        if (value >= 1000) return `฿${(value / 1000).toFixed(0)}k`;
        return `฿${value}`;
    };

    return (
        <div className="space-y-4">
            <Card className="col-span-4 transition-all hover:shadow-md">
                <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                    <div>
                        <CardTitle className="text-xl font-bold text-foreground">Fund Performance Analytics</CardTitle>
                        <CardDescription>
                            Compare Collections, Payments, and Liability amortization over time.
                        </CardDescription>
                    </div>

                    {/* Multi-select Year Filter */}
                    <div className="flex flex-wrap gap-2">
                        {AVAILABLE_YEARS.map(year => (
                            <button
                                key={year}
                                onClick={() => toggleYear(year)}
                                className={`px-3 py-1 text-xs font-semibold rounded-full border transition-colors ${
                                    selectedYears.includes(year)
                                        ? 'bg-primary text-primary-foreground border-primary'
                                        : 'bg-transparent text-muted-foreground border-input hover:bg-muted'
                                }`}
                            >
                                {year}
                            </button>
                        ))}
                    </div>
                </CardHeader>
                <CardContent>
                    {/* Responsive container for the Recharts component */}
                    <div className="h-[400px] w-full mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart
                                data={filteredData}
                                margin={{
                                    top: 20,
                                    right: 20,
                                    bottom: 20,
                                    left: 20,
                                }}
                            >
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="opacity-10" />

                                <XAxis
                                    dataKey="name"
                                    tick={{ fontSize: 12 }}
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={10}
                                />

                                <YAxis
                                    yAxisId="left"
                                    tickFormatter={formatCurrency}
                                    tick={{ fontSize: 12 }}
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={10}
                                />

                                <YAxis
                                    yAxisId="right"
                                    orientation="right"
                                    tickFormatter={formatCurrency}
                                    tick={{ fontSize: 12 }}
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={10}
                                />

                                <Tooltip
                                    formatter={(value: number, name: string) => {
                                        return [`฿${value.toLocaleString()}`, name];
                                    }}
                                    contentStyle={{
                                        borderRadius: '8px',
                                        border: '1px solid var(--border)',
                                        backgroundColor: 'var(--background)',
                                        color: 'var(--foreground)',
                                        boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
                                    }}
                                />

                                <Legend wrapperStyle={{ paddingTop: '20px' }} />

                                {/* 1. Inflow (Collections): Bar Chart (Primary Income) */}
                                <Bar
                                    yAxisId="left"
                                    dataKey="inflow"
                                    name="Inflow (Collections)"
                                    fill="#10b981"
                                    radius={[4, 4, 0, 0]}
                                    barSize={20}
                                />

                                {/* 3. Liability (Debt): Area Chart (Background Amortization) */}
                                <Area
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="liability"
                                    name="Liability (Debt)"
                                    fill="#f43f5e"
                                    stroke="#f43f5e"
                                    fillOpacity={0.1}
                                    strokeWidth={2}
                                />

                                {/* 2. Outflow (Payment): Line Chart (Target vs Bank) */}
                                <Line
                                    yAxisId="left"
                                    type="monotone"
                                    dataKey="outflow"
                                    name="Outflow (Bank Payments)"
                                    stroke="#3b82f6"
                                    strokeWidth={3}
                                    dot={{ r: 4, strokeWidth: 2 }}
                                    activeDot={{ r: 6 }}
                                />

                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Summary Footer */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8 pt-4 border-t">
                        <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#10b981]"></span>
                                Avg. Monthly Collection
                            </span>
                            <span className="text-xl font-bold text-foreground">
                                ฿{Math.round(filteredData.reduce((acc, curr) => acc + curr.inflow, 0) / filteredData.length).toLocaleString()}
                            </span>
                        </div>
                        <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#3b82f6]"></span>
                                Avg. Monthly Payment
                            </span>
                            <span className="text-xl font-bold text-foreground">
                                ฿{Math.round(filteredData.reduce((acc, curr) => acc + curr.outflow, 0) / filteredData.length).toLocaleString()}
                            </span>
                        </div>
                        <div className="flex flex-col">
                            <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#f43f5e]"></span>
                                Current Total Liability
                            </span>
                            <span className="text-xl font-bold text-foreground">
                                ฿{filteredData.length > 0 ? filteredData[filteredData.length - 1].liability.toLocaleString() : 0}
                            </span>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
