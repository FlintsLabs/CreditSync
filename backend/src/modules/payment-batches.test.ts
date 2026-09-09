import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { paymentBatchesRoute } from "./payment-batches";

test("payment batch routes reject unauthenticated create requests", async () => {
    const app = new Elysia().use(paymentBatchesRoute);
    const response = await app.handle(new Request("http://localhost/payment-batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "batch-1" }) }));
    expect(response.status).toBe(401);
});

test("execute route requires literal confirmation true in its closed schema", async () => {
    const app = new Elysia().use(paymentBatchesRoute);
    const response = await app.handle(new Request("http://localhost/payment-batches/00000000-0000-4000-8000-000000000001/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewPublicId: "00000000-0000-4000-8000-000000000002", previewHash: "x", confirmationHash: "x", confirmed: false, idempotencyKey: "x" }) }));
    expect(response.status).toBe(422);
});
