import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/Card';
import { ResponsiveContainer, ComposedChart, Line, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Button } from '../../components/ui/Button';

// 1. Generate Mock Data spanning multiple years
const generateMockData = () => {
    const years = [2023, 2024, 2025];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const data = [];

    let currentLiability = 1000000; // Starting debt: 1 Million

    for (const year of years) {
        for (const month of months) {
            // Simulate amortizing liability (slowly decreasing)
            currentLiability -= Math.floor(Math.random() * 20000) + 10000;
            if (currentLiability < 0) currentLiability = 0;

            // Simulate monthly inflow and outflow
            const inflow = Math.floor(Math.random() * 50000) + 30000; // Collections from borrowers
            const outflow = Math.floor(Math.random() * 40000) + 20000; // Payments to bank

            data.push({
                month: `${month} ${year}`,
                year: year,
                inflow: inflow,
                outflow: outflow,
                liability: currentLiability
            });
        }
    }
    return data;
};

const MOCK_DATA = generateMockData();

export default function FundPerformanceDashboard() {
    // 2. Multi-select Year Filter State
    const [selectedYears, setSelectedYears] = useState<number[]>([2024, 2025]);

    // Toggle year selection
    const toggleYear = (year: number) => {
        setSelectedYears(prev => {
            if (prev.includes(year)) {
                // Prevent unselecting all (keep at least one)
                if (prev.length === 1) return prev;
                return prev.filter(y => y !== year);
            } else {
                return [...prev, year].sort();
            }
        });
    };

    // Filter data based on selected years
    const filteredData = useMemo(() => {
        return MOCK_DATA.filter(item => selectedYears.includes(item.year));
    }, [selectedYears]);

    const availableYears = [2023, 2024, 2025];

    // Custom Tooltip Formatter to format currency
    const formatCurrency = (value: number) => `฿${value.toLocaleString()}`;

    return (
        <Card className="col-span-4 transition-all hover:shadow-md">
            <CardHeader className="pb-2">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <CardTitle className="text-xl">Fund Performance</CardTitle>
                        <CardDescription>
                            Compare Inflow (Collections), Outflow (Bank Payments), and Remaining Liability (Debt) over time.
                        </CardDescription>
                    </div>
                    {/* Multi-select Year Filter UI */}
                    <div className="flex gap-2 items-center bg-muted/50 p-1 rounded-lg">
                        <span className="text-sm font-medium px-2 text-muted-foreground">Years:</span>
                        {availableYears.map(year => (
                            <Button
                                key={year}
                                variant={selectedYears.includes(year) ? "default" : "outline"}
                                size="sm"
                                onClick={() => toggleYear(year)}
                                className={`h-7 px-3 text-xs ${selectedYears.includes(year) ? '' : 'bg-background'}`}
                            >
                                {year}
                            </Button>
                        ))}
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                {/* 3. Recharts ComposedChart Implementation */}
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
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                            <XAxis
                                dataKey="month"
                                stroke="#888888"
                                fontSize={12}
                                tickLine={false}
                                axisLine={false}
                                tick={{ fill: '#888888' }}
                                tickMargin={10}
                            />
                            {/* Primary Y-Axis for Inflow/Outflow (smaller amounts) */}
                            <YAxis
                                yAxisId="left"
                                stroke="#888888"
                                fontSize={12}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(value) => `฿${(value/1000).toFixed(0)}k`}
                            />
                            {/* Secondary Y-Axis for Liability (larger amounts) */}
                            <YAxis
                                yAxisId="right"
                                orientation="right"
                                stroke="#888888"
                                fontSize={12}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(value) => `฿${(value/1000).toFixed(0)}k`}
                            />

                            <Tooltip
                                formatter={(value: number, name: string) => {
                                    return [formatCurrency(value), name];
                                }}
                                contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                                labelStyle={{ fontWeight: 'bold', color: '#374151', marginBottom: '8px' }}
                            />

                            <Legend
                                wrapperStyle={{ paddingTop: '20px' }}
                                iconType="circle"
                            />

                            {/* 3.1 Liability (Debt): Area Chart on Right Axis */}
                            <Area
                                yAxisId="right"
                                type="monotone"
                                dataKey="liability"
                                name="Liability (Remaining Debt)"
                                fill="#f87171"
                                stroke="#ef4444"
                                fillOpacity={0.2}
                            />

                            {/* 3.2 Inflow (Collections): Bar Chart on Left Axis */}
                            <Bar
                                yAxisId="left"
                                dataKey="inflow"
                                name="Inflow (Collections)"
                                barSize={20}
                                fill="#10b981"
                                radius={[4, 4, 0, 0]}
                            />

                            {/* 3.3 Outflow (Payment): Line Chart on Left Axis */}
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
            </CardContent>
        </Card>
    );
}
