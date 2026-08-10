import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import {
    createIntermediary, createIntermediaryCollection, createIntermediaryRemittance,
    getIntermediaryCollection, getIntermediaryRemittance, listIntermediaries,
    listIntermediaryCollections, listIntermediaryRemittances, manualApproveIntermediaryCollection,
    postIntermediaryRemittance, previewIntermediaryRemittance, reverseIntermediaryRemittance,
    saveRemittanceAllocations, searchIntermediaries, updateIntermediary,
} from "../services/intermediary-service";

type RouteUser = { id: number; tenantId: string };
const context = (user: RouteUser, request: Request): CommandContext => {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId, correlationId: request.headers.get("x-correlation-id") ?? requestId, idempotencyKey: request.headers.get("idempotency-key") ?? undefined };
};
const failure = (error: unknown, set: { status?: number | string }) => { const result = presentDomainError(error); set.status = result.status; return result.body; };
const unauthorized = (set: { status?: number | string }) => failure(new DomainError("UNAUTHORIZED", "Unauthorized", 401), set);
const invoke = async <T>(user: RouteUser | null, request: Request, set: { status?: number | string }, command: (ctx: CommandContext) => Promise<T>) => {
    if (!user) return unauthorized(set);
    try { return await command(context(user, request)); } catch (error) { return failure(error, set); }
};

const uuidParam = { params: t.Object({ id: t.String({ format: "uuid" }) }) };

export const intermediariesRoute = new Elysia()
    .use(authPlugin)
    .get("/intermediaries", ({ query, user, request, set }) => invoke(user, request, set, (ctx) => query.q ? searchIntermediaries(ctx, query.q) : listIntermediaries(ctx, query.status)), { query: t.Object({ q: t.Optional(t.String()), status: t.Optional(t.Union([t.Literal("active"), t.Literal("inactive"), t.Literal("all")])) }) })
    .post("/intermediaries", ({ body, user, request, set }) => invoke(user, request, set, (ctx) => createIntermediary(ctx, body)), { body: t.Object({ name: t.String(), aliases: t.Optional(t.Array(t.String())), notes: t.Optional(t.Nullable(t.String())) }) })
    .patch("/intermediaries/:id", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => updateIntermediary(ctx, params.id, body)), { ...uuidParam, body: t.Object({ name: t.Optional(t.String()), aliases: t.Optional(t.Array(t.String())), notes: t.Optional(t.Nullable(t.String())), status: t.Optional(t.Union([t.Literal("active"), t.Literal("inactive")])) }) })
    .get("/intermediary-collections", ({ query, user, request, set }) => invoke(user, request, set, (ctx) => listIntermediaryCollections(ctx, query)), { query: t.Object({ intermediaryPublicId: t.Optional(t.String({ format: "uuid" })), status: t.Optional(t.String()) }) })
    .post("/intermediary-collections", ({ body, user, request, set }) => invoke(user, request, set, (ctx) => createIntermediaryCollection(ctx, body)), { body: t.Object({ intermediaryPublicId: t.String({ format: "uuid" }), borrowerPublicId: t.String({ format: "uuid" }), loanPublicId: t.String({ format: "uuid" }), amount: t.String(), borrowerPaidAt: t.String(), bankReference: t.Optional(t.Nullable(t.String())), note: t.Optional(t.Nullable(t.String())) }) })
    .get("/intermediary-collections/:id", ({ params, user, request, set }) => invoke(user, request, set, (ctx) => getIntermediaryCollection(ctx, params.id)), uuidParam)
    .post("/intermediary-collections/:id/manual-approve", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => manualApproveIntermediaryCollection(ctx, params.id, body)), { ...uuidParam, body: t.Object({ reason: t.String(), confirmed: t.Literal(true) }) })
    .get("/intermediary-remittances", ({ query, user, request, set }) => invoke(user, request, set, (ctx) => listIntermediaryRemittances(ctx, query)), { query: t.Object({ intermediaryPublicId: t.Optional(t.String({ format: "uuid" })), status: t.Optional(t.String()) }) })
    .post("/intermediary-remittances", ({ body, user, request, set }) => invoke(user, request, set, (ctx) => createIntermediaryRemittance(ctx, body)), { body: t.Object({ intermediaryPublicId: t.String({ format: "uuid" }), grossAmount: t.String(), receivedAt: t.String(), bankReference: t.Optional(t.Nullable(t.String())), destinationHint: t.Optional(t.Nullable(t.String())), note: t.Optional(t.Nullable(t.String())) }) })
    .get("/intermediary-remittances/:id", ({ params, user, request, set }) => invoke(user, request, set, (ctx) => getIntermediaryRemittance(ctx, params.id)), uuidParam)
    .put("/intermediary-remittances/:id/allocations", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => saveRemittanceAllocations(ctx, params.id, body)), { ...uuidParam, body: t.Object({ collectionPublicIds: t.Array(t.String({ format: "uuid" })) }) })
    .post("/intermediary-remittances/:id/preview", ({ params, user, request, set }) => invoke(user, request, set, (ctx) => previewIntermediaryRemittance(ctx, params.id)), uuidParam)
    .post("/intermediary-remittances/:id/post", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => postIntermediaryRemittance(ctx, params.id, body)), { ...uuidParam, body: t.Object({ proposalPublicId: t.String({ format: "uuid" }), confirmed: t.Literal(true) }) })
    .post("/intermediary-remittances/:id/reverse", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => reverseIntermediaryRemittance(ctx, params.id, body)), { ...uuidParam, body: t.Object({ reason: t.String() }) });
