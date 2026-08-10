import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { intermediariesRoute } from "./intermediaries";

describe("intermediary settlement REST contract", () => {
    test("protects manual intermediary workflow endpoints", async () => {
        const app = new Elysia().use(intermediariesRoute);
        for (const path of ["/intermediaries", "/intermediary-collections", "/intermediary-remittances"]) {
            const response = await app.handle(new Request(`http://localhost${path}`));
            expect(response.status).toBe(401);
        }
    });
});
