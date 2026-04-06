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
        const scheduledTotal = Number(row.scheduledPrincipal) + Number(row.scheduledInterest) + Number(row.scheduledFee);
        if (scheduledTotal <= 0) return sum;
        return sum + (Number(row.remainingDue) * (Number(row.scheduledPrincipal) / scheduledTotal));
    }, 0);
    const outstandingInterest = schedules.reduce((sum, row) => {
        const scheduledTotal = Number(row.scheduledPrincipal) + Number(row.scheduledInterest) + Number(row.scheduledFee);
        if (scheduledTotal <= 0) return sum;
        return sum + (Number(row.remainingDue) * (Number(row.scheduledInterest) / scheduledTotal));
    }, 0);
    const outstandingFees = schedules.reduce((sum, row) => {
        const scheduledTotal = Number(row.scheduledPrincipal) + Number(row.scheduledInterest) + Number(row.scheduledFee);
        if (scheduledTotal <= 0) return sum;
        return sum + (Number(row.remainingDue) * (Number(row.scheduledFee) / scheduledTotal));
    }, 0);

    let nextDueDate: string | null = null;
    for (const row of schedules) {
        if (Number(row.remainingDue) > 0) {
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
