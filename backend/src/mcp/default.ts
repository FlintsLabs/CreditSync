import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, users } from "../db/schema";
import {
    addBorrowerAlias,
    confirmBorrowerAlias,
    createBorrower,
    deactivateBorrowerAlias,
    getBorrowerPortfolio,
    searchBorrowers,
    updateBorrower,
    type BorrowerInput,
    type BorrowerUpdateInput,
} from "../services/borrower-service";
import { DomainError } from "../services/domain-error";
import type { CommandContext } from "../services/command-context";
import { listFundingSources } from "../services/funding-source-service";
import { createFundingAllocation, listLoanFundingAllocations, previewFundingAllocation, type FundingAllocationInput } from "../services/loan-funding-service";
import {
    activateLoan,
    createLoanDraft,
    deleteLoanDraft,
    getLoanContract,
    previewLoan,
    updateLoanPaymentStartDate,
    type LoanDraftInput,
} from "../services/loan-application-service";
import {
    executeLoanRenewal,
    previewLoanRenewal,
    reverseLoanRenewal,
} from "../services/loan-renewal-service";
import {
    executeLoanRestructure,
    previewLoanRestructure,
    reverseLoanRestructure,
    type PreviewLoanRestructureInput,
} from "../services/loan-restructure-service";
import {
    executeLoanReplacement,
    previewLoanReplacement,
    reverseLoanReplacement,
} from "../services/loan-replacement-service";
import {
    executeLoanWaiver,
    previewLoanWaiver,
    reverseLoanWaiver,
} from "../services/loan-waiver-service";
import {
    executeLoanInterestRateChange,
    listLoanInterestRates,
    previewLoanInterestRateChange,
} from "../services/loan-interest-rate-service";
import {
    executeLoanSettlement,
    previewLoanSettlement,
    reverseLoanSettlement,
} from "../services/loan-settlement-service";
import {
    createPaymentIntake,
    finalizePaymentEvidence,
    getPaymentIntake,
    listLoanPaymentIntakes,
    listPaymentIntakes,
    postPayment,
    preparePaymentEvidence,
    previewPaymentMatch,
    reversePayment,
    type CreatePaymentIntakeInput,
    type EvidenceStorageGateway,
    type ExplicitPaymentAllocation,
    type PrepareEvidenceInput,
} from "../services/payment-service";
import {
    executeReverseWithInterestAccrual,
    previewReverseWithInterestAccrual,
} from "../services/payment-reverse-with-accrual-service";
import { createMcpRateLimiter } from "./rate-limit";
import { createMcpHttpPlugin, type McpToolHandler, type McpToolName } from "./server";
import { parseMcpRuntimeConfig } from "./security";
import {
    createDisbursementDraft,
    finalizeDisbursementEvidence,
    listLoanDisbursements,
    postDisbursement,
    prepareDisbursementEvidence,
    rejectDisbursementDraftEvidenceIds,
    reverseDisbursement,
    updateDisbursementDraft,
    type DisbursementEvidenceStorageGateway,
    type CreateDisbursementDraftInput,
    type PrepareDisbursementEvidenceInput,
    type UpdateDisbursementDraftInput,
} from "../services/loan-disbursement-service";
import {
    createIntermediary, createIntermediaryCollection, createIntermediaryRemittance,
    finalizeIntermediaryRemittanceEvidence, getIntermediaryRemittance, listIntermediaryCollections,
    postIntermediaryRemittance, prepareIntermediaryRemittanceEvidence, previewIntermediaryRemittance,
    saveRemittanceAllocations, searchIntermediaries, type IntermediaryRemittanceEvidenceGateway,
} from "../services/intermediary-service";
import {
    assignIntermediaryToLoan,
    endIntermediaryAssignment,
    getIntermediaryProfile,
    listManagedLoans,
    saveIntermediaryBankAccount,
    type AssignIntermediaryInput,
    type EndIntermediaryAssignmentInput,
    type SaveIntermediaryBankAccountInput,
} from "../services/intermediary-profile-service";
import {
    createIntermediatedDisbursementGroup,
    createTransferEvent,
    getIntermediatedDisbursementGroup,
    listIntermediatedDisbursementGroups,
    postIntermediatedDisbursement,
    previewIntermediatedDisbursement,
    reverseIntermediatedDisbursement,
    type CreateIntermediatedDisbursementGroupInput,
    type CreateTransferEventInput,
    type ListIntermediatedDisbursementGroupsInput,
} from "../services/intermediated-disbursement-service";
import {
    finalizeTransferEvidence,
    prepareTransferEvidence,
    type PrepareTransferEvidenceInput,
    type TransferEvidenceStorageGateway,
} from "../services/transfer-evidence-service";
import {
    addLoanCommissionParticipant,
    endLoanCommissionParticipant,
    listLoanCommissionParticipants,
    previewLoanCommission,
    updateLoanCommissionParticipant,
    type AddLoanCommissionParticipantInput,
    type EndLoanCommissionParticipantInput,
    type UpdateLoanCommissionParticipantInput,
} from "../services/loan-commission-service";
import {
    createPaymentAttribution,
    listPaymentAttributions,
    reversePaymentAttribution,
    type CreatePaymentAttributionInput,
} from "../services/payment-attribution-service";
import { createPaymentRestoreDraft, executePaymentReconciliation, previewPaymentReconciliation, previewPaymentRestore, type ReconciliationAllocation } from "../services/payment-reconciliation-service";
import { addPaymentBatchItem, capturePaymentBatch, createPaymentBatch, executePaymentBatch, finalizePaymentBatchEvidenceMany, getPaymentBatch, preparePaymentBatchEvidenceMany, previewPaymentBatch } from "../services/payment-batch-service";
import { executeUnfundedLoanCancellation, previewUnfundedLoanCancellation } from "../services/loan-cancellation-service";

