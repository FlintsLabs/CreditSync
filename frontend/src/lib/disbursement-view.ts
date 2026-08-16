export type DisbursementSummaryInput = { approvedPrincipal: string; postedGrossAmount?: string; postedEventCount?: number; netDisbursed: string; variance: string; status?: string };

export function formatDisbursementSummary(summary: DisbursementSummaryInput) {
    const normalized = summary.variance.replace(/^[-+]?0+(?:\.0+)?$/, "0.00");
    const status = normalized === "0.00" ? "matched" : normalized.startsWith("-") ? "under_disbursed" : "over_disbursed";
    return { ...summary, status };
}
