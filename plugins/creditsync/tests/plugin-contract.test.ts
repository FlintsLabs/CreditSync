import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MCP_TOOL_NAMES } from "../../../backend/src/mcp/server";

const pluginRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(pluginRoot, "../..");

async function json(path: string) {
    return JSON.parse(await readFile(resolve(pluginRoot, path), "utf8")) as Record<string, unknown>;
}

describe("CreditSync plugin 1.0.0 contract", () => {
    test("manifest exposes only the private app and orchestration skills", async () => {
        const manifest = await json(".codex-plugin/plugin.json");
        expect(manifest.name).toBe("creditsync");
        expect(manifest.version).toBe("1.0.0");
        expect(manifest.skills).toBe("./skills/");
        expect(manifest.apps).toBe("./.app.json");
        expect(manifest).not.toHaveProperty("mcpServers");
        expect(manifest).not.toHaveProperty("hooks");
        expect(manifest).not.toHaveProperty("ui");
    });

    test("private app ID is an explicit registration placeholder without connection secrets", async () => {
        const app = await json(".app.json");
        expect(app).toEqual({
            apps: {
                creditsync: {
                    id: "plugin_asdk_app_REPLACE_AFTER_PRIVATE_REGISTRATION",
                },
            },
        });
        const raw = await readFile(resolve(pluginRoot, ".app.json"), "utf8");
        expect(raw).not.toMatch(/https?:\/\//iu);
        expect(raw).not.toMatch(/bearer|token|secret/iu);
    });

    test("all five skills and their required references are discoverable", async () => {
        const skills = [
            "creditsync",
            "manage-borrowers",
            "reconcile-payments",
            "manage-loans",
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

    test("frozen plugin tool list matches the backend MCP 1.0 surface", async () => {
        const contract = await json("references/mcp-tool-contract.json") as {
            schemaVersion?: string;
            tools?: string[];
        };
        expect(contract.schemaVersion).toBe("1.0");
        expect(contract.tools).toEqual([...MCP_TOOL_NAMES]);
        expect(contract.tools).toHaveLength(20);
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
            "payment-split-loans",
            "payment-split-borrowers-intermediary",
            "payment-partial",
            "renewal-execute",
            "payment-reversal",
            "ambiguous-nickname",
            "allocation-mismatch",
            "duplicate-reference",
            "active-loan-edit",
            "renewal-unsettled-charges",
            "unauthorized-access",
        ]) expect(ids.has(id), `missing eval ${id}`).toBe(true);
        expect(catalog.cases?.filter((entry) => entry.kind === "negative")).toHaveLength(6);
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
            expect(existsSync(resolve(pluginRoot, forbidden)), `${forbidden} must stay out of 1.0.0`).toBe(false);
        }
    });
});
