import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { loanOpeningBalanceComponents, loanRestructures, loanRestructureWaivers, loanWaiverPreviews, loans, transactions, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
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
type WaiverComponent = "interest" | "fee" | "penalty" | "new_interest";
function componentKind(component: string, allowInternalNewInterest = false) {
    const allowed = allowInternalNewInterest ? ["interest", "fee", "penalty", "new_interest"] : ["interest", "fee", "penalty"];
    if (!allowed.includes(component)) throw new DomainError("WAIVER_COMPONENT_NOT_ALLOWED", "Only interest, fee, and penalty may be waived", 400);
    return component as WaiverComponent;
}
async function accessibleReplacement(ctx: CommandContext, loanPublicId: string, executor: Executor = db) {
    if (!uuidPattern.test(loanPublicId)) throw new DomainError("INVALID_PUBLIC_ID", "loanPublicId must be a UUID", 400);
    const loan = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
    const actor = ctx.actorUserId === null ? null : await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (ctx.actorUserId !== null && !actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    if (!loan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    const restructure = await executor.query.loanRestructures.findFirst({ where: and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.newLoanId, loan.id), eq(loanRestructures.status, "executed")) });
    if (!restructure) throw new DomainError("LOAN_NOT_RESTRUCTURED", "Loan has no executed restructure opening balance", 409);
    return { loan, restructure };
}
async function componentState(executor: Executor, ctx: CommandContext, loanId: number, restructureId: number, component: WaiverComponent) {
    const interestScope = component === "interest" || component === "new_interest";
    const kinds = interestScope ? ["carried_interest", "new_contract_interest"] : component === "fee" ? ["carried_fee"] : ["carried_penalty"];
    const opening = await executor.select().from(loanOpeningBalanceComponents).where(and(eq(loanOpeningBalanceComponents.tenantId, ctx.tenantId), eq(loanOpeningBalanceComponents.loanId, loanId), eq(loanOpeningBalanceComponents.restructureId, restructureId))) as Array<typeof loanOpeningBalanceComponents.$inferSelect>;
    const waivers = await executor.select().from(loanRestructureWaivers).where(and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.loanId, loanId), eq(loanRestructureWaivers.restructureId, restructureId), interestScope ? sql`${loanRestructureWaivers.componentKind} IN ('interest', 'new_interest')` : eq(loanRestructureWaivers.componentKind, component))) as WaiverRow[];
    const posted = await executor.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, loanId))).orderBy(transactions.id) as Array<typeof transactions.$inferSelect>;
    const reversed = new Set(posted.filter(row => row.entryType === "reversal" && row.reversedTransactionId !== null).map(row => row.reversedTransactionId!));
    const active = posted.filter(row => row.entryType === "repayment" && !reversed.has(row.id));
    const paid = active.reduce((sum, row) => sum.plus(interestScope ? row.interestComponent : component === "fee" ? row.feeComponent : row.penaltyComponent), new Decimal(0));
    const openingAmount = opening.filter(row => kinds.includes(row.componentKind)).reduce((sum, row) => sum.plus(row.status === "executed" ? row.amount : new Decimal(row.amount).negated()), new Decimal(0));
    const waived = waivers.reduce((sum, row) => sum.plus(row.status === "executed" ? row.amount : new Decimal(row.amount).negated()), new Decimal(0));
    const carriedGross = opening.filter(row => row.componentKind === "carried_interest").reduce((sum, row) => sum.plus(row.status === "executed" ? row.amount : new Decimal(row.amount).negated()), new Decimal(0));
    const newGross = opening.filter(row => row.componentKind === "new_contract_interest").reduce((sum, row) => sum.plus(row.status === "executed" ? row.amount : new Decimal(row.amount).negated()), new Decimal(0));
    const generalWaived = waivers.filter(row => row.componentKind === "interest").reduce((sum, row) => sum.plus(row.status === "executed" ? row.amount : new Decimal(row.amount).negated()), new Decimal(0));
    const explicitNewWaived = waivers.filter(row => row.componentKind === "new_interest").reduce((sum, row) => sum.plus(row.status === "executed" ? row.amount : new Decimal(row.amount).negated()), new Decimal(0));
    const carriedAfterWaiver = Decimal.max(0, carriedGross.minus(Decimal.min(carriedGross, generalWaived)));
    const generalNewWaiver = Decimal.max(0, generalWaived.minus(carriedGross));
    const paidCarried = Decimal.min(paid, carriedAfterWaiver);
    const paidNew = Decimal.max(0, paid.minus(paidCarried));
    const available = component === "new_interest"
        ? Decimal.max(0, newGross.minus(generalNewWaiver).minus(explicitNewWaived).minus(paidNew))
        : Decimal.max(0, openingAmount.minus(waived).minus(paid));
    const version = hash({ loanId, restructureId, component, opening: opening.map(row => [row.publicId, row.componentKind, row.amount, row.status]), waivers: waivers.map(row => [row.publicId, row.amount, row.status, row.reversedWaiverId, row.settlementDate, row.scheduleAllocations]), payments: posted.map(row => [row.publicId, row.entryType, row.reversedTransactionId, row.interestComponent, row.feeComponent, row.penaltyComponent]) });
    return { openingAmount, waived, paid, available, version };
}

