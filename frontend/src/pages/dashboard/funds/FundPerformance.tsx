import { useState, useEffect } from "react";
import { api } from "../../../lib/api";
import {
    ComposedChart,
    Line,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { useTranslation } from "react-i18next";

interface ChartData {
    name: string;
    inflow: number;
    outflow: number;
    liability: number;
}

interface SummaryData {
    totalInflow: number;
    totalOutflow: number;
    totalLiability: number;
}

export default function FundPerformance() {
    const { t } = useTranslation();
    const [chartData, setChartData] = useState<ChartData[]>([]);
    const [summary, setSummary] = useState<SummaryData>({ totalInflow: 0, totalOutflow: 0, totalLiability: 0 });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchPerformanceData = async () => {
            try {
                const response = await api.get("/analytics/funds/performance");

                if (response.data.status === "success") {
                    setChartData(response.data.data.chartData);
                    setSummary(response.data.data.summary);
                }
            } catch (error) {
                console.error("Error fetching fund performance data:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchPerformanceData();
    }, []);

    if (loading) return <div className="p-4">{t('loading')}</div>;

    return (
        <Card className="w-full">
            <CardHeader>
                <CardTitle>{t('fundPerformance') || "Fund Performance"}</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    <div className="p-4 bg-green-100 dark:bg-green-900 rounded-lg text-center">
                        <h3 className="text-sm font-medium text-green-800 dark:text-green-100">{t('totalInflow') || "Total Inflow"}</h3>
                        <p className="text-2xl font-bold text-green-900 dark:text-green-50">
                            ฿{summary.totalInflow.toLocaleString()}
                        </p>
                    </div>
                    <div className="p-4 bg-red-100 dark:bg-red-900 rounded-lg text-center">
                        <h3 className="text-sm font-medium text-red-800 dark:text-red-100">{t('totalOutflow') || "Total Outflow"}</h3>
                        <p className="text-2xl font-bold text-red-900 dark:text-red-50">
                            ฿{summary.totalOutflow.toLocaleString()}
                        </p>
                    </div>
                    <div className="p-4 bg-blue-100 dark:bg-blue-900 rounded-lg text-center">
                        <h3 className="text-sm font-medium text-blue-800 dark:text-blue-100">{t('totalLiability') || "Total Liability"}</h3>
                        <p className="text-2xl font-bold text-blue-900 dark:text-blue-50">
                            ฿{summary.totalLiability.toLocaleString()}
                        </p>
                    </div>
                </div>

                <div className="h-[400px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                            data={chartData}
                            margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
                        >
                            <CartesianGrid stroke="#f5f5f5" />
                            <XAxis dataKey="name" scale="band" />
                            <YAxis />
                            <Tooltip />
                            <Legend />
                            <Bar dataKey="inflow" barSize={20} fill="#413ea0" name="Inflow" />
                            <Bar dataKey="outflow" barSize={20} fill="#ff7300" name="Outflow" />
                            <Line type="monotone" dataKey="liability" stroke="#ff0000" name="Liability" />
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}
