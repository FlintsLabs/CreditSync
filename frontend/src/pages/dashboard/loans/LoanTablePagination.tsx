import { Button } from "../../../components/ui/Button";
import { useTranslation } from "react-i18next";

interface LoanTablePaginationProps {
    controlId: string;
    page: number;
    pageSize: LoanTablePageSize;
    totalItems: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: LoanTablePageSize) => void;
}

export type LoanTablePageSize = 10 | 20 | 50 | 100 | "all";

const pageSizeOptions: LoanTablePageSize[] = [10, 20, 50, 100, "all"];

export function LoanTablePagination({ controlId, page, pageSize, totalItems, onPageChange, onPageSizeChange }: LoanTablePaginationProps) {
    const { t } = useTranslation();
    if (totalItems === 0) return null;
    const totalPages = pageSize === "all" ? 1 : Math.max(1, Math.ceil(totalItems / pageSize));

    return <nav aria-label={t("loanDetail.pagination.label", "Table pagination")} className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <span className="text-sm text-muted-foreground">{t("loanDetail.pagination.total", { count: totalItems })}</span>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <label htmlFor={controlId}>{t("loanDetail.pagination.pageSize", "Rows per page")}</label>
            <select id={controlId} className="h-9 rounded-md border bg-background px-2" value={pageSize} onChange={(event) => onPageSizeChange(event.target.value === "all" ? "all" : Number(event.target.value) as LoanTablePageSize)}>
                {pageSizeOptions.map((option) => <option key={option} value={option}>{option === "all" ? t("loanDetail.pagination.all", "All") : option}</option>)}
            </select>
        </div>
        <span className="text-sm text-muted-foreground">{t("loanDetail.pagination.page", { page, totalPages })}</span>
        <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>{t("loanDetail.pagination.previous", "Previous")}</Button>
            <Button type="button" size="sm" variant="outline" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>{t("loanDetail.pagination.next", "Next")}</Button>
        </div>
    </nav>;
}
