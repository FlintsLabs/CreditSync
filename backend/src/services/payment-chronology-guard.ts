export function bangkokBusinessDate(value: Date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

export type ChronologyItem = {
    itemId: string;
    borrowerId: string | null;
    receivedAt: string | null;
    evidenceReady?: boolean;
};

export type PendingChronologyItem = ChronologyItem & { status: string };

export type ChronologyBlocker =
    | { code: "OLDER_PENDING_PAYMENT"; itemId: string; blockingItemId: string }
    | { code: "UNKNOWN_TRANSFER_TIME"; itemId: string }
    | { code: "FUTURE_TRANSFER_TIMESTAMP"; itemId: string; now: string }
    | { code: "MISSING_EVIDENCE"; itemId: string };

export type ChronologyDecision = { itemId: string; kind: "advance_obligation"; obligationDate: string };

export type ChronologyResult = {
    status: "ready" | "chronology_conflict" | "missing_evidence";
    orderedItemIds: string[];
    warnings: Array<{ code: "MISSING_CALENDAR_EVIDENCE"; fromDate: string; toDate: string }>;
    blockers: ChronologyBlocker[];
    decisions: ChronologyDecision[];
};

type Input = {
    now: string;
    borrowerId: string | null;
    pending: PendingChronologyItem[];
    incoming: ChronologyItem[];
    obligationDates?: Record<string, string>;
};

const TERMINAL_PENDING_STATUSES = new Set(["posted", "cancelled", "duplicate", "reversed"]);

function validDate(value: string | null | undefined) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function nextDate(value: string) {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}

function previousDate(value: string) {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
}

function compareChronology(left: ChronologyItem, right: ChronologyItem) {
    const leftDate = validDate(left.receivedAt);
    const rightDate = validDate(right.receivedAt);
    if (leftDate && rightDate) return leftDate.getTime() - rightDate.getTime() || left.itemId.localeCompare(right.itemId);
    if (leftDate) return -1;
    if (rightDate) return 1;
    return left.itemId.localeCompare(right.itemId);
}

export function evaluatePaymentChronology(input: Input): ChronologyResult {
    const incoming = input.incoming.filter((item) => item.borrowerId === input.borrowerId);
    const ordered = [...incoming].sort(compareChronology);
    const blockers: ChronologyBlocker[] = [];
    const warnings: ChronologyResult["warnings"] = [];
    const decisions: ChronologyDecision[] = [];
    const now = new Date(input.now);
    const relevantPending = input.pending
        .filter((item) => item.borrowerId === input.borrowerId)
        .filter((item) => !TERMINAL_PENDING_STATUSES.has(item.status))
        .sort(compareChronology);

    for (const item of ordered) {
        if (!item.receivedAt) {
            blockers.push({ code: "UNKNOWN_TRANSFER_TIME", itemId: item.itemId });
            continue;
        }
        const received = validDate(item.receivedAt);
        if (!received) {
            blockers.push({ code: "UNKNOWN_TRANSFER_TIME", itemId: item.itemId });
            continue;
        }
        if (received.getTime() > now.getTime()) blockers.push({ code: "FUTURE_TRANSFER_TIMESTAMP", itemId: item.itemId, now: input.now });
        const older = relevantPending.find((pending) => {
            const pendingReceived = validDate(pending.receivedAt);
            return pending.itemId !== item.itemId && pendingReceived && pendingReceived.getTime() < received.getTime();
        });
        if (older) blockers.push({ code: "OLDER_PENDING_PAYMENT", itemId: item.itemId, blockingItemId: older.itemId });
        const obligationDate = input.obligationDates?.[item.itemId];
        if (obligationDate && obligationDate > bangkokBusinessDate(received)) decisions.push({ itemId: item.itemId, kind: "advance_obligation", obligationDate });
        if (item.evidenceReady === false) blockers.push({ code: "MISSING_EVIDENCE", itemId: item.itemId });
    }

    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]!;
        const current = ordered[index]!;
        if (!previous.receivedAt || !current.receivedAt) continue;
        const previousReceived = validDate(previous.receivedAt);
        const currentReceived = validDate(current.receivedAt);
        if (!previousReceived || !currentReceived) continue;
        const previousBusinessDate = bangkokBusinessDate(previousReceived);
        const currentDate = bangkokBusinessDate(currentReceived);
        if (previousBusinessDate !== currentDate && nextDate(previousBusinessDate) < currentDate) warnings.push({ code: "MISSING_CALENDAR_EVIDENCE", fromDate: nextDate(previousBusinessDate), toDate: previousDate(currentDate) });
    }

    const distinctWarnings = warnings.filter((warning, index) => warnings.findIndex((candidate) => candidate.fromDate === warning.fromDate && candidate.toDate === warning.toDate) === index);
    const missingEvidence = incoming.some((item) => item.evidenceReady === false);
    return {
        status: missingEvidence ? "missing_evidence" : blockers.length ? "chronology_conflict" : "ready",
        orderedItemIds: ordered.map((item) => item.itemId),
        warnings: distinctWarnings,
        blockers,
        decisions,
    };
}
