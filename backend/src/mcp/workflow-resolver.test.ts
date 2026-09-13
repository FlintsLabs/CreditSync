import { describe, expect, test } from "bun:test";
import { resolveWorkflowPolicy, type ResolverInput, type ResolverObservation, type ResolverProfile } from "./workflow-resolver";
import { MCP_TOOL_NAMES } from "./catalog-types";
import { toolIsVisibleInProfile, WORKFLOW_REGISTRY, WORKFLOW_TOOL_INVENTORY, WORKFLOW_VERSION } from "./workflow-registry";
import { advertisedMcpToolMetadata } from "./server";

const catalogVersion = "mcp-catalog-test";
const target = { kind: "payment_intake" as const, publicId: "0198c481-3e2b-7000-8000-000000000001" };
const base = { profile: "payments" as const, catalogVersion, workflowVersion: WORKFLOW_VERSION };

describe("workflow resolver policy", () => {
    test("does not route scheduled close-out to floating settlement", () => {
        const resolved = resolveWorkflowPolicy({ intent: "close_loan", profile: "loans", target: { kind: "loan", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", loanType: "scheduled", evidenceReady: true }, { ...base, profile: "loans" });
        expect(resolved.nextSteps.some((step) => step.toolName === "loan.settlement.preview")).toBe(false);
        expect(resolved.nextSteps).toMatchObject([{ toolName: "loan.inspect-context", arguments: { loanPublicId: target.publicId } }]);
        expect(resolved.prohibitedTools).toContain("loan.settlement.execute");
        expect(resolved.blockers).toContain("SCHEDULED_CLOSEOUT_REQUIRES_SUPPORTED_PAYMENT_PATH");
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

    test("requires positive authoritative target identity and mutable state", () => {
        const cases = [
            {},
            { targetAvailable: undefined, identityResolved: true, state: "mutable" as const },
            { targetAvailable: true, identityResolved: undefined, state: "mutable" as const },
            { targetAvailable: true, identityResolved: true, state: "unresolved" as const },
        ];
        for (const observation of cases) {
            const resolved = resolveWorkflowPolicy({ intent: "receive_payment", ...base, target, attachments: "none" }, observation, base);
            expect(resolved.status).toBe("needs_input");
            expect(resolved.nextSteps).toHaveLength(0);
            expect(resolved.prohibitedTools).not.toContain("payment.post");
        }
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

    test("routes a borrower-originated loan to the real draft fields", () => {
        const borrowerTarget = { kind: "borrower" as const, publicId: target.publicId };
        const resolved = resolveWorkflowPolicy({ intent: "originate_loan", profile: "loans", target: borrowerTarget, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "loans" });
        expect(resolved).toMatchObject({
            status: "next_step",
            nextSteps: [
                { toolName: "loan.preview", arguments: {}, requiredInputs: expect.arrayContaining(["principal", "interestRate", "termMonths", "repaymentType", "startDate"]) },
                { toolName: "loan.draft", arguments: { borrowerPublicId: borrowerTarget.publicId } },
            ],
        });
        expect(resolved.nextSteps[1]!.arguments).not.toHaveProperty("loanPublicId");
    });

    test("routes a loan target to an actual payout draft", () => {
        const loanTarget = { kind: "loan" as const, publicId: target.publicId };
        const resolved = resolveWorkflowPolicy({ intent: "disburse_loan", profile: "disbursements", target: loanTarget, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "disbursements" });
        expect(resolved).toMatchObject({ status: "next_step", nextSteps: [{ toolName: "loan.disbursement.draft", arguments: { loanPublicId: loanTarget.publicId } }] });
        expect(resolved.nextSteps[0]!.requiredInputs).toEqual(expect.arrayContaining(["grossAmount", "loanAttributedAmount", "channel", "disbursedAt"]));
    });

    test("does not ask an existing payout without declared evidence for a prepare step", () => {
        const payoutTarget = { kind: "loan_disbursement" as const, publicId: target.publicId };
        const resolved = resolveWorkflowPolicy({ intent: "disburse_loan", profile: "disbursements", target: payoutTarget, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceRequired: false, evidenceReady: true }, { ...base, profile: "disbursements" });
        expect(resolved.nextSteps.some((step) => step.toolName === "loan.disbursement.evidence.prepare")).toBe(false);
        expect(resolved).toMatchObject({ status: "confirmation_required", nextSteps: [{ toolName: "loan.disbursement.post", arguments: { disbursementPublicId: payoutTarget.publicId }, requiresConfirmation: true }] });
    });

    test("confirms an existing payout with all evidence ready instead of re-importing", () => {
        const payoutTarget = { kind: "loan_disbursement" as const, publicId: target.publicId };
        const resolved = resolveWorkflowPolicy({ intent: "disburse_loan", profile: "disbursements", target: payoutTarget, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceRequired: true, evidenceReady: true }, { ...base, profile: "disbursements" });
        expect(resolved.status).toBe("confirmation_required");
        expect(resolved.nextSteps.map((step) => step.toolName)).toEqual(["loan.disbursement.post"]);
    });

    test("uses the renewal preview's oldLoanPublicId field", () => {
        const resolved = resolveWorkflowPolicy({ intent: "renew_loan", profile: "loans", target: { kind: "loan", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", loanType: "scheduled" }, { ...base, profile: "loans" });
        expect(resolved).toMatchObject({ nextSteps: [{ toolName: "renewal.preview", arguments: { oldLoanPublicId: target.publicId } }] });
        expect(resolved.nextSteps[0]!.arguments).not.toHaveProperty("loanPublicId");
    });

    test("routes an existing loan origin target to inspection and activation prerequisites", () => {
        const resolved = resolveWorkflowPolicy({ intent: "originate_loan", profile: "loans", target: { kind: "loan", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "loans" });
        expect(resolved).toMatchObject({ status: "confirmation_required", nextSteps: [{ toolName: "loan.inspect-context" }, { toolName: "loan.activate", arguments: { loanPublicId: target.publicId }, requiredInputs: ["idempotencyKey"], requiresConfirmation: true }] });
        expect(resolved.nextSteps.some((step) => step.toolName === "loan.draft")).toBe(false);
    });

    test("requires confirmation before posting an existing payout without evidence", () => {
        const resolved = resolveWorkflowPolicy({ intent: "disburse_loan", ...base, profile: "disbursements", target: { kind: "loan_disbursement", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceReady: true }, { ...base, profile: "disbursements" });
        expect(resolved.status).toBe("confirmation_required");
        expect(resolved.nextSteps.map((step) => step.toolName)).toEqual(["loan.disbursement.post"]);
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

    test.each(["close_loan", "renew_loan", "intermediary_collection"] as const)("human-review attachment transport blocks %s even without an observation flag", (intent) => {
        const resolved = resolveWorkflowPolicy({ intent, profile: intent === "intermediary_collection" ? "disbursements" : "loans", target: { kind: intent === "intermediary_collection" ? "loan" : "loan", publicId: target.publicId }, attachments: "present", expectedAttachmentCount: 1 }, { targetAvailable: true, identityResolved: true, state: "mutable", loanType: "scheduled", evidenceReady: true }, { ...base, profile: intent === "intermediary_collection" ? "disbursements" : "loans" });
        expect(resolved.status).toBe("blocked");
        expect(resolved.blockers).toContain("HUMAN_REVIEW_REQUIRED_UNSUPPORTED_ATTACHMENT_TRANSPORT");
        expect(resolved.nextSteps).toHaveLength(0);
    });

    test("does not use a fake toolArguments required input", () => {
        const help = resolveWorkflowPolicy({ intent: "tool_help", profile: "full", target, toolName: "intake.get" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "full" });
        expect(help.nextSteps).toMatchObject([{ toolName: "intake.get", requiredInputs: ["paymentIntakePublicId"] }]);
        expect(help.nextSteps.flatMap((step) => step.requiredInputs)).not.toContain("toolArguments");
        const unverified = resolveWorkflowPolicy({ intent: "tool_help", profile: "full", target, toolName: "intake.get" }, {}, { ...base, profile: "full" });
        expect(unverified.nextSteps).toHaveLength(0);
        expect(unverified.blockers).toContain("TARGET_REQUIRES_AUTHORITATIVE_READ");
    });

    test("classifies every catalog tool and never treats an unclassified financial tool as inspect", () => {
        expect(Object.keys(WORKFLOW_TOOL_INVENTORY).sort()).toEqual([...MCP_TOOL_NAMES].sort());
        const financialNames = ["payment.post", "loan.activate", "loan.disbursement.post", "renewal.execute", "loan.settlement.execute"];
        for (const name of financialNames) expect(WORKFLOW_TOOL_INVENTORY[name as keyof typeof WORKFLOW_TOOL_INVENTORY].workflow).not.toBe("inspect");
        expect(Object.isFrozen(WORKFLOW_REGISTRY)).toBe(true);
        expect(Object.isFrozen(WORKFLOW_REGISTRY[0])).toBe(true);
        expect(Object.isFrozen(WORKFLOW_REGISTRY[0]!.tools)).toBe(true);
    });

    test("keeps every resolver partial argument and required input inside the real closed catalog schema", () => {
        const metadata = new Map<string, ReturnType<typeof advertisedMcpToolMetadata>[number]>(advertisedMcpToolMetadata().map((tool) => [tool.name, tool]));
        const cases: Array<[ResolverInput, ResolverObservation, ResolverProfile]> = [
            [{ intent: "inspect", profile: "full", target: { kind: "borrower", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "full" }],
            [{ intent: "inspect", profile: "loans", target: { kind: "loan", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "loans" }],
            [{ intent: "inspect", profile: "payments", target, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, base],
            [{ intent: "inspect", profile: "disbursements", target: { kind: "loan_disbursement", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "disbursements" }],
            [{ intent: "receive_payment", profile: "payments", target, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, base],
            [{ intent: "receive_payment", profile: "payments", target, attachments: "present", expectedAttachmentCount: 1 }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceRequired: true }, base],
            [{ intent: "close_loan", profile: "loans", target: { kind: "loan", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", loanType: "floating" }, { ...base, profile: "loans" }],
            [{ intent: "originate_loan", profile: "loans", target: { kind: "borrower", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "loans" }],
            [{ intent: "disburse_loan", profile: "disbursements", target: { kind: "loan", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "disbursements" }],
            [{ intent: "disburse_loan", profile: "disbursements", target: { kind: "loan_disbursement", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable", evidenceReady: true }, { ...base, profile: "disbursements" }],
            [{ intent: "attach_evidence", profile: "payments", target, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, base],
            [{ intent: "attach_evidence", profile: "disbursements", target: { kind: "loan_disbursement", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "disbursements" }],
            [{ intent: "renew_loan", profile: "loans", target: { kind: "loan", publicId: target.publicId }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "loans" }],
        ];
        for (const [input, observation, resolverProfile] of cases) {
            const resolved = resolveWorkflowPolicy(input, observation, resolverProfile);
            for (const next of resolved.nextSteps) {
                const schema = metadata.get(next.toolName)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
                expect(schema?.properties, next.toolName).toBeDefined();
                for (const key of Object.keys(next.arguments)) expect(schema?.properties, `${next.toolName}.${key}`).toHaveProperty(key);
                for (const key of next.requiredInputs) expect(schema?.properties, `${next.toolName}.${key}`).toHaveProperty(key);
                const required = (metadata.get(next.toolName)?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
                expect(required.filter((key) => !(key in next.arguments) && !next.requiredInputs.includes(key)), next.toolName).toEqual([]);
                expect(toolIsVisibleInProfile(next.toolName, resolverProfile.profile), next.toolName).toBe(true);
            }
        }
    });

    test("refuses tool help for every catalog mutating or financial tool", () => {
        const metadata = advertisedMcpToolMetadata();
        for (const tool of metadata.filter((candidate) => candidate.policy.kind !== "read_only")) {
            const resolved = resolveWorkflowPolicy({ intent: "tool_help", profile: "full", target, toolName: tool.name }, { targetAvailable: true, identityResolved: true, state: "mutable" }, { ...base, profile: "full" });
            expect(resolved.status, tool.name).toBe("needs_input");
            expect(resolved.nextSteps, tool.name).toHaveLength(0);
            expect(resolved.blockers, tool.name).toContain("TOOL_HELP_REQUIRES_WORKFLOW_RESOLUTION");
            expect(resolved.prohibitedTools, tool.name).toContain(tool.name);
        }
    });
});
