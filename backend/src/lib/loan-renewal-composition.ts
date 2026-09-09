import { FinancialDecimal } from "./financial-decimal";
import { parseMoney, serializeMoney } from "./money";

export type RenewalSettlementPolicy = "full_contract_interest" | "accrued_to_date";
export type RenewalAdjustmentKind = "fee" | "penalty" | "other_charge" | "waiver";
export type RenewalManualAdjustment = { kind: RenewalAdjustmentKind; amount: string; reason: string };

export interface RenewalCompositionInput {
    settlementPolicy: RenewalSettlementPolicy;
    renewalDate: string;
    requestedPrincipal: string;
    originalPrincipal: string;
    contractStartDate: string;
    contractDueDate: string;
    schedules: Array<{ dueDate: string; principal: string; interest: string; fee: string }>;
    payments: Array<{ transactionPublicId: string; paidAt: string; amount: string; principal: string; interest: string; fee: string; penalty: string }>;
    accruedDueInterest: string;
    dueFees: string;
    duePenalties: string;
    adjustments: RenewalManualAdjustment[];
}

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
    payments: RenewalCompositionInput["payments"];
    adjustments: Array<RenewalManualAdjustment & { lineNo: number }>;
}

const policies = new Set<RenewalSettlementPolicy>(["full_contract_interest", "accrued_to_date"]);
const adjustmentKinds = new Set<RenewalAdjustmentKind>(["fee", "penalty", "other_charge", "waiver"]);

function invalid(code: string): never {
    throw new Error(code);
}

function money(value: string) {
    try {
        return new FinancialDecimal(parseMoney(value).toFixed(2));
    } catch {
        return invalid("INVALID_RENEWAL_MONEY");
    }
}

function sum(values: string[]) {
    return values.reduce((total, value) => total.plus(money(value)), new FinancialDecimal("0"));
}

export function calculateRenewalComposition(input: RenewalCompositionInput): RenewalComposition {
    if (!policies.has(input.settlementPolicy)) invalid("INVALID_RENEWAL_SETTLEMENT_POLICY");

    const requestedPrincipal = money(input.requestedPrincipal);
    const originalPrincipal = money(input.originalPrincipal);
    const accruedDueInterest = money(input.accruedDueInterest);
    const dueFees = money(input.dueFees);
    const duePenalties = money(input.duePenalties);

    for (const row of input.schedules) {
        money(row.principal);
        money(row.interest);
        money(row.fee);
    }
    for (const row of input.payments) {
        money(row.amount);
        money(row.principal);
        money(row.interest);
        money(row.fee);
        money(row.penalty);
    }

    const adjustments = input.adjustments.map((line, index) => {
        if (!adjustmentKinds.has(line.kind)) invalid("INVALID_RENEWAL_ADJUSTMENT_KIND");
        const amount = money(line.amount);
        if (!amount.gt(0)) invalid("INVALID_RENEWAL_ADJUSTMENT_AMOUNT");
        if (!line.reason.trim()) invalid("RENEWAL_ADJUSTMENT_REASON_REQUIRED");
        return { ...line, lineNo: index + 1 };
    });

    const contractualInterest = sum(input.schedules.map((row) => row.interest));
    const totalScheduledAmount = input.schedules.reduce(
        (total, row) => total.plus(money(row.principal)).plus(money(row.interest)).plus(money(row.fee)),
        new FinancialDecimal("0"),
    );
    const totalPaid = sum(input.payments.map((row) => row.amount));
    const receivedPrincipal = sum(input.payments.map((row) => row.principal));
    const receivedInterest = sum(input.payments.map((row) => row.interest));
    const remainingContractInterest = FinancialDecimal.max(contractualInterest.minus(receivedInterest), "0");
    const recoveredBeforeAdjustments = FinancialDecimal.max(totalPaid.minus(contractualInterest), "0");
    const oldOutstandingPrincipal = FinancialDecimal.max(originalPrincipal.minus(receivedPrincipal), "0");
    const manualCharges = sum(adjustments.filter((line) => line.kind !== "waiver").map((line) => line.amount));
    const manualWaivers = sum(adjustments.filter((line) => line.kind === "waiver").map((line) => line.amount));
    const policyInterest = input.settlementPolicy === "full_contract_interest"
        ? remainingContractInterest
        : accruedDueInterest;
    const eligibleCharges = policyInterest.plus(dueFees).plus(duePenalties).plus(manualCharges);
    if (manualWaivers.gt(eligibleCharges)) invalid("RENEWAL_WAIVER_EXCEEDS_ELIGIBLE_CHARGES");
    const settlementAmount = eligibleCharges.minus(manualWaivers);
    const netCash = requestedPrincipal.minus(oldOutstandingPrincipal).minus(settlementAmount);
    const cashDirection = netCash.gt(0) ? "payout" : netCash.lt(0) ? "collection" : "none";

    return {
        settlementPolicy: input.settlementPolicy,
        contractStartDate: input.contractStartDate,
        contractDueDate: input.contractDueDate,
        renewalDate: input.renewalDate,
        requestedPrincipal: serializeMoney(requestedPrincipal),
        originalPrincipal: serializeMoney(originalPrincipal),
        totalScheduledAmount: serializeMoney(totalScheduledAmount),
        contractualInterest: serializeMoney(contractualInterest),
        totalPaid: serializeMoney(totalPaid),
        receivedPrincipal: serializeMoney(receivedPrincipal),
        receivedInterest: serializeMoney(receivedInterest),
        remainingContractInterest: serializeMoney(remainingContractInterest),
        accruedDueInterest: serializeMoney(accruedDueInterest),
        dueFees: serializeMoney(dueFees),
        duePenalties: serializeMoney(duePenalties),
        recoveredBeforeAdjustments: serializeMoney(recoveredBeforeAdjustments),
        manualCharges: serializeMoney(manualCharges),
        manualWaivers: serializeMoney(manualWaivers),
        settlementAmount: serializeMoney(settlementAmount),
        cashDirection,
        cashAmount: serializeMoney(netCash.abs()),
        payments: input.payments.map((row) => ({ ...row })),
        adjustments,
    };
}
