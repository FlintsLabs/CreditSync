import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MCP_TOOL_NAMES } from "../../../backend/src/mcp/server";
import type { FrozenMcpContract } from "../../../backend/src/mcp/contract-snapshot";
import { canonicalContractJson, captureAdvertisedMcpContract } from "../scripts/mcp-contract";
import { classifyPrivateAppId, PRIVATE_APP_ID_PLACEHOLDER } from "../scripts/validate";

const pluginRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(pluginRoot, "../..");

async function json(path: string) {
    return JSON.parse(await readFile(resolve(pluginRoot, path), "utf8")) as Record<string, unknown>;
}

describe("CreditSync plugin 2.0.0 contract", () => {
    test("manifest exposes only the private app and orchestration skills", async () => {
        const manifest = await json(".codex-plugin/plugin.json");
        expect(manifest.name).toBe("creditsync");
        expect(manifest.version).toBe("2.0.0");
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

    test("all six skills and their required references are discoverable", async () => {
        const skills = [
            "creditsync",
            "manage-borrowers",
            "reconcile-payments",
            "manage-loans",
            "manage-disbursements",
            "renew-daily-loan",
        ];
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

    test("frozen full MCP metadata matches an actual authenticated tools/list response", async () => {
        const contract = await json("references/mcp-tool-contract.json") as unknown as FrozenMcpContract;
        expect(contract.schemaVersion).toBe("1.0");
        expect(contract.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
        expect(contract.tools).toHaveLength(26);
        expect(contract.tools.every((tool) => tool.inputSchema && tool.outputSchema && tool.annotations)).toBe(true);
        const advertised = await captureAdvertisedMcpContract();
        expect(canonicalContractJson(contract)).toBe(canonicalContractJson(advertised));
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
            "disbursement-full-lifecycle",
            "renewal-execute",
            "payment-reversal",
            "ambiguous-nickname",
            "allocation-mismatch",
            "duplicate-reference",
            "duplicate-evidence-hash",
            "active-loan-edit",
            "disbursement-variance-without-confirmation",
            "disbursement-missing-post-confirmation",
            "disbursement-idempotency-conflict",
            "disbursement-schedule-mutation",
            "renewal-unsettled-charges",
            "renewal-missing-confirmation",
            "renewal-reversal-without-result",
            "renewal-reversal-without-borrower",
            "renewal-reversal-blocked",
            "unauthorized-access",
        ]) expect(ids.has(id), `missing eval ${id}`).toBe(true);
        expect(catalog.cases?.filter((entry) => entry.kind === "negative")).toHaveLength(15);
    });

    test("disbursement skill preserves ledger, variance, evidence, confirmation, and reversal boundaries", async () => {
        const skill = await readFile(resolve(pluginRoot, "skills/manage-disbursements/SKILL.md"), "utf8");
        expect(skill).toContain("`loan.disbursement.draft`");
        expect(skill).toContain("`loan.disbursement.evidence.prepare`");
        expect(skill).toContain("`loan.disbursement.evidence.finalize`");
        expect(skill).toContain("unchanged bytes");
        expect(skill).toContain("explicit confirmation");
        expect(skill).toContain("stable post idempotency key");
        expect(skill).toContain("specific non-blank reason");
        expect(skill).toContain("never changes approved principal, installment amounts, due dates, or the schedule");
    });

    test("repo marketplace resolves the plugin from its declared local path", async () => {
        const marketplace = JSON.parse(
            await readFile(resolve(repositoryRoot, ".agents/plugins/marketplace.json"), "utf8"),
        ) as { plugins?: Array<Record<string, unknown>> };
        expect(marketplace.plugins).toContainEqual({
            name: "creditsync",
            source: { source: "local", path: "./plugins/creditsync" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Productivity",
        });
    });

    test("package includes an executable validator and excludes deferred capabilities", async () => {
        expect(existsSync(resolve(pluginRoot, "scripts/validate.ts"))).toBe(true);
        expect(existsSync(resolve(pluginRoot, "assets/README.md"))).toBe(true);
        for (const forbidden of [".mcp.json", "hooks.json", "hooks", "ui", "oauth.json"]) {
            expect(existsSync(resolve(pluginRoot, forbidden)), `${forbidden} must stay out of 2.0.0`).toBe(false);
        }
    });
});
