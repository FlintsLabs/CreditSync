import { FinancialDecimal } from "./financial-decimal";

interface LoanScheduleLike {
    dueDate: string;
    scheduledPrincipal: string;
    scheduledInterest: string;
    scheduledFee: string;
    remainingDue: string;
    status: string;
}

function remainingComponents(row: LoanScheduleLike) {
    const scheduledFee = new FinancialDecimal(row.scheduledFee);
    const scheduledInterest = new FinancialDecimal(row.scheduledInterest);
    const scheduledPrincipal = new FinancialDecimal(row.scheduledPrincipal);
    const scheduledTotal = scheduledFee.plus(scheduledInterest).plus(scheduledPrincipal);
    let paid = FinancialDecimal.max(new FinancialDecimal("0"), scheduledTotal.minus(row.remainingDue));

    const feePaid = FinancialDecimal.min(paid, scheduledFee);
    paid = paid.minus(feePaid);
    const interestPaid = FinancialDecimal.min(paid, scheduledInterest);
    paid = paid.minus(interestPaid);
    const principalPaid = FinancialDecimal.min(paid, scheduledPrincipal);

    return {
        principal: FinancialDecimal.max(new FinancialDecimal("0"), scheduledPrincipal.minus(principalPaid)),
        interest: FinancialDecimal.max(new FinancialDecimal("0"), scheduledInterest.minus(interestPaid)),
        fee: FinancialDecimal.max(new FinancialDecimal("0"), scheduledFee.minus(feePaid)),
    };
}

export function computeLoanRollup(schedules: LoanScheduleLike[]) {
    const components = schedules.map(remainingComponents);
    const outstandingPrincipal = components.reduce((sum, row) => sum.plus(row.principal), new FinancialDecimal("0"));
    const outstandingInterest = components.reduce((sum, row) => sum.plus(row.interest), new FinancialDecimal("0"));
    const outstandingFees = components.reduce((sum, row) => sum.plus(row.fee), new FinancialDecimal("0"));

    let nextDueDate: string | null = null;
    for (const row of schedules) {
        if (new FinancialDecimal(row.remainingDue).gt(0)) {
            nextDueDate = row.dueDate;
            break;
        }
    }

    return {
        outstandingPrincipal,
        outstandingInterest,
        outstandingFees,
        nextDueDate,
        status: nextDueDate ? "active" : "paid",
    };
}
