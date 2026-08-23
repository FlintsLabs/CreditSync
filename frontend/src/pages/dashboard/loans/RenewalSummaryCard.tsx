import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/Button";
import { buildRenewalSummarySvg, renewalSummaryFilename, renewalSummaryPng, type LoanRenewalSummary } from "./renewal-summary-image";

export function RenewalSummaryCard({ summary }: { summary: LoanRenewalSummary }) {
    const { t, i18n } = useTranslation();
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState("");
    const svg = useMemo(() => buildRenewalSummarySvg(summary, i18n.language), [summary, i18n.language]);
    const download = async () => {
        setExporting(true); setError("");
        try {
            const blob = await renewalSummaryPng(summary, i18n.language);
            const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
            anchor.href = url; anchor.download = renewalSummaryFilename(summary); anchor.click(); URL.revokeObjectURL(url);
        } catch { setError(t("renewal.summary.exportError")); }
        finally { setExporting(false); }
    };
    return <section className="space-y-3 rounded border p-4"><strong>{t("renewal.summary.title")}</strong><div className="mx-auto max-w-md overflow-hidden rounded border bg-white [&>svg]:h-auto [&>svg]:w-full" aria-label={t("renewal.summary.preview")} dangerouslySetInnerHTML={{ __html: svg }} />{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="button" variant="outline" disabled={exporting} onClick={() => void download()}><Download className="mr-2 h-4 w-4" />{exporting ? t("common.loading") : t("renewal.summary.download")}</Button></section>;
}
