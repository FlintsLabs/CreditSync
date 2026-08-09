import { createHash } from "node:crypto";
import { createClient } from "redis";

export interface McpRateLimitInput {
    key: string;
    max: number;
    windowSeconds: number;
}

export interface McpRateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
}

export interface CreateMcpRateLimiterInput {
    cacheUrl?: string;
    now?: () => number;
    redisConsume?: (input: McpRateLimitInput) => Promise<{ count: number; ttlSeconds: number }>;
    onWarning?: (code: string) => void;
}

const counterScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

function dragonflyConsumer(cacheUrl: string) {
    type RateRedisClient = {
        connect(): Promise<unknown>;
        destroy(): void;
        on(event: "error", listener: () => void): unknown;
        eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
    };
    let clientPromise: Promise<RateRedisClient> | undefined;
    let activeClient: RateRedisClient | undefined;

    async function bounded<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Dragonfly rate-limit operation timed out")), timeoutMs);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function client(): Promise<RateRedisClient> {
        if (!clientPromise) {
            const next = createClient({
                url: cacheUrl,
                socket: { connectTimeout: 300, reconnectStrategy: false },
            }) as RateRedisClient;
            activeClient = next;
            next.on("error", () => undefined);
            clientPromise = (async () => {
                await bounded(next.connect());
                return next;
            })();
        }
        const pending = clientPromise;
        try {
            return await pending;
        } catch (error) {
            activeClient?.destroy();
            activeClient = undefined;
            clientPromise = undefined;
            throw error;
        }
    }
    return async (input: McpRateLimitInput) => {
        const key = `mcp-rate:${createHash("sha256").update(input.key).digest("hex")}`;
        let raw: unknown;
        try {
            const connected = await client();
            raw = await bounded(connected.eval(counterScript, {
                keys: [key],
                arguments: [String(input.windowSeconds)],
            }));
        } catch (error) {
            activeClient?.destroy();
            activeClient = undefined;
            clientPromise = undefined;
            throw error;
        }
        if (!Array.isArray(raw) || raw.length !== 2) throw new Error("Invalid Dragonfly rate-limit response");
        const count = Number(raw[0]);
        const ttlSeconds = Math.max(1, Number(raw[1]));
        if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(ttlSeconds)) {
            throw new Error("Invalid Dragonfly rate-limit counter");
        }
        return { count, ttlSeconds };
    };
}

export function createMcpRateLimiter(input: CreateMcpRateLimiterInput = {}) {
    const now = input.now ?? Date.now;
    const redisConsume = input.redisConsume ?? (input.cacheUrl ? dragonflyConsumer(input.cacheUrl) : undefined);
    const memory = new Map<string, { count: number; expiresAt: number }>();
    let warned = false;

    function consumeMemory(request: McpRateLimitInput): McpRateLimitResult {
        const key = createHash("sha256").update(request.key).digest("hex");
        const currentTime = now();
        let bucket = memory.get(key);
        if (!bucket || bucket.expiresAt <= currentTime) {
            bucket = { count: 0, expiresAt: currentTime + request.windowSeconds * 1_000 };
        }
        bucket.count += 1;
        memory.set(key, bucket);
        const allowed = bucket.count <= request.max;
        return {
            allowed,
            remaining: Math.max(0, request.max - bucket.count),
            retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.expiresAt - currentTime) / 1_000)),
        };
    }

    return {
        consume: async (request: McpRateLimitInput): Promise<McpRateLimitResult> => {
            if (!redisConsume) return consumeMemory(request);
            try {
                const result = await redisConsume(request);
                const allowed = result.count <= request.max;
                return {
                    allowed,
                    remaining: Math.max(0, request.max - result.count),
                    retryAfterSeconds: allowed ? 0 : result.ttlSeconds,
                };
            } catch {
                if (!warned) {
                    warned = true;
                    input.onWarning?.("MCP_RATE_LIMIT_CACHE_UNAVAILABLE");
                }
                return consumeMemory(request);
            }
        },
    };
}
