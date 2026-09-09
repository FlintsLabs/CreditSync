import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "../../../components/ui/Card";
import { useTranslation } from "react-i18next";

export function FundPerformanceChart() {
    const { t } = useTranslation();

    return (
        <Card className="col-span-4 border-dashed shadow-sm">
            <CardHeader>
                <CardTitle className="text-xl font-semibold tracking-tight">
                    {t("chart.financial_performance")}
                </CardTitle>
                <CardDescription>
                    {t("chart.subtitle")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                    No performance chart is shown yet because sample funding data has been removed. This section should be wired to real bank loan and collection data before it is enabled again.
                </div>
            </CardContent>
        </Card>
    );
}
