interface LoanScheduleLike {
    dueDate: string;
    scheduledPrincipal: string;
    scheduledInterest: string;
    scheduledFee: string;
    remainingDue: string;
    status: string;
}

export function computeLoanRollup(schedules: LoanScheduleLike[]) {
    const outstandingPrincipal = schedules.reduce((sum, row) => {
        const scheduledTotal = new Decimal(row.scheduledPrincipal).plus(row.scheduledInterest).plus(row.scheduledFee);
        if (scheduledTotal.lte(0)) return sum;
        return sum.plus(new Decimal(row.remainingDue).times(new Decimal(row.scheduledPrincipal).div(scheduledTotal)));
    }, new Decimal(0));
    const outstandingInterest = schedules.reduce((sum, row) => {
        const scheduledTotal = new Decimal(row.scheduledPrincipal).plus(row.scheduledInterest).plus(row.scheduledFee);
        if (scheduledTotal.lte(0)) return sum;
        return sum.plus(new Decimal(row.remainingDue).times(new Decimal(row.scheduledInterest).div(scheduledTotal)));
    }, new Decimal(0));
    const outstandingFees = schedules.reduce((sum, row) => {
        const scheduledTotal = new Decimal(row.scheduledPrincipal).plus(row.scheduledInterest).plus(row.scheduledFee);
        if (scheduledTotal.lte(0)) return sum;
        return sum.plus(new Decimal(row.remainingDue).times(new Decimal(row.scheduledFee).div(scheduledTotal)));
    }, new Decimal(0));

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
import Decimal from "decimal.js";
