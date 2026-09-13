import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs, floatingTransactionAllocations, loans, paymentEvidence, paymentIntakes, paymentReconciliationEntries, paymentReconciliationGroups, paymentReconciliationReflowProposals,
    paymentReconciliationProposals, paymentReconciliationReflowEntries, paymentReconciliationReflowGroups,
    transactions,
} from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { assertFinancialEvidenceReady } from "./financial-evidence-requirement-service";
import { assertTemporalReflowEvidenceReady, buildTemporalReflowPlanForLoan, executeTemporalReflow, type TemporalReflowPlan } from "./floating-allocation-reflow-service";
import { lockPaymentBorrowers } from "./payment-chronology-service";
import { bangkokBusinessDate } from "./payment-chronology-guard";

type ReflowRepairPlan = {
    effectiveAfterDate: string;
    displacedTotal: string;
    replacementTotal: string;
    transactions: TemporalReflowPlan["transactions"];
};

export type PaymentReconciliationReflowPreview = {
    publicId: string;
    status: "ready";
    reconciliationGroupPublicId: string;
    effectiveAfterDate: string;
    plan: ReflowRepairPlan;
    previewHash: string;
    expectedBalanceVersion: string;
    reason: string;
    expiresAt: string;
    warnings: [];
};

export type PaymentReconciliationReflowResult = {
    reflowGroupPublicId: string;
    reconciliationGroupPublicId: string;
    compensatingTransactionPublicIds: string[];
    correctedTransactionPublicIds: string[];
    auditPublicIds: string[];
    correlationId: string;
};

function stableHash(value: unknown) {
    return `v1:${createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
        : item)).digest("hex")}`;
}

function combinePlans(plans: TemporalReflowPlan[], effectiveAfterDate: string): ReflowRepairPlan {
    const transactions = plans.flatMap((plan) => plan.transactions).sort((left, right) => left.loanPublicId.localeCompare(right.loanPublicId)
        || left.effectiveDate.localeCompare(right.effectiveDate)
        || left.transactionPublicId.localeCompare(right.transactionPublicId));
    const displaced = plans.reduce((total, plan) => total.plus(plan.displacedTotal), new Decimal(0)).toFixed(2);
    const replacement = plans.reduce((total, plan) => total.plus(plan.replacementTotal), new Decimal(0)).toFixed(2);
    return { effectiveAfterDate, displacedTotal: displaced, replacementTotal: replacement, transactions };
}

