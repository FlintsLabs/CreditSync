import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    intermediaries,
    intermediaryBankAccounts,
    intermediatedDisbursementGroupPreviews,
    intermediatedDisbursementGroups,
    intermediatedTransferEvidenceIntents,
    intermediatedTransferEvents,
    loanDisbursements,
    loanIntermediaryAssignments,
    loans,
    users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import {
    FinancialDecimal,
    signedPublicMoneyPattern,
    unsignedPublicMoneyPattern,
} from "../lib/financial-decimal";
import { parseMoney, serializeMoney, type Money } from "../lib/money";
import {
    calculatePeriodInterest,
    normalizeFloatingInterestPolicy,
    type FloatingInterestPolicy,
} from "../lib/floating-interest-policy";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { intermediaryHeldBalanceProjection } from "./intermediary-service";
import { recordIntermediatedLoanPayout, reverseIntermediatedLoanPayout } from "./loan-disbursement-service";

type Executor = any;
type Actor = typeof users.$inferSelect;
type GroupRow = typeof intermediatedDisbursementGroups.$inferSelect;
type EventRow = typeof intermediatedTransferEvents.$inferSelect;
type PreviewRow = typeof intermediatedDisbursementGroupPreviews.$inferSelect;

export type TransferRole = "funding_to_intermediary" | "borrower_net_payout" | "advance_interest_return";
export type TransferChannel = "bank_transfer" | "cash" | "adjustment";

export interface CreateIntermediatedDisbursementGroupInput {
    loanPublicId: string;
    intermediaryPublicId: string;
    retainedBalance: string;
    note?: string | null;
}

export interface CreateTransferEventInput {
    role: TransferRole;
    channel: TransferChannel;
    amount: string;
    transferredAt: string;
    intermediaryBankAccountPublicId?: string | null;
    senderHint?: string | null;
    payeeHint?: string | null;
    bankReference?: string | null;
    note?: string | null;
}

export interface ListIntermediatedDisbursementGroupsInput {
    loanPublicId?: string;
    intermediaryPublicId?: string;
    status?: "draft" | "needs_review" | "ready" | "posted" | "reversed";
}

type GroupRelations = {
    loanPublicId: string;
    intermediaryPublicId: string;
};

