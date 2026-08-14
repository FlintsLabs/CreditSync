import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { loanOpeningBalanceComponents, loanRestructures, loanRestructureWaivers, loanWaiverPreviews, loans } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { parseMoney, serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type Executor = any;
type WaiverRow = typeof loanRestructureWaivers.$inferSelect;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const previewTtlMs = () => Math.max(60, Number(process.env.WAIVER_PREVIEW_TTL_SECONDS ?? 900)) * 1000;

function sha(payload: unknown) { return createHash("sha256").update(JSON.stringify(payload)).digest("hex"); }
function hash(payload: unknown) { return `v1:${sha(payload)}`; }
function requireText(value: string | undefined, code: string, message: string) {
    const normalized = value?.trim();
    if (!normalized) throw new DomainError(code, message, 400);
    return normalized;
}
function waiverMoney(value: string) {
    try {
        const amount = parseMoney(value);
        if (amount.isZero()) throw new Error();
        return amount;
    } catch { throw new DomainError("INVALID_WAIVER_AMOUNT", "Waiver amount must be a positive two-decimal string", 400); }
}
function componentKind(component: string) {
    if (!(["interest", "fee", "penalty"] as const).includes(component as never)) throw new DomainError("WAIVER_COMPONENT_NOT_ALLOWED", "Only interest, fee, and penalty may be waived", 400);
    return component as "interest" | "fee" | "penalty";
}
async function accessibleReplacement(ctx: CommandContext, loanPublicId: string, executor: Executor = db) {
    if (!uuidPattern.test(loanPublicId)) throw new DomainError("INVALID_PUBLIC_ID", "loanPublicId must be a UUID", 400);
    const loan = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
    if (!loan || (ctx.actorUserId !== null && loan.ownerUserId !== ctx.actorUserId)) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    const restructure = await executor.query.loanRestructures.findFirst({ where: and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.newLoanId, loan.id), eq(loanRestructures.status, "executed")) });
    if (!restructure) throw new DomainError("LOAN_NOT_RESTRUCTURED", "Loan has no executed restructure opening balance", 409);
    return { loan, restructure };
}
async function componentState(executor: Executor, ctx: CommandContext, loanId: number, restructureId: number, component: "interest" | "fee" | "penalty") {
    const kinds = component === "interest" ? ["carried_interest", "new_contract_interest"] : component === "fee" ? ["carried_fee"] : ["carried_penalty"];
    const opening = await executor.select().from(loanOpeningBalanceComponents).where(and(eq(loanOpeningBalanceComponents.tenantId, ctx.tenantId), eq(loanOpeningBalanceComponents.loanId, loanId), eq(loanOpeningBalanceComponents.restructureId, restructureId))) as Array<typeof loanOpeningBalanceComponents.$inferSelect>;
    const waivers = await executor.select().from(loanRestructureWaivers).where(and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.loanId, loanId), eq(loanRestructureWaivers.restructureId, restructureId), eq(loanRestructureWaivers.componentKind, component))) as WaiverRow[];
    const openingAmount = opening.filter(row => kinds.includes(row.componentKind)).reduce((sum, row) => sum.plus(row.status === "executed" ? row.amount : new Decimal(row.amount).negated()), new Decimal(0));
    const waived = waivers.reduce((sum, row) => sum.plus(row.status === "executed" ? row.amount : new Decimal(row.amount).negated()), new Decimal(0));
    const available = Decimal.max(0, openingAmount.minus(waived));
    const version = hash({ loanId, restructureId, component, opening: opening.map(row => [row.publicId, row.componentKind, row.amount, row.status]), waivers: waivers.map(row => [row.publicId, row.amount, row.status, row.reversedWaiverId]) });
    return { openingAmount, waived, available, version };
}

