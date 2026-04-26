import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { ResponsiveContainer, ComposedChart, XAxis, YAxis, Tooltip, Legend, CartesianGrid, Area, Bar, Line } from "recharts";
import api from "../../lib/api";

export default function FundPerformanceChart() {
    const [data, setData] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Fetch real analytics data from the backend when available.
        // For now, if the endpoint is not ready, we use mock data to represent the dashboard.
        const fetchData = async () => {
            try {
                // Future API integration:
                // const response = await api.get('/analytics/fund-performance');
                // setData(response.data);

                // Fallback to mock data for MVP
                setData([
                    { month: 'Jan', inflow: 4000, outflow: 2400, liability: 100000 },
                    { month: 'Feb', inflow: 4500, outflow: 2400, liability: 97900 },
                    { month: 'Mar', inflow: 4800, outflow: 2400, liability: 95500 },
                    { month: 'Apr', inflow: 5100, outflow: 2400, liability: 92800 },
                    { month: 'May', inflow: 5500, outflow: 2400, liability: 89700 },
                    { month: 'Jun', inflow: 4000, outflow: 2400, liability: 88100 },
                    { month: 'Jul', inflow: 6000, outflow: 2400, liability: 84500 },
                    { month: 'Aug', inflow: 6200, outflow: 2400, liability: 80700 },
                    { month: 'Sep', inflow: 6500, outflow: 2400, liability: 76600 },
                    { month: 'Oct', inflow: 6800, outflow: 2400, liability: 72200 },
                    { month: 'Nov', inflow: 7000, outflow: 2400, liability: 67600 },
                    { month: 'Dec', inflow: 7500, outflow: 2400, liability: 62500 },
                ]);
            } catch (error) {
                console.error("Failed to load fund performance data", error);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, []);

    if (loading) {
        return <div className="h-[350px] flex items-center justify-center text-muted-foreground animate-pulse">Loading Chart Data...</div>;
    }

    return (
        <Card className="col-span-4 lg:col-span-7 transition-all hover:shadow-md">
            <CardHeader>
                <CardTitle>Fund Performance Dashboard</CardTitle>
                <CardDescription>
                    Inflow (Collections), Outflow (Bank Payments), and Remaining Liability over time.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="h-[350px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                            data={data}
                            margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
                        >
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                            <XAxis
                                dataKey="month"
                                stroke="#888888"
                                fontSize={12}
                                tickLine={false}
                                axisLine={false}
                            />
                            <YAxis
                                yAxisId="left"
                                stroke="#888888"
                                fontSize={12}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(value) => `฿${value}`}
                            />
                            <YAxis
                                yAxisId="right"
                                orientation="right"
                                stroke="#888888"
                                fontSize={12}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(value) => `฿${value}`}
                            />
                            <Tooltip
                                formatter={(value: number, name: string) => {
                                    const labels: Record<string, string> = {
                                        inflow: "Inflow (Collections)",
                                        outflow: "Outflow (Payments)",
                                        liability: "Remaining Liability"
                                    };
                                    return [`฿${value.toLocaleString()}`, labels[name] || name];
                                }}
                                contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                            />
                            <Legend wrapperStyle={{ paddingTop: '20px' }} />

                            {/* Inflow (Collections) - Bar */}
                            <Bar yAxisId="left" dataKey="inflow" barSize={20} fill="#10b981" radius={[4, 4, 0, 0]} name="Inflow" />

                            {/* Outflow (Payment) - Line */}
                            <Line yAxisId="left" type="monotone" dataKey="outflow" stroke="#ef4444" strokeWidth={2} dot={{ r: 4 }} name="Outflow" />

                            {/* Liability (Debt) - Area */}
                            <Area yAxisId="right" type="monotone" dataKey="liability" fill="#3b82f6" stroke="#2563eb" fillOpacity={0.2} name="Liability" />
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}
