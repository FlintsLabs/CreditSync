import Decimal from "decimal.js";
import type { BatchCandidate, BatchObligation, BatchSlip, BatchSolveInput, BatchSolveResult, BatchWarning, ExplicitBatchAllocation } from "./payment-batch-types";

export const MAX_BATCH_ITEMS = 50;
export const MAX_BATCH_OBLIGATIONS = 200;
export const MAX_BATCH_CANDIDATES = 25;
export const MAX_SOLVER_STATES = 100_000;

const moneyPattern = /^(?:0|[1-9]\d*)\.\d{2}$/;

function cents(value: string, field: string): bigint {
    if (!moneyPattern.test(value) || value.startsWith("-")) throw new Error(`${field} must use exactly two decimal places`);
    try {
        return BigInt(value.replace(".", ""));
    } catch {
        throw new Error(`${field} must use exactly two decimal places`);
    }
}

function money(value: bigint) {
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const text = absolute.toString().padStart(3, "0");
    return `${negative ? "-" : ""}${text.slice(0, -2)}.${text.slice(-2)}`;
}

function compareObligations(left: BatchObligation, right: BatchObligation) {
    return left.dueDate.localeCompare(right.dueDate)
        || left.loanPublicId.localeCompare(right.loanPublicId)
        || left.schedulePublicId.localeCompare(right.schedulePublicId);
}

function eligibleForSlip(obligation: BatchObligation, slip: BatchSlip) {
    const requestedDate = slip.requestedDueDate;
    if (requestedDate && obligation.dueDate !== requestedDate) return false;
    const receivedDate = slip.receivedAt.slice(0, 10);
    return obligation.dueDate <= receivedDate || slip.allowAdvance === true;
}

function allocationFor(slip: BatchSlip, obligation: BatchObligation, amount: bigint, intent: ExplicitBatchAllocation["intent"]): ExplicitBatchAllocation {
    return {
        itemPublicId: slip.itemPublicId,
        schedulePublicId: obligation.schedulePublicId,
        loanPublicId: obligation.loanPublicId,
        amount: money(amount),
        targetDueDate: obligation.dueDate,
        intent,
        matchSource: "unique_exact",
    };
}

type Option = { allocations: ExplicitBatchAllocation[]; used: Set<number> };

export function solvePaymentBatch(input: BatchSolveInput): BatchSolveResult {
    if (input.slips.length > MAX_BATCH_ITEMS) return limitedResult();
    if (input.obligations.length > MAX_BATCH_OBLIGATIONS) return limitedResult();
    const obligations = [...input.obligations].sort(compareObligations);
    const obligationCents = obligations.map((item) => cents(item.remainingDue, "remainingDue"));
    const slipCents = input.slips.map((item) => cents(item.amount, "amount"));
    const warnings: BatchWarning[] = [];
    for (const slip of input.slips) {
        const future = obligations.some((item) => item.dueDate > slip.receivedAt.slice(0, 10));
        if (future && !slip.allowAdvance && !obligations.some((item) => eligibleForSlip(item, slip))) {
            warnings.push({ code: "IMPLICIT_ADVANCE_NOT_ALLOWED", itemPublicId: slip.itemPublicId, message: "Future obligations require explicit advance intent" });
        }
    }
    if (warnings.length) return { status: "needs_review", allocations: [], candidates: [], warnings };

    let states = 0;
    let limited = false;
    const candidates: BatchCandidate[] = [];
    const seen = new Set<string>();

    const optionsFor = (slip: BatchSlip, target: bigint, used: Set<number>): Option[] => {
        const options: Option[] = [];
        const selected: ExplicitBatchAllocation[] = [];
        const selectedIds = new Set<number>();
        const visit = (start: number, remaining: bigint) => {
            if (++states > MAX_SOLVER_STATES) { limited = true; return; }
            if (remaining === 0n) {
                options.push({ allocations: [...selected], used: new Set(selectedIds) });
                return;
            }
            for (let index = start; index < obligations.length; index++) {
                if (used.has(index) || selectedIds.has(index) || !eligibleForSlip(obligations[index]!, slip)) continue;
                const available = obligationCents[index]!;
                if (available <= 0n || available > remaining) continue;
                selectedIds.add(index);
                const intent = obligations[index]!.dueDate > slip.receivedAt.slice(0, 10) ? "advance" : "on_time";
                selected.push(allocationFor(slip, obligations[index]!, available, intent));
                visit(index + 1, remaining - available);
                selected.pop();
                selectedIds.delete(index);
            }
        };
        visit(0, target);
        return options;
    };

    const visitSlips = (slipIndex: number, used: Set<number>, allocations: ExplicitBatchAllocation[]) => {
        if (candidates.length >= MAX_BATCH_CANDIDATES) { limited = true; return; }
        if (slipIndex === input.slips.length) {
            const key = allocations.map((item) => `${item.itemPublicId}:${item.schedulePublicId}:${item.amount}:${item.targetDueDate}:${item.intent}`).join("|");
            if (!seen.has(key)) { seen.add(key); candidates.push({ allocations: [...allocations] }); }
            return;
        }
        const slip = input.slips[slipIndex]!;
        for (const option of optionsFor(slip, slipCents[slipIndex]!, used)) {
            visitSlips(slipIndex + 1, new Set([...used, ...option.used]), [...allocations, ...option.allocations]);
            if (limited && candidates.length >= MAX_BATCH_CANDIDATES) return;
        }
    };
    visitSlips(0, new Set(), []);
    const resultWarnings = limited ? [{ code: "BATCH_SOLVER_LIMIT_REACHED", message: "The bounded solver reached its safety limit" }] : [];
    if (limited) return { status: "needs_review", allocations: [], candidates, warnings: resultWarnings };
    if (candidates.length === 1) return { status: "ready", allocations: candidates[0]!.allocations, candidates, warnings: resultWarnings };
    return { status: "needs_review", allocations: [], candidates, warnings: candidates.length ? resultWarnings : [{ code: "NO_EXACT_ALLOCATION", message: "No exact allocation covers every slip" }] };
}

function limitedResult(): BatchSolveResult {
    return { status: "needs_review", allocations: [], candidates: [], warnings: [{ code: "BATCH_SOLVER_LIMIT_REACHED", message: "The bounded solver reached its safety limit" }] };
}

export function validateBatchMoney(value: string) {
    cents(value, "money");
    return new Decimal(value);
}
