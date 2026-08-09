import Decimal from "decimal.js";

interface LoanScheduleLike {
    dueDate: string;
    scheduledPrincipal: string;
    scheduledInterest: string;
    scheduledFee: string;
    remainingDue: string;
    status: string;
}

function remainingComponents(row: LoanScheduleLike) {
    const scheduledFee = new Decimal(row.scheduledFee);
    const scheduledInterest = new Decimal(row.scheduledInterest);
    const scheduledPrincipal = new Decimal(row.scheduledPrincipal);
    const scheduledTotal = scheduledFee.plus(scheduledInterest).plus(scheduledPrincipal);
    let paid = Decimal.max(0, scheduledTotal.minus(row.remainingDue));

    const feePaid = Decimal.min(paid, scheduledFee);
    paid = paid.minus(feePaid);
    const interestPaid = Decimal.min(paid, scheduledInterest);
    paid = paid.minus(interestPaid);
    const principalPaid = Decimal.min(paid, scheduledPrincipal);

    return {
        principal: Decimal.max(0, scheduledPrincipal.minus(principalPaid)),
        interest: Decimal.max(0, scheduledInterest.minus(interestPaid)),
        fee: Decimal.max(0, scheduledFee.minus(feePaid)),
    };
}

export function computeLoanRollup(schedules: LoanScheduleLike[]) {
    const components = schedules.map(remainingComponents);
    const outstandingPrincipal = components.reduce((sum, row) => sum.plus(row.principal), new Decimal(0));
    const outstandingInterest = components.reduce((sum, row) => sum.plus(row.interest), new Decimal(0));
    const outstandingFees = components.reduce((sum, row) => sum.plus(row.fee), new Decimal(0));

    let nextDueDate: string | null = null;
    for (const row of schedules) {
        if (new Decimal(row.remainingDue).gt(0)) {
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