type EventRelations = {
    groupPublicId: string;
    intermediaryBankAccountPublicId: string | null;
    reversedEventPublicId: string | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const transferRoles = new Set<TransferRole>(["funding_to_intermediary", "borrower_net_payout", "advance_interest_return"]);
const transferChannels = new Set<TransferChannel>(["bank_transfer", "cash", "adjustment"]);

function auditContext(ctx: CommandContext) {
    return {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
    };
}

function requirePublicId(value: string, field: string) {
    if (!uuidPattern.test(value)) {
        throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
    }
}

function commandKey(ctx: CommandContext) {
    const key = ctx.idempotencyKey?.trim();
    if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    return key;
}

function publicCommandKey(ctx: CommandContext) {
    const key = commandKey(ctx);
    if (key.startsWith("internal:")) {
        throw new DomainError(
            "RESERVED_IDEMPOTENCY_KEY",
            "Idempotency keys beginning with internal: are reserved",
            400,
        );
    }
    return key;
}

function money(value: string, field: string) {
    try {
        return parseMoney(value);
    } catch {
        throw new DomainError(
            "INVALID_INTERMEDIATED_DISBURSEMENT_AMOUNT",
            `${field} must be a non-negative string with exactly two decimals`,
            400,
            { field },
        );
    }
}

function transferredAt(value: string) {
    const parsed = new Date(value);
    if (!value || Number.isNaN(parsed.getTime()) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
        throw new DomainError("INVALID_TRANSFERRED_AT", "transferredAt must be an ISO 8601 timestamp with an offset", 400);
    }
    return parsed;
}

function normalizedText(value: string | null | undefined) {
    return value?.trim() || null;
}

function normalizedReference(value: string | null | undefined) {
    const display = normalizedText(value);
    if (!display) return { display: null, hash: null };
    const identity = display.normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    return { display, hashIdentity: identity };
}

function fingerprint(value: Record<string, unknown>) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function referenceHash(tenantId: string, identity: string) {
    return createHash("sha256").update(`${tenantId}\0${identity}`).digest("hex");
}

function signedMoney(value: Money) {
    if (!value.isFinite()) throw new DomainError("INVALID_INTERMEDIATED_DISBURSEMENT_STATE", "Calculated money is not finite", 500);
    const output = value.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
    return output === "-0.00" ? "0.00" : output;
}

function transferAggregates(
    events: Array<Pick<EventRow, "role" | "amount" | "status">>,
    retainedBalance: Money,
) {
    const includedEvents = events.filter((event) => event.status === "ready" || event.status === "posted");
    const totalFor = (role: TransferRole) => includedEvents
        .filter((event) => event.role === role)
        .reduce((total, event) => total.plus(event.amount), new FinancialDecimal("0"));
    const actualFunding = totalFor("funding_to_intermediary");
    const actualBorrowerPayout = totalFor("borrower_net_payout");
    const actualAdvanceInterestReturn = totalFor("advance_interest_return");
    return {
        actualFunding,
        actualBorrowerPayout,
        actualAdvanceInterestReturn,
        variance: actualFunding.minus(actualBorrowerPayout).minus(actualAdvanceInterestReturn).minus(retainedBalance),
    };
}

function previewStateHash(groupPublicId: string, group: GroupRow, events: EventRow[], evidenceReady: boolean) {
    return fingerprint({
        contract: "intermediated-disbursement-preview",
        version: 1,
        groupPublicId,
        expectedFunding: serializeMoney(group.expectedFundingAmount),
        expectedBorrowerPayout: serializeMoney(group.expectedBorrowerPayoutAmount),
        expectedAdvanceInterestReturn: serializeMoney(group.expectedAdvanceInterestReturnAmount),
        retainedBalance: serializeMoney(group.retainedBalanceAmount),
        events: events.map((event) => ({
            publicId: event.publicId,
            role: event.role,
            amount: serializeMoney(event.amount),
            transferredAt: event.transferredAt.toISOString(),
            status: event.status,
            bankReferenceHash: event.bankReferenceHash,
        })),
        evidenceReady,
    });
}

function assertPublicTransferAggregates(aggregates: ReturnType<typeof transferAggregates>) {
    for (const [field, value] of [
        ["actualFunding", aggregates.actualFunding],
        ["actualBorrowerPayout", aggregates.actualBorrowerPayout],
        ["actualAdvanceInterestReturn", aggregates.actualAdvanceInterestReturn],
    ] as const) {
        const output = value.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
        if (!unsignedPublicMoneyPattern.test(output)) {
            throw new DomainError(
                "INTERMEDIATED_DISBURSEMENT_AGGREGATE_OUT_OF_RANGE",
                "Transfer would exceed the supported public money range for this group",
                409,
                { field },
            );
        }
    }
    const variance = aggregates.variance.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
    if (!signedPublicMoneyPattern.test(variance)) {
        throw new DomainError(
            "INTERMEDIATED_DISBURSEMENT_AGGREGATE_OUT_OF_RANGE",
            "Transfer would exceed the supported public money range for this group",
            409,
            { field: "variance" },
        );
    }
}

function presentGroup(row: GroupRow, related: GroupRelations) {
    return {
        publicId: row.publicId,
        loanPublicId: related.loanPublicId,
        intermediaryPublicId: related.intermediaryPublicId,
        expectedFunding: serializeMoney(row.expectedFundingAmount),
        expectedBorrowerPayout: serializeMoney(row.expectedBorrowerPayoutAmount),
        expectedAdvanceInterestReturn: serializeMoney(row.expectedAdvanceInterestReturnAmount),
        retainedBalance: serializeMoney(row.retainedBalanceAmount),
        status: row.status,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function presentEvent(row: EventRow, related: EventRelations) {
    return {
        publicId: row.publicId,
        groupPublicId: related.groupPublicId,
        intermediaryBankAccountPublicId: related.intermediaryBankAccountPublicId,
        reversedEventPublicId: related.reversedEventPublicId,
        role: row.role as TransferRole,
        channel: row.channel as TransferChannel,
        amount: serializeMoney(row.amount),
        senderHint: row.senderHint,
        payeeHint: row.payeeHint,
        bankReference: row.bankReference,
        transferredAt: row.transferredAt.toISOString(),
        status: row.status,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function presentPreview(row: PreviewRow) {
    return {
        publicId: row.publicId,
        version: row.version,
        status: row.status,
        expectedFunding: serializeMoney(row.expectedFundingAmount),
        actualFunding: serializeMoney(row.actualFundingAmount),
        expectedBorrowerPayout: serializeMoney(row.expectedBorrowerPayoutAmount),
        actualBorrowerPayout: serializeMoney(row.actualBorrowerPayoutAmount),
        expectedAdvanceInterestReturn: serializeMoney(row.expectedAdvanceInterestReturnAmount),
        actualAdvanceInterestReturn: serializeMoney(row.actualAdvanceInterestReturnAmount),
        retainedBalance: serializeMoney(row.retainedBalanceAmount),
        variance: signedMoney(new FinancialDecimal(row.varianceAmount)),
        evidenceReady: row.evidenceReady,
        warnings: row.warnings,
        previewHash: row.previewHash,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
    };
}

async function actorFor(ctx: CommandContext, executor: Executor = db): Promise<Actor | null> {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({ where: and(
        eq(users.tenantId, ctx.tenantId),
        eq(users.id, ctx.actorUserId),
    ) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

function canReadOwner(actor: Actor | null, ownerUserId: number | null) {
    return !actor || canAccessTenantWideData({ role: actor.role ?? "viewer" }) || ownerUserId === actor.id;
}

async function loanFor(ctx: CommandContext, publicId: string, actor: Actor | null, executor: Executor = db) {
    requirePublicId(publicId, "loanPublicId");
    const row = await executor.query.loans.findFirst({ where: and(
        eq(loans.tenantId, ctx.tenantId),
        eq(loans.publicId, publicId),
    ) });
    if (!row || !canReadOwner(actor, row.ownerUserId)) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    return row;
}

async function intermediaryFor(ctx: CommandContext, publicId: string, actor: Actor | null, executor: Executor = db) {
    requirePublicId(publicId, "intermediaryPublicId");
    const row = await executor.query.intermediaries.findFirst({ where: and(
        eq(intermediaries.tenantId, ctx.tenantId),
        eq(intermediaries.publicId, publicId),
    ) });
    if (!row || !canReadOwner(actor, row.ownerUserId)) {
        throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
    }
    return row;
}

async function priorAudit(executor: Executor, ctx: CommandContext, entityId: string, action: string) {
    return executor.query.auditLogs.findFirst({
        where: and(
            eq(auditLogs.tenantId, ctx.tenantId),
            eq(auditLogs.entityId, entityId),
            eq(auditLogs.action, action),
        ),
        orderBy: desc(auditLogs.id),
    });
}

function auditFingerprint(row: typeof auditLogs.$inferSelect | undefined) {
    if (!row?.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return null;
    const value = (row.payload as Record<string, unknown>).requestFingerprint;
    return typeof value === "string" ? value : null;
}

function auditedResult<T extends object>(row: typeof auditLogs.$inferSelect | undefined) {
    if (!row?.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return null;
    const value = (row.payload as Record<string, unknown>).after;
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as T
        : null;
}

async function hasPairAssignment(executor: Executor, ctx: CommandContext, loanId: number, intermediaryId: number) {
    return executor.query.loanIntermediaryAssignments.findFirst({ where: and(
        eq(loanIntermediaryAssignments.tenantId, ctx.tenantId),
        eq(loanIntermediaryAssignments.loanId, loanId),
        eq(loanIntermediaryAssignments.intermediaryId, intermediaryId),
        inArray(loanIntermediaryAssignments.role, ["disbursement", "both"]),
    ) });
}

async function effectiveAssignment(
    executor: Executor,
    ctx: CommandContext,
    loanId: number,
    intermediaryId: number,
    at: Date,
) {
    return executor.query.loanIntermediaryAssignments.findFirst({ where: and(
        eq(loanIntermediaryAssignments.tenantId, ctx.tenantId),
        eq(loanIntermediaryAssignments.loanId, loanId),
        eq(loanIntermediaryAssignments.intermediaryId, intermediaryId),
        inArray(loanIntermediaryAssignments.role, ["disbursement", "both"]),
        sql`${loanIntermediaryAssignments.effectiveFrom} <= ${at.toISOString()}::timestamptz`,
        sql`(${loanIntermediaryAssignments.effectiveTo} IS NULL OR ${loanIntermediaryAssignments.effectiveTo} > ${at.toISOString()}::timestamptz)`,
    ) });
}

function contractualTargets(loan: typeof loans.$inferSelect, retained: Money) {
    if (loan.status !== "active") {
        throw new DomainError("LOAN_NOT_ACTIVE", "Only an active loan can have an intermediated disbursement group", 409);
    }
    const snapshot = loan.activationResult;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new DomainError("LOAN_ACTIVATION_RESULT_MISSING", "Persisted loan activation result is required", 409);
    }
    const activation = snapshot as Record<string, unknown>;
    const principalValue = typeof activation.principalAmount === "string"
        ? activation.principalAmount
        : typeof activation.principal === "string" ? activation.principal : null;
    if (!principalValue) {
        throw new DomainError("LOAN_ACTIVATION_RESULT_INVALID", "Persisted loan activation principal is unavailable", 409);
    }
    let principal: Money;
    try {
        principal = parseMoney(principalValue);
    } catch {
        throw new DomainError("LOAN_ACTIVATION_RESULT_INVALID", "Persisted loan activation principal is invalid", 409);
    }
    let advanceInterest = new FinancialDecimal("0");
    if (activation.repaymentType === "floating") {
        const rawPolicy = activation.floatingInterestPolicy;
        if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
            throw new DomainError("LOAN_ACTIVATION_RESULT_INVALID", "Persisted floating activation policy is unavailable", 409);
        }
        let policy: FloatingInterestPolicy;
        try {
            policy = normalizeFloatingInterestPolicy(rawPolicy as FloatingInterestPolicy);
        } catch {
            throw new DomainError("LOAN_ACTIVATION_RESULT_INVALID", "Persisted floating activation policy is invalid", 409);
        }
        if (policy.advanceInterestPeriods === 1) {
            advanceInterest = new FinancialDecimal(calculatePeriodInterest(serializeMoney(principal), policy));
        }
    }
    const baseBorrowerPayout = principal.minus(advanceInterest);
    if (retained.gt(baseBorrowerPayout)) {
        throw new DomainError(
            "INVALID_RETAINED_BALANCE",
            "Retained balance cannot exceed the activated net borrower payout",
            400,
            { maximum: serializeMoney(baseBorrowerPayout) },
        );
    }
    return {
        expectedFunding: serializeMoney(principal),
        expectedBorrowerPayout: serializeMoney(baseBorrowerPayout.minus(retained)),
        expectedAdvanceInterestReturn: serializeMoney(advanceInterest),
    };
}

async function accessibleGroup(ctx: CommandContext, publicId: string, executor: Executor = db) {
    requirePublicId(publicId, "groupPublicId");
    const actor = await actorFor(ctx, executor);
    const group = await executor.query.intermediatedDisbursementGroups.findFirst({ where: and(
        eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
        eq(intermediatedDisbursementGroups.publicId, publicId),
    ) });
    if (!group) throw new DomainError("INTERMEDIATED_DISBURSEMENT_NOT_FOUND", "Intermediated disbursement group not found", 404);
    const [loan, intermediary] = await Promise.all([
        executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, group.loanId)) }),
        executor.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, group.intermediaryId)) }),
    ]);
    if (!loan || !intermediary || !canReadOwner(actor, loan.ownerUserId) || !canReadOwner(actor, intermediary.ownerUserId)) {
        throw new DomainError("INTERMEDIATED_DISBURSEMENT_NOT_FOUND", "Intermediated disbursement group not found", 404);
    }
    return { actor, group, loan, intermediary };
}