type ToolInput = Record<string, unknown>;

export interface DefaultMcpDependencies {
    evidenceGateway?: EvidenceStorageGateway;
    disbursementEvidenceGateway?: DisbursementEvidenceStorageGateway;
    intermediaryRemittanceEvidenceGateway?: IntermediaryRemittanceEvidenceGateway;
    transferEvidenceGateway?: TransferEvidenceStorageGateway;
}

function asString(input: ToolInput, field: string) {
    return input[field] as string;
}

function paymentReversalReason(input: ToolInput) {
    return typeof input.reason === "string" && input.reason.trim()
        ? input.reason.trim()
        : "MCP 1.0 compatibility reversal";
}

export function paymentPostCommandContext(ctx: CommandContext, input: ToolInput): CommandContext {
    const paymentIntakePublicId = asString(input, "paymentIntakePublicId");
    const proposalPublicId = asString(input, "proposalPublicId");
    return {
        ...ctx,
        idempotencyKey: ctx.idempotencyKey ?? `mcp:payment-post:${paymentIntakePublicId}:${proposalPublicId}`,
    };
}

export function paymentReverseCommandContext(ctx: CommandContext, input: ToolInput): CommandContext {
    const paymentIntakePublicId = asString(input, "paymentIntakePublicId");
    return {
        ...ctx,
        idempotencyKey: ctx.idempotencyKey ?? `mcp:payment-reverse:${paymentIntakePublicId}`,
    };
}

