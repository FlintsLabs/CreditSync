import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EVAL_SCENARIO_IDS, runEvalScenario } from "../evals/harness";

const pluginRoot = resolve(import.meta.dir, "..");

type CatalogCase = {
    id: string;
    kind: "positive" | "negative";
    expectedCalls: string[];
    forbiddenCalls: string[];
    expectedEffects?: string[];
    forbiddenEffects?: string[];
};

async function fixtures() {
    const catalog = JSON.parse(await readFile(resolve(pluginRoot, "evals/evals.json"), "utf8")) as { cases: CatalogCase[] };
    const contract = JSON.parse(await readFile(resolve(pluginRoot, "references/mcp-tool-contract.json"), "utf8")) as {
        tools: Array<{ name: string; inputSchema: { required?: string[]; properties?: Record<string, unknown> } }>;
    };
    return { catalog, contract };
}

describe("CreditSync executable orchestration evals", () => {
    test("floating interest execution requires the exact preview and explicit confirmation", async () => {
        const confirmed = await runEvalScenario("floating-rate-scheduled-change");
        expect(confirmed.calls.map((call) => call.name)).toEqual([
            "loan.interest-rate.list", "loan.interest-rate.preview", "loan.interest-rate.execute",
        ]);
        const unconfirmed = await runEvalScenario("floating-rate-missing-confirmation");
        expect(unconfirmed.outcome).toBe("stopped");
        expect(unconfirmed.calls.some((call) => call.name === "loan.interest-rate.execute")).toBe(false);
    });

    test("floating settlement executes only the exact confirmed composition", async () => {
        const result = await runEvalScenario("floating-settlement-execute");
        expect(result).toMatchObject({ outcome: "completed" });
        expect(result.calls.map((call) => call.name)).toEqual([
            "borrower.portfolio",
            "loan.settlement.preview",
            "loan.settlement.execute",
        ]);
        expect(result.calls.at(-1)?.arguments).toEqual({
            settlementPublicId: "0198c481-3e2b-7000-8000-000000000071",
            previewHash: `v1:${"d".repeat(64)}`,
            confirmed: true,
            reason: "Borrower confirmed the exact displayed close-out",
            idempotencyKey: "floating-settlement-20260815-1",
        });
    });

    test("floating settlement stops for missing confirmation, stale state, and refund requests", async () => {
        const unconfirmed = await runEvalScenario("floating-settlement-missing-confirmation");
        expect(unconfirmed).toMatchObject({ outcome: "stopped", stopReason: "settlement-confirmation-required" });
        expect(unconfirmed.calls.some((call) => call.name === "loan.settlement.execute")).toBe(false);

        const stale = await runEvalScenario("floating-settlement-stale-preview");
        expect(stale).toMatchObject({ outcome: "stopped", stopReason: "fresh-settlement-confirmation-required" });
        expect(stale.calls.map((call) => call.name)).toEqual([
            "borrower.portfolio",
            "loan.settlement.preview",
            "loan.settlement.execute",
            "borrower.portfolio",
            "loan.settlement.preview",
        ]);
        expect(stale.calls.filter((call) => call.name === "loan.settlement.execute")).toHaveLength(1);

        const refund = await runEvalScenario("floating-settlement-non-refundable-refund");
        expect(refund).toMatchObject({ outcome: "stopped", stopReason: "advance-interest-non-refundable" });
        expect(refund.calls.map((call) => call.name)).toEqual(["borrower.portfolio", "loan.settlement.preview"]);
        expect(refund.calls.some((call) => call.name === "loan.settlement.execute")).toBe(false);
    });

    test("every catalog case executes with exact ordered/repeated MCP calls", async () => {
        const { catalog } = await fixtures();
        expect(new Set(EVAL_SCENARIO_IDS)).toEqual(new Set(catalog.cases.map((entry) => entry.id)));
        for (const entry of catalog.cases) {
            const result = await runEvalScenario(entry.id);
            expect(result.calls.map((call) => call.name), entry.id).toEqual(entry.expectedCalls);
            for (const forbidden of entry.forbiddenCalls) {
                expect(result.calls.some((call) => call.name === forbidden), `${entry.id} called forbidden ${forbidden}`).toBe(false);
            }
            expect(result.effects, `${entry.id} external side effects`).toEqual(entry.expectedEffects ?? []);
            for (const forbidden of entry.forbiddenEffects ?? []) {
                expect(result.effects.includes(forbidden), `${entry.id} executed forbidden ${forbidden}`).toBe(false);
            }
        }
    });

    test("every scripted call uses only advertised fields and supplies advertised required fields", async () => {
        const { catalog, contract } = await fixtures();
        const tools = new Map(contract.tools.map((tool) => [tool.name, tool]));
        for (const entry of catalog.cases) {
            const result = await runEvalScenario(entry.id);
            for (const call of result.calls) {
                const schema = tools.get(call.name)?.inputSchema;
                expect(schema, `${entry.id}/${call.name} missing frozen input schema`).toBeDefined();
                const supplied = Object.keys(call.arguments).sort();
                const supported = Object.keys(schema?.properties ?? {});
                expect(supplied.filter((key) => !supported.includes(key)), `${entry.id}/${call.name} unsupported args`).toEqual([]);
                expect((schema?.required ?? []).filter((key) => !(key in call.arguments)), `${entry.id}/${call.name} missing required args`).toEqual([]);
            }
        }
    });

    test("alias add and confirmation are separate calls with the returned alias UUID", async () => {
        const result = await runEvalScenario("borrower-create-alias");
        const aliasCalls = result.calls.filter((call) => call.name === "borrower.alias");
        expect(aliasCalls).toHaveLength(2);
        expect(aliasCalls[0]?.arguments).toMatchObject({ action: "add", alias: "นก" });
        expect(aliasCalls[1]?.arguments).toEqual({
            action: "confirm",
            aliasPublicId: "0198c481-3e2b-7000-8000-000000000013",
        });
    });

    test("duplicate evidence stops before finalize, preview, and financial posting", async () => {
        const result = await runEvalScenario("duplicate-evidence-hash");
        expect(result.outcome).toBe("stopped");
        expect(result.stopReason).toBe("duplicate-evidence");
        expect(result.calls.map((call) => call.name)).toEqual(["intake.create", "evidence.prepare", "intake.get"]);
        expect(result.effects).toEqual([]);
    });

    test("stale payment state is inspected and re-previewed before posting the new proposal", async () => {
        const result = await runEvalScenario("payment-stale-repreview");
        expect(result.outcome).toBe("completed");
        expect(result.calls.map((call) => call.name)).toEqual([
            "intake.create",
            "payment.preview",
            "intake.get",
            "payment.preview",
            "payment.post",
        ]);
    });

    test("disbursement lifecycle preserves the evidence order, idempotency boundaries, and compensating reversal", async () => {
        const result = await runEvalScenario("disbursement-full-lifecycle");
        expect(result.outcome).toBe("completed");
        expect(result.effects).toEqual(["disbursement-evidence.put"]);
        expect(result.calls.map((call) => call.name)).toEqual([
            "loan.disbursement.list",
            "loan.disbursement.draft",
            "loan.disbursement.evidence.prepare",
            "loan.disbursement.evidence.finalize",
            "loan.disbursement.list",
            "loan.disbursement.post",
            "loan.disbursement.list",
            "loan.disbursement.reverse",
        ]);
        expect(result.calls.at(-3)?.arguments).toEqual({
            disbursementPublicId: "0198c481-3e2b-7000-8000-000000000051",
            idempotencyKey: "disbursement-post-20260810-1",
        });
        expect(result.calls.at(-1)?.arguments).toEqual({
            disbursementPublicId: "0198c481-3e2b-7000-8000-000000000051",
            reason: "Owner confirmed duplicate payout record",
            idempotencyKey: "disbursement-reverse-20260810-1",
        });
    });

    test("disbursement draft update re-lists current state before posting", async () => {
        const result = await runEvalScenario("disbursement-draft-update");
        expect(result.outcome).toBe("completed");
        expect(result.calls.map((call) => call.name)).toEqual([
            "loan.disbursement.list",
            "loan.disbursement.update",
            "loan.disbursement.list",
            "loan.disbursement.post",
        ]);
        expect(result.calls[1]?.arguments).toEqual({
            disbursementPublicId: "0198c481-3e2b-7000-8000-000000000051",
            changes: { loanAttributedAmount: "4000.00", note: "Corrected attribution after owner review" },
        });
    });

    test("disbursement variance and schedule-change requests stop before a financial write", async () => {
        const variance = await runEvalScenario("disbursement-variance-without-confirmation");
        expect(variance).toMatchObject({ outcome: "stopped", stopReason: "variance-review-required" });
        expect(variance.calls.some((call) => call.name === "loan.disbursement.post")).toBe(false);

        const schedule = await runEvalScenario("disbursement-schedule-mutation");
        expect(schedule).toMatchObject({ outcome: "stopped", stopReason: "disbursement-cannot-mutate-schedule" });
        expect(schedule.calls.map((call) => call.name)).toEqual(["loan.disbursement.list"]);
    });

    test("disbursement stops for missing confirmation and idempotency-key conflict", async () => {
        const unconfirmed = await runEvalScenario("disbursement-missing-post-confirmation");
        expect(unconfirmed).toMatchObject({ outcome: "stopped", stopReason: "disbursement-post-confirmation-required" });
        expect(unconfirmed.calls.some((call) => call.name === "loan.disbursement.post")).toBe(false);

        const conflict = await runEvalScenario("disbursement-idempotency-conflict");
        expect(conflict).toMatchObject({ outcome: "stopped", stopReason: "disbursement-idempotency-conflict" });
        expect(conflict.calls.map((call) => call.name)).toEqual(["loan.disbursement.draft", "loan.disbursement.post"]);
    });

    test("disbursement update stops before writes for locked events and unsupported fields", async () => {
        for (const id of ["disbursement-update-locked", "disbursement-update-unsupported-fields"]) {
            const result = await runEvalScenario(id);
            expect(result.outcome, id).toBe("stopped");
            expect(result.calls.map((call) => call.name), id).toEqual(["loan.disbursement.list"]);
        }
    });

    test("disbursement evidence retries and failures do not create an unsafe upload or post", async () => {
        const ready = await runEvalScenario("disbursement-evidence-ready-retry");
        expect(ready.outcome).toBe("completed");
        expect(ready.effects).toEqual([]);
        expect(ready.calls.map((call) => call.name)).not.toContain("loan.disbursement.evidence.finalize");

        for (const id of ["disbursement-evidence-expired-upload", "disbursement-evidence-checksum-conflict", "disbursement-evidence-finalize-mismatch"]) {
            const result = await runEvalScenario(id);
            expect(result.outcome, id).toBe("stopped");
            expect(result.calls.some((call) => call.name === "loan.disbursement.post"), id).toBe(false);
        }
        expect((await runEvalScenario("disbursement-evidence-expired-upload")).effects).toEqual([]);
        expect((await runEvalScenario("disbursement-evidence-checksum-conflict")).effects).toEqual([]);
    });

    test("disbursement reversal re-lists and selects an exact posted event", async () => {
        const result = await runEvalScenario("disbursement-reversal-event-not-posted");
        expect(result).toMatchObject({ outcome: "stopped", stopReason: "disbursement-posted-event-not-found" });
        expect(result.calls.at(-1)?.name).toBe("loan.disbursement.list");
        expect(result.calls.some((call) => call.name === "loan.disbursement.reverse")).toBe(false);
    });

    test("renewal reversal derives IDs from a same-task execute result and retained pre-execution borrower", async () => {
        const execution = await runEvalScenario("renewal-execute");
        const renewal = await runEvalScenario("renewal-reversal");
        const context = (renewal as typeof renewal & {
            renewalContext?: {
                provenance: string;
                retainedBorrowerPublicId: string;
                executeResult: Record<string, unknown>;
            };
        }).renewalContext;

        expect(context?.provenance).toBe("same_task_renewal_execute_result");
        expect(execution.renewalContext).toEqual(context);
        expect(context?.executeResult).not.toHaveProperty("borrowerPublicId");
        expect(renewal.calls[0]?.arguments).toEqual({ borrowerPublicId: context?.retainedBorrowerPublicId });
        expect(renewal.calls.at(-1)?.arguments).toMatchObject({ renewalPublicId: context?.executeResult.publicId });
        expect(context?.executeResult).toMatchObject({
            oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000031",
            newLoanPublicId: "0198c481-3e2b-7000-8000-000000000032",
        });
        expect(renewal.inspectedLoanStates).toEqual([
            { publicId: "0198c481-3e2b-7000-8000-000000000031", status: "renewed" },
            { publicId: "0198c481-3e2b-7000-8000-000000000032", status: "active" },
        ]);
    });

    test("reversal boundaries require explicit reasons and stop without retained same-task context", async () => {
        const payment = await runEvalScenario("payment-reversal");
        expect(payment.calls.at(-1)?.arguments).toEqual({
            paymentIntakePublicId: "0198c481-3e2b-7000-8000-000000000021",
            reason: "Owner confirmed duplicate bank posting",
        });

        const missingRenewal = await runEvalScenario("renewal-reversal-without-result");
        expect(missingRenewal).toMatchObject({ outcome: "stopped", stopReason: "use-web-renewal-detail", calls: [] });

        const renewal = await runEvalScenario("renewal-reversal");
        expect(renewal.calls.at(-1)?.arguments).toMatchObject({
            reason: "Owner confirmed renewal reversal; backend must atomically check downstream activity",
            idempotencyKey: "renewal-reverse-20260810-1",
        });
    });

    test("renewal reversal stops when retained borrower context is missing", async () => {
        const result = await runEvalScenario("renewal-reversal-without-borrower");
        expect(result).toMatchObject({ outcome: "stopped", stopReason: "use-web-renewal-detail", calls: [] });
    });

    test("renewal.reverse reports the backend's exact aggregate blocker contract and remains stopped", async () => {
        const result = await runEvalScenario("renewal-reversal-blocked");
        expect(result).toMatchObject({
            outcome: "stopped",
            stopReason: "renewal-reverse-blocked",
            error: {
                code: "RENEWAL_REVERSE_BLOCKED",
                message: "Reverse downstream replacement-loan entries first",
                details: { downstreamEntryCount: 3 },
            },
        });
        expect(result).not.toHaveProperty("blockers");
        expect(result.calls.map((call) => call.name)).toEqual(["borrower.portfolio", "renewal.reverse"]);
    });

    test("ambiguous, needs-review, unsettled, and unauthorized fixtures make no forbidden write", async () => {
        for (const id of ["ambiguous-nickname", "allocation-mismatch", "renewal-unsettled-charges", "renewal-missing-confirmation", "unauthorized-access"]) {
            const result = await runEvalScenario(id);
            expect(result.outcome, id).toBe("stopped");
            expect(result.calls.some((call) => ["payment.post", "renewal.execute", "borrower.create"].includes(call.name)), id).toBe(false);
        }
    });
});