export async function previewLoanWaiver(ctx: CommandContext, loanPublicId: string, input: { component: "interest" | "fee" | "penalty"; amount: string; reason: string }) {
    const component = componentKind(input.component);
    const amount = waiverMoney(input.amount);
    const reason = requireText(input.reason, "WAIVER_REASON_REQUIRED", "A waiver reason is required");
    const { loan, restructure } = await accessibleReplacement(ctx, loanPublicId);
    const state = await componentState(db, ctx, loan.id, restructure.id, component);
    if (amount.gt(state.available)) throw new DomainError("WAIVER_EXCEEDS_COMPONENT", "Waiver cannot exceed the available component", 400, { availableAmount: serializeMoney(state.available) });
    const expiresAt = new Date(Date.now() + previewTtlMs());
    return db.transaction(async tx => {
        await tx.update(loanWaiverPreviews).set({ status: "expired", updatedAt: new Date() }).where(and(eq(loanWaiverPreviews.tenantId, ctx.tenantId), eq(loanWaiverPreviews.loanId, loan.id), eq(loanWaiverPreviews.componentKind, component), eq(loanWaiverPreviews.status, "preview")));
        const publicId = crypto.randomUUID();
        const previewHash = hash({ publicId, loanPublicId, restructurePublicId: restructure.publicId, component, amount: serializeMoney(amount), reason, balanceVersion: state.version, expiresAt: expiresAt.toISOString() });
        const row = await tx.insert(loanWaiverPreviews).values({ publicId, tenantId: ctx.tenantId, loanId: loan.id, restructureId: restructure.id, componentKind: component, amount: serializeMoney(amount), reason, balanceVersion: state.version, previewHash, expiresAt, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId }).returning().then(rows => rows[0]!);
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "loan_waiver_preview", entityId: row.publicId, action: "previewed", payload: { loanPublicId, component, amount: serializeMoney(amount), balanceVersion: state.version, expiresAt: expiresAt.toISOString() } });
        return { publicId: row.publicId, loanPublicId, restructurePublicId: restructure.publicId, component, amount: serializeMoney(amount), availableAmount: serializeMoney(state.available), remainingAmount: serializeMoney(state.available.minus(amount)), reason, previewHash, balanceVersion: state.version, expiresAt };
    });
}

