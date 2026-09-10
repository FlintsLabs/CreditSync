import Decimal from "decimal.js";

export type BatchIntent = "on_time" | "advance" | "backdated";
export type BatchItemDraft = {
    id: string;
    paymentIntakePublicId: string;
    amount: string;
    targetDueDate: string;
    intent: BatchIntent;
    loanPublicId: string;
    schedulePublicId: string;
    receivedAt?: string;
    file?: File;
    stagingItemPublicId?: string;
    batchItemPublicId?: string;
    payerName?: string;
    bankReference?: string;
    candidates?: BatchCandidateResult;
    selectedBorrowerPublicId?: string;
    allocations?: Array<{ loanPublicId: string; schedulePublicId?: string; amount: string }>;
    error?: string;
    revision?: number;
    evidenceStatus?: string | null;
    uploadStatus?: "pending" | "uploading" | "ready" | "failed";
    reviewedEditPending?: boolean;
    ocrProposal?: {
        status: "needs_human_review";
        reviewRequired: true;
        amount: string | null;
        transferredAt: string | null;
        payerName: string | null;
        receiverName: string | null;
        fee: string | null;
        evidenceSha256: string;
    };
};

export type BatchCandidateResult = {
    stagingItemPublicId: string;
    stagingRevision: number;
    batchRevision: number;
    inputFingerprint: string;
    borrowerResolution: string;
    borrowerCandidates: Array<{ publicId: string; name: string; matchType: string | null }>;
    contractCandidates: Array<{ borrowerPublicId: string; borrowerName: string; loanPublicId: string; repaymentType: string; status: string; eligible: boolean; eligibilityCode: string | null; startDate?: string | null; principalAmount?: string; outstandingPrincipal?: string; dueComponents: Record<string, string> | null; proposalComponents: Record<string, string> | null; schedules: Array<{ publicId: string; dueDate: string; status: string; remainingDue: string; components: Record<string, string> }> }>;
    candidateLimitReached: boolean;
    reviewRequired: boolean;
};

export type ExplicitBatchAllocation = {
    itemPublicId: string;
    borrowerPublicId?: string;
    loanPublicId: string;
    schedulePublicId?: string;
    amount: string;
    targetDueDate: string;
    intent: BatchIntent;
    calculatedComponents?: { principal: string; interest: string; fee: string; penalty: string };
};

export type BatchPreview = {
    publicId: string;
    status: string;
    version: number;
    previewHash: string;
    confirmationHash: string;
    evidenceReady: boolean;
    allocations: ExplicitBatchAllocation[];
    candidates: unknown[];
    warnings: Array<{ code: string; [key: string]: unknown }>;
};

export function normalizeBangkokDateTime(value: string): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const [, year, month, day, hour, minute] = match;
    if (Number(hour) > 23 || Number(minute) > 59) return null;
    const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return null;
    const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 7, Number(minute)));
    return candidate.toISOString();
}

export function toBangkokDateTimeInput(value: string | null | undefined): string {
    if (!value) return "";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function normalizeMoney(value: string): string {
    try { return new Decimal(value.trim() || "0").toFixed(2); } catch { return "0.00"; }
}

export function batchTotal(items: BatchItemDraft[]): string {
    return items.reduce((total, item) => total.plus(normalizeMoney(item.amount)), new Decimal(0)).toFixed(2);
}

export function isBatchReady(items: BatchItemDraft[], borrowerPublicId: string, confirmed: boolean, preview: BatchPreview | null): boolean {
    const readyPreview = preview;
    if (!readyPreview) return false;
    return confirmed && Boolean(borrowerPublicId.trim()) && items.length > 0 && readyPreview.status === "ready" && readyPreview.evidenceReady
        && readyPreview.warnings.length === 0 && readyPreview.allocations.length > 0
        && items.every((item) => item.paymentIntakePublicId.trim() && item.targetDueDate && item.loanPublicId && new Decimal(normalizeMoney(item.amount)).gt(0)
            && (item.allocations ?? [{ loanPublicId: item.loanPublicId, amount: item.amount }]).every((allocation) => allocation.loanPublicId && new Decimal(normalizeMoney(allocation.amount)).gt(0)));
}

export function toExplicitBatchAllocations(items: BatchItemDraft[], itemPublicIds: string[]): ExplicitBatchAllocation[] {
    if (items.length !== itemPublicIds.length) throw new Error("BATCH_ITEM_MAPPING_MISMATCH");
    return items.flatMap((item, index) => {
        const allocations = item.allocations?.length ? item.allocations : [{ loanPublicId: item.loanPublicId, schedulePublicId: item.schedulePublicId || undefined, amount: item.amount }];
        return allocations.map((allocation) => ({ itemPublicId: itemPublicIds[index], ...(item.selectedBorrowerPublicId ? { borrowerPublicId: item.selectedBorrowerPublicId } : {}), loanPublicId: allocation.loanPublicId, ...(allocation.schedulePublicId ? { schedulePublicId: allocation.schedulePublicId } : {}), amount: normalizeMoney(allocation.amount), targetDueDate: item.targetDueDate, intent: item.intent }));
    });
}

export function semanticSummary(items: BatchItemDraft[]) {
    return items.map((item) => ({ ...item, amount: normalizeMoney(item.amount) }));
}
