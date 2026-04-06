import { createClient, type RedisClientType } from "redis";

const cacheUrl = process.env.CACHE_URL;
const defaultTtlSeconds = Number(process.env.CACHE_TTL_SECONDS ?? 30);

let clientPromise: Promise<RedisClientType | null> | null = null;

function cacheEnabled() {
    return Boolean(cacheUrl);
}

async function getCacheClient() {
    if (!cacheEnabled()) {
        return null;
    }

    if (!clientPromise) {
        clientPromise = (async () => {
            try {
                const client = createClient({ url: cacheUrl });
                client.on("error", (error) => {
                    console.error("Cache client error", error);
                });
                await client.connect();
                return client;
            } catch (error) {
                console.error("Failed to connect cache client", error);
                return null;
            }
        })();
    }

    return await clientPromise;
}

async function getTenantVersion(tenantId: string) {
    const client = await getCacheClient();
    if (!client) return "0";

    const versionKey = `tenant-cache-version:${tenantId}`;
    let version = await client.get(versionKey);
    if (!version) {
        version = "1";
        await client.set(versionKey, version);
    }
    return version;
}

export async function withTenantCache<T>(input: {
    tenantId: string;
    namespace: string;
    key: string;
    ttlSeconds?: number;
    loader: () => Promise<T>;
}): Promise<T> {
    const client = await getCacheClient();
    if (!client) {
        return await input.loader();
    }

    try {
        const version = await getTenantVersion(input.tenantId);
        const cacheKey = `${input.namespace}:${input.tenantId}:v${version}:${input.key}`;
        const cached = await client.get(cacheKey);
        if (cached) {
            return JSON.parse(cached) as T;
        }

        const value = await input.loader();
        await client.set(cacheKey, JSON.stringify(value), {
            EX: input.ttlSeconds ?? defaultTtlSeconds,
        });
        return value;
    } catch (error) {
        console.error("Cache read/write failed, falling back to loader", error);
        return await input.loader();
    }
}

export async function invalidateTenantCache(tenantId: string) {
    const client = await getCacheClient();
    if (!client) return;

    try {
        await client.incr(`tenant-cache-version:${tenantId}`);
    } catch (error) {
        console.error("Failed to invalidate tenant cache", error);
    }
}