export async function executeLoanWaiver(ctx: CommandContext, previewPublicId: string, input: { confirmed: boolean; previewHash: string; expectedBalanceVersion: string; reason: string }) {
    if (input.confirmed !== true) throw new DomainError("WAIVER_CONFIRMATION_REQUIRED", "Waiver execution requires explicit confirmation", 400);
    const reason = requireText(input.reason, "WAIVER_REASON_REQUIRED", "A waiver reason is required");
    const idempotencyKey = requireText(ctx.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED", "Waiver execution requires an idempotency key");
    const requestHash = sha({ contract: "loan-waiver-execute", version: "v1", previewPublicId, previewHash: input.previewHash, expectedBalanceVersion: input.expectedBalanceVersion, reason });
    const replayBeforePreviewLookup = await db.query.loanRestructureWaivers.findFirst({ where: and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.executeIdempotencyKey, idempotencyKey)) });
    if (replayBeforePreviewLookup) {
        if (replayBeforePreviewLookup.executeRequestHash === requestHash) return present(replayBeforePreviewLookup);
        throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was used with another waiver payload", 409);
    }
    const preview = await db.query.loanWaiverPreviews.findFirst({ where: and(eq(loanWaiverPreviews.tenantId, ctx.tenantId), eq(loanWaiverPreviews.publicId, previewPublicId)) });
    if (!preview) throw new DomainError("WAIVER_PREVIEW_NOT_FOUND", "Waiver preview not found", 404);
    return db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-waiver-execute:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        const existing = await tx.query.loanRestructureWaivers.findFirst({ where: and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.executeIdempotencyKey, idempotencyKey)) });
        if (existing) {
            if (existing.executeRequestHash === requestHash) return present(existing);
            throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was used with another waiver payload", 409);
        }
        await tx.execute(sql`SELECT id FROM loan_waiver_previews WHERE tenant_id=${ctx.tenantId} AND id=${preview.id} FOR UPDATE`);
        const lockedPreview = await tx.query.loanWaiverPreviews.findFirst({ where: and(eq(loanWaiverPreviews.tenantId, ctx.tenantId), eq(loanWaiverPreviews.id, preview.id)) });
        if (!lockedPreview || lockedPreview.status !== "preview") throw new DomainError("STALE_WAIVER_PREVIEW", "Waiver preview is no longer executable", 409);
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id=${ctx.tenantId} AND id=${preview.loanId} FOR UPDATE`);
        const component = componentKind(preview.componentKind);
        const state = await componentState(tx, ctx, preview.loanId, preview.restructureId, component);
        if (lockedPreview.expiresAt.getTime() <= Date.now() || lockedPreview.previewHash !== input.previewHash || lockedPreview.balanceVersion !== input.expectedBalanceVersion || state.version !== lockedPreview.balanceVersion || reason !== lockedPreview.reason) {
            throw new DomainError("STALE_WAIVER_PREVIEW", "Waiver preview expired or component balances changed", 409);
        }
        if (new Decimal(preview.amount).gt(state.available)) throw new DomainError("WAIVER_EXCEEDS_COMPONENT", "Waiver exceeds the available component", 409);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "loan_restructure_waiver", entityId: previewPublicId, action: "executed", payload: { component, amount: preview.amount, reason } });
        const row = await tx.insert(loanRestructureWaivers).values({ tenantId: ctx.tenantId, restructureId: preview.restructureId, loanId: preview.loanId, componentKind: component, amount: preview.amount, reason, status: "executed", actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, executeIdempotencyKey: idempotencyKey, executeRequestHash: requestHash, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId, executedAt: new Date() }).returning().then((rows: WaiverRow[]) => rows[0]!);
        await tx.update(loanWaiverPreviews).set({ status: "consumed", consumedAt: new Date(), updatedAt: new Date() }).where(and(eq(loanWaiverPreviews.tenantId, ctx.tenantId), eq(loanWaiverPreviews.id, preview.id), eq(loanWaiverPreviews.status, "preview")));
        return present(row);
    });
}

function present(row: WaiverRow) { return { publicId: row.publicId, status: row.status, component: row.componentKind, amount: serializeMoney(row.amount), reason: row.reason, auditPublicId: row.auditPublicId, correlationId: row.correlationId, executedAt: row.executedAt, reversedAt: row.reversedAt }; }

export async function reverseLoanWaiver(ctx: CommandContext, waiverPublicId: string, input: { reason: string }) {
    if (!uuidPattern.test(waiverPublicId)) throw new DomainError("INVALID_PUBLIC_ID", "waiverPublicId must be a UUID", 400);
    const reason = requireText(input.reason, "REVERSAL_REASON_REQUIRED", "Waiver reversal requires a reason");
    const idempotencyKey = requireText(ctx.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED", "Waiver reversal requires an idempotency key");
    const requestHash = sha({ contract: "loan-waiver-reverse", version: "v1", waiverPublicId, reason });
    return db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-waiver-reverse:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        const replay = await tx.query.loanRestructureWaivers.findFirst({ where: and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.reversalIdempotencyKey, idempotencyKey)) });
        if (replay) {
            if (replay.reversalRequestHash === requestHash) return present(replay);
            throw new DomainError("REVERSAL_IDEMPOTENCY_CONFLICT", "Idempotency key was used with another waiver reversal", 409);
        }
        const original = await tx.query.loanRestructureWaivers.findFirst({ where: and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.publicId, waiverPublicId)) });
        if (!original || original.status !== "executed") throw new DomainError("WAIVER_NOT_REVERSIBLE", "Only an active executed waiver can be reversed", 409);
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id=${ctx.tenantId} AND id=${original.loanId} FOR UPDATE`);
        const later = await tx.query.loanRestructureWaivers.findFirst({ where: and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.loanId, original.loanId), eq(loanRestructureWaivers.componentKind, original.componentKind), sql`${loanRestructureWaivers.id} > ${original.id}`) });
        if (later) throw new DomainError("WAIVER_REVERSAL_BLOCKED", "Later waiver activity must be reversed first", 409);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "loan_restructure_waiver", entityId: waiverPublicId, action: "reversed", payload: { reason, originalAmount: serializeMoney(original.amount) } });
        const compensating = await tx.insert(loanRestructureWaivers).values({ tenantId: ctx.tenantId, restructureId: original.restructureId, loanId: original.loanId, componentKind: original.componentKind, amount: original.amount, reason, status: "reversed", reversedWaiverId: original.id, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, executeIdempotencyKey: `reversal-entry:${idempotencyKey}`, executeRequestHash: sha({ original: original.publicId, amount: original.amount }), reversalIdempotencyKey: idempotencyKey, reversalRequestHash: requestHash, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId, reversedByUserId: ctx.actorUserId, executedAt: new Date(), reversedAt: new Date() }).returning().then((rows: WaiverRow[]) => rows[0]!);
        return present(compensating);
    });
}
