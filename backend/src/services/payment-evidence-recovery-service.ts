import { and, eq } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { financialEvidenceRequirements, paymentIntakes, paymentReplacementLineages, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { registerFinancialEvidenceRequirement } from "./financial-evidence-requirement-service";
import { lockPaymentWorkflowIdentity } from "./payment-workflow-locks";

const operators = new Set(["owner", "manager", "collector"]);

export async function createPaymentEvidenceRecoveryDraft(ctx: CommandContext, input: { sourcePaymentIntakePublicId: string; reason: string; expectedCount: number; idempotencyKey: string }, executor?: DbExecutor) {
    const run = async (tx: DbExecutor) => {
        const actor = ctx.actorUserId === null ? null : await tx.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
        if (!actor || !operators.has(actor.role ?? "viewer")) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_FORBIDDEN", "Only a financial operator may recover payment evidence", 403);
        if (!input.reason?.trim() || !Number.isInteger(input.expectedCount) || input.expectedCount < 1 || input.expectedCount > 20 || !input.idempotencyKey?.trim()) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_INVALID", "A reason, expected slot count, and idempotency key are required", 400);
        const source = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, input.sourcePaymentIntakePublicId)) });
        if (!source) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
        if (source.status !== "cancelled" || source.postedAt !== null) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_SOURCE_INVALID", "Only a cancelled, never-posted intake can start evidence recovery", 409);
        await lockPaymentWorkflowIdentity(ctx, tx, [source.publicId]);
        const existing = await tx.query.paymentReplacementLineages.findFirst({ where: and(eq(paymentReplacementLineages.tenantId, ctx.tenantId), eq(paymentReplacementLineages.sourcePaymentIntakeId, source.id)) });
        if (existing) {
            const child = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, existing.replacementPaymentIntakeId)) });
            if (!child) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_RECEIPT_INVALID", "Recovery successor is incomplete", 500);
            return { sourcePaymentIntakePublicId: source.publicId, recoveryIntakePublicId: child.publicId, status: child.status, resumed: true, auditPublicId: existing.auditPublicId, correlationId: existing.correlationId };
        }
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: actor.id, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_intake", entityId: source.publicId, action: "evidence_recovery_draft_created", payload: { sourcePaymentIntakePublicId: source.publicId, expectedCount: input.expectedCount, reason: input.reason.trim() } });
        const child = await tx.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: source.ownerUserId, source: source.source, status: "draft", amount: source.amount, receivedAt: source.receivedAt, payerName: source.payerName, warnings: source.warnings, originLoanId: source.originLoanId, replacementOfIntakeId: source.id, evidenceRequired: true, createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const lineage = await tx.insert(paymentReplacementLineages).values({ tenantId: ctx.tenantId, sourcePaymentIntakeId: source.id, replacementPaymentIntakeId: child.id, reason: input.reason.trim(), requestHash: input.idempotencyKey.trim(), idempotencyKey: input.idempotencyKey.trim(), requestId: ctx.requestId, correlationId: ctx.correlationId, auditPublicId: audit.publicId, bankReferenceHash: source.bankReferenceHash, qrPayloadHash: source.qrPayloadHash, createdByUserId: actor.id }).returning().then((rows) => rows[0]!);
        await registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: child.publicId }, input.expectedCount);
        return { sourcePaymentIntakePublicId: source.publicId, recoveryIntakePublicId: child.publicId, status: child.status, resumed: false, auditPublicId: audit.publicId, correlationId: ctx.correlationId, lineagePublicId: lineage.publicId };
    };
    return executor ? run(executor) : db.transaction(run);
}
