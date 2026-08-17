import { createHash, randomUUID } from "node:crypto";
import type Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, intermediaries, loans, paymentIntermediaryAttributions, transactions, users } from "../db/schema";
import { FinancialDecimal, signedPublicMoneyPattern, unsignedPublicMoneyPattern } from "../lib/financial-decimal";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { authorizedCanonicalPostedPayment, authorizedPostedPayment, canAccessOwnedRecord } from "./posted-payment-access";

type Attribution = typeof paymentIntermediaryAttributions.$inferSelect;
type Actor = typeof users.$inferSelect;

export interface CreatePaymentAttributionInput {
    paymentPublicId: string;
    sourceKind: "direct" | "intermediary";
    intermediaryPublicId?: string;
    amount: string;
    transactionPublicId?: string;
}

function keyFor(ctx: CommandContext) {
    const key = ctx.idempotencyKey?.trim();
    if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    return key;
}

function positiveMoney(value: string) {
    if (!unsignedPublicMoneyPattern.test(value)) throw new DomainError("INVALID_ATTRIBUTION_AMOUNT", "amount must be a positive exact two-decimal string", 400);
    const amount = new FinancialDecimal(value);
    if (!amount.gt(0)) throw new DomainError("INVALID_ATTRIBUTION_AMOUNT", "amount must be greater than zero", 400);
    return amount;
}

function signedMoney(value: Decimal) {
    const output = value.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
    if (!signedPublicMoneyPattern.test(output)) throw new DomainError("MONEY_OUT_OF_RANGE", "Calculated money is outside the public decimal range", 500);
    return output === "-0.00" ? "0.00" : output;
}

function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function actorFor(ctx: CommandContext, executor: any = db): Promise<Actor | null> {
    if (ctx.actorUserId === null) return null;
    const row = await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!row) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return row;
}

function accessible(actor: Actor | null, ownerUserId: number | null) {
    return canAccessOwnedRecord(actor, ownerUserId);
}

async function paymentFor(ctx: CommandContext, publicId: string, actor: Actor | null, executor: any = db) {
    return authorizedPostedPayment(executor, ctx, actor, { publicId });
}

async function intermediaryFor(ctx: CommandContext, publicId: string, actor: Actor | null, executor: any = db) {
    const row = await executor.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, publicId)) });
    if (!row || !accessible(actor, row.ownerUserId)) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    return row;
}

async function attributionRelations(executor: any, ctx: CommandContext, actor: Actor | null, row: Attribution) {
    const [payment, linkedTransaction, intermediary, reversed] = await Promise.all([
        authorizedCanonicalPostedPayment(executor, ctx, actor, { id: row.paymentId }, "PAYMENT_ATTRIBUTION_NOT_FOUND"),
        row.transactionId ? authorizedCanonicalPostedPayment(executor, ctx, actor, { id: row.transactionId }, "PAYMENT_ATTRIBUTION_NOT_FOUND") : null,
        row.intermediaryId ? executor.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, row.intermediaryId)) }) : null,
        row.reversedAttributionId ? executor.query.paymentIntermediaryAttributions.findFirst({ where: and(eq(paymentIntermediaryAttributions.tenantId, ctx.tenantId), eq(paymentIntermediaryAttributions.id, row.reversedAttributionId)) }) : null,
    ]);
    if ((row.intermediaryId !== null && !intermediary) || (intermediary && !accessible(actor, intermediary.ownerUserId))) {
        throw new DomainError("PAYMENT_ATTRIBUTION_NOT_FOUND", "Payment attribution not found", 404);
    }
    return { payment, linkedTransaction, intermediary, reversed };
}

async function present(executor: any, ctx: CommandContext, actor: Actor | null, row: Attribution) {
    const { payment, linkedTransaction, intermediary, reversed } = await attributionRelations(executor, ctx, actor, row);
    return { publicId: row.publicId, paymentPublicId: payment.publicId, transactionPublicId: linkedTransaction?.publicId ?? null, sourceKind: row.sourceKind as "direct" | "intermediary", intermediaryPublicId: intermediary?.publicId ?? null, amount: signedMoney(new FinancialDecimal(row.attributedAmount)), reason: row.reason, reversedAttributionPublicId: reversed?.publicId ?? null, auditPublicId: row.auditPublicId, correlationId: row.correlationId, createdAt: row.createdAt.toISOString() };
}

async function authorizeAttribution(executor: any, ctx: CommandContext, actor: Actor | null, row: Attribution) {
    await attributionRelations(executor, ctx, actor, row);
}

