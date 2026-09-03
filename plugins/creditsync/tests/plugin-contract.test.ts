import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { MCP_TOOL_NAMES } from "../../../backend/src/mcp/server";
import type { FrozenMcpContract } from "../../../backend/src/mcp/contract-snapshot";
import { canonicalContractJson, captureAdvertisedMcpContract } from "../scripts/mcp-contract";
import {
    classifyPrivateAppId,
    PRIVATE_APP_ID_PLACEHOLDER,
    validateMarketplaceContract,
} from "../scripts/validate";

const pluginRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(pluginRoot, "../..");

async function json(path: string) {
    return JSON.parse(await readFile(resolve(pluginRoot, path), "utf8")) as Record<string, unknown>;
}

describe("CreditSync plugin 8.0.0 contract", () => {
    test("exposes the documented local validation command", async () => {
        const packageManifest = await json("package.json");
        expect(packageManifest.private).toBe(true);
        expect(packageManifest.scripts).toMatchObject({ validate: "bun run scripts/validate.ts" });
    });

    test("manifest exposes only the private app and orchestration skills", async () => {
        const manifest = await json(".codex-plugin/plugin.json");
        expect(manifest.name).toBe("creditsync");
        expect(manifest.version).toBe("8.0.0");
        expect(manifest.skills).toBe("./skills/");
        expect(manifest.apps).toBe("./.app.json");
        expect(manifest).not.toHaveProperty("mcpServers");
        expect(manifest).not.toHaveProperty("hooks");
        expect(manifest).not.toHaveProperty("ui");
    });

    test("private app ID supports the non-live placeholder and registered technical IDs without connection secrets", async () => {
        const app = await json(".app.json") as { apps?: { creditsync?: { id?: string } } };
        expect(Object.keys(app.apps ?? {})).toEqual(["creditsync"]);
        expect(["placeholder", "registered"]).toContain(classifyPrivateAppId(app.apps?.creditsync?.id));
        expect(classifyPrivateAppId(PRIVATE_APP_ID_PLACEHOLDER)).toBe("placeholder");
        expect(classifyPrivateAppId("plugin_asdk_app_A1b2C3d4E5f6G7h8")).toBe("registered");
        expect(classifyPrivateAppId("asdk_app_missing_prefix")).toBe("invalid");
        expect(classifyPrivateAppId("plugin_asdk_app_REPLACE_WITH_REAL_ID")).toBe("invalid");
        const raw = await readFile(resolve(pluginRoot, ".app.json"), "utf8");
        expect(raw).not.toMatch(/https?:\/\//iu);
        expect(raw).not.toMatch(/bearer|token|secret/iu);
    });

    test("all eleven skills and their required references are discoverable and documented", async () => {
        const skills = [
            "creditsync",
            "manage-borrowers",
            "reconcile-payments",
            "reconcile-intermediary-remittances",
            "manage-loans",
            "manage-floating-interest-rates",
            "settle-floating-loans",
            "manage-disbursements",
            "manage-intermediated-disbursements",
            "renew-daily-loan",
            "restructure-loan",
        ];
        expect((await readdir(resolve(pluginRoot, "skills"))).sort()).toEqual([...skills].sort());
        for (const skill of skills) {
            const path = resolve(pluginRoot, "skills", skill, "SKILL.md");
            expect(existsSync(path), `${skill} should have SKILL.md`).toBe(true);
            const contents = await readFile(path, "utf8");
            expect(contents).toMatch(new RegExp(`^---\\nname: ${skill}\\n`, "u"));
            expect(contents).toMatch(/\ndescription: Use when/u);
        }
        for (const reference of ["matching-policy.md", "financial-rules.md", "error-recovery.md", "mcp-tool-contract.json"]) {
            expect(existsSync(resolve(pluginRoot, "references", reference)), `${reference} should exist`).toBe(true);
        }
        expect(await readFile(resolve(pluginRoot, "README.md"), "utf8")).toContain("11 orchestration skills");
        expect(await readFile(resolve(pluginRoot, "scripts/validate.ts"), "utf8")).toContain('"restructure-loan"');
    });

    test("commission and attribution skills bind named tools to write and reversal safety guidance", async () => {
        const required: Record<string, string[]> = {
            creditsync: [
                "loan.commission-participant.list", "loan.commission-participant.add", "loan.commission-participant.update",
                "loan.commission-participant.end", "loan.commission.preview", "loan.commission.list", "loan.commission.calculate",
                "loan.commission.reverse", "payment.intermediary-attribution.create", "payment.intermediary-attribution.list",
                "payment.intermediary-attribution.reverse",
            ],
            "manage-loans": [
                "loan.commission-participant.list", "loan.commission-participant.add", "loan.commission-participant.update",
                "loan.commission-participant.end", "loan.commission.preview", "loan.commission.list", "loan.commission.calculate",
                "loan.commission.reverse",
            ],
            "reconcile-payments": [
                "loan.commission-participant.list", "loan.commission.preview", "loan.commission.reverse",
                "payment.intermediary-attribution.create", "payment.intermediary-attribution.list",
                "payment.intermediary-attribution.reverse",
            ],
        };
        for (const [skillName, toolNames] of Object.entries(required)) {
            const skill = await readFile(resolve(pluginRoot, "skills", skillName, "SKILL.md"), "utf8");
            for (const toolName of toolNames) expect(skill, `${skillName} guidance for ${toolName}`).toContain(`\`${toolName}\``);
            for (const boundary of ["explicit confirmation", "stable idempotency key", "append-only", "read-only compensating preview", "unattributed", "multi-agent"]) {
                expect(skill, `${skillName} ${boundary} boundary`).toContain(boundary);
            }
        }
    });

    test("renewal reversal skill states only capabilities exposed by MCP 1.0", async () => {
        const skill = await readFile(resolve(pluginRoot, "skills/renew-daily-loan/SKILL.md"), "utf8");
        expect(skill).toContain("borrower public UUID retained from the same-task pre-execution resolution");
        expect(skill).toContain("`renewal.execute` does not return a borrower UUID");
        expect(skill).toContain("only the current loan states exposed by `borrower.portfolio`");
        expect(skill).toContain("authoritative atomic downstream-activity check");
        expect(skill).toContain("aggregate `downstreamEntryCount`");
        expect(skill).toContain("backend message");
        expect(skill).not.toContain("supplies the renewal, old-loan, new-loan, and borrower public UUIDs");
        expect(skill).not.toContain("inspect the current state of both loans and downstream activity");
        expect(skill).not.toContain("transaction/adjustment blockers");
        expect(skill).not.toContain("report those blockers");
    });

    test("daily renewal guidance binds full-interest defaults, adjustments, collection acknowledgement, and presentation-only images", async () => {
        const skill = await readFile(resolve(pluginRoot, "skills/renew-daily-loan/SKILL.md"), "utf8");
        for (const boundary of [
            "`full_contract_interest`", "`accrued_to_date`", "contractualInterest", "remainingContractInterest",
            "confirmedCashDirection", "List every manual line and reason", "presentation-only", "never executes the renewal",
        ]) expect(skill).toContain(boundary);
    });

    test("frozen full MCP metadata matches an actual MCP tools/list response", async () => {
        const contract = await json("references/mcp-tool-contract.json") as unknown as FrozenMcpContract;
        expect(contract.schemaVersion).toBe("1.0");
        expect(contract.compatibility).toBe("Tool names, full input/output schemas, descriptions, and annotations are frozen for plugin 8.0.0; breaking changes require plugin 9.0.0.");
        expect(contract.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
        expect(contract.tools).toHaveLength(106);
        expect(contract.tools.every((tool) => tool.inputSchema && tool.outputSchema && tool.annotations)).toBe(true);
        const advertised = await captureAdvertisedMcpContract();
        expect(canonicalContractJson(contract)).toBe(canonicalContractJson(advertised));
        for (const name of ["loan.restructure.preview", "loan.waiver.preview"]) {
            expect(contract.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
                readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
            });
        }
        const restructureOutput = contract.tools.find((tool) => tool.name === "loan.restructure.preview")?.outputSchema as any;
        const replacementTerms = restructureOutput.properties.data.properties.replacementTerms;
        expect(replacementTerms.oneOf).toHaveLength(5);
        expect(replacementTerms.oneOf.every((variant: { additionalProperties?: boolean }) => variant.additionalProperties === false)).toBe(true);
        const restructureInput = contract.tools.find((tool) => tool.name === "loan.restructure.preview")?.inputSchema as any;
        const replacementInput = restructureInput.properties.replacementTerms;
        expect(replacementInput.oneOf).toHaveLength(5);
        expect(replacementInput.oneOf.every((variant: { additionalProperties?: boolean }) => variant.additionalProperties === false)).toBe(true);
        const inputVariants = replacementInput.oneOf as Array<{ properties: Record<string, any> }>;
        const floatingInput = inputVariants.find((variant) => variant.properties.floatingDailyInterest);
        const dailyInput = inputVariants.find((variant) => variant.properties.dailyEntry);
        expect(floatingInput?.properties.floatingDailyInterest.additionalProperties).toBe(false);
        expect(dailyInput?.properties.dailyEntry.additionalProperties).toBe(false);
        expect(dailyInput?.properties.dailyEntry.properties.interestInput.additionalProperties).toBe(false);

        const renewalPreview = contract.tools.find((tool) => tool.name === "renewal.preview") as any;
        expect(renewalPreview.inputSchema.additionalProperties).toBe(false);
        expect(renewalPreview.inputSchema.properties.settlementPolicy.enum).toEqual(["full_contract_interest", "accrued_to_date"]);
        expect(renewalPreview.inputSchema.properties.adjustments.maxItems).toBe(50);
        expect(renewalPreview.inputSchema.properties.adjustments.items.additionalProperties).toBe(false);
        const renewalData = renewalPreview.outputSchema.properties.data;
        expect(renewalData.required).toContain("composition");
        expect(renewalData.properties.composition.additionalProperties).toBe(false);
        expect(renewalData.properties.composition.required).toContain("payments");

        const atomicReplacement = contract.tools.find((tool) => tool.name === "loan.replacement.preview")?.outputSchema as any;
        const atomicReplacementData = atomicReplacement.properties.data;
        expect(atomicReplacementData.additionalProperties).toBe(false);
        expect(atomicReplacementData.properties.replacement.required).toContain("fundingSourceName");
        expect(atomicReplacementData.properties.replacement.properties.fundingSourceName).toMatchObject({ type: "string" });
        expect(atomicReplacementData.properties.warnings.items.oneOf).toHaveLength(2);
        expect(atomicReplacementData.properties.warnings.items.oneOf.every(
            (variant: { additionalProperties?: boolean; properties?: { details?: { additionalProperties?: boolean } } }) =>
                variant.additionalProperties === false && variant.properties?.details?.additionalProperties === false,
        )).toBe(true);
    });

    test("requires audit and correlation UUIDs from every intermediary administrative and evidence write", async () => {
        const contract = await json("references/mcp-tool-contract.json") as unknown as FrozenMcpContract;
        for (const name of [
            "intermediary.bank-account.save",
            "intermediary.assignment.create",
            "intermediary.assignment.end",
            "intermediary.disbursement.evidence.prepare",
            "intermediary.disbursement.evidence.finalize",
        ]) {
            const tool = contract.tools.find((candidate) => candidate.name === name);
            const dataSchema = (tool?.outputSchema as {
                properties?: {
                    data?: {
                        required?: string[];
                        properties?: Record<string, { format?: string }>;
                    };
                };
            } | undefined)?.properties?.data;
            expect(dataSchema?.required, `${name} required output fields`).toEqual(expect.arrayContaining([
                "auditPublicId",
                "correlationId",
            ]));
            expect(dataSchema?.properties, `${name} output properties`).toMatchObject({
                auditPublicId: { format: "uuid" },
                correlationId: { format: "uuid" },
            });
        }
    });

    test("eval catalog covers every required positive and negative workflow", async () => {
        const catalog = await json("evals/evals.json") as {
            cases?: Array<{ id?: string; kind?: string }>;
        };
        const ids = new Set(catalog.cases?.map((entry) => entry.id));
        for (const id of [
            "borrower-create-alias",
            "payment-data-only",
            "payment-slip",
            "payment-stale-repreview",
            "payment-split-loans",
            "payment-split-borrowers-intermediary",
            "payment-partial",
            "loan-draft-activation",
            "loan-replacement-execute",
            "floating-rate-scheduled-change",
            "floating-rate-missing-confirmation",
            "floating-settlement-execute",
            "floating-settlement-missing-confirmation",
            "floating-settlement-stale-preview",
            "floating-settlement-non-refundable-refund",
            "floating-settlement-reverse",
            "disbursement-full-lifecycle",
            "disbursement-draft-update",
            "disbursement-evidence-ready-retry",
            "renewal-execute",
            "renewal-accrued-policy",
            "restructure-execute",
            "waiver-execute",
            "payment-reversal",
            "ambiguous-nickname",
            "allocation-mismatch",
            "duplicate-reference",
            "duplicate-evidence-hash",
            "active-loan-edit",
            "disbursement-variance-without-confirmation",
            "disbursement-missing-post-confirmation",
            "disbursement-evidence-expired-upload",
            "disbursement-evidence-finalize-mismatch",
            "disbursement-evidence-checksum-conflict",
            "disbursement-reversal-event-not-posted",
            "disbursement-idempotency-conflict",
            "disbursement-schedule-mutation",
            "disbursement-update-locked",
            "disbursement-update-unsupported-fields",
            "intermediated-disbursement-full-lifecycle",
            "intermediated-disbursement-ambiguous-identity",
            "intermediated-disbursement-missing-assignment",
            "intermediated-disbursement-missing-evidence",
            "intermediated-disbursement-duplicate-transfer",
            "intermediated-disbursement-amount-payee-mismatch",
            "intermediated-disbursement-finalize-evidence-id-mismatch",
            "intermediated-disbursement-finalize-file-id-mismatch",
            "intermediated-disbursement-ready-metadata-mismatch",
            "intermediated-disbursement-inspection-evidence-mismatch",
            "intermediated-disbursement-unexplained-retained-balance",
            "intermediated-disbursement-stale-preview",
            "intermediated-disbursement-missing-confirmation",
            "renewal-unsettled-charges",
            "renewal-missing-confirmation",
            "renewal-independent-dates",
            "renewal-date-mismatch",
            "renewal-reversal-without-result",
            "renewal-reversal-without-borrower",
            "renewal-reversal-blocked",
            "unauthorized-access",
            "restructure-ambiguous-borrower",
            "restructure-stale-preview",
            "restructure-missing-confirmation",
            "restructure-unexpected-additional-cash",
            "waiver-missing-reason",
            "restructure-unsafe-reversal",
            "loan-replacement-missing-confirmation",
            "loan-replacement-stale-preview",
            "loan-replacement-downstream-activity",
            "loan-replacement-direct-status-mutation",
            "loan-replacement-portfolio-scope-mismatch",
        ]) expect(ids.has(id), `missing eval ${id}`).toBe(true);
        expect(catalog.cases?.filter((entry) => entry.kind === "positive")).toHaveLength(35);
        expect(catalog.cases?.filter((entry) => entry.kind === "negative")).toHaveLength(58);
    });

    test("floating settlement skill preserves exact composition and all execution stop gates", async () => {
        const skill = await readFile(resolve(pluginRoot, "skills/settle-floating-loans/SKILL.md"), "utf8");
        expect(skill).toContain("`borrower.portfolio`");
        expect(skill).toContain("`loan.settlement.preview`");
        expect(skill).toContain("`loan.settlement.execute`");
        expect(skill).toContain("nonRefundableAdvanceInterest");
        expect(skill).toContain("explicit confirmation");
        expect(skill).toContain("stable idempotency key");
        expect(skill).toContain("stale");
        expect(skill).toContain("does not carry over");
        expect(skill).toContain("must not be refunded");
        expect(skill).toContain("Never calculate");
    });

    test("disbursement skill preserves ledger, variance, evidence, confirmation, and reversal boundaries", async () => {
        const skill = await readFile(resolve(pluginRoot, "skills/manage-disbursements/SKILL.md"), "utf8");
        expect(skill).toContain("`loan.disbursement.draft`");
        expect(skill).toContain("`loan.disbursement.update`");
        expect(skill).toContain("PATCH semantics without a stale-state guard");
        expect(skill).toContain("Any confirmation obtained before an update is invalid");
        expect(skill).toContain("`loan.disbursement.evidence.prepare`");
        expect(skill).toContain("`loan.disbursement.evidence.finalize`");
        expect(skill).toContain("unchanged bytes");
        expect(skill).toContain("explicit confirmation");
        expect(skill).toContain("stable post idempotency key");
        expect(skill).toContain("specific non-blank reason");
        expect(skill).toContain("`status: ready`");
        expect(skill).toContain("exact event with `status: posted`");
        expect(skill).toContain("never changes approved principal, installment amounts, due dates, or the schedule");
    });

    test("intermediated disbursement skill preserves exact assignment, evidence, variance, and confirmation gates", async () => {
        const skill = await readFile(resolve(pluginRoot, "skills/manage-intermediated-disbursements/SKILL.md"), "utf8");
        for (const tool of [
            "borrower.search",
            "intermediary.search",
            "intermediary.profile.get",
            "intermediary.disbursement.create",
            "intermediary.disbursement.event.create",
            "intermediary.disbursement.evidence.prepare",
            "intermediary.disbursement.evidence.finalize",
            "intermediary.disbursement.get",
            "intermediary.disbursement.preview",
            "intermediary.disbursement.post",
            "intermediary.disbursement.reverse",
        ]) expect(skill).toContain(`\`${tool}\``);
        for (const phrase of [
            "exact canonical name or confirmed alias",
            "active disbursement assignment",
            "every supplied slip",
            "unchanged bytes",
            "retained balance",
            "variance: 0.00",
            "explicit confirmation",
            "fresh preview",
            "specific non-blank reason",
        ]) expect(skill).toContain(phrase);
        expect(skill).toContain("never expose or request an evidence access URL through MCP");
    });

    test("repo marketplace resolves the plugin from its declared local path", async () => {
        const marketplace = JSON.parse(
            await readFile(resolve(repositoryRoot, ".agents/plugins/marketplace.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(marketplace).toEqual({
            name: "creditsync-marketplace",
            interface: { displayName: "CreditSync" },
            plugins: [{
                name: "creditsync",
                source: { source: "local", path: "./plugins/creditsync" },
                policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
                category: "Productivity",
            }],
        });
        expect(existsSync(resolve(repositoryRoot, "plugins/creditsync"))).toBe(true);
        const referencedManifest = JSON.parse(
            await readFile(resolve(repositoryRoot, "plugins/creditsync/.codex-plugin/plugin.json"), "utf8"),
        ) as { name?: string };
        expect(referencedManifest.name).toBe("creditsync");
        expect(validateMarketplaceContract(marketplace, true, referencedManifest.name)).toEqual([]);
    });

    test("marketplace validation rejects identity, duplication, path, and referenced package drift", () => {
        const valid = {
            name: "creditsync-marketplace",
            interface: { displayName: "CreditSync" },
            plugins: [{
                name: "creditsync",
                source: { source: "local", path: "./plugins/creditsync" },
                policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
                category: "Productivity",
            }],
        };
        expect(validateMarketplaceContract({ ...valid, name: "personal" }, true, "creditsync"))
            .toContain("repo marketplace name must be creditsync-marketplace");
        expect(validateMarketplaceContract({ ...valid, plugins: [...valid.plugins, valid.plugins[0]] }, true, "creditsync"))
            .toContain("repo marketplace must contain exactly one creditsync plugin entry");
        expect(validateMarketplaceContract({
            ...valid,
            plugins: [{ ...valid.plugins[0], source: { source: "local", path: "./plugins/other" } }],
        }, true, "creditsync")).toContain("repo marketplace plugin source must be local at ./plugins/creditsync");
        expect(validateMarketplaceContract(valid, false, "creditsync"))
            .toContain("repo marketplace plugin source directory is missing");
        expect(validateMarketplaceContract(valid, true, "other"))
            .toContain("repo marketplace source manifest name must be creditsync");
    });

    test("package includes an executable validator and excludes deferred capabilities", async () => {
        expect(existsSync(resolve(pluginRoot, "scripts/validate.ts"))).toBe(true);
        expect(existsSync(resolve(pluginRoot, "assets/README.md"))).toBe(true);
        for (const forbidden of [".mcp.json", "hooks.json", "hooks", "ui", "oauth.json"]) {
            expect(existsSync(resolve(pluginRoot, forbidden)), `${forbidden} must stay out of 6.0.0`).toBe(false);
        }
    });
});