async function loadRepairContext(tx: any, ctx: CommandContext, reconciliationPublicId: string) {
    const group = await tx.query.paymentReconciliationGroups.findFirst({ where: and(
        eq(paymentReconciliationGroups.tenantId, ctx.tenantId),
        eq(paymentReconciliationGroups.publicId, reconciliationPublicId),
    ) });
    if (!group || group.status !== "executed") throw new DomainError("RECONCILIATION_GROUP_NOT_FOUND", "Executed reconciliation was not found", 404);
    const existing = await tx.query.paymentReconciliationReflowGroups.findFirst({ where: and(
        eq(paymentReconciliationReflowGroups.tenantId, ctx.tenantId),
        eq(paymentReconciliationReflowGroups.reconciliationGroupId, group.id),
    ) });
    if (existing) throw new DomainError("RECONCILIATION_REFLOW_ALREADY_EXECUTED", "This reconciliation already has temporal reflow provenance", 409);
    const intake = await tx.query.paymentIntakes.findFirst({ where: and(
        eq(paymentIntakes.tenantId, ctx.tenantId),
        eq(paymentIntakes.id, group.paymentIntakeId),
    ) });
    if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Reconciliation source payment was not found", 404);
    const entries = await tx.select({ loanId: paymentReconciliationEntries.loanId, component: paymentReconciliationEntries.component, amount: paymentReconciliationEntries.amount, sourceTransactionId: paymentReconciliationEntries.sourceTransactionId, transactionId: paymentReconciliationEntries.transactionId })
        .from(paymentReconciliationEntries)
        .where(and(eq(paymentReconciliationEntries.tenantId, ctx.tenantId), eq(paymentReconciliationEntries.groupId, group.id), eq(paymentReconciliationEntries.entryType, "replacement"))) as Array<{ loanId: number; component: string; amount: string; sourceTransactionId: number | null; transactionId: number | null }>;
    const loanIds: number[] = [...new Set(entries.filter((entry) => entry.component === "interest").map((entry) => entry.loanId))].sort((a: number, b: number) => a - b);
    if (!loanIds.length || entries.some((entry: { component: string }) => entry.component !== "interest")) {
        throw new DomainError("TEMPORAL_REFLOW_UNSUPPORTED_COMPONENT", "Legacy repair supports complete interest-only reconciliation provenance", 409);
    }
    const loanRows = await tx.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.id, loanIds))).orderBy(loans.id) as Array<typeof loans.$inferSelect>;
    if (loanRows.length !== loanIds.length || loanRows.some((loan: typeof loans.$inferSelect) => loan.repaymentType !== "floating")) {
        throw new DomainError("TEMPORAL_REFLOW_UNSUPPORTED_COMPONENT", "Legacy repair requires accessible floating loans", 409);
    }
    const sourceTransactionIds = [...new Set(entries.map((entry) => entry.sourceTransactionId).filter((id): id is number => id !== null))].sort((a, b) => a - b);
    if (sourceTransactionIds.length !== entries.length || entries.some((entry) => entry.transactionId === null || entry.sourceTransactionId !== entry.transactionId)) {
        throw new DomainError("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE", "Legacy reconciliation is missing source transaction lineage", 409);
    }
    const sourceTransactions = await tx.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), inArray(transactions.id, sourceTransactionIds))).orderBy(transactions.id) as Array<typeof transactions.$inferSelect>;
    const sourceById = new Map(sourceTransactions.map((row) => [row.id, row]));
    if (sourceTransactions.length !== sourceTransactionIds.length || entries.some((entry) => {
        const source = entry.sourceTransactionId === null ? undefined : sourceById.get(entry.sourceTransactionId);
        return !source || entry.amount !== source.interestComponent;
    }) || sourceTransactions.some((row) => !loanIds.includes(row.loanId) || row.entryType !== "repayment" || row.reversedTransactionId !== null || !new Decimal(row.principalComponent).isZero() || !new Decimal(row.feeComponent).isZero() || !new Decimal(row.penaltyComponent).isZero())) {
        throw new DomainError("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE", "Legacy reconciliation source transactions are not a complete interest-only chain", 409);
    }
    const evidence = await tx.select({ publicId: paymentEvidence.publicId, status: paymentEvidence.status, evidenceHash: paymentEvidence.evidenceHash, mimeType: paymentEvidence.mimeType, declaredSize: paymentEvidence.declaredSize, finalizedAt: paymentEvidence.finalizedAt })
        .from(paymentEvidence)
        .where(and(eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, intake.id), eq(paymentEvidence.status, "ready"), sql`${paymentEvidence.finalizedAt} IS NOT NULL`))
        .orderBy(paymentEvidence.id);
    const borrowersForLocks: number[] = [...new Set(loanRows.map((loan) => loan.borrowerId))].sort((a: number, b: number) => a - b);
    return { group, intake, entries, sourceTransactions, evidence, loanRows, borrowersForLocks };
}

async function buildRepairPlan(tx: any, ctx: CommandContext, context: Awaited<ReturnType<typeof loadRepairContext>>) {
    const effectiveAfterDate = bangkokBusinessDate(context.intake.receivedAt);
    const results = [];
    for (const loan of context.loanRows) {
        const result = await buildTemporalReflowPlanForLoan(tx, ctx, loan, effectiveAfterDate);
        results.push(result);
    }
    const plan = combinePlans(results.map((result) => result.plan), effectiveAfterDate);
    if (!plan.transactions.length || plan.displacedTotal !== plan.replacementTotal) {
        throw new DomainError("TEMPORAL_REFLOW_NOT_REQUIRED", "No safe temporal-reflow repair is required", 409);
    }
    return { plan, results };
}

