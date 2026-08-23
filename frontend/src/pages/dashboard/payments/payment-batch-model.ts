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
};

export type ExplicitBatchAllocation = {
    itemPublicId: string;
    loanPublicId: string;
    schedulePublicId: string;
    amount: string;
    targetDueDate: string;
    intent: BatchIntent;
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

export function normalizeMoney(value: string): string {
    try { return new Decimal(value.trim() || "0").toFixed(2); } catch { return "0.00"; }
}

export function batchTotal(items: BatchItemDraft[]): string {
    return items.reduce((total, item) => total.plus(normalizeMoney(item.amount)), new Decimal(0)).toFixed(2);
}

export function isBatchReady(items: BatchItemDraft[], borrowerPublicId: string, confirmed: boolean, preview: BatchPreview | null): boolean {
    if (!preview) return false;
    return confirmed && Boolean(borrowerPublicId.trim()) && items.length > 0 && preview.status === "ready" && preview.evidenceReady
        && preview.warnings.length === 0 && preview.allocations.length > 0
        && items.every((item) => item.paymentIntakePublicId.trim() && item.targetDueDate && item.loanPublicId && item.schedulePublicId && new Decimal(normalizeMoney(item.amount)).gt(0));
}

export function toExplicitBatchAllocations(items: BatchItemDraft[], itemPublicIds: string[]): ExplicitBatchAllocation[] {
    if (items.length !== itemPublicIds.length) throw new Error("BATCH_ITEM_MAPPING_MISMATCH");
    return items.map((item, index) => ({
        itemPublicId: itemPublicIds[index], loanPublicId: item.loanPublicId, schedulePublicId: item.schedulePublicId,
        amount: normalizeMoney(item.amount), targetDueDate: item.targetDueDate, intent: item.intent,
    }));
}

export function semanticSummary(items: BatchItemDraft[]) {
    return items.map((item) => ({ ...item, amount: normalizeMoney(item.amount) }));
}
