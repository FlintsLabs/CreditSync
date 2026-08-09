import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import { extractTextFromImage } from "../lib/ocr";
import { resolveStoredFileUrl } from "../lib/storage";
import {
    addBorrowerAlias,
    confirmBorrowerAlias,
    createBorrower,
    deactivateBorrowerAlias,
    getBorrowerPortfolio,
    searchBorrowers,
    updateBorrower,
} from "../services/borrower-service";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";

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

async function withBorrowerMedia<T extends { photoUrl?: string | null; idCardImageUrl?: string | null }>(borrower: T) {
    return {
        ...borrower,
        photoRef: borrower.photoUrl ?? null,
        photoUrl: await resolveStoredFileUrl(borrower.photoUrl),
        idCardImageRef: borrower.idCardImageUrl ?? null,
        idCardImageUrl: await resolveStoredFileUrl(borrower.idCardImageUrl),
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

const borrowerBody = t.Object({
    name: t.String(),
    idCardNumber: t.Optional(t.Nullable(t.String())),
    phone: t.Optional(t.Nullable(t.String())),
    address: t.Optional(t.Nullable(t.String())),
    creditScore: t.Optional(t.Nullable(t.Number())),
    notes: t.Optional(t.Nullable(t.String())),
    idCardImageUrl: t.Optional(t.Nullable(t.String())),
    tags: t.Optional(t.Nullable(t.Array(t.String()))),
    googleMapsUrl: t.Optional(t.Nullable(t.String())),
});

const borrowerUpdateBody = t.Object({
    name: t.Optional(t.String()),
    idCardNumber: t.Optional(t.Nullable(t.String())),
    phone: t.Optional(t.Nullable(t.String())),
    address: t.Optional(t.Nullable(t.String())),
    creditScore: t.Optional(t.Nullable(t.Number())),
    notes: t.Optional(t.Nullable(t.String())),
    idCardImageUrl: t.Optional(t.Nullable(t.String())),
    tags: t.Optional(t.Nullable(t.Array(t.String()))),
    googleMapsUrl: t.Optional(t.Nullable(t.String())),
});

export const borrowersRoute = new Elysia({ prefix: "/borrowers" })
    .use(authPlugin)
    .post("/extract-id-card", async ({ body, set }) => {
        if (!body.file) {
            set.status = 400;
            return { error: "No file uploaded", code: "FILE_REQUIRED" };
        }
        try {
            const text = await extractTextFromImage(Buffer.from(await body.file.arrayBuffer()));
            const idMatch = text.match(/\d{1}\s?\d{4}\s?\d{5}\s?\d{2}\s?\d{1}/) || text.match(/\d{13}/);
            return { text, idCardNumber: idMatch ? idMatch[0].replace(/\s/g, "") : null };
        } catch {
            set.status = 500;
            return { error: "OCR Failed", code: "OCR_FAILED" };
        }
    }, { body: t.Object({ file: t.File() }) })
    .get("/search", async ({ query, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const result = await searchBorrowers(commandContext(user, request), { query: query.q ?? "" });
            return { ...result, candidates: await Promise.all(result.candidates.map(withBorrowerMedia)) };
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { query: t.Object({ q: t.Optional(t.String()) }) })
    .get("/", async ({ user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const result = await searchBorrowers(commandContext(user, request), { query: "" });
            return Promise.all(result.candidates.map(withBorrowerMedia));
        } catch (error) {
            return domainFailure(error, set);
        }
    })
    .get("/:id/portfolio", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const portfolio = await getBorrowerPortfolio(commandContext(user, request), params.id);
            return { ...portfolio, borrower: await withBorrowerMedia(portfolio.borrower) };
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) })
    .get("/:id", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const portfolio = await getBorrowerPortfolio(commandContext(user, request), params.id);
            return withBorrowerMedia(portfolio.borrower);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) })
    .post("/", async ({ body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return withBorrowerMedia(await createBorrower(commandContext(user, request), body));
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { body: borrowerBody })
    .put("/:id", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return withBorrowerMedia(await updateBorrower(commandContext(user, request), params.id, body));
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }), body: borrowerUpdateBody })
    .post("/:id/aliases", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await addBorrowerAlias(commandContext(user, request), params.id, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            alias: t.String(),
            source: t.Optional(t.Union([t.Literal("manual"), t.Literal("payment"), t.Literal("import")])),
        }),
    })
    .post("/aliases/:aliasId/confirm", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await confirmBorrowerAlias(commandContext(user, request), params.aliasId);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ aliasId: t.String() }) })
    .post("/aliases/:aliasId/deactivate", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await deactivateBorrowerAlias(commandContext(user, request), params.aliasId);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ aliasId: t.String() }) });
