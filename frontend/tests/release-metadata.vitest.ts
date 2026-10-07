import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_VERSION, CHANGELOG_URL, MCP_SCHEMA_VERSION, PLUGIN_VERSION } from "../src/lib/release";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const changelog = readFileSync(resolve(repositoryRoot, "CHANGELOG.md"), "utf8");
const pluginManifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "plugins/creditsync/.codex-plugin/plugin.json"), "utf8"),
) as { version: string };

describe("release metadata", () => {
    test("matches the newest changelog release and actual plugin manifest", () => {
        const newestChangelogVersion = changelog.match(/^## v(\d+\.\d+\.\d+) - /m)?.[1];
        expect(APPLICATION_VERSION).toBe(newestChangelogVersion);
        expect(MCP_SCHEMA_VERSION).toBe("1.0");
        expect(PLUGIN_VERSION).toBe(pluginManifest.version);
        expect(CHANGELOG_URL).toBe("https://github.com/FlintsLabs/CreditSync/blob/main/CHANGELOG.md");
    });
});
