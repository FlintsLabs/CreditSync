interface ScheduleLike {
    dueDate: string;
    status: string;
    scheduledPrincipal: string;
    scheduledInterest: string;
    scheduledFee: string;
    scheduledVat: string;
    paidTotal: string;
    remainingDue: string;
}

function roundMoney(value: number) {
    return Number(value.toFixed(2));
}

export function computeBankLoanRollup(schedules: ScheduleLike[]) {
    const outstandingPrincipal = schedules.reduce(
        (sum, item) => sum + Math.max(0, Number(item.scheduledPrincipal) - Math.min(Number(item.paidTotal), Number(item.scheduledPrincipal))),
        0
    );

    const outstandingInterest = schedules.reduce((sum, item) => {
        const scheduled = Number(item.scheduledInterest) + Number(item.scheduledFee) + Number(item.scheduledVat);
        const principalPaidCap = Math.min(Number(item.paidTotal), Number(item.scheduledPrincipal));
        const paidBeyondPrincipal = Math.max(0, Number(item.paidTotal) - principalPaidCap);
        return sum + Math.max(0, scheduled - paidBeyondPrincipal);
    }, 0);

    const outstandingFees = schedules.reduce((sum, item) => sum + Number(item.remainingDue), 0) - outstandingPrincipal - outstandingInterest;

    const nextDue = schedules.find((item) => item.status !== "paid" && item.remainingDue !== "0");

    return {
        outstandingPrincipal: roundMoney(outstandingPrincipal),
        outstandingInterest: roundMoney(outstandingInterest),
        outstandingFees: roundMoney(Math.max(0, outstandingFees)),
        nextDueDate: nextDue?.dueDate ?? null,
        status: schedules.every((item) => item.status === "paid") ? "closed" : "active",
    };
}
