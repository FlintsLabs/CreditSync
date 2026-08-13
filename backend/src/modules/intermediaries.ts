import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import {
    createIntermediary, createIntermediaryCollection, createIntermediaryRemittance,
    finalizeIntermediaryRemittanceEvidence, getIntermediaryCollection, getIntermediaryRemittance, listIntermediaries,
    listIntermediaryCollections, listIntermediaryRemittances, manualApproveIntermediaryCollection,
    postIntermediaryRemittance, prepareIntermediaryRemittanceEvidence, previewIntermediaryRemittance, reverseIntermediaryRemittance,
    saveRemittanceAllocations, searchIntermediaries, updateIntermediary,
} from "../services/intermediary-service";
import {
    assignIntermediaryToLoan,
    endIntermediaryAssignment,
    getIntermediaryProfile,
    listManagedLoans,
    saveIntermediaryBankAccount,
} from "../services/intermediary-profile-service";

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

const intermediaryProfileRoutes = new Elysia({ normalize: false })
    .use(authPlugin)
    .get("/intermediaries/:id", ({ params, user, request, set }) => invoke(user, request, set, (ctx) => getIntermediaryProfile(ctx, params.id)), uuidParam)
    .put("/intermediaries/:id/bank-accounts", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => saveIntermediaryBankAccount(ctx, params.id, body)), {
        ...uuidParam,
        body: t.Object({
            bankCode: t.Optional(t.Nullable(t.String({ maxLength: 50 }))),
            bankName: t.String({ minLength: 1, maxLength: 200 }),
            accountName: t.String({ minLength: 1, maxLength: 200 }),
            accountNumber: t.String({ minLength: 4, maxLength: 64 }),
            note: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        }, { additionalProperties: t.Never() }),
    })
    .get("/intermediaries/:id/managed-loans", ({ params, query, user, request, set }) => invoke(user, request, set, (ctx) => listManagedLoans(ctx, params.id, query)), {
        ...uuidParam,
        query: t.Object({ role: t.Optional(t.Union([t.Literal("disbursement"), t.Literal("collection"), t.Literal("all")])) }, { additionalProperties: t.Never() }),
    })
    .post("/loans/:id/intermediary-assignments", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => assignIntermediaryToLoan(ctx, params.id, body)), {
        ...uuidParam,
        body: t.Object({
            intermediaryPublicId: t.String({ format: "uuid" }),
            role: t.Union([t.Literal("disbursement"), t.Literal("collection"), t.Literal("both")]),
            effectiveFrom: t.String({ format: "date-time" }),
            note: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        }, { additionalProperties: t.Never() }),
    })
    .post("/intermediary-assignments/:id/end", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => endIntermediaryAssignment(ctx, params.id, body)), {
        ...uuidParam,
        body: t.Object({
            effectiveTo: t.String({ format: "date-time" }),
            reason: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        }, { additionalProperties: t.Never() }),
    });