export function createDefaultMcpToolHandlers(
    dependencies: DefaultMcpDependencies = {},
): Record<McpToolName, McpToolHandler> {
    return {
    "borrower.search": (ctx, input) => searchBorrowers(ctx, { query: asString(input, "query") }),
    "borrower.portfolio": (ctx, input) => getBorrowerPortfolio(ctx, asString(input, "borrowerPublicId")),
    "borrower.create": (ctx, input) => createBorrower(ctx, input as unknown as BorrowerInput),
    "borrower.update": (ctx, input) => updateBorrower(
        ctx,
        asString(input, "borrowerPublicId"),
        input.changes as BorrowerUpdateInput,
    ),
    "borrower.alias": async (ctx, input) => {
        if (input.action === "add") {
            return addBorrowerAlias(ctx, asString(input, "borrowerPublicId"), {
                alias: asString(input, "alias"),
                source: input.source as "manual" | "payment" | "import" | undefined,
            });
        }
        if (input.action === "confirm") return confirmBorrowerAlias(ctx, asString(input, "aliasPublicId"));
        return deactivateBorrowerAlias(ctx, asString(input, "aliasPublicId"));
    },
    "intake.get": (ctx, input) => getPaymentIntake(ctx, asString(input, "paymentIntakePublicId")),
    "intake.list": (ctx, input) => listPaymentIntakes(ctx, { status: input.status as string | undefined }),
    "intake.create": async (ctx, input) => {
        const result = await createPaymentIntake(ctx, input as unknown as CreatePaymentIntakeInput);
        if (!("originLoanPublicId" in result)) return result;
        const { originLoanPublicId: _originLoanPublicId, ...frozenResult } = result;
        return frozenResult;
    },
    "evidence.prepare": (ctx, input) => {
        const { paymentIntakePublicId, ...evidence } = input;
        return preparePaymentEvidence(
            ctx,
            String(paymentIntakePublicId),
            evidence as unknown as PrepareEvidenceInput,
            dependencies.evidenceGateway,
        );
    },
    "evidence.finalize": (ctx, input) => finalizePaymentEvidence(
        ctx,
        asString(input, "paymentIntakePublicId"),
        asString(input, "evidencePublicId"),
        dependencies.evidenceGateway,
    ),
    "payment.preview": (ctx, input) => previewPaymentMatch(
        ctx,
        asString(input, "paymentIntakePublicId"),
        { allocations: input.allocations as ExplicitPaymentAllocation[] | undefined },
    ),
    "payment.post": (ctx, input) => postPayment(
        paymentPostCommandContext(ctx, input),
        asString(input, "paymentIntakePublicId"),
        { proposalPublicId: asString(input, "proposalPublicId") },
    ),
    "payment.reverse": (ctx, input) => reversePayment(paymentReverseCommandContext(ctx, input), asString(input, "paymentIntakePublicId"), {
        reason: paymentReversalReason(input),
    }),
    "payment.reverse-with-accrual.preview": (ctx, input) => previewReverseWithInterestAccrual(
        ctx,
        asString(input, "paymentIntakePublicId"),
    ),
    "payment.reverse-with-accrual.execute": (ctx, input) => executeReverseWithInterestAccrual(
        { ...ctx, idempotencyKey: asString(input, "idempotencyKey") },
        asString(input, "paymentIntakePublicId"),
        {
            reason: asString(input, "reason"),
            previewHash: asString(input, "previewHash"),
            confirmed: true,
            interestAccrualMode: "ensure_due_through_payment_date",
            idempotencyKey: asString(input, "idempotencyKey"),
        },
    ),
    "payment.batch.create": (ctx, input) => createPaymentBatch(ctx, { idempotencyKey: ctx.idempotencyKey ?? asString(input, "idempotencyKey"), borrowerPublicId: input.borrowerPublicId as string | null | undefined, notes: input.notes as string | null | undefined }),
    "payment.batch.capture": (ctx, input) => capturePaymentBatch(ctx, { idempotencyKey: ctx.idempotencyKey ?? asString(input, "idempotencyKey"), borrowerPublicId: input.borrowerPublicId as string | null | undefined, notes: input.notes as string | null | undefined, items: input.items as any[] }),
    "payment.batch.evidence.prepare-many": (ctx, input) => preparePaymentBatchEvidenceMany(ctx, asString(input, "batchPublicId"), input.items as any[], dependencies.evidenceGateway),
    "payment.batch.evidence.finalize-many": (ctx, input) => finalizePaymentBatchEvidenceMany(ctx, asString(input, "batchPublicId"), input.items as any[], dependencies.evidenceGateway),
    "payment.batch.item.add": (ctx, input) => addPaymentBatchItem(ctx, asString(input, "batchPublicId"), { paymentIntakePublicId: asString(input, "paymentIntakePublicId"), itemOrder: input.itemOrder as number }),
    "payment.batch.evidence.prepare": (ctx, input) => preparePaymentEvidence(ctx, asString(input, "paymentIntakePublicId"), { mimeType: input.mimeType as string, size: input.size as number, sha256: asString(input, "sha256"), evidenceType: input.evidenceType as "slip" | "qr" | undefined }, dependencies.evidenceGateway),
    "payment.batch.evidence.finalize": (ctx, input) => finalizePaymentEvidence(ctx, asString(input, "paymentIntakePublicId"), asString(input, "evidencePublicId"), dependencies.evidenceGateway),
    "payment.batch.get": (ctx, input) => getPaymentBatch(ctx, asString(input, "batchPublicId")),
    "payment.batch.preview": (ctx, input) => previewPaymentBatch(ctx, asString(input, "batchPublicId"), { borrowerPublicId: asString(input, "borrowerPublicId"), allocations: input.allocations as any[] | undefined }),
    "payment.batch.execute": (ctx, input) => executePaymentBatch(ctx, asString(input, "batchPublicId"), { previewPublicId: asString(input, "previewPublicId"), previewHash: asString(input, "previewHash"), confirmationHash: asString(input, "confirmationHash"), confirmed: true, idempotencyKey: ctx.idempotencyKey ?? asString(input, "idempotencyKey") }),
    "payment.reconcile.preview": (ctx, input) => previewPaymentReconciliation(ctx, {
        paymentIntakePublicId: asString(input, "paymentIntakePublicId"),
        allocations: input.allocations as ReconciliationAllocation[],
        reason: asString(input, "reason"),
    }),
    "payment.reconcile.execute": (ctx, input) => {
        const idempotencyKey = ctx.idempotencyKey;
        if (!idempotencyKey) {
            throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Payment reconciliation requires an idempotency key", 400);
        }
        return executePaymentReconciliation(ctx, asString(input, "reconciliationPreviewPublicId"), {
            previewHash: asString(input, "previewHash"),
            expectedBalanceVersion: asString(input, "expectedBalanceVersion"),
            confirmed: true,
            reason: asString(input, "reason"),
            idempotencyKey,
        });
    },
    "payment.restore.preview": (ctx, input) => previewPaymentRestore(ctx, {
        paymentIntakePublicId: asString(input, "paymentIntakePublicId"),
        reason: asString(input, "reason"),
    }),
    "payment.restore.create": (ctx, input) => {
        const idempotencyKey = ctx.idempotencyKey;
        if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Payment restore draft requires an idempotency key", 400);
        return createPaymentRestoreDraft(ctx, {
            paymentIntakePublicId: asString(input, "paymentIntakePublicId"),
            reason: asString(input, "reason"),
            idempotencyKey,
        });
    },
    "payment.restore.execute": (ctx, input) => {
        const idempotencyKey = ctx.idempotencyKey;
        if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Payment restore requires an idempotency key", 400);
        return executePaymentReconciliation(ctx, asString(input, "restorePreviewPublicId"), {
            previewHash: asString(input, "previewHash"),
            expectedBalanceVersion: asString(input, "expectedBalanceVersion"),
            confirmed: true,
            reason: asString(input, "reason"),
            idempotencyKey,
        });
    },
    "loan.preview": async (_ctx, input) => {
        try {
            return previewLoan(input as unknown as Parameters<typeof previewLoan>[0]);
        } catch {
            throw new DomainError("INVALID_LOAN_TERMS", "Loan terms are invalid", 400);
        }
    },
    "loan.draft": (ctx, input) => createLoanDraft(ctx, input as unknown as LoanDraftInput),
    "loan.draft.delete": (ctx, input) => deleteLoanDraft(ctx, asString(input, "loanPublicId"), { reason: asString(input, "reason") }),
    "loan.activate": (ctx, input) => activateLoan(ctx, asString(input, "loanPublicId")),
    "loan.payment-start-date.update": (ctx, input) => updateLoanPaymentStartDate(ctx, asString(input, "loanPublicId"), {
        paymentStartDate: asString(input, "paymentStartDate"),
        reason: asString(input, "reason"),
    }),
    "loan.interest-rate.list": (ctx, input) => listLoanInterestRates(ctx, asString(input, "loanPublicId")),
    "loan.interest-rate.preview": (ctx, input) => previewLoanInterestRateChange(ctx, asString(input, "loanPublicId"), {
        effectiveDate: asString(input, "effectiveDate"),
        expiryDate: input.expiryDate as string | null,
        rateType: input.rateType as "percent" | "per_thousand",
        rate: asString(input, "rate"),
    }),
    "loan.interest-rate.execute": (ctx, input) => executeLoanInterestRateChange(ctx, asString(input, "loanPublicId"), {
        previewPublicId: asString(input, "previewPublicId"),
        previewHash: asString(input, "previewHash"),
        reason: asString(input, "reason"),
    }),
    "loan.settlement.preview": (ctx, input) => previewLoanSettlement(
        ctx,
        asString(input, "loanPublicId"),
        asString(input, "asOfDate"),
    ),
    "loan.settlement.execute": (ctx, input) => executeLoanSettlement(ctx, {
        settlementPublicId: asString(input, "settlementPublicId"),
        previewHash: asString(input, "previewHash"),
        confirmed: input.confirmed as boolean,
        reason: asString(input, "reason"),
    }),
    "loan.settlement.reverse": (ctx, input) => reverseLoanSettlement(ctx, {
        settlementPublicId: asString(input, "settlementPublicId"),
        reason: asString(input, "reason"),
    }),
    "loan.cancel.preview": (ctx, input) => previewUnfundedLoanCancellation(ctx, asString(input, "loanPublicId"), asString(input, "reason")),
    "loan.cancel.execute": (ctx, input) => executeUnfundedLoanCancellation(ctx, {
        previewPublicId: asString(input, "previewPublicId"),
        previewHash: asString(input, "previewHash"),
        expectedBalanceVersion: asString(input, "expectedBalanceVersion"),
        confirmed: input.confirmed as true,
        reason: asString(input, "reason"),
    }),
    "loan.replacement.preview": (ctx, input) => previewLoanReplacement(ctx, {
        oldLoanPublicId: asString(input, "oldLoanPublicId"),
        replacementDraftPublicId: asString(input, "replacementDraftPublicId"),
        reason: asString(input, "reason"),
    }),
    "loan.replacement.execute": (ctx, input) => executeLoanReplacement(ctx, {
        replacementPublicId: asString(input, "replacementPublicId"),
        previewHash: asString(input, "previewHash"),
        expectedOldBalanceVersion: asString(input, "expectedOldBalanceVersion"),
        expectedReplacementDraftVersion: asString(input, "expectedReplacementDraftVersion"),
        confirmed: input.confirmed as true,
        reason: asString(input, "reason"),
    }),
    "loan.replacement.reverse": (ctx, input) => reverseLoanReplacement(ctx, {
        replacementPublicId: asString(input, "replacementPublicId"),
        confirmed: input.confirmed as true,
        reason: asString(input, "reason"),
    }),
    "loan.disbursement.list": (ctx, input) => listLoanDisbursements(ctx, asString(input, "loanPublicId")),
    "loan.contract.get": (ctx, input) => getLoanContract(ctx, asString(input, "loanPublicId")),
    "loan.payment-history.list": async (ctx, input) => {
        const loanPublicId = asString(input, "loanPublicId");
        return {
            loanPublicId,
            items: await listLoanPaymentIntakes(ctx, loanPublicId),
        };
    },
    "loan.disbursement.draft": (ctx, input) => {
        const { loanPublicId, ...draft } = input;
        rejectDisbursementDraftEvidenceIds(draft);
        return createDisbursementDraft(ctx, String(loanPublicId), draft as unknown as CreateDisbursementDraftInput);
    },
    "loan.disbursement.update": (ctx, input) => updateDisbursementDraft(
        ctx,
        asString(input, "disbursementPublicId"),
        input.changes as UpdateDisbursementDraftInput,
    ),
    "loan.disbursement.evidence.prepare": (ctx, input) => {
        const { disbursementPublicId, ...evidence } = input;
        return prepareDisbursementEvidence(ctx, String(disbursementPublicId), evidence as unknown as PrepareDisbursementEvidenceInput, dependencies.disbursementEvidenceGateway);
    },
    "loan.disbursement.evidence.finalize": (ctx, input) => finalizeDisbursementEvidence(ctx, asString(input, "disbursementPublicId"), asString(input, "evidencePublicId"), dependencies.disbursementEvidenceGateway),
    "loan.disbursement.post": (ctx, input) => postDisbursement(ctx, asString(input, "disbursementPublicId")),
    "loan.disbursement.reverse": (ctx, input) => reverseDisbursement(ctx, asString(input, "disbursementPublicId"), asString(input, "reason")),
    "loan.commission-participant.list": async (ctx, input) => ({ items: await listLoanCommissionParticipants(ctx, asString(input, "loanPublicId")) }),
    "loan.commission-participant.add": (ctx, input) => {
        const { confirmed: _confirmed, ...participant } = input;
        return addLoanCommissionParticipant(ctx, participant as unknown as AddLoanCommissionParticipantInput);
    },
    "loan.commission-participant.update": (ctx, input) => {
        const { confirmed: _confirmed, ...participant } = input;
        return updateLoanCommissionParticipant(ctx, participant as unknown as UpdateLoanCommissionParticipantInput);
    },
    "loan.commission-participant.end": (ctx, input) => {
        const { confirmed: _confirmed, ...participant } = input;
        return endLoanCommissionParticipant(ctx, participant as unknown as EndLoanCommissionParticipantInput);
    },
    "loan.commission.preview": (ctx, input) => previewLoanCommission(ctx, {
        loanPublicId: asString(input, "loanPublicId"), paymentPublicIds: input.paymentPublicIds as string[],
    }),
    "loan.commission.list": (ctx, input) => previewLoanCommission(ctx, {
        loanPublicId: asString(input, "loanPublicId"), paymentPublicIds: input.paymentPublicIds as string[],
    }),
    "loan.commission.calculate": (ctx, input) => previewLoanCommission(ctx, {
        loanPublicId: asString(input, "loanPublicId"), paymentPublicIds: input.paymentPublicIds as string[],
    }),
    "loan.commission.reverse": (ctx, input) => previewLoanCommission(ctx, {
        loanPublicId: asString(input, "loanPublicId"), paymentPublicIds: input.paymentPublicIds as string[],
    }),
    "payment.intermediary-attribution.create": (ctx, input) => {
        const { confirmed: _confirmed, ...attribution } = input;
        return createPaymentAttribution(ctx, attribution as unknown as CreatePaymentAttributionInput);
    },
    "payment.intermediary-attribution.list": async (ctx, input) => ({ items: await listPaymentAttributions(ctx, asString(input, "paymentPublicId")) }),
    "payment.intermediary-attribution.reverse": (ctx, input) => reversePaymentAttribution(ctx, {
        attributionPublicId: asString(input, "attributionPublicId"), reason: asString(input, "reason"),
    }),
    "intermediary.search": async (ctx, input) => ({ items: await searchIntermediaries(ctx, asString(input, "query")) }),
    "intermediary.create": (ctx, input) => createIntermediary(ctx, input as { name: string; aliases?: string[]; notes?: string | null }),
    "intermediary.profile.get": (ctx, input) => getIntermediaryProfile(ctx, asString(input, "intermediaryPublicId")),
    "intermediary.bank-account.save": (ctx, input) => {
        const { intermediaryPublicId, ...account } = input;
        return saveIntermediaryBankAccount(ctx, String(intermediaryPublicId), account as unknown as SaveIntermediaryBankAccountInput);
    },
    "intermediary.managed-loan.list": async (ctx, input) => listManagedLoans(ctx, asString(input, "intermediaryPublicId"), {
        role: input.role as "disbursement" | "collection" | "all" | undefined,
    }),
    "intermediary.assignment.create": (ctx, input) => {
        const { loanPublicId, ...assignment } = input;
        return assignIntermediaryToLoan(ctx, String(loanPublicId), assignment as unknown as AssignIntermediaryInput);
    },
    "intermediary.assignment.end": (ctx, input) => {
        const { assignmentPublicId, ...assignmentEnd } = input;
        return endIntermediaryAssignment(ctx, String(assignmentPublicId), assignmentEnd as unknown as EndIntermediaryAssignmentInput);
    },
    "intermediary.disbursement.list": async (ctx, input) => listIntermediatedDisbursementGroups(ctx, input as ListIntermediatedDisbursementGroupsInput),
    "intermediary.disbursement.get": (ctx, input) => getIntermediatedDisbursementGroup(ctx, asString(input, "groupPublicId")),
    "intermediary.disbursement.create": (ctx, input) => createIntermediatedDisbursementGroup(ctx, input as unknown as CreateIntermediatedDisbursementGroupInput),
    "intermediary.disbursement.event.create": (ctx, input) => {
        const { groupPublicId, ...event } = input;
        return createTransferEvent(ctx, String(groupPublicId), event as unknown as CreateTransferEventInput);
    },
    "intermediary.disbursement.evidence.prepare": (ctx, input) => {
        const { groupPublicId, eventPublicId, ...evidence } = input;
        return prepareTransferEvidence(
            ctx,
            String(groupPublicId),
            String(eventPublicId),
            evidence as unknown as PrepareTransferEvidenceInput,
            dependencies.transferEvidenceGateway,
        );
    },
    "intermediary.disbursement.evidence.finalize": (ctx, input) => finalizeTransferEvidence(
        ctx,
        asString(input, "groupPublicId"),
        asString(input, "eventPublicId"),
        asString(input, "evidencePublicId"),
        dependencies.transferEvidenceGateway,
    ),
    "intermediary.disbursement.preview": (ctx, input) => previewIntermediatedDisbursement(ctx, asString(input, "groupPublicId")),
    "intermediary.disbursement.post": (ctx, input) => postIntermediatedDisbursement(
        ctx,
        asString(input, "groupPublicId"),
        asString(input, "proposalPublicId"),
        input.confirmed as boolean,
    ),
    "intermediary.disbursement.reverse": (ctx, input) => reverseIntermediatedDisbursement(
        ctx,
        asString(input, "groupPublicId"),
        asString(input, "reason"),
    ),
    "intermediary.collection.list": async (ctx, input) => ({ items: await listIntermediaryCollections(ctx, { intermediaryPublicId: input.intermediaryPublicId as string | undefined, status: input.status as string | undefined }) }),
    "intermediary.collection.create": (ctx, input) => createIntermediaryCollection(ctx, input as any),
    "intermediary.remittance.get": (ctx, input) => getIntermediaryRemittance(ctx, asString(input, "remittancePublicId")),
    "intermediary.remittance.create": (ctx, input) => createIntermediaryRemittance(ctx, input as any),
    "intermediary.remittance.allocations.save": (ctx, input) => saveRemittanceAllocations(ctx, asString(input, "remittancePublicId"), { collectionPublicIds: input.collectionPublicIds as string[] }),
    "intermediary.remittance.preview": (ctx, input) => previewIntermediaryRemittance(ctx, asString(input, "remittancePublicId")),
    "intermediary.remittance.evidence.prepare": (ctx, input) => { const { remittancePublicId, ...evidence } = input; return prepareIntermediaryRemittanceEvidence(ctx, String(remittancePublicId), evidence as any, dependencies.intermediaryRemittanceEvidenceGateway); },
    "intermediary.remittance.evidence.finalize": (ctx, input) => finalizeIntermediaryRemittanceEvidence(ctx, asString(input, "remittancePublicId"), asString(input, "evidencePublicId"), dependencies.intermediaryRemittanceEvidenceGateway),
    "intermediary.remittance.post": (ctx, input) => postIntermediaryRemittance(ctx, asString(input, "remittancePublicId"), { proposalPublicId: asString(input, "proposalPublicId"), confirmed: input.confirmed as boolean }),
    "renewal.preview": (ctx, input) => previewLoanRenewal(ctx, asString(input, "oldLoanPublicId"), {
        requestedPrincipal: asString(input, "requestedPrincipal"),
        renewalDate: input.renewalDate as string | undefined,
        paymentStartDate: input.paymentStartDate as string | undefined,
        settlementPolicy: input.settlementPolicy as "full_contract_interest" | "accrued_to_date" | undefined,
        adjustments: input.adjustments as Array<{ kind: "fee" | "penalty" | "other_charge" | "waiver"; amount: string; reason: string }> | undefined,
        waivedCharges: input.waivedCharges as string | undefined,
        waiverReason: (input.waiverReason as string | null | undefined) ?? undefined,
    }),
    "renewal.execute": (ctx, input) => executeLoanRenewal(ctx, asString(input, "renewalPublicId"), {
        previewHash: asString(input, "previewHash"),
        confirmed: input.confirmed as boolean,
        reason: asString(input, "reason"),
        confirmedCashDirection: input.confirmedCashDirection as "collection" | undefined,
    }),
    "renewal.reverse": (ctx, input) => reverseLoanRenewal(ctx, asString(input, "renewalPublicId"), {
        reason: asString(input, "reason"),
    }),
    "loan.restructure.preview": (ctx, input) => {
        const { oldLoanPublicId, ...request } = input;
        return previewLoanRestructure(ctx, String(oldLoanPublicId), request as unknown as PreviewLoanRestructureInput);
    },
    "loan.restructure.execute": (ctx, input) => executeLoanRestructure(ctx, asString(input, "restructurePublicId"), {
        previewHash: asString(input, "previewHash"),
        expectedBalanceVersion: asString(input, "expectedBalanceVersion"),
        confirmed: input.confirmed as boolean,
        reason: asString(input, "reason"),
    }),
    "loan.restructure.reverse": (ctx, input) => reverseLoanRestructure(ctx, asString(input, "restructurePublicId"), {
        reason: asString(input, "reason"),
    }),
    "loan.waiver.preview": (ctx, input) => previewLoanWaiver(ctx, asString(input, "loanPublicId"), {
        component: input.component as "interest" | "fee" | "penalty",
        amount: asString(input, "amount"),
        reason: asString(input, "reason"),
    }),
    "loan.waiver.execute": (ctx, input) => executeLoanWaiver(ctx, asString(input, "previewPublicId"), {
        previewHash: asString(input, "previewHash"),
        expectedBalanceVersion: asString(input, "expectedBalanceVersion"),
        confirmed: input.confirmed as boolean,
        reason: asString(input, "reason"),
    }),
    "loan.waiver.reverse": (ctx, input) => reverseLoanWaiver(ctx, asString(input, "waiverPublicId"), {
        reason: asString(input, "reason"),
    }),
    "funding-source.list": (ctx, input) => listFundingSources(ctx, {
        status: input.status as "active" | "closed" | "all" | undefined,
    }),
    "funding-allocation.preview": (ctx, input) => previewFundingAllocation(ctx, input as unknown as FundingAllocationInput),
    "funding-allocation.create": (ctx, input) => createFundingAllocation({
        ...ctx,
        idempotencyKey: ctx.idempotencyKey ?? `mcp:funding-allocation:${asString(input, "loanPublicId")}:${asString(input, "allocatedAmount")}:${asString(input, "allocationDate")}`,
    }, input as unknown as FundingAllocationInput),
    "funding-allocation.list": async (ctx, input) => ({ items: await listLoanFundingAllocations(ctx, asString(input, "loanPublicId")) }),
    };
}

