import { describe, expect, test } from "bun:test";
import { createMcpRateLimiter } from "./rate-limit";

describe("MCP rate limiter", () => {
    test("enforces the configured window in memory", async () => {
        let now = 1_000;
        const limiter = createMcpRateLimiter({ now: () => now });
        const input = { key: "tenant-a:token-fingerprint", max: 2, windowSeconds: 10 };

        expect(await limiter.consume(input)).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
        expect(await limiter.consume(input)).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
        expect(await limiter.consume(input)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 10 });
        now = 11_001;
        expect(await limiter.consume(input)).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    });

    test("falls back to the safe in-memory limiter when Dragonfly fails", async () => {
        const warnings: string[] = [];
        const limiter = createMcpRateLimiter({
            redisConsume: async () => {
                throw new Error("redis://user:secret@cache.internal:6379");
            },
            onWarning: (code) => warnings.push(code),
        });
        const input = { key: "tenant-a:token-fingerprint", max: 1, windowSeconds: 60 };

        expect((await limiter.consume(input)).allowed).toBe(true);
        expect(await limiter.consume(input)).toMatchObject({ allowed: false, remaining: 0 });
        expect(warnings).toEqual(["MCP_RATE_LIMIT_CACHE_UNAVAILABLE"]);
        expect(JSON.stringify(warnings)).not.toContain("secret");
    });

    test("uses the Dragonfly result when the atomic counter is available", async () => {
        const limiter = createMcpRateLimiter({
            redisConsume: async () => ({ count: 3, ttlSeconds: 17 }),
        });

        expect(await limiter.consume({ key: "tenant-a:token", max: 3, windowSeconds: 60 })).toEqual({
            allowed: true,
            remaining: 0,
            retryAfterSeconds: 0,
        });
        expect(await limiter.consume({ key: "tenant-a:token", max: 2, windowSeconds: 60 })).toEqual({
            allowed: false,
            remaining: 0,
            retryAfterSeconds: 17,
        });
    });

    // Break caught: a cache outage after distributed requests restarts the local allowance at zero.
    test("preserves requests already observed when Dragonfly fails mid-window", async () => {
        let calls = 0;
        const limiter = createMcpRateLimiter({
            now: () => 1_000,
            redisConsume: async () => {
                calls += 1;
                if (calls <= 2) return { count: calls, ttlSeconds: 45 };
                throw new Error("Dragonfly unavailable");
            },
        });
        const input = { key: "tenant-a:transition-token", max: 2, windowSeconds: 60 };

        expect(await limiter.consume(input)).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
        expect(await limiter.consume(input)).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
        expect(await limiter.consume(input)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    });

    test("bounds a real unavailable Dragonfly connection and immediately falls back", async () => {
        const warnings: string[] = [];
        const limiter = createMcpRateLimiter({
            cacheUrl: "redis://127.0.0.1:1",
            onWarning: (code) => warnings.push(code),
        });
        const startedAt = performance.now();

        const result = await limiter.consume({ key: "tenant-a:token", max: 1, windowSeconds: 60 });

        expect(result.allowed).toBe(true);
        expect(performance.now() - startedAt).toBeLessThan(1_500);
        expect(warnings).toEqual(["MCP_RATE_LIMIT_CACHE_UNAVAILABLE"]);
    }, 2_000);
});