export const intermediariesRoute = new Elysia()
    .use(authPlugin)
    .get("/intermediaries", ({ query, user, request, set }) => invoke(user, request, set, (ctx) => query.q ? searchIntermediaries(ctx, query.q) : listIntermediaries(ctx, query.status)), { query: t.Object({ q: t.Optional(t.String()), status: t.Optional(t.Union([t.Literal("active"), t.Literal("inactive"), t.Literal("all")])) }) })
    .post("/intermediaries", ({ body, user, request, set }) => invoke(user, request, set, (ctx) => createIntermediary(ctx, body)), { body: t.Object({ name: t.String(), aliases: t.Optional(t.Array(t.String())), notes: t.Optional(t.Nullable(t.String())) }) })
    .patch("/intermediaries/:id", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => updateIntermediary(ctx, params.id, body)), { ...uuidParam, body: t.Object({ name: t.Optional(t.String()), aliases: t.Optional(t.Array(t.String())), notes: t.Optional(t.Nullable(t.String())), status: t.Optional(t.Union([t.Literal("active"), t.Literal("inactive")])) }) })
    .get("/intermediary-collections", ({ query, user, request, set }) => invoke(user, request, set, (ctx) => listIntermediaryCollections(ctx, query)), { query: t.Object({ intermediaryPublicId: t.Optional(t.String({ format: "uuid" })), status: t.Optional(t.String()) }) })
    .post("/intermediary-collections", ({ body, user, request, set }) => invoke(user, request, set, (ctx) => createIntermediaryCollection(ctx, body)), { body: t.Object({ intermediaryPublicId: t.String({ format: "uuid" }), borrowerPublicId: t.String({ format: "uuid" }), loanPublicId: t.String({ format: "uuid" }), amount: t.String(), borrowerPaidAt: t.String(), bankReference: t.Optional(t.Nullable(t.String())), note: t.Optional(t.Nullable(t.String())), paymentIntakePublicId: t.Optional(t.Nullable(t.String({ format: "uuid" }))) }) })
    .get("/intermediary-collections/:id", ({ params, user, request, set }) => invoke(user, request, set, (ctx) => getIntermediaryCollection(ctx, params.id)), uuidParam)
    .post("/intermediary-collections/:id/manual-approve", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => manualApproveIntermediaryCollection(ctx, params.id, body)), { ...uuidParam, body: t.Object({ reason: t.String(), confirmed: t.Literal(true) }) })
    .get("/intermediary-remittances", ({ query, user, request, set }) => invoke(user, request, set, (ctx) => listIntermediaryRemittances(ctx, query)), { query: t.Object({ intermediaryPublicId: t.Optional(t.String({ format: "uuid" })), status: t.Optional(t.String()) }) })
    .post("/intermediary-remittances", ({ body, user, request, set }) => invoke(user, request, set, (ctx) => createIntermediaryRemittance(ctx, body)), { body: t.Object({ intermediaryPublicId: t.String({ format: "uuid" }), grossAmount: t.String(), receivedAt: t.String(), bankReference: t.Optional(t.Nullable(t.String())), destinationHint: t.Optional(t.Nullable(t.String())), note: t.Optional(t.Nullable(t.String())) }) })
    .get("/intermediary-remittances/:id", ({ params, user, request, set }) => invoke(user, request, set, (ctx) => getIntermediaryRemittance(ctx, params.id)), uuidParam)
    .post("/intermediary-remittances/:id/evidence/prepare", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => prepareIntermediaryRemittanceEvidence(ctx, params.id, body)), { ...uuidParam, body: t.Object({ mimeType: t.Union([t.Literal("image/jpeg"), t.Literal("image/png"), t.Literal("application/pdf")]), size: t.Integer({ minimum: 1 }), sha256: t.String({ pattern: "^[0-9a-fA-F]{64}$" }), originalName: t.Optional(t.Nullable(t.String({ maxLength: 500 }))) }) })
    .post("/intermediary-remittances/:id/evidence/:evidenceId/finalize", ({ params, user, request, set }) => invoke(user, request, set, (ctx) => finalizeIntermediaryRemittanceEvidence(ctx, params.id, params.evidenceId)), { params: t.Object({ id: t.String({ format: "uuid" }), evidenceId: t.String({ format: "uuid" }) }) })
    .put("/intermediary-remittances/:id/allocations", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => saveRemittanceAllocations(ctx, params.id, body)), { ...uuidParam, body: t.Object({ collectionPublicIds: t.Array(t.String({ format: "uuid" })) }) })
    .post("/intermediary-remittances/:id/preview", ({ params, user, request, set }) => invoke(user, request, set, (ctx) => previewIntermediaryRemittance(ctx, params.id)), uuidParam)
    .post("/intermediary-remittances/:id/post", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => postIntermediaryRemittance(ctx, params.id, body)), { ...uuidParam, body: t.Object({ proposalPublicId: t.String({ format: "uuid" }), confirmed: t.Literal(true) }) })
    .post("/intermediary-remittances/:id/reverse", ({ params, body, user, request, set }) => invoke(user, request, set, (ctx) => reverseIntermediaryRemittance(ctx, params.id, body)), { ...uuidParam, body: t.Object({ reason: t.String() }) })
    .use(intermediaryProfileRoutes);
