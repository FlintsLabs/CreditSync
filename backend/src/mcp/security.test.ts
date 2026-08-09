import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    authenticateBearer,
    hostIsAllowed,
    parseMcpRuntimeConfig,
} from "./security";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

describe("MCP edge security", () => {
    test("accepts either configured token hash during rotation and rejects every other bearer", () => {
        const config = parseMcpRuntimeConfig({
            MCP_API_TOKEN_HASHES: `${digest("old-secret")},${digest("new-secret")}`,
            MCP_ALLOWED_HOSTS: "mcp.example.test,127.0.0.1",
            MCP_TENANT_ID: "tenant-a",
            MCP_ACTOR_EMAIL: "agent@example.test",
        });

        expect(authenticateBearer("Bearer old-secret", config.tokenHashes)?.tokenFingerprint).toHaveLength(16);
        expect(authenticateBearer("Bearer new-secret", config.tokenHashes)?.tokenFingerprint).toHaveLength(16);
        expect(authenticateBearer("Bearer wrong-secret", config.tokenHashes)).toBeNull();
        expect(authenticateBearer("Basic old-secret", config.tokenHashes)).toBeNull();
    });

    test("rejects malformed or over-rotated token hash configuration", () => {
        const base = {
            MCP_ALLOWED_HOSTS: "mcp.example.test",
            MCP_TENANT_ID: "tenant-a",
            MCP_ACTOR_EMAIL: "agent@example.test",
        };

        expect(() => parseMcpRuntimeConfig({ ...base, MCP_API_TOKEN_HASHES: "not-a-hash" })).toThrow("MCP_API_TOKEN_HASHES");
        expect(() => parseMcpRuntimeConfig({
            ...base,
            MCP_API_TOKEN_HASHES: [digest("one"), digest("two"), digest("three")].join(","),
        })).toThrow("one or two");
        expect(() => parseMcpRuntimeConfig({
            ...base,
            MCP_API_TOKEN_HASHES: digest("one"),
            MCP_ALLOWED_HOSTS: "mcp.example.test,https://typo.example.test",
        })).toThrow("MCP_ALLOWED_HOSTS");
    });

    test("matches allowed hosts exactly after safe hostname normalization", () => {
        const allowed = ["mcp.example.test", "127.0.0.1", "[::1]"];

        expect(hostIsAllowed("mcp.example.test", allowed)).toBe(true);
        expect(hostIsAllowed("mcp.example.test:443", allowed)).toBe(true);
        expect(hostIsAllowed("127.0.0.1:32123", allowed)).toBe(true);
        expect(hostIsAllowed("[::1]:3000", allowed)).toBe(true);
        expect(hostIsAllowed("evil-mcp.example.test", allowed)).toBe(false);
        expect(hostIsAllowed("mcp.example.test.evil", allowed)).toBe(false);
        expect(hostIsAllowed(null, allowed)).toBe(false);
    });
});
