import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
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
        tools: Array<{
            name: string;
            inputSchema: Record<string, unknown>;
            outputSchema?: Record<string, unknown>;
        }>;
    };
    return { catalog, contract };
}

function sha256(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex");
}

function effectNames(effects: Array<string | { name: string }>) {
    return effects.map((effect) => typeof effect === "string" ? effect : effect.name);
}

function conciseSchemaErrors(errors: null | undefined | Array<{ instancePath?: string; keyword?: string }>) {
    return (errors ?? []).map((error) => `${error.instancePath || "/"}:${error.keyword}`).join(", ");
}

describe("CreditSync executable orchestration evals", () => {
    test("intermediated disbursement posts only an exact assigned three-slip group after confirmation", async () => {
        const result = await runEvalScenario("intermediated-disbursement-full-lifecycle");
        expect(result).toMatchObject({ outcome: "completed" });
        expect(result.calls.map((call) => call.name)).toEqual([
            "borrower.search",
            "borrower.portfolio",
            "intermediary.search",
            "intermediary.profile.get",
            "intermediary.disbursement.create",
            "intermediary.disbursement.event.create",
            "intermediary.disbursement.evidence.prepare",
            "intermediary.disbursement.evidence.finalize",
            "intermediary.disbursement.event.create",
            "intermediary.disbursement.evidence.prepare",
            "intermediary.disbursement.evidence.finalize",
            "intermediary.disbursement.event.create",
            "intermediary.disbursement.evidence.prepare",
            "intermediary.disbursement.evidence.finalize",
            "intermediary.disbursement.get",
            "intermediary.disbursement.preview",
            "intermediary.disbursement.post",
        ]);
        expect(result.effects).toEqual([0, 1, 2].map((index) => {
            const bytes = Buffer.from(`intermediated-slip-${index + 1}-fixture-bytes`, "utf8");
            return {
                name: "intermediated-evidence.put",
                uploadUrl: `https://storage.example/intermediated-upload-${index + 1}`,
                requiredHeaders: { "content-type": "image/png" },
                byteLength: bytes.byteLength,
                sha256: sha256(bytes),
                bytesUnchanged: true,
            };
        }));
        const prepareCalls = result.calls.filter((call) => call.name === "intermediary.disbursement.evidence.prepare");
        const finalizeCalls = result.calls.filter((call) => call.name === "intermediary.disbursement.evidence.finalize");
        for (const index of [0, 1, 2]) {
            const bytes = Buffer.from(`intermediated-slip-${index + 1}-fixture-bytes`, "utf8");
            expect(prepareCalls[index]?.arguments).toEqual({
                groupPublicId: "0198c481-3e2b-7000-8000-000000000084",
                eventPublicId: `0198c481-3e2b-7000-8000-00000000008${index + 5}`,
                mimeType: "image/png",
                size: bytes.byteLength,
                sha256: sha256(bytes),
                originalName: `intermediated-slip-${index + 1}.png`,
            });
            expect(finalizeCalls[index]?.arguments).toEqual({
                groupPublicId: "0198c481-3e2b-7000-8000-000000000084",
                eventPublicId: `0198c481-3e2b-7000-8000-00000000008${index + 5}`,
                evidencePublicId: `0198c481-3e2b-7000-8000-0000000000${index + 88}`,
            });
        }
        expect(result.calls.at(-1)?.arguments).toMatchObject({ confirmed: true });
        expect(result.events.slice(-3).map((event) => event.type === "tool" ? event.name : `${event.type}:${event.name}`)).toEqual([
            "presentation:intermediated-disbursement-preview",
            "confirmation:intermediated-disbursement",
            "intermediary.disbursement.post",
        ]);
        expect(result.events.at(-2)).toEqual({
            type: "confirmation",
            name: "intermediated-disbursement",
            confirmed: true,
        });
    });

    test("intermediated disbursement stops on every required ambiguity and stale-state boundary", async () => {
        const expectedStops = {
            "intermediated-disbursement-ambiguous-identity": "intermediated-identity-ambiguous",
            "intermediated-disbursement-missing-assignment": "intermediated-assignment-required",
            "intermediated-disbursement-missing-evidence": "intermediated-evidence-required",
            "intermediated-disbursement-duplicate-transfer": "intermediated-duplicate-transfer",
            "intermediated-disbursement-amount-payee-mismatch": "intermediated-transfer-mismatch",
            "intermediated-disbursement-finalize-evidence-id-mismatch": "intermediated-evidence-binding-mismatch",
            "intermediated-disbursement-finalize-file-id-mismatch": "intermediated-evidence-binding-mismatch",
            "intermediated-disbursement-ready-metadata-mismatch": "intermediated-evidence-binding-mismatch",
            "intermediated-disbursement-inspection-evidence-mismatch": "intermediated-evidence-binding-mismatch",
            "intermediated-disbursement-unexplained-retained-balance": "intermediated-retained-balance-unexplained",
            "intermediated-disbursement-stale-preview": "fresh-intermediated-confirmation-required",
            "intermediated-disbursement-missing-confirmation": "intermediated-confirmation-required",
        } as const;
        for (const [id, stopReason] of Object.entries(expectedStops)) {
            const result = await runEvalScenario(id);
            expect(result).toMatchObject({ outcome: "stopped", stopReason });
            const confirmedPosts = result.calls.filter((call) => call.name === "intermediary.disbursement.post" && call.arguments.confirmed === true);
            expect(confirmedPosts).toHaveLength(id === "intermediated-disbursement-stale-preview" ? 1 : 0);
        }
    });

    test("intermediated disbursement stops when evidence identity or immutable slip metadata changes", async () => {
        const scenarioIds = [
            "intermediated-disbursement-finalize-evidence-id-mismatch",
            "intermediated-disbursement-finalize-file-id-mismatch",
            "intermediated-disbursement-ready-metadata-mismatch",
            "intermediated-disbursement-inspection-evidence-mismatch",
        ] as const;
        for (const id of scenarioIds) {
            const result = await runEvalScenario(id);
            expect(result).toMatchObject({
                outcome: "stopped",
                stopReason: "intermediated-evidence-binding-mismatch",
            });
            expect(result.calls.some((call) => call.name === "intermediary.disbursement.preview")).toBe(false);
            expect(result.calls.some((call) => call.name === "intermediary.disbursement.post")).toBe(false);
            if (id === "intermediated-disbursement-ready-metadata-mismatch") {
                expect(result.calls.some((call) => call.name === "intermediary.disbursement.evidence.finalize")).toBe(false);
                expect(result.effects).toEqual([]);
            }
        }
    });

    test("intermediated disbursement sends the declared retained balance and stops before transfer events", async () => {
        const result = await runEvalScenario("intermediated-disbursement-unexplained-retained-balance");
        expect(result).toMatchObject({
            outcome: "stopped",
            stopReason: "intermediated-retained-balance-unexplained",
        });
        expect(result.calls.at(-1)).toEqual({
            name: "intermediary.disbursement.create",
            arguments: {
                loanPublicId: "0198c481-3e2b-7000-8000-000000000031",
                intermediaryPublicId: "0198c481-3e2b-7000-8000-000000000081",
                retainedBalance: "100.00",
                note: "Exact three-leg disbursement",
                idempotencyKey: "intermediated-group-20260813-1",
            },
        });
        expect(result.calls.some((call) => call.name === "intermediary.disbursement.event.create")).toBe(false);
    });

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
        expect(result.events).toEqual([
            { type: "tool", name: "borrower.portfolio" },
            { type: "tool", name: "loan.settlement.preview" },
            {
                type: "presentation",
                name: "floating-settlement-preview",
                data: {
                    publicId: "0198c481-3e2b-7000-8000-000000000071",
                    outstandingPrincipal: "5000.00",
                    dueInterest: "25.00",
                    accruedNotDueInterest: "17.14",
                    outstandingFees: "10.00",
                    outstandingPenalties: "5.00",
                    nonRefundableAdvanceInterest: "600.00",
                    settlementTotal: "5057.14",
                    expiresAt: "2026-08-15T06:15:00.000Z",
                    balanceVersion: `v1:${"c".repeat(64)}`,
                    previewHash: `v1:${"d".repeat(64)}`,
                },
            },
            { type: "confirmation", name: "floating-settlement", confirmed: true },
            { type: "tool", name: "loan.settlement.execute" },
        ]);
    });

    test("floating settlement treats an omitted confirmation as unconfirmed", async () => {
        const unconfirmed = await runEvalScenario("floating-settlement-missing-confirmation");
        expect(unconfirmed).toMatchObject({ outcome: "stopped", stopReason: "settlement-confirmation-required" });
        expect(unconfirmed.calls.some((call) => call.name === "loan.settlement.execute")).toBe(false);
        expect(unconfirmed.events?.at(-1)).toEqual({
            type: "confirmation",
            name: "floating-settlement",
            confirmed: false,
        });
    });

    test("floating settlement stops for stale state and refund requests", async () => {
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
            expect(effectNames(result.effects), `${entry.id} external side effects`).toEqual(entry.expectedEffects ?? []);
            for (const forbidden of entry.forbiddenEffects ?? []) {
                expect(effectNames(result.effects).includes(forbidden), `${entry.id} executed forbidden ${forbidden}`).toBe(false);
            }
        }
    });

    test("every scripted call and every catalog output/error passes the full frozen JSON schemas", async () => {
        const { catalog, contract } = await fixtures();
        const tools = new Map(contract.tools.map((tool) => [tool.name, tool]));
        const ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(ajv);
        const inputValidators = new Map(contract.tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
        const outputValidators = new Map(contract.tools.flatMap((tool) => tool.outputSchema
            ? [[tool.name, ajv.compile(tool.outputSchema)] as const]
            : []));
        const errorValidator = ajv.compile({
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "retryable", "reviewRequired", "details"],
            properties: {
                code: { type: "string", minLength: 1 },
                message: { type: "string", minLength: 1 },
                retryable: { type: "boolean" },
                reviewRequired: { type: "boolean" },
                details: { type: "object", additionalProperties: true },
            },
        });
        let validatedCalls = 0;
        let validatedOutputs = 0;
        const validationErrors: string[] = [];
        for (const entry of catalog.cases) {
            await runEvalScenario(entry.id, {
                validateCall(name, args) {
                    const validate = inputValidators.get(name);
                    expect(validate, `${entry.id}/${name} missing frozen input schema`).toBeDefined();
                    if (!validate!(args)) validationErrors.push(`${entry.id}/${name} input ${conciseSchemaErrors(validate!.errors)}`);
                    validatedCalls += 1;
                },
                validateOutput(name, data) {
                    const tool = tools.get(name);
                    const validate = outputValidators.get(name);
                    expect(validate, `${entry.id}/${name} missing frozen output schema`).toBeDefined();
                    const required = (tool?.outputSchema?.required as string[] | undefined) ?? [];
                    const envelope = required.includes("correlationId")
                        ? {
                            schemaVersion: "1.0",
                            data,
                            correlationId: "0198c481-3e2b-7000-8000-000000000099",
                            auditPublicIds: ["0198c481-3e2b-7000-8000-000000000098"],
                        }
                        : { schemaVersion: "1.0", data };
                    if (!validate!(envelope)) validationErrors.push(`${entry.id}/${name} output ${conciseSchemaErrors(validate!.errors)}`);
                    validatedOutputs += 1;
                },
                validateError(name, error) {
                    if (!errorValidator(error)) {
                        validationErrors.push(`${entry.id}/${name} error ${conciseSchemaErrors(errorValidator.errors)}`);
                    }
                    validatedOutputs += 1;
                },
            });
        }
        expect(validationErrors).toEqual([]);
        expect(validatedCalls).toBeGreaterThan(0);
        expect(validatedOutputs).toBeGreaterThan(0);
    });

    test("every settlement reversal fixture matches the complete frozen output schema", async () => {
        const { catalog, contract } = await fixtures();
        const tool = contract.tools.find((candidate) => candidate.name === "loan.settlement.reverse");
        expect(tool?.outputSchema).toBeDefined();
        const ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(ajv);
        const validate = ajv.compile(tool!.outputSchema!);
        const errors: string[] = [];
        for (const entry of catalog.cases) {
            await runEvalScenario(entry.id, {
                validateCall() {},
                validateOutput(name, data) {
                    if (name !== "loan.settlement.reverse") return;
                    const envelope = {
                        schemaVersion: "1.0",
                        data,
                        correlationId: "0198c481-3e2b-7000-8000-000000000099",
                        auditPublicIds: ["0198c481-3e2b-7000-8000-000000000098"],
                    };
                    if (!validate(envelope)) errors.push(`${entry.id}/${name} output ${conciseSchemaErrors(validate.errors)}`);
                },
            });
        }
        expect(errors).toEqual([]);
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

    test("payment data-only and slip flows keep evidence conditional and ordered", async () => {
        const dataOnly = await runEvalScenario("payment-data-only");
        expect(dataOnly).toMatchObject({ outcome: "completed", effects: [] });
        expect(dataOnly.calls.map((call) => call.name)).toEqual([
            "intake.create",
            "payment.preview",
            "payment.post",
        ]);

        const slip = await runEvalScenario("payment-slip");
        expect(slip).toMatchObject({ outcome: "completed" });
        expect(slip.calls.map((call) => call.name)).toEqual([
            "intake.create",
            "evidence.prepare",
            "evidence.finalize",
            "payment.preview",
            "payment.post",
        ]);
        const bytes = Buffer.from("payment-slip-fixture-bytes", "utf8");
        expect(slip.effects).toEqual([{
            name: "evidence.put",
            uploadUrl: "https://storage.example/payment-upload",
            requiredHeaders: {},
            byteLength: bytes.byteLength,
            sha256: sha256(bytes),
            bytesUnchanged: true,
        }]);
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
        const bytes = Buffer.from("disbursement-slip-fixture-bytes", "utf8");
        expect(result.effects).toEqual([{
            name: "disbursement-evidence.put",
            uploadUrl: "https://storage.example/upload",
            requiredHeaders: { "content-type": "image/jpeg" },
            byteLength: bytes.byteLength,
            sha256: sha256(bytes),
            bytesUnchanged: true,
        }]);
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
