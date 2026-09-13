import { describe, expect, test } from "bun:test";
import { resolveWorkflowPolicy } from "./workflow-resolver";
import { MCP_TOOL_NAMES } from "./catalog-types";
import { WORKFLOW_REGISTRY, WORKFLOW_TOOL_INVENTORY, WORKFLOW_VERSION } from "./workflow-registry";

const catalogVersion = "mcp-catalog-test";
const target = { kind: "payment_intake" as const, publicId: "0198c481-3e2b-7000-8000-000000000001" };
const base = { profile: "payments" as const, catalogVersion, workflowVersion: WORKFLOW_VERSION };

describe("workflow resolver policy", () => {
    test("routes scheduled close-out to authoritative settlement preview", () => {
        const resolved = resolveWorkflowPolicy({ intent: "close_loan", profile: "loans", target: { kind: "loan", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", loanType: "scheduled", evidenceReady: true }, { ...base, profile: "loans" });
        expect(resolved).toMatchObject({ status: "next_step", nextSteps: [{ toolName: "loan.settlement.preview" }] });
    });

    test("blocks floating close-out attachments without supported transport", () => {
        const resolved = resolveWorkflowPolicy({ intent: "close_loan", profile: "loans", target: { kind: "loan", publicId: target.publicId }, attachments: "present", expectedAttachmentCount: 1 }, { targetAvailable: true, identityResolved: true, state: "mutable", loanType: "floating", evidenceReady: true, supportedAttachmentTransport: false }, { ...base, profile: "loans" });
        expect(resolved.status).toBe("blocked");
        expect(resolved.blockers).toContain("HUMAN_REVIEW_REQUIRED_FLOATING_ATTACHMENT_TRANSPORT");
    });

    test("routes a posted intake to supplement instead of normal posting", () => {
        const resolved = resolveWorkflowPolicy({ intent: "receive_payment", ...base, target, attachments: "present", expectedAttachmentCount: 1 }, { targetAvailable: true, identityResolved: true, state: "posted", evidenceReady: true }, base);
        expect(resolved).toMatchObject({ status: "confirmation_required", nextSteps: [{ toolName: "payment.evidence-supplement.import-chatgpt-file" }] });
        expect(resolved.prohibitedTools).not.toContain("payment.post");
    });

    test("fails closed for unavailable attachment or missing identity", () => {
        const missingFile = resolveWorkflowPolicy({ intent: "receive_payment", ...base, target, attachments: "unknown" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, base);
        expect(missingFile.status).toBe("needs_input");
        const missingIdentity = resolveWorkflowPolicy({ intent: "receive_payment", ...base, target, attachments: "none" }, { targetAvailable: true, identityResolved: false, state: "mutable" }, base);
        expect(missingIdentity).toMatchObject({ status: "needs_input", blockers: ["IDENTITY_REQUIRES_REVIEW"] });
    });

    test("does not suggest tools outside the selected profile or bypass pending evidence", () => {
        const wrongProfile = resolveWorkflowPolicy({ intent: "disburse_loan", profile: "core-read", target: { kind: "loan_disbursement", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "core-read" });
        expect(wrongProfile.status).toBe("connection_required");
        const pending = resolveWorkflowPolicy({ intent: "receive_payment", ...base, target, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceRequired: true, evidenceReady: false, pendingEvidenceCount: 1 }, base);
        expect(pending).toMatchObject({ status: "blocked", blockers: ["EVIDENCE_REQUIRED_NOT_READY"] });
        expect(pending.prohibitedTools).toContain("payment.post");
    });

    test("refreshes stale versions before recommending financial tools", () => {
        const resolved = resolveWorkflowPolicy({ intent: "receive_payment", ...base, target, attachments: "none", knownWorkflowVersion: "old" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, base);
        expect(resolved).toMatchObject({ status: "refresh_required", nextSteps: [], blockers: ["WORKFLOW_VERSION_STALE"] });
    });

    test("uses the supported ChatGPT importer for a payment attachment without inventing arguments", () => {
        const resolved = resolveWorkflowPolicy({ intent: "receive_payment", ...base, target, attachments: "present", expectedAttachmentCount: 1 }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceRequired: true, evidenceReady: false }, base);
        expect(resolved).toMatchObject({
            status: "next_step",
            nextSteps: [{ toolName: "evidence.import-chatgpt-file", arguments: { paymentIntakePublicId: target.publicId }, requiredInputs: ["idempotencyKey", "chatgptFile"] }],
        });
        expect(resolved.nextSteps[0]!.arguments).not.toHaveProperty("loanPublicId");
    });

    test("does not emit a speculative payout post or future identifiers", () => {
        const resolved = resolveWorkflowPolicy({ intent: "disburse_loan", ...base, profile: "disbursements", target: { kind: "loan_disbursement", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceReady: true }, { ...base, profile: "disbursements" });
        expect(resolved.status).toBe("next_step");
        expect(resolved.nextSteps.map((step) => step.toolName)).toEqual(["loan.disbursement.evidence.prepare"]);
        expect(resolved.nextSteps.some((step) => step.toolName === "loan.disbursement.post")).toBe(false);
        expect(resolved.nextSteps.every((step) => Object.values(step.arguments).every((value) => value === target.publicId))).toBe(true);
    });

    test("provides bounded inspect guidance and refuses arbitrary financial tool help", () => {
        const inspect = resolveWorkflowPolicy({ intent: "inspect", ...base, target, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, base);
        expect(inspect).toMatchObject({ status: "next_step", nextSteps: [{ toolName: "intake.get", arguments: { paymentIntakePublicId: target.publicId } }] });
        const help = resolveWorkflowPolicy({ intent: "tool_help", ...base, target, toolName: "payment.post" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, base);
        expect(help.status).toBe("needs_input");
        expect(help.nextSteps).toHaveLength(0);
        expect(help.prohibitedTools).toContain("payment.post");
    });

    test("refuses help for every non-inspection catalog tool and accepts payout evidence attachment targets", () => {
        const mutatingHelp = resolveWorkflowPolicy({ intent: "tool_help", profile: "full", target, toolName: "borrower.create" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "full" });
        expect(mutatingHelp.status).toBe("needs_input");
        expect(mutatingHelp.blockers).toContain("TOOL_HELP_REQUIRES_WORKFLOW_RESOLUTION");
        const payout = resolveWorkflowPolicy({ intent: "attach_evidence", profile: "disbursements", target: { kind: "loan_disbursement", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceRequired: false, evidenceReady: true }, { ...base, profile: "disbursements" });
        expect(payout).toMatchObject({ status: "next_step", nextSteps: [{ toolName: "loan.disbursement.evidence.prepare" }] });
    });

    test("keeps unsupported or incomplete evidence states fail-closed", () => {
        const unsupported = resolveWorkflowPolicy({ intent: "receive_payment", ...base, target, attachments: "present", expectedAttachmentCount: 1 }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceRequired: true, evidenceReady: false, supportedAttachmentTransport: false }, base);
        expect(unsupported).toMatchObject({ status: "blocked", blockers: ["HUMAN_REVIEW_REQUIRED_UNSUPPORTED_ATTACHMENT_TRANSPORT"] });
        const unknownTarget = resolveWorkflowPolicy({ intent: "inspect", ...base, target: { kind: "future" as never, publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, base);
        expect(unknownTarget.status).toBe("needs_input");
        expect(unknownTarget.nextSteps).toHaveLength(0);
    });

    test("classifies every catalog tool and never treats an unclassified financial tool as inspect", () => {
        expect(Object.keys(WORKFLOW_TOOL_INVENTORY).sort()).toEqual([...MCP_TOOL_NAMES].sort());
        const financialNames = ["payment.post", "loan.activate", "loan.disbursement.post", "renewal.execute", "loan.settlement.execute"];
        for (const name of financialNames) expect(WORKFLOW_TOOL_INVENTORY[name as keyof typeof WORKFLOW_TOOL_INVENTORY].workflow).not.toBe("inspect");
        expect(Object.isFrozen(WORKFLOW_REGISTRY)).toBe(true);
        expect(Object.isFrozen(WORKFLOW_REGISTRY[0])).toBe(true);
        expect(Object.isFrozen(WORKFLOW_REGISTRY[0]!.tools)).toBe(true);
    });
});
