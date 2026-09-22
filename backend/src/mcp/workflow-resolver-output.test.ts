import { expect, test } from "bun:test";
import { toolDataSchemas } from "./server";
import { resolveWorkflowPolicy } from "./workflow-resolver";

for (const state of ["cancelled", "duplicate", "reversed"] as const) {
    test(`workflow.resolve accepts the public ${state} observation at its MCP boundary`, () => {
        const result = resolveWorkflowPolicy({ intent: "receive_payment", profile: "full", target: { kind: "payment_intake", publicId: "00000000-0000-4000-8000-000000000001" }, attachments: "none" }, { targetAvailable: true, identityResolved: true, state, evidenceReady: true }, { profile: "full", catalogVersion: "test-catalog" });
        expect(toolDataSchemas["workflow.resolve"].safeParse(result).success).toBe(true);
        expect(result.observed.state).toBe(state);
    });
}
