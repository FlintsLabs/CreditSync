import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/Card";
import { ResponsiveContainer, ComposedChart, Line, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";

const data = [
    {
        name: 'Jan',
        inflow: 4000,
        outflow: 2400,
        liability: 150000,
    },
    {
        name: 'Feb',
        inflow: 3000,
        outflow: 1398,
        liability: 147602,
    },
    {
        name: 'Mar',
        inflow: 2000,
        outflow: 9800,
        liability: 137802,
    },
    {
        name: 'Apr',
        inflow: 2780,
        outflow: 3908,
        liability: 133894,
    },
    {
        name: 'May',
        inflow: 1890,
        outflow: 4800,
        liability: 129094,
    },
    {
        name: 'Jun',
        inflow: 2390,
        outflow: 3800,
        liability: 125294,
    },
    {
        name: 'Jul',
        inflow: 3490,
        outflow: 4300,
        liability: 120994,
    },
];

export default function FundPerformance() {
    return (
        <Card className="col-span-full mt-4">
            <CardHeader>
                <CardTitle>Fund Performance</CardTitle>
                <CardDescription>
                    Combo chart comparing Inflow (Collections), Outflow (Payments), and Liability (Debt) over time.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="h-[400px] w-full">
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
                            <CartesianGrid stroke="#f5f5f5" />
                            <XAxis dataKey="name" />
                            <YAxis yAxisId="left" tickFormatter={(value) => `฿${value}`} />
                            <YAxis yAxisId="right" orientation="right" tickFormatter={(value) => `฿${value}`} />
                            <Tooltip formatter={(value) => `฿${value.toLocaleString()}`} />
                            <Legend verticalAlign="bottom" height={36} />

                            {/* Liability (Debt) - Area Chart */}
                            <Area yAxisId="right" type="monotone" dataKey="liability" name="Liability (Debt)" fill="#ffc658" stroke="#ffc658" fillOpacity={0.3} />

                            {/* Inflow (Collections) - Bar Chart */}
                            <Bar yAxisId="left" dataKey="inflow" name="Inflow (Collections)" barSize={20} fill="#10b981" />

                            {/* Outflow (Payments) - Line Chart */}
                            <Line yAxisId="left" type="monotone" dataKey="outflow" name="Outflow (Payments)" stroke="#ef4444" strokeWidth={2} />
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}
