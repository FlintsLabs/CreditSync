import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { MCP_TOOL_NAMES } from "../../../backend/src/mcp/server";

const pluginRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(pluginRoot, "../..");
const expectedSkills = ["creditsync", "manage-borrowers", "reconcile-payments", "manage-loans", "renew-daily-loan"];
const expectedReferences = ["matching-policy.md", "financial-rules.md", "error-recovery.md", "mcp-tool-contract.json"];
const forbiddenEntries = [".mcp.json", "hooks.json", "hooks", "ui", "oauth.json"];

async function parseJson(path: string) {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function equalStrings(left: unknown, right: readonly string[]) {
    return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

async function filesBelow(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) files.push(...await filesBelow(path));
        else files.push(path);
    }
    return files;
}

export async function validatePlugin() {
    const errors: string[] = [];
    const manifest = await parseJson(resolve(pluginRoot, ".codex-plugin/plugin.json"));
    if (manifest.name !== "creditsync") errors.push("manifest name must be creditsync");
    if (manifest.version !== "1.0.0") errors.push("manifest version must be 1.0.0");
    if (manifest.skills !== "./skills/") errors.push("manifest skills path must be ./skills/");
    if (manifest.apps !== "./.app.json") errors.push("manifest apps path must be ./.app.json");
    for (const field of ["mcpServers", "hooks", "ui", "oauth"]) {
        if (field in manifest) errors.push(`manifest must not declare ${field}`);
    }

    const app = await parseJson(resolve(pluginRoot, ".app.json")) as { apps?: Record<string, { id?: string }> };
    const appId = app.apps?.creditsync?.id;
    if (appId !== "plugin_asdk_app_REPLACE_AFTER_PRIVATE_REGISTRATION") {
        errors.push(".app.json must use the documented private-registration placeholder until registration");
    }
    const appRaw = await readFile(resolve(pluginRoot, ".app.json"), "utf8");
    if (/https?:\/\//iu.test(appRaw) || /bearer|token|secret/iu.test(appRaw)) errors.push(".app.json must not contain connection data");

    for (const entry of forbiddenEntries) {
        if (existsSync(resolve(pluginRoot, entry))) errors.push(`forbidden 1.0.0 capability exists: ${entry}`);
    }
    for (const skill of expectedSkills) {
        const skillPath = resolve(pluginRoot, "skills", skill, "SKILL.md");
        if (!existsSync(skillPath)) {
            errors.push(`missing skill ${skill}`);
            continue;
        }
        const contents = await readFile(skillPath, "utf8");
        if (!contents.startsWith(`---\nname: ${skill}\ndescription: Use when`)) errors.push(`invalid discovery frontmatter for ${skill}`);
    }
    for (const reference of expectedReferences) {
        if (!existsSync(resolve(pluginRoot, "references", reference))) errors.push(`missing reference ${reference}`);
    }

    const contract = await parseJson(resolve(pluginRoot, "references/mcp-tool-contract.json")) as {
        schemaVersion?: string;
        tools?: string[];
        operations?: Record<string, unknown>;
    };
    if (contract.schemaVersion !== "1.0") errors.push("tool contract schemaVersion must be 1.0");
    if (!equalStrings(contract.tools, MCP_TOOL_NAMES)) errors.push("plugin tool list differs from backend MCP tool list/order");
    if (!equalStrings(Object.keys(contract.operations ?? {}), MCP_TOOL_NAMES)) errors.push("operation contracts differ from backend MCP tool list/order");

    const evals = await parseJson(resolve(pluginRoot, "evals/evals.json")) as {
        execution?: { liveMcpCallsPerformed?: boolean };
        cases?: Array<{ id?: string; kind?: string; prompt?: string; expectedCalls?: string[]; forbiddenCalls?: string[] }>;
    };
    if (evals.execution?.liveMcpCallsPerformed !== false) errors.push("eval manifest must truthfully declare that live MCP calls were not run");
    const cases = evals.cases ?? [];
    if (cases.filter((entry) => entry.kind === "positive").length < 8) errors.push("evals require at least eight positive workflows");
    if (cases.filter((entry) => entry.kind === "negative").length !== 6) errors.push("evals require exactly six negative safety workflows");
    const validTools = new Set<string>(MCP_TOOL_NAMES);
    for (const entry of cases) {
        if (!entry.id || !entry.prompt) errors.push("each eval requires id and prompt");
        for (const name of [...entry.expectedCalls ?? [], ...entry.forbiddenCalls ?? []]) {
            if (!validTools.has(name)) errors.push(`eval ${entry.id ?? "unknown"} references unknown tool ${name}`);
        }
    }

    const marketplace = await parseJson(resolve(repositoryRoot, ".agents/plugins/marketplace.json")) as {
        plugins?: Array<{ name?: string; source?: { source?: string; path?: string } }>;
    };
    const marketEntry = marketplace.plugins?.find((entry) => entry.name === "creditsync");
    if (marketEntry?.source?.source !== "local" || marketEntry.source.path !== "./plugins/creditsync") {
        errors.push("repo marketplace does not resolve ./plugins/creditsync");
    }

    const secretPatterns = [
        /sk-[A-Za-z0-9_-]{20,}/u,
        /Authorization:\s*Bearer\s+(?!<)[A-Za-z0-9._~-]{20,}/iu,
        /MCP_API_TOKEN_HASHES\s*=\s*[0-9a-f]{64}/iu,
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    ];
    const unresolvedMarker = `[${"TODO"}:`;
    for (const path of await filesBelow(pluginRoot)) {
        if (!/\.(?:json|md|ts)$/u.test(path)) continue;
        const contents = await readFile(path, "utf8");
        if (contents.includes(unresolvedMarker)) errors.push(`${path} contains an unresolved TODO placeholder`);
        if (secretPatterns.some((pattern) => pattern.test(contents))) errors.push(`${path} appears to contain a secret`);
    }
    return errors;
}

if (import.meta.main) {
    const errors = await validatePlugin();
    if (errors.length > 0) {
        console.error("CreditSync plugin validation failed:");
        for (const error of errors) console.error(`- ${error}`);
        process.exit(1);
    }
    console.log("CreditSync plugin validation passed (1.0.0, 5 skills, 20 tools, no bundled MCP/secrets). ");
}
