import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");

describe("CreditSync MCP operational safety documentation", () => {
    test("conditional payment-slip evidence is a hard prerequisite while data-only remains supported", async () => {
        const paymentSkill = await readFile(resolve(repositoryRoot, "plugins/creditsync/skills/reconcile-payments/SKILL.md"), "utf8");
        const rootSkill = await readFile(resolve(repositoryRoot, "plugins/creditsync/skills/creditsync/SKILL.md"), "utf8");
        const pluginReadme = await readFile(resolve(repositoryRoot, "plugins/creditsync/README.md"), "utf8");
        expect(paymentSkill).toContain("supplied image");
        expect(paymentSkill).toContain("before `payment.preview` or `payment.post`");
        expect(paymentSkill).toContain("data-only");
        expect(paymentSkill).toContain("stop");
        expect(paymentSkill).toContain("signed URL");
        expect(paymentSkill).toContain("evidence is `ready`");
        expect(paymentSkill).toContain("SHA-256");
        expect(rootSkill).toContain("supplied payment-slip image");
        expect(rootSkill).toContain("before `payment.preview` or `payment.post`");
        expect(rootSkill).toContain("data-only");
        expect(rootSkill).toContain("stop");
        expect(pluginReadme).toContain("supplied image");
        expect(pluginReadme).toContain("before `payment.preview` or `payment.post`");
        expect(pluginReadme).toContain("data-only");
    });

    test("Git marketplace installation and updates are documented consistently", async () => {
        const rootReadme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");
        const pluginReadme = await readFile(resolve(repositoryRoot, "plugins/creditsync/README.md"), "utf8");
        for (const readme of [rootReadme, pluginReadme]) {
            expect(readme).toContain("codex plugin marketplace add FlintsLabs/CreditSync --ref main");
            expect(readme).toContain("codex plugin add creditsync@creditsync-marketplace");
            expect(readme).toContain("codex plugin marketplace upgrade creditsync-marketplace");
        }
        expect(pluginReadme).toContain("does not hot-reload");
        expect(pluginReadme).toContain("Start a new Codex task after reinstalling");
        expect(pluginReadme).not.toContain("creditsync@personal");
        expect(pluginReadme).not.toContain("/absolute/path/to/CreditSync");
    });

    test("documented token generation hashes exact bytes without a trailing newline", async () => {
        const operations = await readFile(resolve(repositoryRoot, "docs/operations/agent-mcp-plugin.md"), "utf8");
        expect(operations).toContain("openssl rand -hex 32 | tr -d '\\n'");
        expect(operations).toContain("wc -c");
        expect(operations).not.toContain("openssl rand -hex 32 > /secure");

        const process = Bun.spawn(["sh", "-c", "openssl rand -hex 32 | tr -d '\\n'"], { stdout: "pipe", stderr: "pipe" });
        const bytes = new Uint8Array(await new Response(process.stdout).arrayBuffer());
        expect(await process.exited).toBe(0);
        expect(bytes.byteLength).toBe(64);
        expect(bytes.at(-1)).not.toBe(10);
        const exactDigest = createHash("sha256").update(bytes).digest("hex");
        const newlineDigest = createHash("sha256").update(bytes).update("\n").digest("hex");
        expect(exactDigest).toHaveLength(64);
        expect(exactDigest).not.toBe(newlineDigest);
    });

    test("MinIO recovery preserves and verifies evidence metadata and checksums", async () => {
        const recovery = await readFile(resolve(repositoryRoot, "docs/operations/backup-recovery.md"), "utf8");
        expect(recovery).toContain("quiesced storage-level snapshot");
        expect(recovery).toContain("stop tunnel minio");
        expect(recovery).toContain("tenant");
        expect(recovery).toContain("intake");
        expect(recovery).toContain("payment_evidence.sha256");
        expect(recovery).not.toContain("mc mirror --preserve creditsync-source");
        expect(recovery).not.toContain("mc alias set creditsync-source");
    });

    test("MCP kill switch preserves REST backend availability", async () => {
        const operations = await readFile(resolve(repositoryRoot, "docs/operations/agent-mcp-plugin.md"), "utf8");
        expect(operations).toContain("leaving web/REST routes available");
        expect(operations).toContain("valid token whose raw value is not distributed");
        expect(operations).toContain("Never leave `MCP_API_TOKEN_HASHES` empty");
        expect(operations).not.toContain("remove both MCP token hashes");
    });
});
