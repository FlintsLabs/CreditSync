export interface BorrowerLabelLoan {
    id: string;
    publicId: string;
    borrowerName: string;
    borrowerAliases?: (string | null)[] | null;
    borrowerTags?: (string | null)[] | null;
    currentAgent?: { name?: string | null; aliases?: (string | null)[] | null } | null;
    currentAgentName?: string | null;
    currentAgentAliases?: (string | null)[] | null;
}

/** Renewed/replaced/restructured are terminal lifecycle states; they remain visible as history, not active collection targets. */
export function isDoneLoanStatus(status: string): boolean {
    return status === "paid" || status === "closed" || status === "renewed" || status === "replaced" || status === "restructured";
}

export function getLoanStatusesForTab(tab: "active" | "done" | "all"): string[] {
    if (tab === "all") return ["active", "draft", "paid", "closed", "renewed", "replaced", "restructured", "defaulted", "pending", "problem"];
    if (tab === "done") return ["paid", "closed", "renewed", "replaced", "restructured"];
    return ["active", "draft", "defaulted"];
}

export function getFloatingAccrualCycle(loan: { repaymentType: string; floatingAccrualCycle?: "daily" | "weekly" | "monthly" | null; interestPeriodUnit?: "day" | "week" | "month" | null }) {
    if (loan.repaymentType !== "floating") return null;
    if (loan.interestPeriodUnit === "week") return "weekly";
    if (loan.interestPeriodUnit === "month") return "monthly";
    if (loan.interestPeriodUnit === "day") return "daily";
    if (loan.floatingAccrualCycle) return loan.floatingAccrualCycle;
    return "daily";
}

function normalizeLabel(value: string) {
    return value
        .trim()
        .normalize("NFKC")
        .toLocaleLowerCase("und");
}

export function getBorrowerLabels(loan: BorrowerLabelLoan): string[] {
    const labels = [
        ...(loan.borrowerAliases ?? []),
        ...(loan.borrowerTags ?? []),
    ];

    const result: string[] = [];
    const seen = new Set<string>();
    for (const rawLabel of labels) {
        if (!rawLabel) continue;
        const text = rawLabel.trim();
        if (!text) continue;
        const normalized = normalizeLabel(text);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(text);
    }
    return result;
}

export function getBorrowerTags(loan: BorrowerLabelLoan): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const rawTag of loan.borrowerTags ?? []) {
        if (!rawTag) continue;
        const tag = rawTag.trim();
        if (!tag) continue;
        const normalized = normalizeLabel(tag);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(tag);
    }
    return result;
}

export function getUniqueBorrowerTags(loans: BorrowerLabelLoan[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const loan of loans) {
        for (const tag of getBorrowerTags(loan)) {
            const normalized = normalizeLabel(tag);
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            result.push(tag);
        }
    }
    return result;
}

export function getVisibleBorrowerLabels(loan: BorrowerLabelLoan, limit = 3) {
    const all = getBorrowerLabels(loan);
    return {
        visible: all.slice(0, limit),
        overflow: Math.max(0, all.length - limit),
    };
}

export function loanMatchesSearch(loan: BorrowerLabelLoan, query: string): boolean {
    const normalized = normalizeLabel(query);
    if (!normalized) return true;
    const haystack = [
        loan.borrowerName,
        loan.id,
        loan.publicId,
        ...((loan.borrowerAliases ?? []) as (string | null | undefined)[]),
        ...((loan.borrowerTags ?? []) as (string | null | undefined)[]),
        loan.currentAgent?.name,
        ...((loan.currentAgent?.aliases ?? []) as (string | null | undefined)[]),
        loan.currentAgentName,
        ...((loan.currentAgentAliases ?? []) as (string | null | undefined)[]),
    ]
        .filter((value): value is string => Boolean(value))
        .map((value) => normalizeLabel(value));
    return haystack.some((value) => value.includes(normalized));
}
