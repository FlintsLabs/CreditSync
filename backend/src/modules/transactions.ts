import { Elysia, t } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, fundLedgerEntries, loanFundingAllocations, loanSchedules, loans, transactions } from "../db/schema";
import { uploadFile } from "../lib/storage";
import { authPlugin } from "../middleware/auth";
import { computeLoanRollup } from "../lib/loan-rollup";
import { createAuditLog } from "../lib/audit-log";
import { computeOverdueSnapshot } from "../lib/overdue";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";

export const transactionsRoute = new Elysia({ prefix: "/transactions" })
    .use(authPlugin)
    .get("/", async ({ user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "transactions",
            key: "list",
            ttlSeconds: 20,
            loader: async () => await db.select({
                id: transactions.id,
                loanId: transactions.loanId,
                scheduleId: transactions.scheduleId,
                borrowerName: borrowers.name,
                amount: transactions.amount,
                principalComponent: transactions.principalComponent,
                interestComponent: transactions.interestComponent,
                feeComponent: transactions.feeComponent,
                penaltyComponent: transactions.penaltyComponent,
                type: transactions.type,
                date: transactions.transactionDate,
                slipUrl: transactions.slipUrl
            })
                .from(transactions)
                .leftJoin(loans, eq(transactions.loanId, loans.id))
                .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                .where(eq(transactions.tenantId, user.tenantId))
                .orderBy(desc(transactions.transactionDate)),
        });
    })
    .post("/", async ({ body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        let slipUrl = null;
        if (body.slip) {
            const file = body.slip;
            const key = `slips/${Date.now()}_${file.name}`;
            try {
                const buffer = await file.arrayBuffer();
                slipUrl = await uploadFile(key, Buffer.from(buffer), file.type);
            } catch (error) {
                console.error("Slip upload failed", error);
            }
        }

        const loanId = Number(body.loanId);

        const created = await db.transaction(async (tx) => {
            const loan = await tx.query.loans.findFirst({
                where: and(eq(loans.id, loanId), eq(loans.tenantId, user.tenantId)),
            });

            if (!loan) {
                set.status = 404;
                return { error: "Loan not found" };
            }

            const targetSchedule = body.scheduleId
                ? await tx.query.loanSchedules.findFirst({
                    where: and(
                        eq(loanSchedules.id, Number(body.scheduleId)),
                        eq(loanSchedules.loanId, loanId),
                        eq(loanSchedules.tenantId, user.tenantId)
                    ),
                })
                : await tx.select().from(loanSchedules).where(
                    and(
                        eq(loanSchedules.loanId, loanId),
                        eq(loanSchedules.tenantId, user.tenantId)
                    )
                ).orderBy(loanSchedules.installmentNo).then((rows) =>
                    rows.find((row) => Number(row.remainingDue) > 0)
                );

            const paymentAmount = Number(body.amount);
            if (paymentAmount <= 0) {
                set.status = 400;
                return { error: "Payment amount must be greater than zero" };
            }

            let remainingPayment = paymentAmount;
            let totalPrincipalPaid = 0;
            let totalInterestPaid = 0;
            let totalFeePaid = 0;
            let totalPenaltyPaid = 0;

            const allAllocations = await tx.select().from(loanFundingAllocations).where(
                and(
                    eq(loanFundingAllocations.loanId, loanId),
                    eq(loanFundingAllocations.tenantId, user.tenantId)
                )
            );
            const totalAllocatedAmount = allAllocations.reduce((sum, row) => sum + Number(row.allocatedAmount), 0);

            // If a specific schedule was targeted, we only pay that one.
            // Otherwise, we pay all available schedules in order.
            const schedulesToPay = body.scheduleId
                ? [targetSchedule].filter((s): s is typeof loanSchedules.$inferSelect => !!s)
                : await tx.select().from(loanSchedules).where(
                    and(
                        eq(loanSchedules.loanId, loanId),
                        eq(loanSchedules.tenantId, user.tenantId)
                    )
                ).orderBy(loanSchedules.installmentNo).then((rows) =>
                    rows.filter((row) => Number(row.remainingDue) > 0)
                );

            const result = await tx.insert(transactions).values({
                tenantId: user.tenantId,
                loanId,
                scheduleId: targetSchedule?.id ?? null,
                amount: paymentAmount.toFixed(2),
                principalComponent: "0.00", // Will update after loop
                interestComponent: "0.00",
                feeComponent: "0.00",
                penaltyComponent: "0.00",
                type: body.type || "repayment",
                slipUrl,
                transactionDate: new Date(body.date),
                notes: body.notes,
                recordedByUserId: user.id,
            }).returning().then((rows) => rows[0]);

            for (const schedule of schedulesToPay) {
                if (remainingPayment <= 0) break;

                const scheduledPrincipal = Number(schedule.scheduledPrincipal);
                const scheduledInterest = Number(schedule.scheduledInterest);
                const scheduledFee = Number(schedule.scheduledFee);
                const currentPaid = Number(schedule.paidTotal);
                const currentPaidPenalty = Number(schedule.paidPenalty);
                const currentRemainingDue = Number(schedule.remainingDue);
                const overdue = computeOverdueSnapshot({
                    dueDate: schedule.dueDate,
                    remainingDue: currentRemainingDue,
                    paidPenalty: currentPaidPenalty,
                    gracePeriodDays: loan.gracePeriodDays,
                    lateFeeMode: loan.lateFeeMode,
                    lateFeeAmount: loan.lateFeeAmount,
                    baseStatus: schedule.status,
                    asOf: body.date,
                });

                const penaltyStep = Math.min(remainingPayment, overdue.penaltyDue);
                totalPenaltyPaid += penaltyStep;
                remainingPayment -= penaltyStep;

                const amountForThisSchedule = Math.min(remainingPayment, currentRemainingDue);
                
                // Allocation logic for this specific schedule row:
                // 1. Principal remaining in this row
                const principalRemainingInRow = Math.max(0, scheduledPrincipal - currentPaid);
                const principalStep = Math.min(amountForThisSchedule, principalRemainingInRow);
                
                // 2. Interest remaining in this row
                const interestStep = Math.min(amountForThisSchedule - principalStep, scheduledInterest);
                
                // 3. Fee remaining in this row
                const feeStep = Math.min(amountForThisSchedule - principalStep - interestStep, scheduledFee);

                totalPrincipalPaid += principalStep;
                totalInterestPaid += interestStep;
                totalFeePaid += feeStep;
                remainingPayment -= amountForThisSchedule;

                const newPaidTotal = Number((currentPaid + amountForThisSchedule).toFixed(2));
                const newPaidPenalty = Number((currentPaidPenalty + penaltyStep).toFixed(2));
                const newRemainingDue = Number(Math.max(0, currentRemainingDue - amountForThisSchedule).toFixed(2));
                const nextOverdue = computeOverdueSnapshot({
                    dueDate: schedule.dueDate,
                    remainingDue: newRemainingDue,
                    paidPenalty: newPaidPenalty,
                    gracePeriodDays: loan.gracePeriodDays,
                    lateFeeMode: loan.lateFeeMode,
                    lateFeeAmount: loan.lateFeeAmount,
                    baseStatus: schedule.status,
                    asOf: body.date,
                });

                await tx.update(loanSchedules)
                    .set({
                        paidTotal: newPaidTotal.toFixed(2),
                        paidPenalty: newPaidPenalty.toFixed(2),
                        overdueDays: nextOverdue.overdueDays,
                        remainingDue: newRemainingDue.toFixed(2),
                        status: nextOverdue.effectiveStatus,
                        updatedAt: new Date(),
                    })
                    .where(eq(loanSchedules.id, schedule.id));

                // Record Ledger Entries for each step if there is funding allocation
                if (totalAllocatedAmount > 0) {
                    for (const allocation of allAllocations) {
                        if (!allocation.bankProfileId) continue;
                        const share = Number(allocation.allocatedAmount) / totalAllocatedAmount;
                        
                        if (principalStep > 0) {
                            await tx.insert(fundLedgerEntries).values({
                                tenantId: user.tenantId,
                                bankProfileId: allocation.bankProfileId,
                                bankLoanId: allocation.bankLoanId,
                                loanId,
                                transactionId: result.id,
                                entryDate: new Date(body.date),
                                entryType: "principal_return_in",
                                amount: (principalStep * share).toFixed(2),
                                note: `Principal return (Sch #${schedule.installmentNo})`,
                                createdByUserId: user.id,
                            });
                        }
                        if (interestStep > 0) {
                            await tx.insert(fundLedgerEntries).values({
                                tenantId: user.tenantId,
                                bankProfileId: allocation.bankProfileId,
                                bankLoanId: allocation.bankLoanId,
                                loanId,
                                transactionId: result.id,
                                entryDate: new Date(body.date),
                                entryType: "interest_income_in",
                                amount: (interestStep * share).toFixed(2),
                                note: `Interest income (Sch #${schedule.installmentNo})`,
                                createdByUserId: user.id,
                            });
                        }
                        if (feeStep > 0) {
                            await tx.insert(fundLedgerEntries).values({
                                tenantId: user.tenantId,
                                bankProfileId: allocation.bankProfileId,
                                bankLoanId: allocation.bankLoanId,
                                loanId,
                                transactionId: result.id,
                                entryDate: new Date(body.date),
                                entryType: "fee_income_in",
                                amount: (feeStep * share).toFixed(2),
                                note: `Fee income (Sch #${schedule.installmentNo})`,
                                createdByUserId: user.id,
                            });
                        }
                    }
                }
            }

            // Any remaining payment after all schedules and overdue penalties are satisfied is treated as extra penalty/tip.
            if (remainingPayment > 0) {
                totalPenaltyPaid += remainingPayment;
            }

            await tx.update(transactions)
                .set({
                    principalComponent: totalPrincipalPaid.toFixed(2),
                    interestComponent: totalInterestPaid.toFixed(2),
                    feeComponent: totalFeePaid.toFixed(2),
                    penaltyComponent: totalPenaltyPaid.toFixed(2),
                    updatedAt: new Date(),
                })
                .where(eq(transactions.id, result.id));

            const updatedSchedules = await tx.select().from(loanSchedules).where(
                and(
                    eq(loanSchedules.loanId, loanId),
                    eq(loanSchedules.tenantId, user.tenantId)
                )
            ).orderBy(loanSchedules.installmentNo);

            const rollup = computeLoanRollup(updatedSchedules);

            await tx.update(loans)
                .set({
                    outstandingPrincipal: rollup.outstandingPrincipal.toFixed(2),
                    outstandingInterest: rollup.outstandingInterest.toFixed(2),
                    outstandingFees: rollup.outstandingFees.toFixed(2),
                    nextDueDate: rollup.nextDueDate ?? undefined,
                    status: rollup.status,
                })
                .where(eq(loans.id, loanId));

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "transaction",
                entityId: result.id,
                action: "borrower_repayment.recorded",
                payload: {
                    loanId,
                    scheduleId: targetSchedule?.id ?? null,
                    amount: result.amount,
                    slipUrl: result.slipUrl,
                },
            });

            return result;
        });

        await invalidateTenantCache(user.tenantId);
        return created;
    }, {
        body: t.Object({
            loanId: t.String(),
            scheduleId: t.Optional(t.String()),
            amount: t.String(),
            type: t.Optional(t.String()),
            date: t.String(),
            notes: t.Optional(t.String()),
            slip: t.Optional(t.File())
        })
    });