const auditTarget: Partial<Record<McpToolName, { entityType: string; action: string }>> = {
    "payment.post": { entityType: "payment_intake", action: "posted" },
    "payment.reverse": { entityType: "payment_intake", action: "reversed" },
    "payment.reverse-with-accrual.execute": { entityType: "payment_intake", action: "reversed_with_interest_accruals_materialized" },
    "payment.batch.execute": { entityType: "payment_batch", action: "posted" },
    "payment.reconcile.execute": { entityType: "payment_reconciliation", action: "executed" },
    "payment.restore.execute": { entityType: "payment_reconciliation", action: "restored" },
    "payment.restore.create": { entityType: "payment_intake", action: "restore_draft_created" },
    "loan.activate": { entityType: "loan", action: "activated" },
    "loan.payment-start-date.update": { entityType: "loan", action: "payment_start_date_changed" },
    "loan.interest-rate.execute": { entityType: "loan_interest_rate_timeline", action: "interest_rate_timeline_changed" },
    "loan.settlement.execute": { entityType: "loan_settlement", action: "executed" },
    "loan.settlement.reverse": { entityType: "loan_settlement", action: "reversed" },
    "loan.cancel.execute": { entityType: "loan", action: "cancelled_unfunded" },
    "loan.replacement.execute": { entityType: "loan_replacement", action: "executed" },
    "loan.replacement.reverse": { entityType: "loan_replacement", action: "reversed" },
    "loan.disbursement.post": { entityType: "loan_disbursement", action: "posted" },
    "loan.disbursement.reverse": { entityType: "loan_disbursement", action: "reversed" },
    "loan.commission-participant.add": { entityType: "loan_commission_participant", action: "added" },
    "loan.commission-participant.update": { entityType: "loan_commission_participant", action: "updated" },
    "loan.commission-participant.end": { entityType: "loan_commission_participant", action: "ended" },
    "payment.intermediary-attribution.create": { entityType: "payment_intermediary_attribution", action: "created" },
    "payment.intermediary-attribution.reverse": { entityType: "payment_intermediary_attribution", action: "reversed" },
    "intermediary.disbursement.post": { entityType: "intermediated_disbursement_group", action: "posted" },
    "intermediary.disbursement.reverse": { entityType: "intermediated_disbursement_group", action: "reversed" },
    "intermediary.remittance.post": { entityType: "intermediary_remittance", action: "posted" },
    "renewal.execute": { entityType: "loan_renewal", action: "executed" },
    "renewal.reverse": { entityType: "loan_renewal", action: "reversed" },
    "loan.restructure.execute": { entityType: "loan_restructure", action: "executed" },
    "loan.restructure.reverse": { entityType: "loan_restructure", action: "reversed" },
    "loan.waiver.execute": { entityType: "loan_restructure_waiver", action: "executed" },
    "loan.waiver.reverse": { entityType: "loan_restructure_waiver", action: "reversed" },
    "funding-allocation.create": { entityType: "loan_funding_allocation", action: "created" },
};

