import { formatMoneyExact } from "../../../lib/workflow-model";

export type RenewalSettlementPolicy = "full_contract_interest" | "accrued_to_date";
export type RenewalAdjustmentKind = "fee" | "penalty" | "other_charge" | "waiver";
export type RenewalAdjustmentDraft = { kind: RenewalAdjustmentKind; amount: string; reason: string };

export interface RenewalComposition {
    settlementPolicy: RenewalSettlementPolicy;
    contractStartDate: string;
    contractDueDate: string;
    renewalDate: string;
    requestedPrincipal: string;
    originalPrincipal: string;
    totalScheduledAmount: string;
    contractualInterest: string;
    totalPaid: string;
    receivedPrincipal: string;
    receivedInterest: string;
    remainingContractInterest: string;
    accruedDueInterest: string;
    dueFees: string;
    duePenalties: string;
    recoveredBeforeAdjustments: string;
    manualCharges: string;
    manualWaivers: string;
    settlementAmount: string;
    cashDirection: "payout" | "collection" | "none";
    cashAmount: string;
    payments: Array<{ transactionPublicId: string; paidAt: string; amount: string; principal: string; interest: string; fee: string; penalty: string }>;
    adjustments: Array<RenewalAdjustmentDraft & { lineNo: number }>;
}

export const defaultRenewalPolicy: RenewalSettlementPolicy = "full_contract_interest";

export function newRenewalAdjustment(): RenewalAdjustmentDraft {
    return { kind: "fee", amount: "", reason: "" };
}

export function invalidateRenewalApproval<T extends { preview: unknown; confirmed: boolean; collectionConfirmed: boolean; executionIntentKey: string | null }>(state: T): T {
    return { ...state, preview: null, confirmed: false, collectionConfirmed: false, executionIntentKey: null };
}

export function displayRenewalMoney(value: string, language: string) {
    return formatMoneyExact(value, language);
}

export function canExecuteRenewal(
    cashDirection: RenewalComposition["cashDirection"],
    confirmed: boolean,
    collectionConfirmed: boolean,
) {
    return confirmed && (cashDirection !== "collection" || collectionConfirmed);
}
