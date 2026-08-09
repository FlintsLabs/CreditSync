import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");

describe("CreditSync MCP operational safety documentation", () => {
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
