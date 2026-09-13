import { MCP_TOOL_NAMES, type McpToolDefinition, type McpToolName, type ToolProfile } from "./catalog-types";

const readOnly = [
    "system.error-diagnostic.get", "system.error-diagnostic.list", "borrower.search", "borrower.portfolio",
    "intake.get", "intake.list", "payment.batch.get", "payment.batch.workspace", "payment.batch.candidates",
    "loan.preview", "loan.cancel.preview", "loan.interest-rate.list",
    "loan.disbursement.list", "loan.contract.get", "loan.payment-history.list", "loan.commission-participant.list",
    "loan.commission.preview", "loan.commission.list", "loan.commission.calculate", "loan.commission.reverse",
    "payment.intermediary-attribution.list", "intermediary.search", "intermediary.profile.get", "intermediary.managed-loan.list",
    "intermediary.disbursement.list", "intermediary.disbursement.get", "intermediary.collection.list", "intermediary.remittance.get",
    "funding-source.list", "funding-allocation.preview", "funding-allocation.list", "payment.reverse-with-accrual.preview",
    "payment.reconcile.preflight",
] as const satisfies readonly McpToolName[];

const payments = [
    "borrower.search", "borrower.portfolio", "intake.get", "intake.list", "intake.create", "evidence.prepare", "evidence.finalize",
    "evidence.import-chatgpt-file", "payment.evidence-supplement.import-chatgpt-file", "payment.evidence-supplement.record",
    "payment.preview", "payment.post", "payment.cancel", "payment.reverse", "payment.reverse-with-accrual.preview", "payment.reverse-with-accrual.execute",
    "payment.batch.get", "payment.batch.create", "payment.batch.capture", "payment.batch.evidence.prepare-many", "payment.batch.evidence.finalize-many",
    "payment.batch.item.add", "payment.batch.evidence.prepare", "payment.batch.evidence.finalize", "payment.batch.preview", "payment.batch.execute",
    "payment.batch.stage", "payment.batch.staging.evidence.prepare", "payment.batch.staging.evidence.finalize", "payment.batch.staging.extract",
    "payment.batch.workspace", "payment.batch.candidates", "payment.batch.staging.review", "payment.batch.staging.edit", "payment.batch.split",
    "payment.batch.decision", "payment.batch.cancel", "payment.reconcile.preview", "payment.reconcile.preflight", "payment.reconcile.mark-review",
    "payment.reconcile.execute", "payment.reconcile.reflow.preview", "payment.reconcile.reflow.execute", "payment.allocation-correction.preview",
    "payment.allocation-correction.execute", "payment.restore.create", "payment.restore.evidence.prepare", "payment.restore.evidence.finalize",
    "payment.restore.preview", "payment.restore.execute", "payment.restore.schedule-backfill", "payment.intermediary-attribution.list",
    "payment.intermediary-attribution.create", "payment.intermediary-attribution.reverse",
] as const satisfies readonly McpToolName[];

const loans = [
    "borrower.search", "borrower.portfolio", "loan.preview", "loan.draft", "loan.draft.delete", "loan.activate", "loan.cancel.preview", "loan.cancel.execute",
    "loan.interest-rate.list", "loan.interest-rate.preview", "loan.interest-rate.execute", "loan.settlement.preview", "loan.settlement.execute", "loan.settlement.reverse",
    "loan.replacement.preview", "loan.replacement.execute", "loan.replacement.reverse", "loan.contract.get", "loan.payment-start-date.update", "loan.payment-history.list",
    "loan.disbursement.list", "loan.disbursement.draft", "loan.disbursement.update", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize",
    "loan.disbursement.evidence.import-chatgpt-file", "loan.disbursement.post", "loan.disbursement.reverse", "renewal.preview", "renewal.execute", "renewal.reverse",
    "loan.restructure.preview", "loan.restructure.execute", "loan.restructure.reverse", "loan.waiver.preview", "loan.waiver.execute", "loan.waiver.reverse",
    "funding-source.list", "funding-allocation.preview", "funding-allocation.create", "funding-allocation.list", "payment.evidence-supplement.import-chatgpt-file",
] as const satisfies readonly McpToolName[];

const disbursements = [
    "borrower.search", "borrower.portfolio", "loan.contract.get", "loan.disbursement.list", "loan.disbursement.draft", "loan.disbursement.update",
    "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.evidence.import-chatgpt-file", "loan.disbursement.post", "loan.disbursement.reverse",
    "intermediary.search", "intermediary.profile.get", "intermediary.managed-loan.list", "intermediary.assignment.create", "intermediary.assignment.end",
    "intermediary.disbursement.list", "intermediary.disbursement.get", "intermediary.disbursement.create", "intermediary.disbursement.event.create",
    "intermediary.disbursement.evidence.prepare", "intermediary.disbursement.evidence.finalize", "intermediary.disbursement.preview", "intermediary.disbursement.post", "intermediary.disbursement.reverse",
    "funding-source.list", "funding-allocation.preview", "funding-allocation.list",
] as const satisfies readonly McpToolName[];

const admin = [
    "system.error-diagnostic.get", "system.error-diagnostic.list", "borrower.search", "borrower.create", "borrower.update", "borrower.alias",
    "intermediary.search", "intermediary.create", "intermediary.profile.get", "intermediary.bank-account.save", "intermediary.managed-loan.list",
    "intermediary.assignment.create", "intermediary.assignment.end", "intermediary.collection.list", "intermediary.remittance.get", "intermediary.remittance.create",
    "intermediary.remittance.allocations.save", "intermediary.remittance.preview", "intermediary.remittance.evidence.prepare", "intermediary.remittance.evidence.finalize",
    "intermediary.remittance.post", "intermediary.collection.create", "funding-source.list", "funding-allocation.preview", "funding-allocation.create", "funding-allocation.list",
    "loan.commission-participant.list", "loan.commission-participant.add", "loan.commission-participant.update", "loan.commission-participant.end",
    "loan.commission.preview", "loan.commission.list", "loan.commission.calculate", "loan.commission.reverse",
] as const satisfies readonly McpToolName[];

export const TOOL_PROFILES: Readonly<Record<ToolProfile, readonly McpToolName[]>> = Object.freeze({
    full: Object.freeze([...MCP_TOOL_NAMES]),
    "core-read": Object.freeze([...readOnly]),
    payments: Object.freeze([...payments]),
    loans: Object.freeze([...loans]),
    disbursements: Object.freeze([...disbursements]),
    admin: Object.freeze([...admin]),
});

export function toolsForProfile(profile: ToolProfile, catalog: readonly McpToolDefinition[] = []): readonly McpToolDefinition[] {
    const byName = new Map(catalog.map((tool) => [tool.name, tool]));
    return TOOL_PROFILES[profile].flatMap((name) => {
        const tool = byName.get(name);
        return tool ? [tool] : [];
    });
}

export function toolNamesForProfile(profile: ToolProfile): readonly McpToolName[] {
    return TOOL_PROFILES[profile];
}
