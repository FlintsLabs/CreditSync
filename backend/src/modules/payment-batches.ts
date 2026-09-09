import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import { addPaymentBatchItem, cancelPaymentBatch, createPaymentBatch, executePaymentBatch, getPaymentBatch, previewPaymentBatch } from "../services/payment-batch-service";

type RouteUser = { id: number; tenantId: string };
function ctx(user: RouteUser, request: Request): CommandContext { const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID(); return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId, correlationId: request.headers.get("x-correlation-id") ?? requestId, idempotencyKey: request.headers.get("idempotency-key") ?? undefined }; }
function failure(error: unknown, set: { status?: number | string }) { const presented = presentDomainError(error); set.status = presented.status; return presented.body; }
function unauthorized(set: { status?: number | string }) { return failure(new DomainError("UNAUTHORIZED", "Unauthorized", 401), set); }
const id = t.String({ format: "uuid" });
const allocation = t.Object({ itemPublicId: id, borrowerPublicId: t.Optional(id), loanPublicId: id, schedulePublicId: id, amount: t.String(), targetDueDate: t.String(), intent: t.Union([t.Literal("on_time"), t.Literal("advance"), t.Literal("backdated")]) });

export const paymentBatchesRoute = new Elysia({ prefix: "/payment-batches" }).use(authPlugin)
    .post("/", async ({ body, user, request, set }) => { if (!user) return unauthorized(set); try { return await createPaymentBatch(ctx(user, request), body); } catch (error) { return failure(error, set); } }, { body: t.Object({ idempotencyKey: t.String(), borrowerPublicId: t.Optional(t.Nullable(id)), notes: t.Optional(t.Nullable(t.String())) }) })
    .get("/:id", async ({ params, user, request, set }) => { if (!user) return unauthorized(set); try { return await getPaymentBatch(ctx(user, request), params.id); } catch (error) { return failure(error, set); } }, { params: t.Object({ id }) })
    .post("/:id/items", async ({ params, body, user, request, set }) => { if (!user) return unauthorized(set); try { return await addPaymentBatchItem(ctx(user, request), params.id, body); } catch (error) { return failure(error, set); } }, { params: t.Object({ id }), body: t.Object({ paymentIntakePublicId: id, itemOrder: t.Integer({ minimum: 1 }) }) })
    .post("/:id/preview", async ({ params, body, user, request, set }) => { if (!user) return unauthorized(set); try { return await previewPaymentBatch(ctx(user, request), params.id, body); } catch (error) { return failure(error, set); } }, { params: t.Object({ id }), body: t.Object({ borrowerPublicId: id, allocations: t.Optional(t.Array(allocation, { maxItems: 200 })) }) })
    .post("/:id/execute", async ({ params, body, user, request, set }) => { if (!user) return unauthorized(set); try { return await executePaymentBatch(ctx(user, request), params.id, body); } catch (error) { return failure(error, set); } }, { params: t.Object({ id }), body: t.Object({ previewPublicId: id, previewHash: t.String(), confirmationHash: t.String(), confirmed: t.Literal(true), idempotencyKey: t.String() }) });

export const paymentBatchCancelRoute = new Elysia({ prefix: "/payment-batches" }).use(authPlugin)
    .post("/:id/cancel", async ({ params, user, request, set }) => { if (!user) return unauthorized(set); try { return await cancelPaymentBatch(ctx(user, request), params.id); } catch (error) { return failure(error, set); } }, { params: t.Object({ id }) });