export async function getLoanWaiverAvailability(ctx: CommandContext, loanPublicId: string, component: WaiverComponent) {
    const resolved = await accessibleReplacement(ctx, loanPublicId);
    const state = await componentState(db, ctx, resolved.loan.id, resolved.restructure.id, component);
    return { availableAmount: serializeMoney(state.available), balanceVersion: state.version };
}

export async function previewLoanWaiver(ctx: CommandContext, loanPublicId: string, input: { component: "interest" | "fee" | "penalty" | "new_interest"; amount: string; reason: string }, options: { allowInternalNewInterest?: boolean; settlementDate?: string; scheduleAllocations?: Array<{ schedulePublicId: string; dueDate: string; amount: string }> } = {}) {
    const component = componentKind(input.component, options.allowInternalNewInterest);
    const amount = waiverMoney(input.amount);
    const reason = requireText(input.reason, "WAIVER_REASON_REQUIRED", "A waiver reason is required");
    const { loan, restructure } = await accessibleReplacement(ctx, loanPublicId);
    const state = await componentState(db, ctx, loan.id, restructure.id, component);
    if (amount.gt(state.available)) throw new DomainError("WAIVER_EXCEEDS_COMPONENT", "Waiver cannot exceed the available component", 400, { availableAmount: serializeMoney(state.available) });
    const expiresAt = new Date(Date.now() + previewTtlMs());
    return db.transaction(async tx => {
        await tx.update(loanWaiverPreviews).set({ status: "expired", updatedAt: new Date() }).where(and(eq(loanWaiverPreviews.tenantId, ctx.tenantId), eq(loanWaiverPreviews.loanId, loan.id), eq(loanWaiverPreviews.componentKind, component), eq(loanWaiverPreviews.status, "preview")));
        const publicId = crypto.randomUUID();
        const previewHash = hash({ publicId, loanPublicId, restructurePublicId: restructure.publicId, component, amount: serializeMoney(amount), reason, settlementDate: options.settlementDate, scheduleAllocations: options.scheduleAllocations, balanceVersion: state.version, expiresAt: expiresAt.toISOString() });
        const row = await tx.insert(loanWaiverPreviews).values({ publicId, tenantId: ctx.tenantId, loanId: loan.id, restructureId: restructure.id, componentKind: component, amount: serializeMoney(amount), reason, settlementDate: options.settlementDate, scheduleAllocations: options.scheduleAllocations ?? [], balanceVersion: state.version, previewHash, expiresAt, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId }).returning().then(rows => rows[0]!);
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
        const component = componentKind(preview.componentKind, true);
        const state = await componentState(tx, ctx, preview.loanId, preview.restructureId, component);
        if (lockedPreview.expiresAt.getTime() <= Date.now() || lockedPreview.previewHash !== input.previewHash || lockedPreview.balanceVersion !== input.expectedBalanceVersion || state.version !== lockedPreview.balanceVersion || reason !== lockedPreview.reason) {
            throw new DomainError("STALE_WAIVER_PREVIEW", "Waiver preview expired or component balances changed", 409);
        }
        if (new Decimal(preview.amount).gt(state.available)) throw new DomainError("WAIVER_EXCEEDS_COMPONENT", "Waiver exceeds the available component", 409);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "loan_restructure_waiver", entityId: previewPublicId, action: "executed", payload: { component, amount: preview.amount, reason } });
        const row = await tx.insert(loanRestructureWaivers).values({ tenantId: ctx.tenantId, restructureId: preview.restructureId, loanId: preview.loanId, componentKind: component, amount: preview.amount, reason, settlementDate: preview.settlementDate, scheduleAllocations: preview.scheduleAllocations, status: "executed", actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, executeIdempotencyKey: idempotencyKey, executeRequestHash: requestHash, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId, executedAt: new Date() }).returning().then((rows: WaiverRow[]) => rows[0]!);
        await tx.update(loanWaiverPreviews).set({ status: "consumed", consumedAt: new Date(), updatedAt: new Date() }).where(and(eq(loanWaiverPreviews.tenantId, ctx.tenantId), eq(loanWaiverPreviews.id, preview.id), eq(loanWaiverPreviews.status, "preview")));
        const { refreshReplacementLoanEconomicRollup } = await import("./payment-service");
        await refreshReplacementLoanEconomicRollup(tx, ctx.tenantId, preview.loanId);
        return present(row);
    });
}

