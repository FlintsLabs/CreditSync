import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { files, users } from "../db/schema";
import { filesRoute } from "./files";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function tokenFor(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `${unsigned}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url")}`;
}

async function access(app: { handle(request: Request): Response | Promise<Response> }, publicId: string, token: string) {
    const response = await app.handle(new Request(`http://localhost/files/${publicId}/access-url`, { headers: { authorization: `Bearer ${token}` } }));
    return { response, body: await response.json() };
}

describe("file access URLs", () => {
    if (integrationEnabled) beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE files, users RESTART IDENTITY CASCADE`); });

    integrationTest("resolves an authorized file public UUID and rejects another tenant", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-file-owner", email: "file-owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const outsider = await db.insert(users).values({ tenantId: "tenant-file-outsider", email: "file-outsider@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const file = await db.insert(files).values({ tenantId: owner.tenantId, ownerUserId: owner.id, bucket: "test", key: "evidence.png", url: "https://signed.example/evidence" }).returning().then((rows) => rows[0]!);
        const app = new Elysia().use(filesRoute);

        const allowed = await access(app, file.publicId, await tokenFor(owner));
        expect(allowed.response.status).toBe(200);
        expect(allowed.body).toMatchObject({ id: file.id, url: "https://signed.example/evidence" });

        const denied = await access(app, file.publicId, await tokenFor(outsider));
        expect(denied.response.status).toBe(404);
    });
});
