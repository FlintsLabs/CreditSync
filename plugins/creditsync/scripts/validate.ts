import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { MCP_TOOL_NAMES } from "../../../backend/src/mcp/server";
import type { FrozenMcpContract } from "../../../backend/src/mcp/contract-snapshot";
import { EVAL_SCENARIO_IDS, runEvalScenario } from "../evals/harness";
import { canonicalContractJson, captureAdvertisedMcpContract } from "./mcp-contract";

const pluginRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(pluginRoot, "../..");
const expectedSkills = ["creditsync", "manage-borrowers", "reconcile-payments", "reconcile-intermediary-remittances", "manage-loans", "manage-floating-interest-rates", "settle-floating-loans", "manage-disbursements", "renew-daily-loan"];
const expectedReferences = ["matching-policy.md", "financial-rules.md", "error-recovery.md", "mcp-tool-contract.json"];
const forbiddenEntries = [".mcp.json", "hooks.json", "hooks", "ui", "oauth.json"];
export const PRIVATE_APP_ID_PLACEHOLDER = "plugin_asdk_app_REPLACE_AFTER_PRIVATE_REGISTRATION";

export function classifyPrivateAppId(value: unknown): "placeholder" | "registered" | "invalid" {
    if (value === PRIVATE_APP_ID_PLACEHOLDER) return "placeholder";
    if (typeof value === "string" && /^plugin_asdk_app_[A-Za-z0-9_-]{8,}$/u.test(value) && !/REPLACE/iu.test(value)) {
        return "registered";
    }
    return "invalid";
}

