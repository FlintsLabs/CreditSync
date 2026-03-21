import { ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Area } from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/Card";

const fundPerformanceData = [
    { month: "Jan", inflow: 120000, outflow: 50000, liability: 1000000 },
    { month: "Feb", inflow: 150000, outflow: 50000, liability: 950000 },
    { month: "Mar", inflow: 140000, outflow: 55000, liability: 900000 },
    { month: "Apr", inflow: 180000, outflow: 60000, liability: 850000 },
    { month: "May", inflow: 200000, outflow: 60000, liability: 790000 },
    { month: "Jun", inflow: 190000, outflow: 65000, liability: 730000 },
    { month: "Jul", inflow: 220000, outflow: 70000, liability: 670000 },
    { month: "Aug", inflow: 210000, outflow: 70000, liability: 610000 },
    { month: "Sep", inflow: 250000, outflow: 75000, liability: 540000 },
    { month: "Oct", inflow: 240000, outflow: 75000, liability: 470000 },
    { month: "Nov", inflow: 280000, outflow: 80000, liability: 400000 },
    { month: "Dec", inflow: 300000, outflow: 85000, liability: 320000 },
];

export default function FundPerformance() {
    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>Fund Performance (Cashflow & Liability)</CardTitle>
                    <CardDescription>
                        Compare Inflow (Collections), Outflow (Bank Payments), and Remaining Liability (Debt) over time.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="h-[400px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart
                                data={fundPerformanceData}
                                margin={{
                                    top: 20,
                                    right: 20,
                                    bottom: 20,
                                    left: 20,
                                }}
                            >
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                                <XAxis
                                    dataKey="month"
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
                                    tickFormatter={(value) => `฿${(value / 1000)}k`}
                                    dx={-10}
                                />
                                <YAxis
                                    yAxisId="right"
                                    orientation="right"
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{ fill: '#6b7280', fontSize: 12 }}
                                    tickFormatter={(value) => `฿${(value / 1000)}k`}
                                    dx={10}
                                />
                                <Tooltip
                                    formatter={(value: any, name: any) => {
                                        const numValue = Number(value) || 0;
                                        return [`฿${numValue.toLocaleString()}`, String(name)];
                                    }}
                                    contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                                />
                                <Legend wrapperStyle={{ paddingTop: "20px" }} />

                                {/* Liability: Area background for remaining debt */}
                                <Area
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="liability"
                                    name="Liability (Debt)"
                                    fill="#f3f4f6"
                                    stroke="#d1d5db"
                                    strokeWidth={2}
                                />

                                {/* Inflow: Bars for collection */}
                                <Bar
                                    yAxisId="left"
                                    dataKey="inflow"
                                    name="Inflow (Collections)"
                                    barSize={20}
                                    fill="#10b981"
                                    radius={[4, 4, 0, 0]}
                                />

                                {/* Outflow: Line for bank payments */}
                                <Line
                                    yAxisId="left"
                                    type="monotone"
                                    dataKey="outflow"
                                    name="Outflow (Payment)"
                                    stroke="#ef4444"
                                    strokeWidth={3}
                                    dot={{ r: 4, fill: "#ef4444", strokeWidth: 2, stroke: "#fff" }}
                                    activeDot={{ r: 6 }}
                                />
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