function resultPublicId(result: unknown) {
    if (!result || typeof result !== "object") return null;
    const record = result as Record<string, unknown>;
    const value = record.publicId
        ?? record.id
        ?? record.loanPublicId
        ?? record.settlementPublicId
        ?? record.replacementPublicId
        ?? record.reconciliationPublicId
        ?? record.batchPublicId;
    return typeof value === "string" ? value : null;
}

function structuredLog(entry: Record<string, unknown>) {
    console.log(JSON.stringify(entry));
}

export function createDefaultMcpHttpPlugin(
    env: Record<string, string | undefined> = process.env,
    dependencies: DefaultMcpDependencies = {},
) {
    const config = parseMcpRuntimeConfig(env);
    const limiter = createMcpRateLimiter({
        cacheUrl: env.CACHE_URL,
        onWarning: (code) => structuredLog({ event: "mcp_warning", code }),
    });
    return createMcpHttpPlugin({
        config,
        handlers: createDefaultMcpToolHandlers(dependencies),
        consumeRateLimit: (input) => limiter.consume(input),
        logger: structuredLog,
        resolvePrincipal: async ({ tenantId, actorEmail }) => {
            const actor = await db.query.users.findFirst({ where: and(
                eq(users.tenantId, tenantId),
                sql`lower(${users.email}) = ${actorEmail}`,
            ) });
            if (!actor) throw new DomainError("MCP_ACTOR_NOT_FOUND", "Configured MCP actor is not available", 503);
            return { tenantId: actor.tenantId, actorUserId: actor.id };
        },
        findAuditPublicIds: async ({ ctx, toolName, result }) => {
            const target = auditTarget[toolName];
            const entityId = resultPublicId(result);
            if (!target || !entityId) return [];
            if (result && typeof result === "object") {
                const record = result as Record<string, unknown>;
                const advertised = [
                    ...(Array.isArray(record.auditPublicIds) ? record.auditPublicIds : []),
                    record.auditPublicId,
                ].filter((value): value is string => typeof value === "string");
                if (advertised.length) {
                    const rows = await db.select({ publicId: auditLogs.publicId }).from(auditLogs).where(and(
                        eq(auditLogs.tenantId, ctx.tenantId),
                        inArray(auditLogs.publicId, advertised),
                        eq(auditLogs.entityType, target.entityType),
                        eq(auditLogs.action, target.action),
                    ));
                    if (rows.length) return rows.map((row) => row.publicId);
                }
            }
            const rows = await db.select({ publicId: auditLogs.publicId }).from(auditLogs).where(and(
                eq(auditLogs.tenantId, ctx.tenantId),
                eq(auditLogs.entityType, target.entityType),
                eq(auditLogs.entityId, entityId),
                eq(auditLogs.action, target.action),
            )).orderBy(desc(auditLogs.id)).limit(1);
            return rows.map((row) => row.publicId);
        },
    });
}
