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

/** Replaced/restructured are terminal lifecycle states; they remain visible as history, not active collection targets. */
export function isDoneLoanStatus(status: string): boolean {
    return status === "paid" || status === "closed" || status === "replaced" || status === "restructured";
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
