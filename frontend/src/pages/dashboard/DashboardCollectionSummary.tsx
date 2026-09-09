import { UsersRound, WalletCards } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/Card";
import { formatMoneyExact } from "../../lib/workflow-model";
import type { DashboardCollectionItem, DashboardCollectionSummary as DashboardCollectionSummaryData } from "./dashboard-model";

function CollectionItems({ items }: { items: DashboardCollectionItem[] }) {
    const { i18n } = useTranslation();
    return items.length ? (
        <ul className="mt-3 space-y-2 border-t pt-3 text-sm">
            {items.map((item) => (
                <li key={item.loanPublicId} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{item.borrowerName}</span>
                    <span className="shrink-0 font-medium tabular-nums">{formatMoneyExact(item.dueTodayAmount, i18n.language)}</span>
                </li>
            ))}
        </ul>
    ) : null;
}

export default function DashboardCollectionSummary({ summary }: { summary: DashboardCollectionSummaryData }) {
    const { t, i18n } = useTranslation();
    return (
        <section className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)]" aria-label={t("dashboardPage.sections.collectionSummary")}>
            <Card>
                <CardHeader className="border-b pb-4">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <CardTitle className="flex items-center gap-2 text-lg"><WalletCards className="h-5 w-5 text-primary" />{t("dashboardPage.sections.collectionSummary")}</CardTitle>
                            <p className="mt-1 text-sm text-muted-foreground">{t("dashboardPage.sections.collectionSummaryDescription")}</p>
                        </div>
                        <div className="text-right">
                            <p className="text-xs text-muted-foreground">{t("dashboardPage.collectionSummary.totalDueToday")}</p>
                            <p className="mt-1 text-xl font-semibold tabular-nums">{formatMoneyExact(summary.totalDueToday, i18n.language)}</p>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                    {summary.categories.map((category) => (
                        <article key={category.key} className="rounded-xl border bg-muted/20 p-4">
                            <p className="text-sm font-medium">{t(`dashboardPage.collectionSummary.categories.${category.key}`)}</p>
                            <p className="mt-1 text-lg font-semibold tabular-nums">{formatMoneyExact(category.totalDueToday, i18n.language)}</p>
                            <CollectionItems items={category.items} />
                        </article>
                    ))}
                </CardContent>
            </Card>
            <Card>
                <CardHeader className="border-b pb-4">
                    <CardTitle className="flex items-center gap-2 text-lg"><UsersRound className="h-5 w-5 text-primary" />{t("dashboardPage.sections.intermediaryCollections")}</CardTitle>
                    <p className="text-sm text-muted-foreground">{t("dashboardPage.sections.intermediaryCollectionsDescription")}</p>
                </CardHeader>
                <CardContent className="space-y-3 p-4">
                    {summary.intermediaries.length ? summary.intermediaries.map((intermediary) => (
                        <article key={intermediary.intermediaryPublicId} className="rounded-xl border p-4">
                            <div className="flex items-center justify-between gap-3">
                                <p className="font-medium">{intermediary.intermediaryName}</p>
                                <p className="font-semibold tabular-nums">{formatMoneyExact(intermediary.totalDueToday, i18n.language)}</p>
                            </div>
                            <CollectionItems items={intermediary.items} />
                        </article>
                    )) : <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("dashboardPage.empty.noIntermediaryCollection")}</p>}
                </CardContent>
            </Card>
        </section>
    );
}