async function accountPublicId(ctx: CommandContext, accountId: number | null, executor: Executor = db) {
    if (accountId === null) return null;
    return executor.query.intermediaryBankAccounts.findFirst({ where: and(
        eq(intermediaryBankAccounts.tenantId, ctx.tenantId),
        eq(intermediaryBankAccounts.id, accountId),
    ) }).then((row: typeof intermediaryBankAccounts.$inferSelect | undefined) => row?.publicId ?? null);
}

export async function createIntermediatedDisbursementGroup(
    ctx: CommandContext,
    input: CreateIntermediatedDisbursementGroupInput,
) {
    const idempotencyKey = publicCommandKey(ctx);
    const retained = money(input.retainedBalance, "retainedBalance");
    const note = normalizedText(input.note);
    const actor = await actorFor(ctx);
    const [accessibleLoan, accessibleIntermediary] = await Promise.all([
        loanFor(ctx, input.loanPublicId, actor),
        intermediaryFor(ctx, input.intermediaryPublicId, actor),
    ]);
    const requestFingerprint = fingerprint({
        loanPublicId: input.loanPublicId,
        intermediaryPublicId: input.intermediaryPublicId,
        retainedBalance: serializeMoney(retained),
        note,
    });

    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intermediated-group-create:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        const existing = await tx.query.intermediatedDisbursementGroups.findFirst({ where: and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.idempotencyKey, idempotencyKey),
        ) });
        if (existing) {
            const prior = await priorAudit(tx, ctx, existing.publicId, "created");
            if (existing.loanId !== accessibleLoan.id
                || existing.intermediaryId !== accessibleIntermediary.id
                || auditFingerprint(prior) !== requestFingerprint) {
                throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used for a different disbursement group", 409);
            }
            const stored = auditedResult<ReturnType<typeof presentGroup>>(prior);
            if (!prior || !stored) throw new DomainError("IDEMPOTENT_RESULT_NOT_FOUND", "Stored disbursement group result is unavailable", 409);
            return {
                ...stored,
                auditPublicId: prior.publicId,
                correlationId: prior.correlationId ?? ctx.correlationId,
            };
        }

        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${accessibleLoan.id} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM intermediaries WHERE tenant_id = ${ctx.tenantId} AND id = ${accessibleIntermediary.id} FOR UPDATE`);
        const [loan, intermediary] = await Promise.all([
            tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, accessibleLoan.id)) }),
            tx.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, accessibleIntermediary.id)) }),
        ]);
        if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
        if (!intermediary) throw new DomainError("INTERMEDIARY_NOT_FOUND", "Intermediary not found", 404);
        if (intermediary.status !== "active") {
            throw new DomainError("INTERMEDIARY_INACTIVE", "Inactive intermediaries cannot receive disbursement groups", 409);
        }
        if (!await hasPairAssignment(tx, ctx, loan.id, intermediary.id)) {
            throw new DomainError("DISBURSEMENT_ASSIGNMENT_REQUIRED", "A matching disbursement assignment is required", 409);
        }
        const expected = contractualTargets(loan, retained);
        const row = await tx.insert(intermediatedDisbursementGroups).values({
            tenantId: ctx.tenantId,
            loanId: loan.id,
            intermediaryId: intermediary.id,
            expectedFundingAmount: expected.expectedFunding,
            expectedBorrowerPayoutAmount: expected.expectedBorrowerPayout,
            expectedAdvanceInterestReturnAmount: expected.expectedAdvanceInterestReturn,
            retainedBalanceAmount: serializeMoney(retained),
            idempotencyKey,
            note,
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        const after = presentGroup(row, { loanPublicId: loan.publicId, intermediaryPublicId: intermediary.publicId });
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "intermediated_disbursement_group",
            entityId: row.publicId,
            action: "created",
            payload: { before: null, after, idempotencyKey, requestFingerprint },
        });
        return { ...after, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function createTransferEvent(
    ctx: CommandContext,
    groupPublicId: string,
    input: CreateTransferEventInput,
) {
    const idempotencyKey = publicCommandKey(ctx);
    requirePublicId(groupPublicId, "groupPublicId");
    if (!transferRoles.has(input.role)) {
        throw new DomainError("INVALID_TRANSFER_ROLE", "Unsupported intermediated transfer role", 400);
    }
    if (!transferChannels.has(input.channel)) {
        throw new DomainError("INVALID_TRANSFER_CHANNEL", "Unsupported intermediated transfer channel", 400);
    }
    const parsedAmount = money(input.amount, "amount");
    if (parsedAmount.isZero()) throw new DomainError("INVALID_TRANSFER_AMOUNT", "Transfer amount must be greater than zero", 400);
    const at = transferredAt(input.transferredAt);
    const bankReference = normalizedReference(input.bankReference);
    const bankReferenceHash = bankReference.hashIdentity ? referenceHash(ctx.tenantId, bankReference.hashIdentity) : null;
    const senderHint = normalizedText(input.senderHint);
    const payeeHint = normalizedText(input.payeeHint);
    const note = normalizedText(input.note);
    if (input.intermediaryBankAccountPublicId) requirePublicId(input.intermediaryBankAccountPublicId, "intermediaryBankAccountPublicId");
    const requestFingerprint = fingerprint({
        groupPublicId,
        role: input.role,
        channel: input.channel,
        amount: serializeMoney(parsedAmount),
        transferredAt: at.toISOString(),
        intermediaryBankAccountPublicId: input.intermediaryBankAccountPublicId ?? null,
        senderHint,
        payeeHint,
        bankReferenceHash,
        note,
    });
    const accessible = await accessibleGroup(ctx, groupPublicId);

    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intermediated-event-create:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        const existing = await tx.query.intermediatedTransferEvents.findFirst({ where: and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.idempotencyKey, idempotencyKey),
        ) });
        if (existing) {
            const prior = await priorAudit(tx, ctx, existing.publicId, "created");
            if (existing.groupId !== accessible.group.id || auditFingerprint(prior) !== requestFingerprint) {
                throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key was already used for a different transfer event", 409);
            }
            const stored = auditedResult<ReturnType<typeof presentEvent>>(prior);
            if (!prior || !stored) throw new DomainError("IDEMPOTENT_RESULT_NOT_FOUND", "Stored transfer-event result is unavailable", 409);
            return {
                ...stored,
                auditPublicId: prior.publicId,
                correlationId: prior.correlationId ?? ctx.correlationId,
            };
        }
        if (bankReferenceHash) {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intermediated-event-reference:${ctx.tenantId}:${bankReferenceHash}`}, 0))`);
        }
        await tx.execute(sql`SELECT id FROM intermediated_disbursement_groups WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.group.id} FOR UPDATE`);
        const group = await tx.query.intermediatedDisbursementGroups.findFirst({ where: and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.id, accessible.group.id),
        ) });
        if (!group) throw new DomainError("INTERMEDIATED_DISBURSEMENT_NOT_FOUND", "Intermediated disbursement group not found", 404);
        if (["posted", "reversed"].includes(group.status)) {
            throw new DomainError("INTERMEDIATED_DISBURSEMENT_LOCKED", "Posted or reversed groups cannot receive transfer events", 409);
        }
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${group.loanId} FOR UPDATE`);
        const intermediary = await tx.query.intermediaries.findFirst({ where: and(
            eq(intermediaries.tenantId, ctx.tenantId),
            eq(intermediaries.id, group.intermediaryId),
        ) });
        if (!intermediary || intermediary.status !== "active") {
            throw new DomainError("INTERMEDIARY_INACTIVE", "Inactive intermediaries cannot receive transfer events", 409);
        }
        if (!await effectiveAssignment(tx, ctx, group.loanId, group.intermediaryId, at)) {
            throw new DomainError(
                "DISBURSEMENT_ASSIGNMENT_REQUIRED",
                "A matching disbursement assignment must be effective at the transfer timestamp",
                409,
            );
        }
        let account: typeof intermediaryBankAccounts.$inferSelect | null = null;
        if (input.intermediaryBankAccountPublicId) {
            account = await tx.query.intermediaryBankAccounts.findFirst({ where: and(
                eq(intermediaryBankAccounts.tenantId, ctx.tenantId),
                eq(intermediaryBankAccounts.publicId, input.intermediaryBankAccountPublicId),
            ) }) ?? null;
            if (!account || account.intermediaryId !== group.intermediaryId) {
                throw new DomainError("INTERMEDIARY_BANK_ACCOUNT_NOT_FOUND", "Intermediary bank account not found", 404);
            }
            if (account.status !== "active") {
                throw new DomainError("INTERMEDIARY_BANK_ACCOUNT_INACTIVE", "Inactive bank accounts cannot receive transfer events", 409);
            }
        }
        if (bankReferenceHash && await tx.query.intermediatedTransferEvents.findFirst({ where: and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.bankReferenceHash, bankReferenceHash),
        ) })) {
            throw new DomainError("DUPLICATE_BANK_REFERENCE", "Bank reference is already attached to another transfer event", 409);
        }
        const existingEvents = await tx.select({
            role: intermediatedTransferEvents.role,
            amount: intermediatedTransferEvents.amount,
            status: intermediatedTransferEvents.status,
        }).from(intermediatedTransferEvents).where(and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.groupId, group.id),
        ));
        assertPublicTransferAggregates(transferAggregates([
            ...existingEvents,
            { role: input.role, amount: serializeMoney(parsedAmount), status: "ready" },
        ], new FinancialDecimal(group.retainedBalanceAmount)));
        const row = await tx.insert(intermediatedTransferEvents).values({
            tenantId: ctx.tenantId,
            groupId: group.id,
            intermediaryBankAccountId: account?.id ?? null,
            role: input.role,
            channel: input.channel,
            amount: serializeMoney(parsedAmount),
            senderHint,
            payeeHint,
            bankReference: bankReference.display,
            bankReferenceHash,
            transferredAt: at,
            status: "ready",
            idempotencyKey,
            note,
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        const after = presentEvent(row, {
            groupPublicId,
            intermediaryBankAccountPublicId: account?.publicId ?? null,
            reversedEventPublicId: null,
        });
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "intermediated_transfer_event",
            entityId: row.publicId,
            action: "created",
            payload: { before: null, after, groupPublicId, idempotencyKey, requestFingerprint },
        });
        await tx.update(intermediatedDisbursementGroupPreviews).set({ status: "stale" }).where(and(
            eq(intermediatedDisbursementGroupPreviews.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroupPreviews.groupId, group.id),
            inArray(intermediatedDisbursementGroupPreviews.status, ["ready", "needs_review"]),
        ));
        await tx.update(intermediatedDisbursementGroups).set({
            status: "draft",
            updatedByUserId: ctx.actorUserId,
            updatedAt: new Date(),
        }).where(and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.id, group.id),
        ));
        return { ...after, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

function addRoleWarning(
    warnings: Array<{ code: string; amount?: string }>,
    actual: Money,
    expected: Money,
    role: "FUNDING" | "BORROWER_PAYOUT" | "ADVANCE_INTEREST_RETURN",
) {
    if (actual.eq(expected)) return;
    warnings.push({
        code: `${role}_${actual.lt(expected) ? "UNDER" : "OVER"}_EXPECTED`,
        amount: serializeMoney(actual.minus(expected).abs()),
    });
}

export async function previewIntermediatedDisbursement(ctx: CommandContext, groupPublicId: string) {
    const accessible = await accessibleGroup(ctx, groupPublicId);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM intermediated_disbursement_groups WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.group.id} FOR UPDATE`);
        const group = await tx.query.intermediatedDisbursementGroups.findFirst({ where: and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.id, accessible.group.id),
        ) });
        if (!group) throw new DomainError("INTERMEDIATED_DISBURSEMENT_NOT_FOUND", "Intermediated disbursement group not found", 404);
        if (["posted", "reversed"].includes(group.status)) {
            throw new DomainError("INTERMEDIATED_DISBURSEMENT_LOCKED", "Posted or reversed groups cannot be previewed", 409);
        }
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${group.loanId} FOR UPDATE`);
        const events = await tx.select().from(intermediatedTransferEvents).where(and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.groupId, group.id),
        )).orderBy(asc(intermediatedTransferEvents.id));
        const aggregates = transferAggregates(events, new FinancialDecimal(group.retainedBalanceAmount));
        const { actualFunding, actualBorrowerPayout, actualAdvanceInterestReturn, variance } = aggregates;
        assertPublicTransferAggregates(aggregates);
        const expectedFunding = new FinancialDecimal(group.expectedFundingAmount);
        const expectedBorrowerPayout = new FinancialDecimal(group.expectedBorrowerPayoutAmount);
        const expectedAdvanceInterestReturn = new FinancialDecimal(group.expectedAdvanceInterestReturnAmount);
        const retainedBalance = new FinancialDecimal(group.retainedBalanceAmount);

        const warnings: Array<{ code: string; amount?: string }> = [];
        addRoleWarning(warnings, actualFunding, expectedFunding, "FUNDING");
        addRoleWarning(warnings, actualBorrowerPayout, expectedBorrowerPayout, "BORROWER_PAYOUT");
        addRoleWarning(warnings, actualAdvanceInterestReturn, expectedAdvanceInterestReturn, "ADVANCE_INTEREST_RETURN");
        if (!variance.isZero()) warnings.push({
            code: variance.isNegative() ? "NEGATIVE_RECONCILIATION_VARIANCE" : "POSITIVE_RECONCILIATION_VARIANCE",
            amount: serializeMoney(variance.abs()),
        });
        const allEventsReady = events.length > 0 && events.every((event) => event.status === "ready" || event.status === "posted");
        let pendingEvidence = false;
        if (events.length) {
            pendingEvidence = Boolean(await tx.query.intermediatedTransferEvidenceIntents.findFirst({ where: and(
                eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
                inArray(intermediatedTransferEvidenceIntents.eventId, events.map((event) => event.id)),
                eq(intermediatedTransferEvidenceIntents.status, "pending"),
            ) }));
        }
        const evidenceReady = allEventsReady && !pendingEvidence;
        if (!allEventsReady) warnings.push({ code: "TRANSFER_EVENTS_NOT_READY" });
        if (pendingEvidence) warnings.push({ code: "TRANSFER_EVIDENCE_NOT_READY" });
        const roleTotalsMatch = actualFunding.eq(expectedFunding)
            && actualBorrowerPayout.eq(expectedBorrowerPayout)
            && actualAdvanceInterestReturn.eq(expectedAdvanceInterestReturn);
        const status = roleTotalsMatch && variance.isZero() && evidenceReady ? "ready" : "needs_review";

        const prior = await tx.select().from(intermediatedDisbursementGroupPreviews).where(and(
            eq(intermediatedDisbursementGroupPreviews.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroupPreviews.groupId, group.id),
        )).orderBy(desc(intermediatedDisbursementGroupPreviews.version));
        if (prior.some((row) => row.status === "ready" || row.status === "needs_review")) {
            await tx.update(intermediatedDisbursementGroupPreviews).set({ status: "stale" }).where(and(
                eq(intermediatedDisbursementGroupPreviews.tenantId, ctx.tenantId),
                eq(intermediatedDisbursementGroupPreviews.groupId, group.id),
                inArray(intermediatedDisbursementGroupPreviews.status, ["ready", "needs_review"]),
            ));
        }
        const version = (prior[0]?.version ?? 0) + 1;
        const previewHash = previewStateHash(groupPublicId, group, events, evidenceReady);
        const expiresAt = new Date(Date.now() + 15 * 60_000);
        const row = await tx.insert(intermediatedDisbursementGroupPreviews).values({
            tenantId: ctx.tenantId,
            groupId: group.id,
            version,
            status,
            expectedFundingAmount: serializeMoney(expectedFunding),
            actualFundingAmount: serializeMoney(actualFunding),
            expectedBorrowerPayoutAmount: serializeMoney(expectedBorrowerPayout),
            actualBorrowerPayoutAmount: serializeMoney(actualBorrowerPayout),
            expectedAdvanceInterestReturnAmount: serializeMoney(expectedAdvanceInterestReturn),
            actualAdvanceInterestReturnAmount: serializeMoney(actualAdvanceInterestReturn),
            retainedBalanceAmount: serializeMoney(retainedBalance),
            varianceAmount: signedMoney(variance),
            evidenceReady,
            warnings,
            previewHash,
            expiresAt,
            createdByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await tx.update(intermediatedDisbursementGroups).set({
            status,
            updatedByUserId: ctx.actorUserId,
            updatedAt: new Date(),
        }).where(and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.id, group.id),
        ));
        const after = presentPreview(row);
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "intermediated_disbursement_preview",
            entityId: row.publicId,
            action: "created",
            payload: {
                groupPublicId,
                version,
                status,
                previewHash,
                expectedFunding: after.expectedFunding,
                actualFunding: after.actualFunding,
                actualBorrowerPayout: after.actualBorrowerPayout,
                actualAdvanceInterestReturn: after.actualAdvanceInterestReturn,
                retainedBalance: after.retainedBalance,
                variance: after.variance,
                warnings,
            },
        });
        return {
            ...after,
            groupPublicId,
            auditPublicId: audit.publicId,
            correlationId: ctx.correlationId,
        };
    });
}

