import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import { createPaymentRestoreDraft, executePaymentReconciliation, previewPaymentRestore, backfillPostedRestoreSchedule } from "../services/payment-reconciliation-service";
import { finalizePaymentRestoreEvidence, preparePaymentRestoreEvidence } from "../services/payment-service";

type RouteUser = { id: number; tenantId: string };
function ctx(user: RouteUser, request: Request): CommandContext { const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID(); return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId, correlationId: request.headers.get("x-correlation-id") ?? requestId, idempotencyKey: request.headers.get("idempotency-key") ?? undefined }; }
function failure(error: unknown, set: { status?: number | string }) { const presented = presentDomainError(error); set.status = presented.status; return presented.body; }
function unauthorized(set: { status?: number | string }) { return failure(new DomainError("UNAUTHORIZED", "Unauthorized", 401), set); }
const id = t.String({ format: "uuid" });
const reasonKey = t.Object({ paymentIntakePublicId: id, reason: t.String(), idempotencyKey: t.String() });

export const paymentRestoresRoute = new Elysia({ prefix: "/payment-restores" }).use(authPlugin)
    .post("/draft", async ({ body, user, request, set }) => { if (!user) return unauthorized(set); try { return await createPaymentRestoreDraft(ctx(user, request), body); } catch (error) { return failure(error, set); } }, { body: reasonKey })
    .post("/evidence/prepare", async ({ body, user, request, set }) => { if (!user) return unauthorized(set); try { return await preparePaymentRestoreEvidence(ctx(user, request), body.restoreDraftPublicId, body); } catch (error) { return failure(error, set); } }, { body: t.Object({ restoreDraftPublicId: id, mimeType: t.String(), size: t.Integer({ minimum: 1 }), sha256: t.String(), evidenceType: t.Optional(t.Union([t.Literal("slip"), t.Literal("qr")])), originalName: t.Optional(t.Nullable(t.String())) }) })
    .post("/evidence/finalize", async ({ body, user, request, set }) => { if (!user) return unauthorized(set); try { return await finalizePaymentRestoreEvidence(ctx(user, request), body.restoreDraftPublicId, body.evidencePublicId); } catch (error) { return failure(error, set); } }, { body: t.Object({ restoreDraftPublicId: id, evidencePublicId: id }) })
    .post("/preview", async ({ body, user, request, set }) => { if (!user) return unauthorized(set); try { return await previewPaymentRestore(ctx(user, request), body); } catch (error) { return failure(error, set); } }, { body: t.Object({ paymentIntakePublicId: id, reason: t.String() }) })
    .post("/execute", async ({ body, user, request, set }) => { if (!user) return unauthorized(set); try { return await executePaymentReconciliation(ctx(user, request), body.previewPublicId, body); } catch (error) { return failure(error, set); } }, { body: t.Object({ previewPublicId: id, previewHash: t.String(), expectedBalanceVersion: t.String(), confirmed: t.Literal(true), reason: t.String(), idempotencyKey: t.String() }) })
    .post("/schedule-backfill", async ({ body, user, request, set }) => { if (!user) return unauthorized(set); try { return await backfillPostedRestoreSchedule(ctx(user, request), body); } catch (error) { return failure(error, set); } }, { body: reasonKey });