export function validateMarketplaceContract(
    marketplace: Record<string, unknown>,
    sourceDirectoryExists: boolean,
    sourceManifestName: unknown,
): string[] {
    const errors: string[] = [];
    if (marketplace.name !== "creditsync-marketplace") {
        errors.push("repo marketplace name must be creditsync-marketplace");
    }
    const marketplaceInterface = marketplace.interface as { displayName?: unknown } | undefined;
    if (marketplaceInterface?.displayName !== "CreditSync") {
        errors.push("repo marketplace display name must be CreditSync");
    }
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    if (plugins.length !== 1 || (plugins[0] as { name?: unknown } | undefined)?.name !== "creditsync") {
        errors.push("repo marketplace must contain exactly one creditsync plugin entry");
    }
    const entry = plugins.find((candidate) => (candidate as { name?: unknown })?.name === "creditsync") as {
        source?: { source?: unknown; path?: unknown };
        policy?: { installation?: unknown; authentication?: unknown };
        category?: unknown;
    } | undefined;
    if (entry?.source?.source !== "local" || entry.source.path !== "./plugins/creditsync") {
        errors.push("repo marketplace plugin source must be local at ./plugins/creditsync");
    }
    if (entry?.policy?.installation !== "AVAILABLE" || entry.policy.authentication !== "ON_INSTALL") {
        errors.push("repo marketplace plugin policy must be AVAILABLE with ON_INSTALL authentication");
    }
    if (entry?.category !== "Productivity") {
        errors.push("repo marketplace plugin category must be Productivity");
    }
    if (!sourceDirectoryExists) errors.push("repo marketplace plugin source directory is missing");
    if (sourceManifestName !== "creditsync") errors.push("repo marketplace source manifest name must be creditsync");
    return errors;
}

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
    if (manifest.version !== "3.0.0") errors.push("manifest version must be 3.0.0");
    if (manifest.skills !== "./skills/") errors.push("manifest skills path must be ./skills/");
    if (manifest.apps !== "./.app.json") errors.push("manifest apps path must be ./.app.json");
    for (const field of ["mcpServers", "hooks", "ui", "oauth"]) {
        if (field in manifest) errors.push(`manifest must not declare ${field}`);
    }

    const app = await parseJson(resolve(pluginRoot, ".app.json")) as { apps?: Record<string, { id?: string }> };
    const appId = app.apps?.creditsync?.id;
    const appRegistration = classifyPrivateAppId(appId);
    if (appRegistration === "invalid") errors.push(".app.json requires the documented placeholder or a technical ID beginning plugin_asdk_app_");
    const appRaw = await readFile(resolve(pluginRoot, ".app.json"), "utf8");
    if (/https?:\/\//iu.test(appRaw) || /bearer|token|secret/iu.test(appRaw)) errors.push(".app.json must not contain connection data");

    for (const entry of forbiddenEntries) {
        if (existsSync(resolve(pluginRoot, entry))) errors.push(`forbidden 3.0.0 capability exists: ${entry}`);
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

    const contract = await parseJson(resolve(pluginRoot, "references/mcp-tool-contract.json")) as unknown as FrozenMcpContract;
    if (contract.schemaVersion !== "1.0") errors.push("tool contract schemaVersion must be 1.0");
    if (!equalStrings(contract.tools?.map((tool) => tool.name), MCP_TOOL_NAMES)) errors.push("plugin tool list differs from backend MCP tool list/order");
    const advertised = await captureAdvertisedMcpContract();
    if (canonicalContractJson(contract) !== canonicalContractJson(advertised)) {
        errors.push("committed MCP contract differs from an authenticated local tools/list response; regenerate with scripts/mcp-contract.ts --write");
    }

    const evals = await parseJson(resolve(pluginRoot, "evals/evals.json")) as {
        execution?: { liveMcpCallsPerformed?: boolean };
        cases?: Array<{
            id?: string;
            kind?: string;
            prompt?: string;
            expectedCalls?: string[];
            forbiddenCalls?: string[];
            expectedEffects?: string[];
            forbiddenEffects?: string[];
        }>;
    };
    if (evals.execution?.liveMcpCallsPerformed !== false) errors.push("eval manifest must truthfully declare that live MCP calls were not run");
    const cases = evals.cases ?? [];
    if (cases.filter((entry) => entry.kind === "positive").length < 8) errors.push("evals require at least eight positive workflows");
    if (cases.filter((entry) => entry.kind === "negative").length < 9) errors.push("evals require at least nine negative safety workflows");
    if (!equalStrings(cases.map((entry) => entry.id), EVAL_SCENARIO_IDS)) errors.push("eval catalog and executable harness scenario order differ");
    const validTools = new Set<string>(MCP_TOOL_NAMES);
    for (const entry of cases) {
        if (!entry.id || !entry.prompt) errors.push("each eval requires id and prompt");
        for (const name of [...entry.expectedCalls ?? [], ...entry.forbiddenCalls ?? []]) {
            if (!validTools.has(name)) errors.push(`eval ${entry.id ?? "unknown"} references unknown tool ${name}`);
        }
        if (!entry.id) continue;
        try {
            const result = await runEvalScenario(entry.id);
            if (!equalStrings(result.calls.map((call) => call.name), entry.expectedCalls ?? [])) {
                errors.push(`eval ${entry.id} executable call order differs from its catalog contract`);
            }
            for (const name of entry.forbiddenCalls ?? []) {
                if (result.calls.some((call) => call.name === name)) errors.push(`eval ${entry.id} executed forbidden tool ${name}`);
            }
            if (!equalStrings(result.effects, entry.expectedEffects ?? [])) {
                errors.push(`eval ${entry.id} executable side effects differ from its catalog contract`);
            }
            for (const effect of entry.forbiddenEffects ?? []) {
                if (result.effects.includes(effect)) errors.push(`eval ${entry.id} executed forbidden side effect ${effect}`);
            }
        } catch (error) {
            errors.push(`eval ${entry.id} harness failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const marketplace = await parseJson(resolve(repositoryRoot, ".agents/plugins/marketplace.json"));
    const sourceDirectory = resolve(repositoryRoot, "plugins/creditsync");
    const sourceManifest = existsSync(resolve(sourceDirectory, ".codex-plugin/plugin.json"))
        ? await parseJson(resolve(sourceDirectory, ".codex-plugin/plugin.json"))
        : {};
    errors.push(...validateMarketplaceContract(marketplace, existsSync(sourceDirectory), sourceManifest.name));

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
    const app = await parseJson(resolve(pluginRoot, ".app.json")) as { apps?: Record<string, { id?: string }> };
    const registration = classifyPrivateAppId(app.apps?.creditsync?.id);
    console.log(`CreditSync plugin validation passed (3.0.0, 9 skills, 43 tools, no bundled MCP/secrets; private app: ${registration}${registration === "placeholder" ? ", non-live" : ""}).`);
}
