export interface LoanReplacementProposal {
    schemaVersion: 1;
    asOfDate: string;
    reason: string;
    oldLoan: {
        loanPublicId: string;
        statusBefore: "active";
        statusAfter: "replaced";
        principal: string;
        collectibleBefore: {
            principal: string;
            interest: string;
            fee: string;
            penalty: string;
            nextDueDate: string | null;
        };
        collectibleAfter: {
            principal: "0.00";
            interest: "0.00";
            fee: "0.00";
            penalty: "0.00";
            nextDueDate: null;
        };
    };
    cash: { direction: "none"; amount: "0.00" };
    correction: {
        principal: string;
        interest: string;
        fee: string;
        penalty: string;
    };
    replacement: {
        loanPublicId: string;
        statusBefore: "draft";
        statusAfter: "active";
        principal: string;
        interestRate: string;
        repaymentType: "daily" | "weekly" | "monthly";
        termMonths: number;
        totalInstallments: number;
        installmentAmount: string;
        startDate: string;
        firstDueDate: string;
        lastDueDate: string;
        totalRepayment: string;
        fundingSourceKind: "drawdown" | "own_capital";
        fundingSourcePublicId: string;
    };
    warnings: string[];
}

export interface LegacyLoanReplacementProposal {
    schemaVersion: 0;
    asOfDate: string;
    reason: string;
    legacy: true;
    proposalUnavailable: true;
}

export type PersistedLoanReplacementProposal =
    | LoanReplacementProposal
    | LegacyLoanReplacementProposal;

const publicUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const moneyPattern = /^(?:0|[1-9]\d*)\.\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPublicUuid(value: unknown): value is string {
    return typeof value === "string" && publicUuidPattern.test(value);
}

function isDate(value: unknown): value is string {
    return typeof value === "string" && datePattern.test(value);
}

function isMoney(value: unknown): value is string {
    return typeof value === "string" && moneyPattern.test(value);
}

function isCollectible(value: unknown, afterReplacement: boolean): boolean {
    if (!isRecord(value) || !hasExactKeys(value, [
        "principal", "interest", "fee", "penalty", "nextDueDate",
    ])) return false;
    if (!isMoney(value.principal)
        || !isMoney(value.interest)
        || !isMoney(value.fee)
        || !isMoney(value.penalty)
        || (value.nextDueDate !== null && !isDate(value.nextDueDate))) return false;
    return !afterReplacement || (
        value.principal === "0.00"
        && value.interest === "0.00"
        && value.fee === "0.00"
        && value.penalty === "0.00"
        && value.nextDueDate === null
    );
}

export function isLoanReplacementProposal(value: unknown): value is LoanReplacementProposal {
    if (!isRecord(value) || !hasExactKeys(value, [
        "schemaVersion", "asOfDate", "reason", "oldLoan", "cash", "correction", "replacement", "warnings",
    ])) return false;
    if (value.schemaVersion !== 1
        || !isDate(value.asOfDate)
        || typeof value.reason !== "string"
        || value.reason.trim().length === 0
        || !Array.isArray(value.warnings)
        || !value.warnings.every((warning) => typeof warning === "string")) return false;

    const oldLoan = value.oldLoan;
    if (!isRecord(oldLoan) || !hasExactKeys(oldLoan, [
        "loanPublicId", "statusBefore", "statusAfter", "principal", "collectibleBefore", "collectibleAfter",
    ])) return false;
    if (!isPublicUuid(oldLoan.loanPublicId)
        || oldLoan.statusBefore !== "active"
        || oldLoan.statusAfter !== "replaced"
        || !isMoney(oldLoan.principal)
        || !isCollectible(oldLoan.collectibleBefore, false)
        || !isCollectible(oldLoan.collectibleAfter, true)) return false;

    const cash = value.cash;
    if (!isRecord(cash)
        || !hasExactKeys(cash, ["direction", "amount"])
        || cash.direction !== "none"
        || cash.amount !== "0.00") return false;

    const correction = value.correction;
    if (!isRecord(correction)
        || !hasExactKeys(correction, ["principal", "interest", "fee", "penalty"])
        || !isMoney(correction.principal)
        || !isMoney(correction.interest)
        || !isMoney(correction.fee)
        || !isMoney(correction.penalty)) return false;

    const replacement = value.replacement;
    if (!isRecord(replacement) || !hasExactKeys(replacement, [
        "loanPublicId", "statusBefore", "statusAfter", "principal", "interestRate", "repaymentType",
        "termMonths", "totalInstallments", "installmentAmount", "startDate", "firstDueDate", "lastDueDate",
        "totalRepayment", "fundingSourceKind", "fundingSourcePublicId",
    ])) return false;
    return isPublicUuid(replacement.loanPublicId)
        && replacement.statusBefore === "draft"
        && replacement.statusAfter === "active"
        && isMoney(replacement.principal)
        && isMoney(replacement.interestRate)
        && ["daily", "weekly", "monthly"].includes(String(replacement.repaymentType))
        && Number.isInteger(replacement.termMonths)
        && Number(replacement.termMonths) > 0
        && Number.isInteger(replacement.totalInstallments)
        && Number(replacement.totalInstallments) > 0
        && isMoney(replacement.installmentAmount)
        && isDate(replacement.startDate)
        && isDate(replacement.firstDueDate)
        && isDate(replacement.lastDueDate)
        && isMoney(replacement.totalRepayment)
        && ["drawdown", "own_capital"].includes(String(replacement.fundingSourceKind))
        && isPublicUuid(replacement.fundingSourcePublicId);
}

export function isLegacyLoanReplacementProposal(
    value: unknown,
): value is LegacyLoanReplacementProposal {
    return isRecord(value)
        && hasExactKeys(value, ["schemaVersion", "asOfDate", "reason", "legacy", "proposalUnavailable"])
        && value.schemaVersion === 0
        && isDate(value.asOfDate)
        && typeof value.reason === "string"
        && value.reason.trim().length > 0
        && value.legacy === true
        && value.proposalUnavailable === true;
}
