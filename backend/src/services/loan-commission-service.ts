import { createHash, randomUUID } from "node:crypto";
import type Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { auditLogs, intermediaries, loanCommissionParticipants, loans, transactions, users } from "../db/schema";
import { FinancialDecimal } from "../lib/financial-decimal";
import { signedPublicMoneyPattern } from "../lib/financial-decimal";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { canAccessOwnedRecord, canonicalPostedPaymentPredicate } from "./posted-payment-access";

type Participant = typeof loanCommissionParticipants.$inferSelect;
type Actor = typeof users.$inferSelect;

export interface AddLoanCommissionParticipantInput {
    loanPublicId: string;
    intermediaryPublicId: string;
    commissionRate: string;
    role: string;
    effectiveFrom: string;
    note?: string | null;
}

export interface UpdateLoanCommissionParticipantInput {
    participantPublicId: string;
    commissionRate: string;
    role: string;
    effectiveFrom: string;
    note?: string | null;
}

export interface EndLoanCommissionParticipantInput {
    participantPublicId: string;
    effectiveTo: string;
    reason: string;
}

function commandKey(ctx: CommandContext) {
    const value = ctx.idempotencyKey?.trim();
    if (!value) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    return value;
}

function text(value: string, code: string, message: string) {
    const normalized = value.trim();
    if (!normalized) throw new DomainError(code, message, 400);
    return normalized;
}

function timestamp(value: string, field: string) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    if (!match) throw new DomainError("INVALID_COMMISSION_DATE", `${field} must be a valid ISO 8601 timestamp`, 400);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day > daysInMonth) throw new DomainError("INVALID_COMMISSION_DATE", `${field} must be a valid ISO 8601 timestamp`, 400);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new DomainError("INVALID_COMMISSION_DATE", `${field} must be a valid ISO 8601 timestamp`, 400);
    return parsed;
}

function rate(value: string) {
    if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(value)) throw new DomainError("INVALID_COMMISSION_RATE", "commissionRate must be between 0 and 100 with up to four decimals", 400);
    const parsed = new FinancialDecimal(value);
    if (parsed.lt(0) || parsed.gt(100)) throw new DomainError("INVALID_COMMISSION_RATE", "commissionRate must be between 0 and 100 with up to four decimals", 400);
    return parsed;
}

function exactRate(value: string) {
    return new FinancialDecimal(value).toFixed(4).replace(/(\.\d{2})0+$/, "$1");
}

function signedMoney(value: Decimal) {
    const output = value.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
    if (!signedPublicMoneyPattern.test(output)) throw new DomainError("MONEY_OUT_OF_RANGE", "Calculated money is outside the public decimal range", 500);
    return output === "-0.00" ? "0.00" : output;
}

function fingerprint(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function actorFor(ctx: CommandContext, executor: DbExecutor = db): Promise<Actor | null> {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

function accessible(actor: Actor | null, ownerUserId: number | null) {
    return canAccessOwnedRecord(actor, ownerUserId);
}

async function loanFor(ctx: CommandContext, publicId: string, actor: Actor | null, executor: DbExecutor = db) {
    const row = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, publicId)) });
    if (!row || !accessible(actor, row.ownerUserId)) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    return row;
}

async function intermediaryFor(ctx: CommandContext, publicId: string, actor: Actor | null, executor: DbExecutor = db) {
    const row = await executor.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.publicId, publicId)) });
    if (!row || !accessible(actor, row.ownerUserId)) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    return row;
}

async function participantRelations(executor: DbExecutor, ctx: CommandContext, row: Participant) {
    const [loan, intermediary, previous] = await Promise.all([
        executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, row.loanId)) }),
        executor.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, row.intermediaryId)) }),
        row.previousParticipantId ? executor.query.loanCommissionParticipants.findFirst({ where: and(eq(loanCommissionParticipants.tenantId, ctx.tenantId), eq(loanCommissionParticipants.id, row.previousParticipantId)) }) : null,
    ]);
    return { loan, intermediary, previous };
}

async function present(executor: DbExecutor, ctx: CommandContext, row: Participant) {
    const related = await participantRelations(executor, ctx, row);
    if (!related.loan || !related.intermediary) throw new DomainError("COMMISSION_PARTICIPANT_NOT_FOUND", "Commission participant not found", 404);
    return {
        publicId: row.publicId,
        loanPublicId: related.loan.publicId,
        intermediaryPublicId: related.intermediary.publicId,
        intermediaryName: related.intermediary.name,
        intermediaryAliases: related.intermediary.aliases,
        previousParticipantPublicId: related.previous?.publicId ?? null,
        commissionRate: exactRate(row.commissionRate),
        role: row.role,
        note: row.note,
        effectiveFrom: row.effectiveFrom.toISOString(),
        effectiveTo: row.effectiveTo?.toISOString() ?? null,
        status: row.status as "active" | "ended",
        auditPublicId: row.auditPublicId,
        correlationId: row.correlationId,
        createdAt: row.createdAt.toISOString(),
    };
}