async function replay(executor: any, ctx: CommandContext, actor: Actor | null, key: string, expected: string) {
    const row = await executor.query.paymentIntermediaryAttributions.findFirst({ where: and(eq(paymentIntermediaryAttributions.tenantId, ctx.tenantId), eq(paymentIntermediaryAttributions.idempotencyKey, key)) });
    if (!row) return null;
    await authorizeAttribution(executor, ctx, actor, row);
    const audit = await executor.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.publicId, row.auditPublicId)) });
    const stored = audit?.payload && typeof audit.payload === "object" && !Array.isArray(audit.payload) ? (audit.payload as Record<string, unknown>).requestFingerprint : null;
    if (stored !== expected) throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used for a different payment attribution command", 409);
    return present(executor, ctx, actor, row);
}

async function insertAttribution(executor: any, ctx: CommandContext, input: { publicId: string; paymentId: number; transactionId: number | null; intermediaryId: number | null; sourceKind: string; amount: string; reason: string | null; reversedAttributionId: number | null; key: string; requestFingerprint: string; action: string }) {
    const auditPublicId = randomUUID();
    await executor.insert(auditLogs).values({ publicId: auditPublicId, tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_intermediary_attribution", entityId: input.publicId, action: input.action, payload: { requestFingerprint: input.requestFingerprint, reversedAttributionId: input.reversedAttributionId } });
    return executor.insert(paymentIntermediaryAttributions).values({ publicId: input.publicId, tenantId: ctx.tenantId, paymentId: input.paymentId, transactionId: input.transactionId, intermediaryId: input.intermediaryId, sourceKind: input.sourceKind, attributedAmount: input.amount, reason: input.reason, reversedAttributionId: input.reversedAttributionId, idempotencyKey: input.key, auditPublicId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId }).returning().then((rows: Attribution[]) => rows[0]!);
}

export async function createPaymentAttribution(ctx: CommandContext, input: CreatePaymentAttributionInput) {
    const key = keyFor(ctx);
    const amount = positiveMoney(input.amount);
    if (input.sourceKind !== "direct" && input.sourceKind !== "intermediary") throw new DomainError("INVALID_ATTRIBUTION_SOURCE", "sourceKind must be direct or intermediary", 400);
    if (input.sourceKind === "direct" && input.intermediaryPublicId) throw new DomainError("INVALID_ATTRIBUTION_SOURCE", "Direct attribution cannot reference an intermediary", 400);
    if (input.sourceKind === "intermediary" && !input.intermediaryPublicId) throw new DomainError("INTERMEDIARY_REQUIRED", "Intermediary attribution requires intermediaryPublicId", 400);
    const requestFingerprint = fingerprint({ operation: "create", paymentPublicId: input.paymentPublicId, transactionPublicId: input.transactionPublicId ?? null, sourceKind: input.sourceKind, intermediaryPublicId: input.intermediaryPublicId ?? null, amount: amount.toFixed(2) });
    const actor = await actorFor(ctx);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:payment-attribution:${key}`}, 0))`);
        const existing = await replay(tx, ctx, actor, key, requestFingerprint);
        if (existing) return existing;
        const candidatePayment = await paymentFor(ctx, input.paymentPublicId, actor, tx);
        await tx.execute(sql`SELECT id FROM loans
            WHERE tenant_id = ${ctx.tenantId} AND id = ${candidatePayment.loanId}
            FOR UPDATE`);
        const parent = await tx.query.loans.findFirst({ where: and(
            eq(loans.tenantId, ctx.tenantId),
            eq(loans.id, candidatePayment.loanId),
        ) });
        if (!parent) throw new DomainError("PAYMENT_NOT_FOUND", "Payment not found", 404);
        if (parent.status === "replaced") {
            throw new DomainError(
                "PAYMENT_PARENT_TERMINAL",
                "Payment attribution cannot be created for a replaced loan",
                409,
                { blockerPublicIds: [parent.publicId] },
            );
        }
        // The parent lock serializes replacement and payment reversal writers. Re-read the
        // canonical payment after locking its row so a compensated original cannot be attributed.
        await tx.execute(sql`SELECT id FROM transactions WHERE tenant_id = ${ctx.tenantId} AND id = ${candidatePayment.id} FOR UPDATE`);
        const payment = await paymentFor(ctx, input.paymentPublicId, actor, tx);
        const intermediary = input.intermediaryPublicId ? await intermediaryFor(ctx, input.intermediaryPublicId, actor, tx) : null;
        const linkedTransaction = input.transactionPublicId ? await paymentFor(ctx, input.transactionPublicId, actor, tx) : payment;
        if (linkedTransaction.loanId !== payment.loanId) throw new DomainError("ATTRIBUTION_TRANSACTION_MISMATCH", "Referenced transaction must belong to the same loan", 409);
        const rows = await tx.select().from(paymentIntermediaryAttributions).where(and(eq(paymentIntermediaryAttributions.tenantId, ctx.tenantId), eq(paymentIntermediaryAttributions.paymentId, payment.id)));
        const attributed = rows.reduce((sum, row) => sum.plus(row.attributedAmount), new FinancialDecimal("0"));
        const capacity = new FinancialDecimal(payment.amount);
        if (!capacity.gt(0)) throw new DomainError("PAYMENT_NOT_ATTRIBUTABLE", "Only positive payments may be attributed", 409);
        if (attributed.plus(amount).gt(capacity)) throw new DomainError("PAYMENT_ATTRIBUTION_EXCEEDS_PAYMENT", "Attribution split exceeds the payment amount", 409, { remainingAmount: signedMoney(FinancialDecimal.max("0", capacity.minus(attributed))) });
        const row = await insertAttribution(tx, ctx, { publicId: randomUUID(), paymentId: payment.id, transactionId: linkedTransaction.id, intermediaryId: intermediary?.id ?? null, sourceKind: input.sourceKind, amount: amount.toFixed(2), reason: null, reversedAttributionId: null, key, requestFingerprint, action: "created" });
        return present(tx, ctx, actor, row);
    });
}