function presentPreview(row: typeof paymentReconciliationReflowProposals.$inferSelect, plan: ReflowRepairPlan, reconciliationGroupPublicId: string): PaymentReconciliationReflowPreview {
    return {
        publicId: row.publicId, status: "ready", reconciliationGroupPublicId, effectiveAfterDate: plan.effectiveAfterDate,
        plan, previewHash: row.previewHash, expectedBalanceVersion: row.expectedBalanceVersion,
        reason: row.reason, expiresAt: row.expiresAt.toISOString(), warnings: [],
    };
}

export async function previewPaymentReconciliationReflow(ctx: CommandContext, input: { reconciliationPublicId: string; reason: string }): Promise<PaymentReconciliationReflowPreview> {
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError("RECONCILIATION_REASON_REQUIRED", "Temporal reflow repair requires a reason", 400);
    return db.transaction(async (tx) => {
        const context = await loadRepairContext(tx, ctx, input.reconciliationPublicId);
        const consumedIntakeIds = [...new Set([context.intake.id, ...context.sourceTransactions.map((row) => row.paymentIntakeId).filter((id): id is number => id !== null)])].sort((left, right) => left - right);
        await lockPaymentBorrowers(tx, ctx.tenantId, context.borrowersForLocks);
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(consumedIntakeIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        const { plan } = await buildRepairPlan(tx, ctx, context);
        const source = { reconciliationGroupPublicId: context.group.publicId, paymentIntakePublicId: context.intake.publicId, sourceTransactions: context.sourceTransactions.map((row) => ({ publicId: row.publicId, loanPublicId: context.loanRows.find((loan) => loan.id === row.loanId)?.publicId, transactionDate: row.transactionDate, amount: row.amount, principalComponent: row.principalComponent, interestComponent: row.interestComponent, feeComponent: row.feeComponent, penaltyComponent: row.penaltyComponent })), evidence: context.evidence.map((row: typeof context.evidence[number]) => ({ publicId: row.publicId, status: row.status, evidenceHash: row.evidenceHash, mimeType: row.mimeType, declaredSize: row.declaredSize, finalizedAt: row.finalizedAt })), plan };
        const expectedBalanceVersion = stableHash(source);
        const previewHash = stableHash({ source, reason });
        const expiresAt = new Date(Date.now() + Math.max(60, Number(process.env.PAYMENT_PREVIEW_TTL_SECONDS ?? 900)) * 1000);
        const row = await tx.insert(paymentReconciliationReflowProposals).values({
            tenantId: ctx.tenantId, reconciliationGroupId: context.group.id, status: "ready", previewHash,
            expectedBalanceVersion, sourceSnapshot: source, proposedReflow: plan, warnings: [], reason,
            expiresAt, createdByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_reconciliation_reflow", entityId: row.publicId, action: "previewed", payload: { reconciliationGroupPublicId: context.group.publicId, previewHash, expectedBalanceVersion, reason } });
        return presentPreview(row, plan, context.group.publicId);
    });
}

async function replayResult(tx: any, ctx: CommandContext, group: typeof paymentReconciliationReflowGroups.$inferSelect): Promise<PaymentReconciliationReflowResult> {
    const rows = await tx.select({ transactionId: paymentReconciliationReflowEntries.transactionId, entry: paymentReconciliationReflowEntries })
        .from(paymentReconciliationReflowEntries)
        .where(and(eq(paymentReconciliationReflowEntries.tenantId, ctx.tenantId), eq(paymentReconciliationReflowEntries.groupId, group.id)))
        .orderBy(paymentReconciliationReflowEntries.id) as Array<{ transactionId: number; entry: typeof paymentReconciliationReflowEntries.$inferSelect }>;
    const allocationIds = [...new Set(rows.flatMap((row) => [row.entry.reversalAllocationId, row.entry.replacementAllocationId]))];
    const allocationRows = allocationIds.length ? await tx.select({ id: floatingTransactionAllocations.id, transactionId: floatingTransactionAllocations.transactionId }).from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, ctx.tenantId), inArray(floatingTransactionAllocations.id, allocationIds))) as Array<{ id: number; transactionId: number }> : [];
    const transactionIds = [...new Set([...rows.map((row) => row.transactionId), ...allocationRows.map((row) => row.transactionId)])];
    const transactionsById = transactionIds.length ? await tx.select({ id: transactions.id, publicId: transactions.publicId, entryType: transactions.entryType }).from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), inArray(transactions.id, transactionIds))) as Array<{ id: number; publicId: string; entryType: string }> : [];
    const publicId = new Map(transactionsById.map((row) => [row.id, row.publicId]));
    const transactionIdByAllocation = new Map(allocationRows.map((row) => [row.id, row.transactionId]));
    return {
        reflowGroupPublicId: group.publicId, reconciliationGroupPublicId: (await tx.query.paymentReconciliationGroups.findFirst({ where: and(eq(paymentReconciliationGroups.tenantId, ctx.tenantId), eq(paymentReconciliationGroups.id, group.reconciliationGroupId)) }))!.publicId,
        compensatingTransactionPublicIds: [...new Set(rows.map((row) => transactionIdByAllocation.get(row.entry.reversalAllocationId)).filter((id): id is number => Boolean(id)))].map((id) => publicId.get(id)!).filter(Boolean),
        correctedTransactionPublicIds: [...new Set(rows.map((row) => row.transactionId).filter((id) => transactionsById.find((txRow) => txRow.id === id)?.entryType === "repayment"))].map((id) => publicId.get(id)!).filter(Boolean),
        auditPublicIds: [group.auditPublicId], correlationId: group.correlationId,
    };
}

