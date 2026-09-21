import { MCP_TOOL_NAMES, type McpToolName, type ToolProfile } from "./catalog-types";
import { TOOL_PROFILES } from "./tool-profiles";
import { WORKFLOW_POLICY_REVISION, WORKFLOW_VERSION } from "./workflow-version";

export { WORKFLOW_POLICY_REVISION, WORKFLOW_VERSION } from "./workflow-version";

export type WorkflowIntent = "inspect" | "receive_payment" | "close_loan" | "originate_loan" | "disburse_loan" | "attach_evidence" | "renew_loan" | "intermediary_collection" | "cancel_payment_restore" | "tool_help";

export const WORKFLOW_INTENTS = [
    "inspect", "receive_payment", "close_loan", "originate_loan", "disburse_loan", "attach_evidence", "renew_loan", "intermediary_collection", "cancel_payment_restore", "tool_help",
] as const satisfies readonly WorkflowIntent[];

export type WorkflowRule = Readonly<{
    intent: WorkflowIntent;
    description: string;
    profiles: readonly ToolProfile[];
    tools: readonly string[];
    attachmentTransport: "payment" | "payout" | "supplement" | "none" | "human_review";
}>;

const workflowRules: readonly WorkflowRule[] = [
    { intent: "inspect", description: "Inspect authoritative borrower, loan, payment, or payout state.", profiles: ["full", "core-read", "payments", "loans", "disbursements", "admin"], tools: ["borrower.resolve-and-portfolio", "loan.inspect-context", "payment.match-context", "intake.get", "loan.disbursement.list"], attachmentTransport: "none" },
    { intent: "cancel_payment_restore", description: "Inspect an exact restore draft, require explicit confirmation, and cancel only that unposted child.", profiles: ["full", "payments"], tools: ["intake.get", "payment.restore.cancel"], attachmentTransport: "human_review" },
    { intent: "receive_payment", description: "Create and reconcile a payment intake through the existing payment workflow.", profiles: ["full", "payments"], tools: ["intake.create", "evidence.prepare", "evidence.finalize", "evidence.import-chatgpt-file", "payment.preview", "payment.post"], attachmentTransport: "payment" },
    { intent: "close_loan", description: "Preview and execute the applicable scheduled or floating close-out.", profiles: ["full", "loans"], tools: ["loan.inspect-context", "loan.settlement.preview", "loan.settlement.execute", "payment.preview", "payment.post"], attachmentTransport: "human_review" },
    { intent: "originate_loan", description: "Preview, create, and activate a new loan with immutable terms.", profiles: ["full", "loans"], tools: ["loan.preview", "loan.draft", "loan.activate"], attachmentTransport: "none" },
    { intent: "disburse_loan", description: "Create, evidence, inspect, confirm, and post an actual payout.", profiles: ["full", "loans", "disbursements"], tools: ["loan.disbursement.draft", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.evidence.import-chatgpt-file", "loan.disbursement.post"], attachmentTransport: "payout" },
    { intent: "attach_evidence", description: "Prepare or record evidence for an exact mutable target, or a supported posted supplement.", profiles: ["full", "payments", "loans", "disbursements"], tools: ["evidence.prepare", "evidence.finalize", "evidence.import-chatgpt-file", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.evidence.import-chatgpt-file", "payment.evidence-supplement.import-chatgpt-file", "payment.evidence-supplement.record"], attachmentTransport: "supplement" },
    { intent: "renew_loan", description: "Preview, confirm, and execute a renewal with explicit cash direction.", profiles: ["full", "loans"], tools: ["renewal.preview", "renewal.execute"], attachmentTransport: "human_review" },
    { intent: "intermediary_collection", description: "Review, cancel an eligible unposted collection, or reconcile intermediary remittances.", profiles: ["full", "disbursements", "admin"], tools: ["intermediary.collection.list", "intermediary.collection.cancel", "intermediary.collection.create", "intermediary.remittance.preview", "intermediary.remittance.post"], attachmentTransport: "human_review" },
    { intent: "tool_help", description: "Explain a named tool visible on the selected connection.", profiles: ["full", "core-read", "payments", "loans", "disbursements", "admin"], tools: [], attachmentTransport: "none" },
];

function freezeWorkflowRule(rule: WorkflowRule): WorkflowRule {
    return Object.freeze({
        ...rule,
        profiles: Object.freeze([...rule.profiles]),
        tools: Object.freeze([...rule.tools]),
    });
}

export const WORKFLOW_REGISTRY: readonly WorkflowRule[] = Object.freeze(workflowRules.map(freezeWorkflowRule));

const allProfiles = Object.keys(TOOL_PROFILES) as ToolProfile[];
const humanReviewOnly = new Set<McpToolName>([
    "intermediary.disbursement.evidence.prepare", "intermediary.disbursement.evidence.finalize", "intermediary.disbursement.post",
    "intermediary.remittance.evidence.prepare", "intermediary.remittance.evidence.finalize", "intermediary.remittance.post",
    "renewal.execute", "loan.settlement.execute", "loan.restructure.execute",
]);

/** Every catalog tool is classified, including tools not suggested by the resolver. */
export const WORKFLOW_TOOL_INVENTORY: Readonly<Record<McpToolName, Readonly<{ workflow: WorkflowIntent | "human_review"; humanReviewOnly: boolean }>>> = Object.freeze(
    Object.fromEntries(MCP_TOOL_NAMES.map((name) => {
        const rule = WORKFLOW_REGISTRY.find((candidate) => candidate.tools.includes(name));
        return [name, Object.freeze({ workflow: rule?.intent ?? "human_review", humanReviewOnly: humanReviewOnly.has(name) || !rule })];
    })) as Record<McpToolName, Readonly<{ workflow: WorkflowIntent | "human_review"; humanReviewOnly: boolean }>>,
);

export function workflowRule(intent: WorkflowIntent) {
    return WORKFLOW_REGISTRY.find((rule) => rule.intent === intent)!;
}

export function toolIsVisibleInProfile(toolName: string, profile: ToolProfile) {
    return profile === "full" || (TOOL_PROFILES[profile] as readonly string[]).includes(toolName);
}

export function workflowToolsForProfile(intent: WorkflowIntent, profile: ToolProfile) {
    return workflowRule(intent).tools.filter((toolName) => toolIsVisibleInProfile(toolName, profile));
}

export function supportedWorkflowProfiles(intent: WorkflowIntent) {
    return workflowRule(intent).profiles.filter((profile) => allProfiles.includes(profile));
}
