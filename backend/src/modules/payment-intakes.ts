import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import {
    createPaymentIntake,
    finalizePaymentEvidence,
    getPaymentIntake,
    listPaymentIntakePage,
    listPaymentReviewQueue,
    postPayment,
    preparePaymentEvidence,
    previewPaymentMatch,
    reversePayment,
    reviewPaymentIntake,
} from "../services/payment-service";
import { cancelPaymentIntake } from "../services/payment-cancellation-service";
import { executePaymentIdentityDecision, previewPaymentIdentityDecision } from "../services/payment-identity-decision-service";
import { executePaymentEvidenceRecovery, previewPaymentEvidenceRecovery } from "../services/payment-evidence-recovery-service";

type RouteUser = { id: number; tenantId: string };

function commandContext(user: RouteUser, request: Request): CommandContext {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    return {
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorSource: "web",
        requestId,
        correlationId: request.headers.get("x-correlation-id") ?? requestId,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    };
}

function domainFailure(error: unknown, set: { status?: number | string }) {
    const presented = presentDomainError(error);
    set.status = presented.status;
    return presented.body;
}

function unauthorized(set: { status?: number | string }) {
    return domainFailure(new DomainError("UNAUTHORIZED", "Unauthorized", 401), set);
}

const explicitAllocation = t.Object({
    borrowerPublicId: t.String(),
    loanPublicId: t.String(),
    schedulePublicId: t.Optional(t.String()),
    amount: t.String(),
});

export const paymentIntakesRoute = new Elysia({ prefix: "/payment-intakes" })
    .use(authPlugin)
    .get("/review-queue", async ({ user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await listPaymentReviewQueue(commandContext(user, request));
        } catch (error) {
            return domainFailure(error, set);
        }
    })
    .get("/", async ({ query, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await listPaymentIntakePage(commandContext(user, request), query);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { query: t.Object({
        search: t.Optional(t.String()),
        status: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
    }) })
    .post("/", async ({ body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await createPaymentIntake(commandContext(user, request), body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        body: t.Object({
            amount: t.String(),
            receivedAt: t.String(),
            payerName: t.Optional(t.Nullable(t.String())),
            bankReference: t.Optional(t.Nullable(t.String())),
            qrPayload: t.Optional(t.Nullable(t.String())),
            notes: t.Optional(t.Nullable(t.String())),
            originLoanPublicId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
            attachmentRequirement: t.Optional(t.Object({ expectedCount: t.Integer({ minimum: 1, maximum: 20 }) })),
        }),
    })
    .get("/:id", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await getPaymentIntake(commandContext(user, request), params.id);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) })
    .post("/:id/review", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await reviewPaymentIntake(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            status: t.Union([t.Literal("draft"), t.Literal("needs_review")]),
            notes: t.Optional(t.Nullable(t.String())),
        }),
    })
    .post("/:id/cancel", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const headerKey = request.headers.get("idempotency-key");
            if (headerKey && body.idempotencyKey && headerKey.trim() !== body.idempotencyKey.trim()) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key conflicts with request body", 409);
            return await cancelPaymentIntake(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String({ format: "uuid" }) }),
        body: t.Object({ reason: t.String(), idempotencyKey: t.String(), expectedStateHash: t.String() }, { additionalProperties: t.Never() }),
    })
    .post("/:id/evidence/upload-intents", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await preparePaymentEvidence(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            mimeType: t.String(),
            size: t.Number(),
            sha256: t.String(),
            evidenceType: t.Optional(t.Union([t.Literal("slip"), t.Literal("qr")])),
            url: t.Optional(t.String()),
        }),
    })
    .post("/:id/evidence/:evidenceId/finalize", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await finalizePaymentEvidence(commandContext(user, request), params.id, params.evidenceId);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String(), evidenceId: t.String() }) })
    .post("/:id/match-preview", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await previewPaymentMatch(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({ allocations: t.Optional(t.Array(explicitAllocation)) }),
    })
    .post("/:id/identity-decision/preview", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const idempotencyKey = request.headers.get("idempotency-key") ?? body.idempotencyKey;
            return await previewPaymentIdentityDecision(commandContext(user, request), { ...body, participantPaymentIntakePublicIds: [...new Set([params.id, ...body.participantPaymentIntakePublicIds])], idempotencyKey });
        } catch (error) { return domainFailure(error, set); }
    }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ participantPaymentIntakePublicIds: t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 50 }), decision: t.Union([t.Literal("same_payment"), t.Literal("distinct_payment")]), reason: t.String(), idempotencyKey: t.String() }) })
    .post("/:id/identity-decision/execute", async ({ body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try { return await executePaymentIdentityDecision(commandContext(user, request), { ...body, confirmed: true, idempotencyKey: request.headers.get("idempotency-key") ?? body.idempotencyKey }); }
        catch (error) { return domainFailure(error, set); }
    }, { body: t.Object({ identityDecisionPreviewPublicId: t.String({ format: "uuid" }), previewHash: t.String(), confirmed: t.Literal(true), reason: t.String(), idempotencyKey: t.String() }) })
    .post("/:id/evidence-recovery/preview", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try { return await previewPaymentEvidenceRecovery(commandContext(user, request), { ...body, sourcePaymentIntakePublicId: params.id, idempotencyKey: request.headers.get("idempotency-key") ?? body.idempotencyKey }); }
        catch (error) { return domainFailure(error, set); }
    }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ reason: t.String(), expectedCount: t.Integer({ minimum: 1, maximum: 20 }), reuseEvidence: t.Boolean(), requirementDecision: t.Optional(t.Object({ confirmed: t.Literal(true), reason: t.String() })), idempotencyKey: t.String() }) })
    .post("/:id/evidence-recovery/execute", async ({ body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try { return await executePaymentEvidenceRecovery(commandContext(user, request), { ...body, confirmed: true, idempotencyKey: request.headers.get("idempotency-key") ?? body.idempotencyKey }); }
        catch (error) { return domainFailure(error, set); }
    }, { body: t.Object({ recoveryPreviewPublicId: t.String({ format: "uuid" }), previewHash: t.String(), confirmed: t.Literal(true), reason: t.String(), idempotencyKey: t.String() }) })
    .post("/:id/post", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await postPayment(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({ proposalPublicId: t.String() }),
    })
    .post("/:id/reverse", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await reversePayment(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({ reason: t.String() }),
    });