export async function listPaymentAttributions(ctx: CommandContext, paymentPublicId: string) {
    const actor = await actorFor(ctx);
    const payment = await authorizedCanonicalPostedPayment(db, ctx, actor, { publicId: paymentPublicId });
    const rows = await db.select().from(paymentIntermediaryAttributions).where(and(eq(paymentIntermediaryAttributions.tenantId, ctx.tenantId), eq(paymentIntermediaryAttributions.paymentId, payment.id))).orderBy(paymentIntermediaryAttributions.id);
    const visible = await Promise.all(rows.map(async (row) => {
        try { return await present(db, ctx, actor, row); }
        catch (error) {
            if (error instanceof DomainError && error.code === "PAYMENT_ATTRIBUTION_NOT_FOUND") return null;
            throw error;
        }
    }));
    return visible.filter((row) => row !== null);
}

export async function reversePaymentAttribution(ctx: CommandContext, input: { attributionPublicId: string; reason: string }) {
    const key = keyFor(ctx);
    const reason = input.reason.trim();
    if (!reason) throw new DomainError("REVERSAL_REASON_REQUIRED", "A reversal reason is required", 400);
    const requestFingerprint = fingerprint({ operation: "reverse", attributionPublicId: input.attributionPublicId, reason });
    const actor = await actorFor(ctx);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:payment-attribution:${key}`}, 0))`);
        const existing = await replay(tx, ctx, actor, key, requestFingerprint);
        if (existing) return existing;
        const original = await tx.query.paymentIntermediaryAttributions.findFirst({ where: and(eq(paymentIntermediaryAttributions.tenantId, ctx.tenantId), eq(paymentIntermediaryAttributions.publicId, input.attributionPublicId)) });
        if (!original) throw new DomainError("PAYMENT_ATTRIBUTION_NOT_FOUND", "Payment attribution not found", 404);
        await authorizeAttribution(tx, ctx, actor, original);
        if (new FinancialDecimal(original.attributedAmount).lt(0)) throw new DomainError("PAYMENT_ATTRIBUTION_NOT_REVERSIBLE", "A reversal entry cannot be reversed", 409);
        await tx.execute(sql`SELECT id FROM payment_intermediary_attributions WHERE tenant_id = ${ctx.tenantId} AND id = ${original.id} FOR UPDATE`);
        const priorReversal = await tx.query.paymentIntermediaryAttributions.findFirst({ where: and(eq(paymentIntermediaryAttributions.tenantId, ctx.tenantId), eq(paymentIntermediaryAttributions.reversedAttributionId, original.id)) });
        if (priorReversal) throw new DomainError("PAYMENT_ATTRIBUTION_ALREADY_REVERSED", "Payment attribution has already been reversed", 409);
        const row = await insertAttribution(tx, ctx, { publicId: randomUUID(), paymentId: original.paymentId, transactionId: original.transactionId, intermediaryId: original.intermediaryId, sourceKind: original.sourceKind, amount: new FinancialDecimal(original.attributedAmount).negated().toFixed(2), reason, reversedAttributionId: original.id, key, requestFingerprint, action: "reversed" });
        return present(tx, ctx, actor, row);
    });
}