type PostedGroupResult = ReturnType<typeof presentGroup> & {
    proposalPublicId: string;
    loanDisbursementPublicId: string;
    advanceInterestProjectionPublicId: string;
    fundingAmount: string;
    borrowerPayoutAmount: string;
    advanceInterestAmount: string;
    intermediaryHeldBalance: string;
    transferEventPublicIds: string[];
};

function latestTransferTime(events: EventRow[]) {
    return events.reduce(
        (latest, event) => event.transferredAt.getTime() > latest.getTime() ? event.transferredAt : latest,
        events[0]!.transferredAt,
    );
}

async function finalizedEvidenceReady(executor: Executor, ctx: CommandContext, events: EventRow[]) {
    if (!events.length) return false;
    const pending = await executor.query.intermediatedTransferEvidenceIntents.findFirst({ where: and(
        eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
        inArray(intermediatedTransferEvidenceIntents.eventId, events.map((event) => event.id)),
        eq(intermediatedTransferEvidenceIntents.status, "pending"),
    ) });
    return !pending;
}

function storedPostedResult(row: typeof auditLogs.$inferSelect | undefined) {
    return auditedResult<PostedGroupResult>(row);
}

function reversalRequestHash(groupPublicId: string, reason: string) {
    return fingerprint({
        contract: "intermediated-disbursement-reversal",
        version: 1,
        groupPublicId,
        reason,
    });
}