export async function executePaymentReconciliationReflow(ctx: CommandContext, input: { reflowPreviewPublicId: string; previewHash: string; expectedBalanceVersion: string; confirmed: true; reason: string; idempotencyKey: string }): Promise<PaymentReconciliationReflowResult> {
    if (input.confirmed !== true) throw new DomainError("CONFIRMATION_REQUIRED", "Temporal reflow execution requires confirmed: true", 400);
    const reason = input.reason?.trim();
    const key = input.idempotencyKey?.trim();
    if (!reason || !key) throw new DomainError("RECONCILIATION_COMMAND_CONTEXT_REQUIRED", "Reason and idempotency key are required", 400);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:payment-reconciliation-reflow:${key}`}, 0))`);
        const existing = await tx.query.paymentReconciliationReflowGroups.findFirst({ where: and(eq(paymentReconciliationReflowGroups.tenantId, ctx.tenantId), eq(paymentReconciliationReflowGroups.idempotencyKey, key)) });
        if (existing) {
            const proposal = await tx.query.paymentReconciliationReflowProposals.findFirst({ where: and(eq(paymentReconciliationReflowProposals.tenantId, ctx.tenantId), eq(paymentReconciliationReflowProposals.id, existing.proposalId!)) });
            if (!proposal || proposal.publicId !== input.reflowPreviewPublicId || proposal.previewHash !== input.previewHash || proposal.expectedBalanceVersion !== input.expectedBalanceVersion || existing.reason !== reason) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different temporal repair", 409);
            return replayResult(tx, ctx, existing);
        }
        const initial = await tx.query.paymentReconciliationReflowProposals.findFirst({ where: and(eq(paymentReconciliationReflowProposals.tenantId, ctx.tenantId), eq(paymentReconciliationReflowProposals.publicId, input.reflowPreviewPublicId)) });
        if (!initial) throw new DomainError("TEMPORAL_REFLOW_PREVIEW_NOT_FOUND", "Temporal reflow preview was not found", 404);
        await tx.execute(sql`SELECT id FROM payment_reconciliation_reflow_proposals WHERE tenant_id = ${ctx.tenantId} AND id = ${initial.id} FOR UPDATE`);
        if (initial.status !== "ready" || initial.expiresAt.getTime() <= Date.now() || initial.previewHash !== input.previewHash || initial.expectedBalanceVersion !== input.expectedBalanceVersion || initial.reason !== reason) throw new DomainError("STALE_TEMPORAL_REFLOW_PREVIEW", "Temporal reflow preview is stale or expired", 409);
        const context = await loadRepairContext(tx, ctx, (initial.sourceSnapshot as { reconciliationGroupPublicId: string }).reconciliationGroupPublicId);
        const consumedIntakeIds = [...new Set([context.intake.id, ...context.sourceTransactions.map((row) => row.paymentIntakeId).filter((id): id is number => id !== null)])].sort((left, right) => left - right);
        await lockPaymentBorrowers(tx, ctx.tenantId, context.borrowersForLocks);
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(consumedIntakeIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        await assertFinancialEvidenceReady(tx, ctx, { kind: "payment_intake", publicId: context.intake.publicId });
        await assertTemporalReflowEvidenceReady(tx, ctx, context.sourceTransactions.map((row) => ({ transactionId: row.id })));
        const { plan, results } = await buildRepairPlan(tx, ctx, context);
        const source = { reconciliationGroupPublicId: context.group.publicId, paymentIntakePublicId: context.intake.publicId, sourceTransactions: context.sourceTransactions.map((row) => ({ publicId: row.publicId, loanPublicId: context.loanRows.find((loan) => loan.id === row.loanId)?.publicId, transactionDate: row.transactionDate, amount: row.amount, principalComponent: row.principalComponent, interestComponent: row.interestComponent, feeComponent: row.feeComponent, penaltyComponent: row.penaltyComponent })), evidence: context.evidence.map((row: typeof context.evidence[number]) => ({ publicId: row.publicId, status: row.status, evidenceHash: row.evidenceHash, mimeType: row.mimeType, declaredSize: row.declaredSize, finalizedAt: row.finalizedAt })), plan };
        if (stableHash(source) !== initial.expectedBalanceVersion || stableHash({ source, reason }) !== initial.previewHash) throw new DomainError("STALE_TEMPORAL_REFLOW_PREVIEW", "Temporal reflow state changed after preview", 409);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_reconciliation_reflow", entityId: initial.publicId, action: "executed", payload: { reconciliationGroupPublicId: context.group.publicId, reason, idempotencyKey: key } });
        const group = await tx.insert(paymentReconciliationReflowGroups).values({ tenantId: ctx.tenantId, reconciliationGroupId: context.group.id, proposalId: initial.id, origin: "repair", reason, idempotencyKey: key, correlationId: ctx.correlationId, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const outputs = [];
        for (const result of results) {
            const executed = await executeTemporalReflow(tx, ctx, { plan: result.plan, sources: result.sources, replacements: result.replacements, groupId: group.id, auditPublicId: audit.publicId, reason, idempotencyPrefix: `${key}:${group.publicId}` });
            outputs.push(...executed.entries.map((entry) => ({ ...entry, source: result.sources.find((source) => source.allocationId === entry.sourceAllocationId) })));
        }
        for (const entry of outputs) {
            if (!entry.source) throw new DomainError("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE", "Repair source disappeared during execution", 409);
            await tx.insert(paymentReconciliationReflowEntries).values({ tenantId: ctx.tenantId, groupId: group.id, loanId: entry.source.loanId, transactionId: entry.replacementTransactionId, sourceAllocationId: entry.sourceAllocationId, reversalAllocationId: entry.reversalAllocationId, replacementAllocationId: entry.replacementAllocationId, effectiveDate: entry.source.effectiveDate, oldDueDate: entry.oldDueDate, newDueDate: entry.newDueDate, displacedAmount: entry.displacedAmount, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId });
        }
        await tx.update(paymentReconciliationReflowProposals).set({ status: "executed", executedByUserId: ctx.actorUserId, executedAt: new Date() }).where(and(eq(paymentReconciliationReflowProposals.tenantId, ctx.tenantId), eq(paymentReconciliationReflowProposals.id, initial.id)));
        return replayResult(tx, ctx, group);
    });
}
