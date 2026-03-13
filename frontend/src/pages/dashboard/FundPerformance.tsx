import { useEffect, useState } from "react";
import { ComposedChart, Line, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/Card";
import { api } from "../../lib/api";

interface AnalyticsData {
    name: string;
    year: number;
    month: string;
    inflow: number;
    outflow: number;
    liability: number;
}

export default function FundPerformance() {
    const [data, setData] = useState<AnalyticsData[]>([]);
    const [loading, setLoading] = useState(false);

    // Default to current year and previous year
    const currentYear = new Date().getFullYear();
    const [selectedYears, setSelectedYears] = useState<number[]>([currentYear - 1, currentYear]);

    // Available years for the filter (mock logic: last 5 years)
    const availableYears = Array.from({ length: 5 }, (_, i) => currentYear - i).sort((a, b) => a - b);

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const yearsParam = selectedYears.join(",");
                const res = await api.get(`/analytics/fund-performance?years=${yearsParam}`);
                setData(res.data);
            } catch (error) {
                console.error("Failed to fetch analytics data:", error);
            } finally {
                setLoading(false);
            }
        };

        if (selectedYears.length > 0) {
            fetchData();
        } else {
            setData([]);
        }
    }, [selectedYears]);

    const toggleYear = (year: number) => {
        setSelectedYears(prev =>
            prev.includes(year)
                ? prev.filter(y => y !== year)
                : [...prev, year].sort((a, b) => a - b)
        );
    };

    return (
        <Card className="col-span-4 transition-all hover:shadow-md">
            <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-2 sm:space-y-0 pb-2">
                <div>
                    <CardTitle>Fund Performance</CardTitle>
                    <CardDescription>
                        Compare Collections (Inflow), Payments (Outflow), and Debt (Liability)
                    </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                    {availableYears.map(year => (
                        <button
                            key={year}
                            onClick={() => toggleYear(year)}
                            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                                selectedYears.includes(year)
                                    ? "bg-primary text-primary-foreground border-primary"
                                    : "bg-background text-muted-foreground border-border hover:bg-muted"
                            }`}
                        >
                            {year}
                        </button>
                    ))}
                </div>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="h-[400px] w-full flex items-center justify-center text-muted-foreground">
                        Loading performance data...
                    </div>
                ) : data.length === 0 ? (
                    <div className="h-[400px] w-full flex items-center justify-center text-muted-foreground">
                        No data available for the selected years.
                    </div>
                ) : (
                    <div className="h-[400px] w-full mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart
                                data={data}
                                margin={{
                                    top: 20,
                                    right: 20,
                                    bottom: 20,
                                    left: 20,
                                }}
                            >
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                <XAxis
                                    dataKey="name"
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{ fill: '#6b7280', fontSize: 12 }}
                                    dy={10}
                                />
                                <YAxis
                                    yAxisId="left"
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{ fill: '#6b7280', fontSize: 12 }}
                                    tickFormatter={(value) => `฿${(value / 1000).toFixed(0)}k`}
                                    dx={-10}
                                />
                                <YAxis
                                    yAxisId="right"
                                    orientation="right"
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{ fill: '#6b7280', fontSize: 12 }}
                                    tickFormatter={(value) => `฿${(value / 1000).toFixed(0)}k`}
                                    dx={10}
                                />
                                <Tooltip
                                    formatter={(value: number, name: string) => [`฿${value.toLocaleString()}`, name]}
                                    contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                                />
                                <Legend wrapperStyle={{ paddingTop: "20px" }} />

                                {/* Area: Liability (Debt) - mapped to left Y-axis */}
                                <defs>
                                    <linearGradient id="colorLiability" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <Area
                                    yAxisId="left"
                                    type="monotone"
                                    dataKey="liability"
                                    name="Liability (Debt)"
                                    stroke="#f43f5e"
                                    strokeWidth={2}
                                    fillOpacity={1}
                                    fill="url(#colorLiability)"
                                />

                                {/* Bar: Inflow (Collections) - mapped to right Y-axis for better scaling if amounts differ vastly */}
                                <Bar
                                    yAxisId="right"
                                    dataKey="inflow"
                                    name="Inflow (Collections)"
                                    barSize={20}
                                    fill="#10b981"
                                    radius={[4, 4, 0, 0]}
                                />

                                {/* Line: Outflow (Payment) - mapped to right Y-axis */}
                                <Line
                                    yAxisId="right"
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