export async function postIntermediatedDisbursement(
    ctx: CommandContext,
    groupPublicId: string,
    proposalPublicId: string,
    confirmed: boolean,
) {
    requirePublicId(groupPublicId, "groupPublicId");
    requirePublicId(proposalPublicId, "proposalPublicId");
    if (!confirmed) {
        throw new DomainError(
            "INTERMEDIATED_DISBURSEMENT_CONFIRMATION_REQUIRED",
            "Explicit confirmation is required to post an intermediated disbursement",
            400,
        );
    }
    const postIdempotencyKey = commandKey(ctx);
    const accessible = await accessibleGroup(ctx, groupPublicId);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intermediated-group-post:${ctx.tenantId}:${postIdempotencyKey}`}, 0))`);
        const reusedKey = await tx.query.intermediatedDisbursementGroups.findFirst({ where: and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.postIdempotencyKey, postIdempotencyKey),
        ) });
        if (reusedKey && reusedKey.id !== accessible.group.id) {
            throw new DomainError(
                "IDEMPOTENCY_KEY_CONFLICT",
                "Idempotency key was already used for another intermediated disbursement post",
                409,
            );
        }
        await tx.execute(sql`SELECT id FROM intermediated_disbursement_groups WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.group.id} FOR UPDATE`);
        const group = await tx.query.intermediatedDisbursementGroups.findFirst({ where: and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.id, accessible.group.id),
        ) });
        if (!group) throw new DomainError("INTERMEDIATED_DISBURSEMENT_NOT_FOUND", "Intermediated disbursement group not found", 404);
        if (group.status === "posted") {
            if (group.postIdempotencyKey !== postIdempotencyKey) {
                throw new DomainError(
                    "INTERMEDIATED_DISBURSEMENT_ALREADY_POSTED",
                    "Intermediated disbursement was already posted with another idempotency key",
                    409,
                );
            }
            const storedAudit = await priorAudit(tx, ctx, group.publicId, "posted");
            const prior = storedPostedResult(storedAudit);
            if (!storedAudit || !prior || prior.proposalPublicId !== proposalPublicId) {
                throw new DomainError(
                    "IDEMPOTENCY_KEY_CONFLICT",
                    "The post idempotency key was replayed with a different proposal",
                    409,
                );
            }
            return {
                ...prior,
                duplicate: true,
                auditPublicId: storedAudit.publicId,
                correlationId: storedAudit.correlationId ?? ctx.correlationId,
            };
        }
        if (group.status === "reversed") {
            throw new DomainError("INTERMEDIATED_DISBURSEMENT_LOCKED", "Reversed groups cannot be posted", 409);
        }

        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${group.loanId} FOR UPDATE`);
        const currentLoan = await tx.query.loans.findFirst({ where: and(
            eq(loans.tenantId, ctx.tenantId),
            eq(loans.id, group.loanId),
        ) });
        if (!currentLoan || currentLoan.status !== "active") {
            throw new DomainError("LOAN_NOT_ACTIVE", "Only an active loan can be posted", 409);
        }
        const currentTargets = contractualTargets(
            currentLoan,
            new FinancialDecimal(group.retainedBalanceAmount),
        );
        if (!new FinancialDecimal(currentTargets.expectedFunding).eq(group.expectedFundingAmount)
            || !new FinancialDecimal(currentTargets.expectedBorrowerPayout).eq(group.expectedBorrowerPayoutAmount)
            || !new FinancialDecimal(currentTargets.expectedAdvanceInterestReturn).eq(group.expectedAdvanceInterestReturnAmount)) {
            throw new DomainError(
                "STALE_INTERMEDIATED_DISBURSEMENT_PROPOSAL",
                "The loan activation no longer matches this intermediated disbursement proposal",
                409,
            );
        }
        const postedForLoan = await tx.select({
            id: intermediatedDisbursementGroups.id,
            publicId: intermediatedDisbursementGroups.publicId,
        }).from(intermediatedDisbursementGroups).where(and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.loanId, group.loanId),
            eq(intermediatedDisbursementGroups.status, "posted"),
        ));
        if (postedForLoan.length) {
            const compensations = await tx.select({
                reversedGroupId: intermediatedDisbursementGroups.reversedGroupId,
            }).from(intermediatedDisbursementGroups).where(and(
                eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
                eq(intermediatedDisbursementGroups.status, "reversed"),
                inArray(intermediatedDisbursementGroups.reversedGroupId, postedForLoan.map((candidate) => candidate.id)),
            ));
            const compensatedIds = new Set(compensations.map((candidate) => candidate.reversedGroupId));
            const uncompensated = postedForLoan.find((candidate) => !compensatedIds.has(candidate.id));
            if (uncompensated) {
                throw new DomainError(
                    "INTERMEDIATED_DISBURSEMENT_ALREADY_POSTED_FOR_LOAN",
                    "This loan already has an uncompensated posted intermediary disbursement",
                    409,
                    { postedGroupPublicId: uncompensated.publicId },
                );
            }
        }
        await tx.execute(sql`SELECT id FROM intermediated_transfer_events WHERE tenant_id = ${ctx.tenantId} AND group_id = ${group.id} ORDER BY id FOR UPDATE`);
        const events = await tx.select().from(intermediatedTransferEvents).where(and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.groupId, group.id),
        )).orderBy(asc(intermediatedTransferEvents.id));
        const proposal = await tx.query.intermediatedDisbursementGroupPreviews.findFirst({ where: and(
            eq(intermediatedDisbursementGroupPreviews.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroupPreviews.groupId, group.id),
            eq(intermediatedDisbursementGroupPreviews.publicId, proposalPublicId),
        ) });
        const latestProposal = await tx.query.intermediatedDisbursementGroupPreviews.findFirst({
            where: and(
                eq(intermediatedDisbursementGroupPreviews.tenantId, ctx.tenantId),
                eq(intermediatedDisbursementGroupPreviews.groupId, group.id),
            ),
            orderBy: desc(intermediatedDisbursementGroupPreviews.version),
        });
        if (!proposal
            || !latestProposal
            || proposal.id !== latestProposal.id
            || proposal.status === "stale"
            || proposal.status === "expired"
            || proposal.expiresAt.getTime() <= Date.now()) {
            throw new DomainError(
                "STALE_INTERMEDIATED_DISBURSEMENT_PROPOSAL",
                "The intermediated disbursement proposal is stale or expired",
                409,
            );
        }
        const evidenceReady = await finalizedEvidenceReady(tx, ctx, events);
        const aggregates = transferAggregates(events, new FinancialDecimal(group.retainedBalanceAmount));
        const roleTotalsMatch = aggregates.actualFunding.eq(group.expectedFundingAmount)
            && aggregates.actualBorrowerPayout.eq(group.expectedBorrowerPayoutAmount)
            && aggregates.actualAdvanceInterestReturn.eq(group.expectedAdvanceInterestReturnAmount);
        const currentPreviewHash = previewStateHash(groupPublicId, group, events, evidenceReady);
        if (currentPreviewHash !== proposal.previewHash) {
            throw new DomainError(
                "STALE_INTERMEDIATED_DISBURSEMENT_PROPOSAL",
                "The intermediated disbursement proposal no longer matches current transfer state",
                409,
            );
        }
        if (proposal.status !== "ready"
            || group.status !== "ready"
            || !roleTotalsMatch
            || !aggregates.variance.isZero()
            || !evidenceReady
            || !events.length
            || events.some((event) => event.status !== "ready")) {
            throw new DomainError(
                "INTERMEDIATED_DISBURSEMENT_NOT_READY",
                "Only an exact zero-variance ready proposal can be posted",
                409,
            );
        }

        const advanceProjection = await tx.query.loanDisbursements.findFirst({ where: and(
            eq(loanDisbursements.tenantId, ctx.tenantId),
            eq(loanDisbursements.loanId, group.loanId),
        ) });
        if (!advanceProjection
            || !new FinancialDecimal(advanceProjection.grossPrincipal).eq(group.expectedFundingAmount)
            || !new FinancialDecimal(advanceProjection.firstDayInterestDeducted).eq(group.expectedAdvanceInterestReturnAmount)
            || !new FinancialDecimal(advanceProjection.netDisbursement).eq(
                new FinancialDecimal(group.expectedFundingAmount).minus(group.expectedAdvanceInterestReturnAmount),
            )) {
            throw new DomainError(
                "INTERMEDIATED_ADVANCE_INTEREST_PROJECTION_MISMATCH",
                "The loan activation disbursement projection no longer matches this intermediary group",
                409,
            );
        }
        const borrowerEvents = events.filter((event) => event.role === "borrower_net_payout");
        const borrowerChannels = new Set(borrowerEvents.map((event) => event.channel));
        const payout = await recordIntermediatedLoanPayout(tx, ctx, {
            loanId: group.loanId,
            groupPublicId,
            amount: serializeMoney(aggregates.actualBorrowerPayout),
            channel: borrowerChannels.size === 1
                ? borrowerEvents[0]!.channel as TransferChannel
                : "adjustment",
            payeeHint: borrowerEvents.map((event) => event.payeeHint).find(Boolean) ?? null,
            disbursedAt: latestTransferTime(borrowerEvents.length ? borrowerEvents : events),
        });
        const postedAt = new Date();
        const postedEvents = await tx.update(intermediatedTransferEvents).set({
            status: "posted",
            postedAt,
            updatedByUserId: ctx.actorUserId,
            updatedAt: postedAt,
        }).where(and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.groupId, group.id),
            eq(intermediatedTransferEvents.status, "ready"),
        )).returning();
        if (postedEvents.length !== events.length) {
            throw new DomainError("INTERMEDIATED_DISBURSEMENT_LOCKED", "Transfer events changed before posting", 409);
        }
        const postedGroup = await tx.update(intermediatedDisbursementGroups).set({
            status: "posted",
            postIdempotencyKey,
            postedByUserId: ctx.actorUserId,
            postedAt,
            updatedByUserId: ctx.actorUserId,
            updatedAt: postedAt,
        }).where(and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.id, group.id),
            eq(intermediatedDisbursementGroups.status, "ready"),
        )).returning().then((rows) => rows[0]);
        if (!postedGroup) {
            throw new DomainError("INTERMEDIATED_DISBURSEMENT_LOCKED", "Group changed before posting", 409);
        }
        await tx.update(intermediatedDisbursementGroupPreviews).set({ status: "executed" }).where(and(
            eq(intermediatedDisbursementGroupPreviews.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroupPreviews.id, proposal.id),
            eq(intermediatedDisbursementGroupPreviews.status, "ready"),
        ));
        const held = await intermediaryHeldBalanceProjection(tx, ctx.tenantId, group.intermediaryId);
        const after: PostedGroupResult = {
            ...presentGroup(postedGroup, {
                loanPublicId: accessible.loan.publicId,
                intermediaryPublicId: accessible.intermediary.publicId,
            }),
            proposalPublicId: proposal.publicId,
            loanDisbursementPublicId: payout.publicId,
            advanceInterestProjectionPublicId: advanceProjection.publicId,
            fundingAmount: serializeMoney(aggregates.actualFunding),
            borrowerPayoutAmount: serializeMoney(aggregates.actualBorrowerPayout),
            advanceInterestAmount: serializeMoney(aggregates.actualAdvanceInterestReturn),
            intermediaryHeldBalance: serializeMoney(held.disbursementHeldBalance),
            transferEventPublicIds: postedEvents.map((event) => event.publicId),
        };
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "intermediated_disbursement_group",
            entityId: group.publicId,
            action: "posted",
            payload: {
                proposalPublicId: proposal.publicId,
                loanDisbursementPublicId: payout.publicId,
                advanceInterestProjectionPublicId: advanceProjection.publicId,
                transferEventPublicIds: after.transferEventPublicIds,
                postIdempotencyKey,
                after,
            },
        });
        return {
            ...after,
            duplicate: false,
            auditPublicId: audit.publicId,
            correlationId: ctx.correlationId,
        };
    });
}

export async function reverseIntermediatedDisbursement(
    ctx: CommandContext,
    groupPublicId: string,
    reasonInput: string,
) {
    requirePublicId(groupPublicId, "groupPublicId");
    const reversalIdempotencyKey = commandKey(ctx);
    const reason = normalizedText(reasonInput);
    if (!reason) throw new DomainError("REVERSAL_REASON_REQUIRED", "A reversal reason is required", 400);
    const accessible = await accessibleGroup(ctx, groupPublicId);
    const requestHash = reversalRequestHash(groupPublicId, reason);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intermediated-group-reverse:${ctx.tenantId}:${reversalIdempotencyKey}`}, 0))`);
        const reusedKey = await tx.query.intermediatedDisbursementGroups.findFirst({ where: and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.reversalIdempotencyKey, reversalIdempotencyKey),
        ) });
        if (reusedKey && (reusedKey.reversedGroupId !== accessible.group.id || reusedKey.reversalRequestHash !== requestHash)) {
            throw new DomainError(
                "INTERMEDIATED_DISBURSEMENT_REVERSAL_CONFLICT",
                "The reversal idempotency key was already used for another group or reason",
                409,
            );
        }
        await tx.execute(sql`SELECT id FROM intermediated_disbursement_groups WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.group.id} FOR UPDATE`);
        const original = await tx.query.intermediatedDisbursementGroups.findFirst({ where: and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.id, accessible.group.id),
        ) });
        if (!original || original.status !== "posted") {
            throw new DomainError(
                "INTERMEDIATED_DISBURSEMENT_NOT_POSTED",
                "Only a posted intermediated disbursement can be reversed",
                409,
            );
        }
        const existing = await tx.query.intermediatedDisbursementGroups.findFirst({ where: and(
            eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
            eq(intermediatedDisbursementGroups.reversedGroupId, original.id),
        ) });
        if (existing) {
            if (existing.reversalIdempotencyKey !== reversalIdempotencyKey
                || existing.reversalRequestHash !== requestHash) {
                throw new DomainError(
                    "INTERMEDIATED_DISBURSEMENT_REVERSAL_CONFLICT",
                    "This group was already reversed with another idempotency key or reason",
                    409,
                );
            }
            const storedAudit = await priorAudit(tx, ctx, existing.publicId, "reversed");
            const prior = storedAudit && auditedResult<Record<string, unknown>>(storedAudit);
            if (!storedAudit || !prior) {
                throw new DomainError("IDEMPOTENT_RESULT_NOT_FOUND", "Stored reversal result is unavailable", 409);
            }
            return {
                ...prior,
                duplicate: true,
                auditPublicId: storedAudit.publicId,
                correlationId: storedAudit.correlationId ?? ctx.correlationId,
            };
        }
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${original.loanId} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM intermediated_transfer_events WHERE tenant_id = ${ctx.tenantId} AND group_id = ${original.id} ORDER BY id FOR UPDATE`);
        const events = await tx.select().from(intermediatedTransferEvents).where(and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.groupId, original.id),
        )).orderBy(asc(intermediatedTransferEvents.id));
        if (!events.length || events.some((event) => event.status !== "posted")) {
            throw new DomainError(
                "INTERMEDIATED_DISBURSEMENT_REVERSAL_BLOCKED",
                "Every source transfer must remain posted before reversing the group",
                409,
            );
        }
        const postAudit = await priorAudit(tx, ctx, original.publicId, "posted");
        const posted = storedPostedResult(postAudit);
        if (!posted) {
            throw new DomainError("FINANCIAL_AUDIT_NOT_FOUND", "Posted intermediated disbursement audit record is missing", 409);
        }
        const payoutReversal = await reverseIntermediatedLoanPayout(tx, ctx, {
            groupPublicId,
            disbursementPublicId: posted.loanDisbursementPublicId,
            reason,
        });
        const reversedAt = new Date();
        const reversalGroup = await tx.insert(intermediatedDisbursementGroups).values({
            tenantId: ctx.tenantId,
            loanId: original.loanId,
            intermediaryId: original.intermediaryId,
            expectedFundingAmount: original.expectedFundingAmount,
            expectedBorrowerPayoutAmount: original.expectedBorrowerPayoutAmount,
            expectedAdvanceInterestReturnAmount: original.expectedAdvanceInterestReturnAmount,
            retainedBalanceAmount: original.retainedBalanceAmount,
            status: "reversed",
            idempotencyKey: `internal:intermediated-group-reversal:${original.publicId}`,
            postIdempotencyKey: null,
            reversedGroupId: original.id,
            reversalIdempotencyKey,
            reversalRequestHash: requestHash,
            reversalReason: reason,
            note: reason,
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
            postedByUserId: original.postedByUserId,
            reversedByUserId: ctx.actorUserId,
            postedAt: original.postedAt,
            reversedAt,
            createdAt: reversedAt,
            updatedAt: reversedAt,
        }).returning().then((rows) => rows[0]!);
        const reversalEvents = await tx.insert(intermediatedTransferEvents).values(events.map((event) => ({
            tenantId: ctx.tenantId,
            groupId: reversalGroup.id,
            intermediaryBankAccountId: event.intermediaryBankAccountId,
            role: event.role,
            channel: event.channel,
            amount: event.amount,
            senderHint: event.senderHint,
            payeeHint: event.payeeHint,
            bankReference: null,
            bankReferenceHash: null,
            transferredAt: event.transferredAt,
            status: "reversed",
            idempotencyKey: `internal:intermediated-event-reversal:${event.publicId}`,
            reversedEventId: event.id,
            reversalReason: reason,
            note: reason,
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
            postedAt: event.postedAt,
            reversedAt,
            createdAt: reversedAt,
            updatedAt: reversedAt,
        }))).returning();
        const sourceEventPublicIds = new Map(events.map((event) => [event.id, event.publicId]));
        const transferEvents = reversalEvents.map((event) => ({
            publicId: event.publicId,
            reversedEventPublicId: sourceEventPublicIds.get(event.reversedEventId!)!,
        }));
        const held = await intermediaryHeldBalanceProjection(tx, ctx.tenantId, original.intermediaryId);
        const after = {
            ...presentGroup(reversalGroup, {
                loanPublicId: accessible.loan.publicId,
                intermediaryPublicId: accessible.intermediary.publicId,
            }),
            reversedGroupPublicId: original.publicId,
            reversedLoanDisbursementPublicId: posted.loanDisbursementPublicId,
            loanDisbursementPublicId: payoutReversal.publicId,
            advanceInterestProjectionPublicId: posted.advanceInterestProjectionPublicId,
            fundingAmount: posted.fundingAmount,
            borrowerPayoutAmount: posted.borrowerPayoutAmount,
            advanceInterestAmount: posted.advanceInterestAmount,
            intermediaryHeldBalance: serializeMoney(held.disbursementHeldBalance),
            transferEventPublicIds: reversalEvents.map((event) => event.publicId),
            transferEvents,
            reversalReason: reason,
        };
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "intermediated_disbursement_group",
            entityId: reversalGroup.publicId,
            action: "reversed",
            payload: {
                reversedGroupPublicId: original.publicId,
                reversedLoanDisbursementPublicId: posted.loanDisbursementPublicId,
                loanDisbursementPublicId: payoutReversal.publicId,
                advanceInterestProjectionPublicId: posted.advanceInterestProjectionPublicId,
                reversalIdempotencyKey,
                reason,
                after,
            },
        });
        return {
            ...after,
            duplicate: false,
            auditPublicId: audit.publicId,
            correlationId: ctx.correlationId,
        };
    });
}

