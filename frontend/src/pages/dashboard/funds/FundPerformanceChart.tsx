import { useState, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "../../../components/ui/Card";
import { useTranslation } from "react-i18next";
import { ComposedChart, Area, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Checkbox } from "../../../components/ui/Checkbox";

// Note: Sample data mock based on requirements.
// Need to replace this with real data mapping from backend in the future.
const mockData = [
    { month: "Jan", year: 2023, inflow: 4000, outflow: 2400, liability: 24000 },
    { month: "Feb", year: 2023, inflow: 3000, outflow: 1398, liability: 22108 },
    { month: "Mar", year: 2023, inflow: 2000, outflow: 9800, liability: 22900 },
    { month: "Apr", year: 2023, inflow: 2780, outflow: 3908, liability: 20000 },
    { month: "May", year: 2023, inflow: 1890, outflow: 4800, liability: 21810 },
    { month: "Jun", year: 2023, inflow: 2390, outflow: 3800, liability: 25000 },
    { month: "Jul", year: 2023, inflow: 3490, outflow: 4300, liability: 21000 },

    { month: "Jan", year: 2024, inflow: 5000, outflow: 3400, liability: 21000 },
    { month: "Feb", year: 2024, inflow: 4000, outflow: 2398, liability: 20108 },
    { month: "Mar", year: 2024, inflow: 3000, outflow: 8800, liability: 18900 },
    { month: "Apr", year: 2024, inflow: 3780, outflow: 4908, liability: 17000 },
    { month: "May", year: 2024, inflow: 2890, outflow: 5800, liability: 15810 },
    { month: "Jun", year: 2024, inflow: 3390, outflow: 4800, liability: 14000 },
    { month: "Jul", year: 2024, inflow: 4490, outflow: 5300, liability: 12000 },
];

export function FundPerformanceChart() {
    const { t } = useTranslation();
    const [selectedYears, setSelectedYears] = useState<number[]>([2023, 2024]);

    const availableYears = useMemo(() => Array.from(new Set(mockData.map(d => d.year))).sort(), []);

    const toggleYear = (year: number) => {
        setSelectedYears(prev =>
            prev.includes(year)
                ? prev.filter(y => y !== year)
                : [...prev, year]
        );
    };

    const filteredData = useMemo(() => {
        return mockData
            .filter(d => selectedYears.includes(d.year))
            .map(d => ({
                ...d,
                label: `${d.month} ${d.year}`
            }));
    }, [selectedYears]);

    return (
        <Card className="col-span-4 border-dashed shadow-sm">
            <CardHeader>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <CardTitle className="text-xl font-semibold tracking-tight">
                            {t("chart.financial_performance", "Financial Performance")}
                        </CardTitle>
                        <CardDescription>
                            {t("chart.subtitle", "Fund flow and liability overview over time")}
                        </CardDescription>
                    </div>
                    <div className="flex items-center gap-4 text-sm bg-muted/30 p-2 rounded-md">
                        <span className="font-medium text-muted-foreground">Filter Years:</span>
                        {availableYears.map(year => (
                            <label key={year} className="flex items-center space-x-2 cursor-pointer hover:bg-accent/50 p-1 rounded transition-colors">
                                <Checkbox
                                    checked={selectedYears.includes(year)}
                                    onCheckedChange={() => toggleYear(year)}
                                />
                                <span className="leading-none">{year}</span>
                            </label>
                        ))}
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                {selectedYears.length === 0 ? (
                    <div className="h-[400px] flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                        Please select at least one year to view the chart.
                    </div>
                ) : (
                    <div className="h-[400px] w-full mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart
                                data={filteredData}
                                margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
                            >
                                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                                <XAxis
                                    dataKey="label"
                                    tick={{ fontSize: 12, fill: "currentColor" }}
                                    tickLine={false}
                                    axisLine={false}
                                    dy={10}
                                />
                                <YAxis
                                    yAxisId="left"
                                    tick={{ fontSize: 12, fill: "currentColor" }}
                                    tickFormatter={(value) => `฿${(value / 1000).toFixed(0)}k`}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <YAxis
                                    yAxisId="right"
                                    orientation="right"
                                    tick={{ fontSize: 12, fill: "currentColor" }}
                                    tickFormatter={(value) => `฿${(value / 1000).toFixed(0)}k`}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <Tooltip
                                    contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', backgroundColor: 'var(--background)' }}
                                    formatter={(value: number, name: string) => [`฿${value.toLocaleString()}`, name]}
                                    labelStyle={{ color: 'var(--foreground)', fontWeight: 'bold', marginBottom: '8px' }}
                                />
                                <Legend
                                    verticalAlign="top"
                                    height={36}
                                    iconType="circle"
                                    wrapperStyle={{ fontSize: '14px', paddingTop: '10px' }}
                                />

                                <Area
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="liability"
                                    name="Liability (Debt)"
                                    fill="#f43f5e"
                                    fillOpacity={0.1}
                                    stroke="#f43f5e"
                                    strokeWidth={2}
                                />
                                <Bar
                                    yAxisId="left"
                                    dataKey="inflow"
                                    name="Inflow (Collections)"
                                    fill="#10b981"
                                    radius={[4, 4, 0, 0]}
                                    barSize={32}
                                />
                                <Line
                                    yAxisId="left"
                                    type="monotone"
                                    dataKey="outflow"
                                    name="Outflow (Payment)"
                                    stroke="#3b82f6"
                                    strokeWidth={3}
                                    dot={{ r: 4, strokeWidth: 2 }}
                                    activeDot={{ r: 6 }}
                                />
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
