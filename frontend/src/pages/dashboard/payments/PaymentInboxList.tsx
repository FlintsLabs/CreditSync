import { useTranslation } from "react-i18next";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import type { PaymentInboxQuery, PaymentIntakePage } from "./payment-inbox-list-model";

interface Props {
    data: PaymentIntakePage;
    query: PaymentInboxQuery;
    selectedId: string;
    loading: boolean;
    formatDateTime: (value: string) => string;
    formatMoney: (value: string) => string;
    onQueryChange: (query: PaymentInboxQuery) => void;
    onSelect: (publicId: string) => void;
}

const statuses = ["draft", "needs_review", "ready", "posted", "reversed", "duplicate"];

const neutralStatusTone = {
    name: "neutral",
    className: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

const paymentStatusTones: Record<string, { name: string; className: string }> = {
    draft: neutralStatusTone,
    needs_review: {
        name: "warning",
        className: "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    },
    ready: {
        name: "success",
        className: "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
    },
    posted: {
        name: "info",
        className: "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
    },
    reversed: {
        name: "danger",
        className: "border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/60 dark:text-red-300",
    },
    duplicate: {
        name: "duplicate",
        className: "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
    },
};

function paymentStatusTone(status: string) {
    return paymentStatusTones[status] ?? neutralStatusTone;
}

export function PaymentInboxList({
    data, query, selectedId, loading, formatDateTime, formatMoney, onQueryChange, onSelect,
}: Props) {
    const { t } = useTranslation();
    const setFilter = (patch: Partial<PaymentInboxQuery>) => onQueryChange({ ...query, ...patch, page: 1 });
    const first = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
    const last = Math.min(data.page * data.pageSize, data.total);
    const hasFilters = Boolean(query.search || query.status || query.from || query.to);

    return <>
        <div className="grid gap-3 border-b p-4 sm:grid-cols-2 xl:grid-cols-4">
            <label className="sm:col-span-2 xl:col-span-4">
                <span className="sr-only">{t("payments.filters.search")}</span>
                <Input
                    type="search"
                    value={query.search}
                    placeholder={t("payments.filters.searchPlaceholder")}
                    aria-label={t("payments.filters.search")}
                    onChange={(event) => setFilter({ search: event.target.value })}
                />
            </label>
            <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">{t("payments.filters.status")}</span>
                <select
                    className="h-10 rounded-md border border-input bg-background px-3"
                    value={query.status}
                    aria-label={t("payments.filters.status")}
                    onChange={(event) => setFilter({ status: event.target.value })}
                >
                    <option value="">{t("payments.filters.allStatuses")}</option>
                    {statuses.map((status) => <option key={status} value={status}>{t(`payments.status.${status}`)}</option>)}
                </select>
            </label>
            <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">{t("payments.filters.from")}</span>
                <Input type="date" value={query.from} onChange={(event) => setFilter({ from: event.target.value })} />
            </label>
            <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">{t("payments.filters.to")}</span>
                <Input type="date" value={query.to} onChange={(event) => setFilter({ to: event.target.value })} />
            </label>
            <div className="flex items-end">
                <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    disabled={!hasFilters}
                    onClick={() => onQueryChange({ ...query, search: "", status: "", from: "", to: "", page: 1 })}
                >{t("payments.filters.clear")}</Button>
            </div>
        </div>

        {loading ? <div role="status" className="p-6 text-center text-muted-foreground">{t("common.loading")}</div> : data.items.length ? (
            <ul role="list" aria-label={t("payments.inbox")} className="divide-y">
                {data.items.map((item) => {
                    const statusTone = paymentStatusTone(item.status);
                    return <li role="listitem" key={item.publicId}>
                    <button
                        type="button"
                        aria-current={selectedId === item.publicId ? "true" : undefined}
                        onClick={() => onSelect(item.publicId)}
                        className={`grid w-full gap-1 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4 ${selectedId === item.publicId ? "bg-primary/5 shadow-[inset_3px_0_0_hsl(var(--primary))]" : ""}`}
                    >
                        <span className="min-w-0">
                            <span className="block truncate font-medium">{item.payerName || t("payments.unknownPayer")}</span>
                            <span className="block text-sm text-muted-foreground sm:mt-0.5">{formatDateTime(item.receivedAt)}</span>
                        </span>
                        <Badge data-status-tone={statusTone.name} className={`w-fit ${statusTone.className}`} variant="outline">{t(`payments.status.${item.status}`)}</Badge>
                        <span className="font-medium tabular-nums sm:min-w-24 sm:text-right">{formatMoney(item.amount)}</span>
                    </button>
                </li>;
                })}
            </ul>
        ) : <div className="p-8 text-center text-muted-foreground">{hasFilters ? t("payments.filteredEmpty") : t("payments.empty")}</div>}

        {!loading && data.total > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <span className="text-sm text-muted-foreground">{t("payments.pagination.range", { first, last, total: data.total })}</span>
            <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" disabled={data.page <= 1} onClick={() => onQueryChange({ ...query, page: data.page - 1 })}>{t("payments.pagination.previous")}</Button>
                <Button type="button" size="sm" variant="outline" disabled={data.page >= data.totalPages} onClick={() => onQueryChange({ ...query, page: data.page + 1 })}>{t("payments.pagination.next")}</Button>
            </div>
        </div>}
    </>;
}