export async function getIntermediatedDisbursementGroup(ctx: CommandContext, groupPublicId: string) {
    const { group, loan, intermediary } = await accessibleGroup(ctx, groupPublicId);
    const [events, latestPreview] = await Promise.all([
        db.select().from(intermediatedTransferEvents).where(and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.groupId, group.id),
        )).orderBy(asc(intermediatedTransferEvents.id)),
        db.query.intermediatedDisbursementGroupPreviews.findFirst({
            where: and(
                eq(intermediatedDisbursementGroupPreviews.tenantId, ctx.tenantId),
                eq(intermediatedDisbursementGroupPreviews.groupId, group.id),
            ),
            orderBy: desc(intermediatedDisbursementGroupPreviews.version),
        }),
    ]);
    const presentedEvents = await Promise.all(events.map(async (event) => presentEvent(event, {
        groupPublicId,
        intermediaryBankAccountPublicId: await accountPublicId(ctx, event.intermediaryBankAccountId),
        reversedEventPublicId: event.reversedEventId === null
            ? null
            : await db.query.intermediatedTransferEvents.findFirst({ where: and(
                eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
                eq(intermediatedTransferEvents.id, event.reversedEventId),
            ) }).then((source) => source?.publicId ?? null),
    })));
    return {
        ...presentGroup(group, { loanPublicId: loan.publicId, intermediaryPublicId: intermediary.publicId }),
        events: presentedEvents,
        latestPreview: latestPreview ? { ...presentPreview(latestPreview), groupPublicId } : null,
    };
}