async function authorizeParticipant(executor: DbExecutor, ctx: CommandContext, actor: Actor | null, row: Participant) {
    const related = await participantRelations(executor, ctx, row);
    if (!related.loan || !accessible(actor, related.loan.ownerUserId)) throw new DomainError("COMMISSION_PARTICIPANT_NOT_FOUND", "Commission participant not found", 404);
    if (!related.intermediary || !accessible(actor, related.intermediary.ownerUserId)) throw new DomainError("COMMISSION_PARTICIPANT_NOT_FOUND", "Commission participant not found", 404);
}

async function replay(executor: DbExecutor, ctx: CommandContext, actor: Actor | null, key: string, expectedFingerprint: string) {
    const row = await executor.query.loanCommissionParticipants.findFirst({ where: and(eq(loanCommissionParticipants.tenantId, ctx.tenantId), eq(loanCommissionParticipants.idempotencyKey, key)) });
    if (!row) return null;
    await authorizeParticipant(executor, ctx, actor, row);
    const audit = await executor.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.publicId, row.auditPublicId)) });
    const stored = audit?.payload && typeof audit.payload === "object" && !Array.isArray(audit.payload) ? (audit.payload as Record<string, unknown>).requestFingerprint : null;
    if (stored !== expectedFingerprint) throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used for a different commission command", 409);
    return present(executor, ctx, row);
}

async function insertVersion(executor: DbExecutor, ctx: CommandContext, input: {
    publicId: string; loanId: number; intermediaryId: number; previousParticipantId: number | null; commissionRate: string; role: string; note: string | null;
    effectiveFrom: Date; effectiveTo: Date | null; status: "active" | "ended"; idempotencyKey: string; requestFingerprint: string; action: string;
}) {
    const auditPublicId = randomUUID();
    await executor.insert(auditLogs).values({
        publicId: auditPublicId, tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource,
        requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "loan_commission_participant", entityId: input.publicId,
        action: input.action, payload: { requestFingerprint: input.requestFingerprint, previousParticipantId: input.previousParticipantId },
    });
    return executor.insert(loanCommissionParticipants).values({
        publicId: input.publicId, tenantId: ctx.tenantId, loanId: input.loanId, intermediaryId: input.intermediaryId,
        previousParticipantId: input.previousParticipantId, commissionRate: input.commissionRate, role: input.role, note: input.note,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, status: input.status, idempotencyKey: input.idempotencyKey,
        auditPublicId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId,
    }).returning().then((rows: Participant[]) => rows[0]!);
}

async function headRows(executor: DbExecutor, tenantId: string, loanId: number) {
    return executor.select().from(loanCommissionParticipants).where(and(
        eq(loanCommissionParticipants.tenantId, tenantId), eq(loanCommissionParticipants.loanId, loanId),
        sql`NOT EXISTS (SELECT 1 FROM loan_commission_participants successor WHERE successor.tenant_id = ${tenantId} AND successor.previous_participant_id = ${loanCommissionParticipants.id})`,
    )).orderBy(loanCommissionParticipants.id) as Promise<Participant[]>;
}

