export const MCP_TOOL_NAMES = [
    "borrower.search", "borrower.portfolio", "borrower.resolve-and-portfolio", "borrower.create", "borrower.update", "borrower.alias",
    "intake.get", "intake.list", "payment.batch.get", "payment.batch.stage", "payment.batch.staging.evidence.prepare",
    "payment.batch.staging.evidence.finalize", "payment.batch.staging.extract", "payment.batch.workspace", "payment.batch.candidates",
    "payment.batch.staging.review", "payment.batch.staging.edit", "payment.batch.split", "payment.batch.decision", "payment.batch.cancel",
    "intake.create", "evidence.prepare", "evidence.finalize", "evidence.import-chatgpt-file", "loan.disbursement.evidence.import-chatgpt-file",
    "payment.evidence-supplement.import-chatgpt-file", "payment.evidence-supplement.record", "payment.preview", "payment.cancel", "payment.replacement.inspect", "payment.replacement.create", "payment.replacement.duplicate-review.preview", "payment.replacement.duplicate-review.execute", "payment.post",
    "payment.reverse", "payment.reverse-with-accrual.preview", "payment.reverse-with-accrual.execute", "payment.batch.create", "payment.batch.capture",
    "payment.batch.evidence.prepare-many", "payment.batch.evidence.finalize-many", "payment.batch.item.add", "payment.batch.evidence.prepare",
    "payment.batch.evidence.finalize", "payment.batch.preview", "payment.batch.execute", "payment.reconcile.preview", "payment.reconcile.reflow.preview",
    "payment.reconcile.reflow.execute", "payment.allocation-correction.preview", "payment.reconcile.preflight", "payment.reconcile.mark-review",
    "payment.reconcile.execute", "payment.allocation-correction.execute", "payment.restore.create", "payment.restore.evidence.prepare",
    "payment.restore.evidence.finalize", "payment.restore.preview", "payment.restore.execute", "payment.restore.cancel", "payment.restore.schedule-backfill", "loan.preview",
    "loan.cancel.preview", "loan.draft", "loan.draft.delete", "loan.activate", "loan.interest-rate.list", "loan.interest-rate.preview",
    "loan.interest-rate.execute", "loan.settlement.preview", "loan.settlement.execute", "loan.settlement.reverse", "loan.cancel.execute",
    "loan.replacement.preview", "loan.replacement.execute", "loan.replacement.reverse", "loan.disbursement.list", "loan.contract.get", "loan.inspect-context",
    "loan.payment-start-date.update", "loan.payment-history.list", "payment.match-context", "loan.disbursement.draft", "loan.disbursement.update",
    "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.post", "loan.disbursement.reverse",
    "loan.commission-participant.list", "loan.commission-participant.add", "loan.commission-participant.update", "loan.commission-participant.end",
    "loan.commission.preview", "loan.commission.list", "loan.commission.calculate", "loan.commission.reverse",
    "payment.intermediary-attribution.create", "payment.intermediary-attribution.list", "payment.intermediary-attribution.reverse",
    "intermediary.search", "intermediary.create", "intermediary.profile.get", "intermediary.bank-account.save", "intermediary.managed-loan.list",
    "intermediary.assignment.create", "intermediary.assignment.end", "intermediary.disbursement.list", "intermediary.disbursement.get",
    "intermediary.disbursement.create", "intermediary.disbursement.event.create", "intermediary.disbursement.evidence.prepare",
    "intermediary.disbursement.evidence.finalize", "intermediary.disbursement.preview", "intermediary.disbursement.post", "intermediary.disbursement.reverse",
    "intermediary.collection.list", "intermediary.collection.create", "intermediary.collection.cancel", "intermediary.remittance.get", "intermediary.remittance.create",
    "intermediary.remittance.allocations.save", "intermediary.remittance.preview", "intermediary.remittance.evidence.prepare",
    "intermediary.remittance.evidence.finalize", "intermediary.remittance.post", "renewal.preview", "renewal.execute", "renewal.reverse",
    "loan.restructure.preview", "loan.restructure.execute", "loan.restructure.reverse", "loan.waiver.preview", "loan.waiver.execute",
    "loan.waiver.reverse", "funding-source.list", "funding-allocation.preview", "funding-allocation.create", "funding-allocation.list",
    "system.error-diagnostic.get", "system.error-diagnostic.list", "workflow.resolve",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export type ToolProfile = "full" | "core-read" | "payments" | "loans" | "disbursements" | "admin";

export type McpToolDefinition<Name extends string = McpToolName> = Readonly<{
    name: Name;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    annotations: Readonly<{
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    }>;
    policy: Readonly<{ kind: "read_only" | "mutating" | "financial"; requiresAudit: boolean }>;
    _meta?: Readonly<Record<string, unknown>>;
}>;