export async function listIntermediatedDisbursementGroups(
    ctx: CommandContext,
    input: ListIntermediatedDisbursementGroupsInput = {},
) {
    if (input.loanPublicId) requirePublicId(input.loanPublicId, "loanPublicId");
    if (input.intermediaryPublicId) requirePublicId(input.intermediaryPublicId, "intermediaryPublicId");
    if (input.status && !["draft", "needs_review", "ready", "posted", "reversed"].includes(input.status)) {
        throw new DomainError("INVALID_INTERMEDIATED_DISBURSEMENT_STATUS", "Unsupported group status", 400);
    }
    const actor = await actorFor(ctx);
    const conditions = [eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId)];
    if (input.loanPublicId) conditions.push(eq(loans.publicId, input.loanPublicId));
    if (input.intermediaryPublicId) conditions.push(eq(intermediaries.publicId, input.intermediaryPublicId));
    if (input.status) conditions.push(eq(intermediatedDisbursementGroups.status, input.status));
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        conditions.push(eq(loans.ownerUserId, actor.id));
        conditions.push(eq(intermediaries.ownerUserId, actor.id));
    }
    const rows = await db.select({
        group: intermediatedDisbursementGroups,
        loanPublicId: loans.publicId,
        intermediaryPublicId: intermediaries.publicId,
    }).from(intermediatedDisbursementGroups)
        .innerJoin(loans, and(
            eq(loans.tenantId, intermediatedDisbursementGroups.tenantId),
            eq(loans.id, intermediatedDisbursementGroups.loanId),
        ))
        .innerJoin(intermediaries, and(
            eq(intermediaries.tenantId, intermediatedDisbursementGroups.tenantId),
            eq(intermediaries.id, intermediatedDisbursementGroups.intermediaryId),
        ))
        .where(and(...conditions))
        .orderBy(desc(intermediatedDisbursementGroups.createdAt), desc(intermediatedDisbursementGroups.id));
    return rows.map((row) => presentGroup(row.group, {
        loanPublicId: row.loanPublicId,
        intermediaryPublicId: row.intermediaryPublicId,
    }));
}
