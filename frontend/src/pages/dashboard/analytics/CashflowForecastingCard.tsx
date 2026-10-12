import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import { api } from "../../../lib/api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/Card";
import { formatMoneyExact } from "../../../lib/workflow-model";

type CashflowData = {
  date: string;
  expectedCollection: string;
  upcomingBankPayment: string;
};

export default function CashflowForecastingCard() {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<CashflowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .get("/cashflow-forecasting")
      .then((response) => {
        if (active) {
          setData(response.data as CashflowData[]);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error("Failed to load cashflow forecasting data", err);
        if (active) {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const formatAxisDate = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00`));

  const formatTooltip = (value: unknown) =>
    formatMoneyExact(String(value ?? "0.00"), i18n.language);

  if (error) {
    return (
      <Card className="col-span-full xl:col-span-2">
        <CardHeader>
          <CardTitle>Cashflow Forecasting (30 Days)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Expected Collection vs Upcoming Bank Payments
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex h-64 items-center justify-center text-sm text-destructive">
            Failed to load data.
          </div>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card className="col-span-full xl:col-span-2">
        <CardHeader>
          <CardTitle>Cashflow Forecasting (30 Days)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Expected Collection vs Upcoming Bank Payments
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-64 w-full animate-pulse rounded-md bg-muted"></div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="col-span-full xl:col-span-2">
      <CardHeader>
        <CardTitle>Cashflow Forecasting (30 Days)</CardTitle>
        <p className="text-sm text-muted-foreground">
          Expected Collection vs Upcoming Bank Payments
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="date" tickFormatter={formatAxisDate} minTickGap={24} />
              <YAxis tickFormatter={(value) => formatTooltip(value)} width={80} />
              <Tooltip
                labelFormatter={(value) => formatAxisDate(String(value))}
                formatter={(value, name) => [
                  formatTooltip(value),
                  name === "expectedCollection" ? "Expected Collection" : "Upcoming Bank Payment",
                ]}
              />
              <Legend verticalAlign="top" height={36} />
              <Bar dataKey="expectedCollection" name="expectedCollection" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Line type="monotone" dataKey="upcomingBankPayment" name="upcomingBankPayment" stroke="#ef4444" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