async function assertRateCapacity(executor: DbExecutor, ctx: CommandContext, loanId: number, newRate: Decimal, effectiveFrom: Date, excludedHeadId?: number) {
    await executor.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${loanId} FOR UPDATE`);
    const lockedLoan = await executor.query.loans.findFirst({ where: and(
        eq(loans.tenantId, ctx.tenantId),
        eq(loans.id, loanId),
    ) });
    if (!lockedLoan || lockedLoan.status === "replaced" || lockedLoan.status === "cancelled") {
        throw new DomainError(
            "LOAN_COMMISSION_LOCKED",
            "Commission participation cannot be changed for a terminal loan",
            409,
        );
    }
    const heads = await headRows(executor, ctx.tenantId, loanId);
    const total = heads.filter((row) => row.id !== excludedHeadId && (row.status === "active" || (row.effectiveTo !== null && row.effectiveTo > effectiveFrom)))
        .reduce((sum, row) => sum.plus(row.commissionRate), new FinancialDecimal("0")).plus(newRate);
    if (total.gt(100)) throw new DomainError("COMMISSION_RATE_OVERLAP", "Overlapping commission rates cannot exceed 100 percent", 409);
}

export async function addLoanCommissionParticipant(ctx: CommandContext, input: AddLoanCommissionParticipantInput) {
    const key = commandKey(ctx);
    const parsedRate = rate(input.commissionRate);
    const effectiveFrom = timestamp(input.effectiveFrom, "effectiveFrom");
    const role = text(input.role, "INVALID_COMMISSION_ROLE", "role is required");
    const note = input.note?.trim() || null;
    const requestFingerprint = fingerprint({ operation: "add", ...input, commissionRate: exactRate(parsedRate.toString()), role, note, effectiveFrom: effectiveFrom.toISOString() });
    const actor = await actorFor(ctx);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:loan-commission:${key}`}, 0))`);
        const existing = await replay(tx, ctx, actor, key, requestFingerprint);
        if (existing) return existing;
        const [loan, intermediary] = await Promise.all([loanFor(ctx, input.loanPublicId, actor, tx), intermediaryFor(ctx, input.intermediaryPublicId, actor, tx)]);
        if (intermediary.status !== "active") throw new DomainError("INTERMEDIARY_INACTIVE", "Inactive intermediaries cannot receive commission agreements", 409);
        await assertRateCapacity(tx, ctx, loan.id, parsedRate, effectiveFrom);
        const row = await insertVersion(tx, ctx, { publicId: randomUUID(), loanId: loan.id, intermediaryId: intermediary.id, previousParticipantId: null, commissionRate: parsedRate.toFixed(4), role, note, effectiveFrom, effectiveTo: null, status: "active", idempotencyKey: key, requestFingerprint, action: "added" });
        return present(tx, ctx, row);
    });
}

async function currentParticipant(ctx: CommandContext, publicId: string, actor: Actor | null, executor: DbExecutor) {
    const row = await executor.query.loanCommissionParticipants.findFirst({ where: and(eq(loanCommissionParticipants.tenantId, ctx.tenantId), eq(loanCommissionParticipants.publicId, publicId)) });
    if (!row) throw new DomainError("COMMISSION_PARTICIPANT_NOT_FOUND", "Commission participant not found", 404);
    await authorizeParticipant(executor, ctx, actor, row);
    const successor = await executor.query.loanCommissionParticipants.findFirst({ where: and(eq(loanCommissionParticipants.tenantId, ctx.tenantId), eq(loanCommissionParticipants.previousParticipantId, row.id)) });
    if (successor) throw new DomainError("COMMISSION_PARTICIPANT_SUPERSEDED", "Commission participant version is no longer current", 409);
    return row;
}

export async function updateLoanCommissionParticipant(ctx: CommandContext, input: UpdateLoanCommissionParticipantInput) {
    const key = commandKey(ctx);
    const parsedRate = rate(input.commissionRate);
    const effectiveFrom = timestamp(input.effectiveFrom, "effectiveFrom");
    const role = text(input.role, "INVALID_COMMISSION_ROLE", "role is required");
    const note = input.note?.trim() || null;
    const requestFingerprint = fingerprint({ operation: "update", participantPublicId: input.participantPublicId, commissionRate: exactRate(parsedRate.toString()), role, note, effectiveFrom: effectiveFrom.toISOString() });
    const actor = await actorFor(ctx);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:loan-commission:${key}`}, 0))`);
        const existing = await replay(tx, ctx, actor, key, requestFingerprint);
        if (existing) return existing;
        const prior = await currentParticipant(ctx, input.participantPublicId, actor, tx);
        if (prior.status !== "active") throw new DomainError("COMMISSION_PARTICIPANT_ENDED", "Ended commission participation cannot be updated", 409);
        if (effectiveFrom <= prior.effectiveFrom) throw new DomainError("INVALID_COMMISSION_DATE", "effectiveFrom must be after the prior version", 400);
        await assertRateCapacity(tx, ctx, prior.loanId, parsedRate, effectiveFrom, prior.id);
        const row = await insertVersion(tx, ctx, { publicId: randomUUID(), loanId: prior.loanId, intermediaryId: prior.intermediaryId, previousParticipantId: prior.id, commissionRate: parsedRate.toFixed(4), role, note, effectiveFrom, effectiveTo: null, status: "active", idempotencyKey: key, requestFingerprint, action: "updated" });
        return present(tx, ctx, row);
    });
}

export async function endLoanCommissionParticipant(ctx: CommandContext, input: EndLoanCommissionParticipantInput) {
    const key = commandKey(ctx);
    const effectiveTo = timestamp(input.effectiveTo, "effectiveTo");
    const reason = text(input.reason, "COMMISSION_END_REASON_REQUIRED", "reason is required");
    const requestFingerprint = fingerprint({ operation: "end", participantPublicId: input.participantPublicId, effectiveTo: effectiveTo.toISOString(), reason });
    const actor = await actorFor(ctx);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:loan-commission:${key}`}, 0))`);
        const existing = await replay(tx, ctx, actor, key, requestFingerprint);
        if (existing) return existing;
        const prior = await currentParticipant(ctx, input.participantPublicId, actor, tx);
        if (prior.status !== "active") throw new DomainError("COMMISSION_PARTICIPANT_ENDED", "Commission participant has already ended", 409);
        if (effectiveTo <= prior.effectiveFrom) throw new DomainError("INVALID_COMMISSION_DATE", "effectiveTo must be after effectiveFrom", 400);
        const row = await insertVersion(tx, ctx, { publicId: randomUUID(), loanId: prior.loanId, intermediaryId: prior.intermediaryId, previousParticipantId: prior.id, commissionRate: prior.commissionRate, role: prior.role, note: reason, effectiveFrom: prior.effectiveFrom, effectiveTo, status: "ended", idempotencyKey: key, requestFingerprint, action: "ended" });
        return present(tx, ctx, row);
    });
}

export async function listLoanCommissionParticipants(ctx: CommandContext, loanPublicId: string) {
    const actor = await actorFor(ctx);
    const loan = await loanFor(ctx, loanPublicId, actor);
    const rows = await headRows(db, ctx.tenantId, loan.id);
    const authorizedRows = await Promise.all(rows.map(async (row) => {
        try { await authorizeParticipant(db, ctx, actor, row); return row; }
        catch (error) {
            if (error instanceof DomainError && error.code === "COMMISSION_PARTICIPANT_NOT_FOUND") return null;
            throw error;
        }
    }));
    return Promise.all(authorizedRows.filter((row): row is Participant => row !== null).map((row) => present(db, ctx, row)));
}

export async function previewLoanCommission(ctx: CommandContext, input: { loanPublicId: string; paymentPublicIds: string[] }) {
    const actor = await actorFor(ctx);
    const loan = await loanFor(ctx, input.loanPublicId, actor);
    if (!Array.isArray(input.paymentPublicIds) || input.paymentPublicIds.length === 0) throw new DomainError("PAYMENTS_REQUIRED", "At least one paymentPublicId is required", 400);
    const uniqueIds = [...new Set(input.paymentPublicIds)];
    const payments = await db.select().from(transactions).where(and(
        canonicalPostedPaymentPredicate(ctx.tenantId),
        eq(transactions.loanId, loan.id),
        inArray(transactions.publicId, uniqueIds),
    ));
    if (payments.length !== uniqueIds.length) throw new DomainError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    const interest = payments.reduce((sum, payment) => sum.plus(payment.interestComponent), new FinancialDecimal("0"));
    const versions = await db.select().from(loanCommissionParticipants).where(and(eq(loanCommissionParticipants.tenantId, ctx.tenantId), eq(loanCommissionParticipants.loanId, loan.id))).orderBy(loanCommissionParticipants.id);
    const successors = new Map(versions.filter((row) => row.previousParticipantId !== null).map((row) => [row.previousParticipantId!, row]));
    const chains = versions.filter((row) => row.previousParticipantId === null).map((root) => {
        const chain = [root];
        let cursor = root;
        while (successors.has(cursor.id)) {
            cursor = successors.get(cursor.id)!;
            chain.push(cursor);
        }
        return chain;
    });
    const participants = await Promise.all(chains.map(async (chain) => {
        const head = chain[chain.length - 1]!;
        const intermediary = await db.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, head.intermediaryId)) });
        if (!intermediary || !accessible(actor, intermediary.ownerUserId)) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
        const amount = payments.reduce((sum, payment) => {
            const occurredAt = payment.postedAt;
            const applicable = chain.find((version, index) => version.effectiveFrom <= occurredAt
                && (chain[index + 1] === undefined || occurredAt < chain[index + 1]!.effectiveFrom)
                && (version.status === "active" || (version.effectiveTo !== null && occurredAt < version.effectiveTo)));
            return applicable ? sum.plus(new FinancialDecimal(payment.interestComponent).times(applicable.commissionRate).dividedBy(100)) : sum;
        }, new FinancialDecimal("0"));
        return { participantPublicId: head.publicId, intermediaryPublicId: intermediary.publicId, commissionRate: exactRate(head.commissionRate), commissionAmount: signedMoney(amount) };
    }));
    const total = participants.reduce((sum, participant) => sum.plus(participant.commissionAmount), new FinancialDecimal("0"));
    return { loanPublicId: loan.publicId, paymentPublicIds: uniqueIds, interestAmount: signedMoney(interest), totalCommission: signedMoney(total), participants };
}
