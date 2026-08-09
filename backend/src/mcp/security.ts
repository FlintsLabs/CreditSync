import { createHash, timingSafeEqual } from "node:crypto";

export interface McpRuntimeConfig {
    tokenHashes: string[];
    allowedHosts: string[];
    tenantId: string;
    actorEmail: string;
    rateLimitMax: number;
    rateLimitWindowSeconds: number;
}

const sha256Pattern = /^[0-9a-f]{64}$/i;

function requiredValue(env: Record<string, string | undefined>, name: string) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} must be configured`);
    return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
    return parsed;
}

function normalizeHost(host: string): string | null {
    const value = host.trim().toLocaleLowerCase("en-US");
    if (!value || /[\s/@?#]/u.test(value)) return null;
    if (value.startsWith("[")) {
        const closing = value.indexOf("]");
        if (closing < 0) return null;
        const suffix = value.slice(closing + 1);
        if (suffix && !/^:\d{1,5}$/.test(suffix)) return null;
        return `${value.slice(0, closing + 1).replace(/\.$/, "")}`;
    }
    const withoutPort = /:\d{1,5}$/.test(value) ? value.replace(/:\d{1,5}$/, "") : value;
    if (withoutPort.includes(":")) return null;
    return withoutPort.replace(/\.$/, "");
}

export function parseMcpRuntimeConfig(env: Record<string, string | undefined>): McpRuntimeConfig {
    const tokenHashes = requiredValue(env, "MCP_API_TOKEN_HASHES")
        .split(",")
        .map((value) => value.trim().toLocaleLowerCase("en-US"))
        .filter(Boolean);
    if (tokenHashes.length < 1 || tokenHashes.length > 2) {
        throw new Error("MCP_API_TOKEN_HASHES must contain one or two SHA-256 hashes");
    }
    if (new Set(tokenHashes).size !== tokenHashes.length || tokenHashes.some((value) => !sha256Pattern.test(value))) {
        throw new Error("MCP_API_TOKEN_HASHES must contain unique 64-character hexadecimal SHA-256 hashes");
    }
    const configuredHosts = requiredValue(env, "MCP_ALLOWED_HOSTS")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const normalizedHosts = configuredHosts.map((value) => normalizeHost(value));
    if (normalizedHosts.some((value) => value === null)) {
        throw new Error("MCP_ALLOWED_HOSTS must contain hostnames only, without schemes or paths");
    }
    const allowedHosts = normalizedHosts as string[];
    if (allowedHosts.length === 0) throw new Error("MCP_ALLOWED_HOSTS must contain at least one valid hostname");
    const tenantId = requiredValue(env, "MCP_TENANT_ID");
    const actorEmail = requiredValue(env, "MCP_ACTOR_EMAIL").toLocaleLowerCase("en-US");
    if (tenantId.length > 128) throw new Error("MCP_TENANT_ID is too long");
    if (actorEmail.length > 320 || !actorEmail.includes("@")) throw new Error("MCP_ACTOR_EMAIL must be a valid email address");
    return {
        tokenHashes,
        allowedHosts: [...new Set(allowedHosts)],
        tenantId,
        actorEmail,
        rateLimitMax: positiveInteger(env.MCP_RATE_LIMIT_MAX, 60, "MCP_RATE_LIMIT_MAX"),
        rateLimitWindowSeconds: positiveInteger(env.MCP_RATE_LIMIT_WINDOW_SECONDS, 60, "MCP_RATE_LIMIT_WINDOW_SECONDS"),
    };
}

export function authenticateBearer(authorization: string | null, tokenHashes: string[]) {
    const match = authorization?.trim().match(/^Bearer ([^\s]+)$/i);
    if (!match || match[1]!.length > 4096) return null;
    const digest = createHash("sha256").update(match[1]!).digest();
    let matched = 0;
    for (const configured of tokenHashes) {
        const candidate = Buffer.from(configured, "hex");
        matched |= candidate.length === digest.length && timingSafeEqual(digest, candidate) ? 1 : 0;
    }
    if (matched !== 1) return null;
    return { tokenFingerprint: digest.toString("hex").slice(0, 16) };
}

export function hostIsAllowed(host: string | null, allowedHosts: string[]) {
    if (!host) return false;
    const normalized = normalizeHost(host);
    return normalized !== null && allowedHosts.includes(normalized);
}