function present(row: WaiverRow) { return { publicId: row.publicId, status: row.status, component: row.componentKind, amount: serializeMoney(row.amount), reason: row.reason, auditPublicId: row.auditPublicId, correlationId: row.correlationId, executedAt: row.executedAt, reversedAt: row.reversedAt }; }

export async function listLoanWaivers(ctx: CommandContext, loanPublicId: string) {
    const { loan, restructure } = await accessibleReplacement(ctx, loanPublicId);
    const rows = await db.select().from(loanRestructureWaivers).where(and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.loanId, loan.id), eq(loanRestructureWaivers.restructureId, restructure.id))).orderBy(desc(loanRestructureWaivers.createdAt));
    return rows.map(present);
}

export async function getLoanWaiver(ctx: CommandContext, waiverPublicId: string) {
    if (!uuidPattern.test(waiverPublicId)) throw new DomainError("INVALID_PUBLIC_ID", "waiverPublicId must be a UUID", 400);
    const row = await db.query.loanRestructureWaivers.findFirst({ where: and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.publicId, waiverPublicId)) });
    if (!row) throw new DomainError("WAIVER_NOT_FOUND", "Loan waiver not found", 404);
    const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, row.loanId)) });
    if (!loan) throw new DomainError("WAIVER_NOT_FOUND", "Loan waiver not found", 404);
    await accessibleReplacement(ctx, loan.publicId);
    return present(row);
}

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
        const downstreamRows = await tx.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, original.loanId), gt(transactions.createdAt, original.executedAt))).orderBy(transactions.id);
        const reversedDownstreamIds = new Set(downstreamRows.filter((row: typeof transactions.$inferSelect) => row.entryType === "reversal" && row.reversedTransactionId !== null).map((row: typeof transactions.$inferSelect) => row.reversedTransactionId!));
        const downstreamPayment = downstreamRows.find((row: typeof transactions.$inferSelect) => row.entryType === "repayment" && !reversedDownstreamIds.has(row.id));
        if (downstreamPayment) throw new DomainError("WAIVER_REVERSAL_BLOCKED", "Active payments posted after this waiver must be reversed first", 409);
        const later = await tx.query.loanRestructureWaivers.findFirst({ where: and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.loanId, original.loanId), eq(loanRestructureWaivers.componentKind, original.componentKind), sql`${loanRestructureWaivers.id} > ${original.id}`) });
        if (later) throw new DomainError("WAIVER_REVERSAL_BLOCKED", "Later waiver activity must be reversed first", 409);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "loan_restructure_waiver", entityId: waiverPublicId, action: "reversed", payload: { reason, originalAmount: serializeMoney(original.amount) } });
        const compensating = await tx.insert(loanRestructureWaivers).values({ tenantId: ctx.tenantId, restructureId: original.restructureId, loanId: original.loanId, componentKind: original.componentKind, amount: original.amount, reason, settlementDate: original.settlementDate, scheduleAllocations: original.scheduleAllocations, status: "reversed", reversedWaiverId: original.id, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, executeIdempotencyKey: `reversal-entry:${idempotencyKey}`, executeRequestHash: sha({ original: original.publicId, amount: original.amount }), reversalIdempotencyKey: idempotencyKey, reversalRequestHash: requestHash, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId, reversedByUserId: ctx.actorUserId, executedAt: new Date(), reversedAt: new Date() }).returning().then((rows: WaiverRow[]) => rows[0]!);
        const { refreshReplacementLoanEconomicRollup } = await import("./payment-service");
        await refreshReplacementLoanEconomicRollup(tx, ctx.tenantId, original.loanId);
        return present(compensating);
    });
}
