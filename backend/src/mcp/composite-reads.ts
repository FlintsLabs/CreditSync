import { createHash } from "node:crypto";
import {
    getBorrowerPortfolio,
    searchBorrowers,
} from "../services/borrower-service";
import type { CommandContext } from "../services/command-context";
import { DomainError } from "../services/domain-error";
import { getLoanContract } from "../services/loan-application-service";
import { listLoanDisbursements } from "../services/loan-disbursement-service";
import {
    getPaymentIntake,
    listLoanPaymentIntakes,
} from "../services/payment-service";

export const COMPOSITE_READ_DEFAULT_LIMIT = 25;
export const COMPOSITE_READ_MAX_LIMIT = 100;

export type CompositeReadView = "summary" | "schedule" | "history";

type CursorCollection =
    | "borrowerCandidates"
    | "aliases"
    | "loans"
    | "allocations"
    | "schedule"
    | "history"
    | "disbursements"
    | "accruals";

type CursorPayload = {
    version: 1;
    tool: string;
    parentPublicId: string;
    view: CompositeReadView | "portfolio";
    collection: CursorCollection;
    snapshot: string;
    offset: number;
};

export type CompositePage<T> = {
    items: T[];
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
};

function invalidCompositeInput(field: string, message = "Invalid composite read input"): never {
    throw new DomainError("INVALID_COMPOSITE_READ_INPUT", message, 400, { field });
}

function limitFor(input: Record<string, unknown>) {
    if (input.limit === undefined) return COMPOSITE_READ_DEFAULT_LIMIT;
    if (typeof input.limit !== "number" || !Number.isSafeInteger(input.limit)
        || input.limit < 1 || input.limit > COMPOSITE_READ_MAX_LIMIT) {
        invalidCompositeInput("limit", `limit must be an integer between 1 and ${COMPOSITE_READ_MAX_LIMIT}`);
    }
    return input.limit as number;
}

function encodeCursor(payload: CursorPayload) {
    return `mcp1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeCursor(
    value: unknown,
    expected: Omit<CursorPayload, "offset" | "version" | "snapshot"> & { snapshot: string },
) {
    if (typeof value !== "string" || !value.startsWith("mcp1.")) {
        invalidCompositeInput("cursor", "Cursor is malformed or expired");
    }
    let payload: unknown;
    try {
        payload = JSON.parse(Buffer.from((value as string).slice(5), "base64url").toString("utf8"));
    } catch {
        invalidCompositeInput("cursor", "Cursor is malformed or expired");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        invalidCompositeInput("cursor", "Cursor is malformed or expired");
    }
    const candidate = payload as Partial<CursorPayload>;
    if (candidate.version !== 1
        || candidate.tool !== expected.tool
        || candidate.parentPublicId !== expected.parentPublicId
        || candidate.view !== expected.view
        || candidate.collection !== expected.collection
        || candidate.snapshot !== expected.snapshot
        || typeof candidate.offset !== "number"
        || !Number.isSafeInteger(candidate.offset)
        || candidate.offset < 0) {
        invalidCompositeInput("cursor", "Cursor does not belong to this read, view, or collection");
    }
    return candidate.offset!;
}

function page<T>(
    items: readonly T[],
    limit: number,
    cursor: unknown,
    expected: Omit<CursorPayload, "offset" | "version" | "snapshot"> & { snapshot?: string },
): CompositePage<T> {
    const snapshot = expected.snapshot ?? snapshotFor(items);
    const pageExpected = { ...expected, snapshot } as Omit<CursorPayload, "offset" | "version">;
    const offset = cursor === undefined
        ? 0
        : decodeCursor(cursor, pageExpected);
    if (offset > items.length) invalidCompositeInput("cursor", "Cursor is no longer valid");
    const selected = items.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    const hasMore = nextOffset < items.length;
    return {
        items: selected,
        limit,
        hasMore,
        nextCursor: hasMore ? encodeCursor({ version: 1, ...expected, snapshot, offset: nextOffset }) : null,
    };
}

function snapshotFor(items: readonly unknown[]) {
    return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function publicIdOf(value: unknown) {
    return value && typeof value === "object" && "publicId" in value && typeof value.publicId === "string"
        ? value.publicId
        : "";
}

function dateValue(value: unknown) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string") return Date.parse(value);
    return 0;
}

function sortByPublicId<T>(items: readonly T[], compare: (left: T, right: T) => number = () => 0) {
    return items.map((item, index) => ({ item, index })).sort((left, right) =>
        compare(left.item, right.item)
        || publicIdOf(left.item).localeCompare(publicIdOf(right.item))
        || left.index - right.index,
    ).map(({ item }) => item);
}

function cursorMap(input: Record<string, unknown>) {
    const cursors = input.cursors;
    if (cursors === undefined) return {} as Record<string, unknown>;
    if (!cursors || typeof cursors !== "object" || Array.isArray(cursors)) {
        invalidCompositeInput("cursors");
    }
    return cursors as Record<string, unknown>;
}

function nestedCursor(cursors: Record<string, unknown>, mapName: string, key: string) {
    const nested = cursors[mapName];
    if (nested === undefined) return undefined;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
        invalidCompositeInput(`cursors.${mapName}`);
    }
    return (nested as Record<string, unknown>)[key];
}

function requireSelection(input: Record<string, unknown>, fields: string[]) {
    const present = fields.filter((field) => typeof input[field] === "string" && String(input[field]).trim());
    if (present.length !== 1) invalidCompositeInput(fields.join("/"), "Exactly one selector is required");
    return present[0]!;
}

function viewFor(input: Record<string, unknown>) {
    const view = input.view ?? "summary";
    if (view !== "summary" && view !== "schedule" && view !== "history") {
        invalidCompositeInput("view", "view must be summary, schedule, or history");
    }
    return view as CompositeReadView;
}

function assertNoCursor(cursors: Record<string, unknown>, names: string[]) {
    for (const name of names) {
        if (cursors[name] !== undefined) invalidCompositeInput(`cursors.${name}`, "Cursor is incompatible with this view");
    }
}

function assertOnlyCursors(cursors: Record<string, unknown>, names: string[]) {
    const allowed = new Set(names);
    for (const name of Object.keys(cursors)) {
        if (!allowed.has(name)) invalidCompositeInput(`cursors.${name}`, "Cursor is incompatible with this tool or view");
    }
}

function assertNestedCursorKeys(cursors: Record<string, unknown>, mapName: string, allowedKeys: readonly string[]) {
    const nested = cursors[mapName];
    if (nested === undefined) return;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
        invalidCompositeInput(`cursors.${mapName}`);
    }
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(nested as Record<string, unknown>)) {
        if (!allowed.has(key)) invalidCompositeInput(`cursors.${mapName}.${key}`, "Cursor does not belong to a returned child");
    }
}

export async function resolveAndPortfolio(ctx: CommandContext, input: Record<string, unknown>) {
    const selector = requireSelection(input, ["query", "borrowerPublicId"]);
    const limit = limitFor(input);
    const cursors = cursorMap(input);
    assertOnlyCursors(cursors, selector === "query" ? ["borrowerCandidates", "aliases", "loans"] : ["aliases", "loans"]);

    let resolution: "none" | "unique" | "ambiguous" | "candidates";
    let matchType: "public_id" | "canonical" | "confirmed_alias" | "fuzzy" | null;
    let candidates: Array<Record<string, unknown>>;
    let selectedBorrowerPublicId: string | null = null;

    if (selector === "borrowerPublicId") {
        selectedBorrowerPublicId = String(input.borrowerPublicId);
        resolution = "unique";
        matchType = "public_id";
        candidates = [];
    } else {
        const search = await searchBorrowers(ctx, { query: String(input.query) });
        resolution = search.resolution;
        matchType = search.matchType;
        candidates = search.candidates as Array<Record<string, unknown>>;
        if (search.resolution === "unique") selectedBorrowerPublicId = String(search.candidates[0]!.publicId);
    }

    const candidatePage = page(candidates, limit, cursors.borrowerCandidates, {
        tool: "borrower.resolve-and-portfolio",
        parentPublicId: selectedBorrowerPublicId ?? (selector === "query" ? String(input.query) : String(input.borrowerPublicId)),
        view: "portfolio",
        collection: "borrowerCandidates",
    });

    let portfolio: Record<string, unknown> | null = null;
    if (selectedBorrowerPublicId) {
        const result = await getBorrowerPortfolio(ctx, selectedBorrowerPublicId);
        const aliases = sortByPublicId(result.aliases as Array<Record<string, unknown>>, (left, right) =>
            dateValue(left.createdAt) - dateValue(right.createdAt));
        const loans = sortByPublicId(result.loans as Array<Record<string, unknown>>, (left, right) =>
            dateValue(left.createdAt) - dateValue(right.createdAt));
        portfolio = {
            borrower: result.borrower,
            aliases: page(aliases, limit, cursors.aliases, {
                tool: "borrower.resolve-and-portfolio",
                parentPublicId: selectedBorrowerPublicId,
                view: "portfolio",
                collection: "aliases",
            }),
            loans: page(loans, limit, cursors.loans, {
                tool: "borrower.resolve-and-portfolio",
                parentPublicId: selectedBorrowerPublicId,
                view: "portfolio",
                collection: "loans",
            }),
        };
    } else {
        assertNoCursor(cursors, ["aliases", "loans"]);
    }

    return {
        resolution,
        matchType,
        selectedBorrowerPublicId,
        candidates: candidatePage,
        portfolio,
    };
}

export async function inspectLoanContext(ctx: CommandContext, input: Record<string, unknown>) {
    const selector = requireSelection(input, ["loanPublicId"]);
    if (selector !== "loanPublicId") invalidCompositeInput("loanPublicId");
    const loanPublicId = String(input.loanPublicId);
    const view = viewFor(input);
    const limit = limitFor(input);
    const cursors = cursorMap(input);
    assertOnlyCursors(cursors, view === "summary"
        ? []
        : view === "schedule" ? ["schedule"] : ["history", "disbursements", "accruals"]);
    const contract = await getLoanContract(ctx, loanPublicId, {
        includeSchedule: view === "schedule",
        includeAccruals: view === "history",
    });
    const { schedule: allSchedule, accruals: allAccruals = [], ...loan } = contract as typeof contract & { schedule: unknown[]; accruals?: unknown[] };

    let schedule: CompositePage<unknown> | null = null;
    let history: CompositePage<unknown> | null = null;
    let disbursements: CompositePage<unknown> | null = null;
    let accruals: CompositePage<unknown> | null = null;
    if (view === "schedule") {
        schedule = page(sortByPublicId(allSchedule, (left, right) =>
            Number((left as { installmentNo?: number }).installmentNo ?? 0)
            - Number((right as { installmentNo?: number }).installmentNo ?? 0)), limit, cursors.schedule, {
            tool: "loan.inspect-context", parentPublicId: loanPublicId, view, collection: "schedule",
        });
    } else if (view === "history") {
        const [allHistory, disbursementResult] = await Promise.all([
            listLoanPaymentIntakes(ctx, loanPublicId),
            listLoanDisbursements(ctx, loanPublicId),
        ]);
        history = page(sortByPublicId(allHistory, (left, right) =>
            dateValue(right.receivedAt) - dateValue(left.receivedAt)), limit, cursors.history, {
            tool: "loan.inspect-context", parentPublicId: loanPublicId, view, collection: "history",
        });
        disbursements = page(sortByPublicId(disbursementResult.events, (left, right) =>
            dateValue(right.disbursedAt) - dateValue(left.disbursedAt)), limit, cursors.disbursements, {
            tool: "loan.inspect-context", parentPublicId: loanPublicId, view, collection: "disbursements",
        });
        accruals = page(sortByPublicId(allAccruals as Array<Record<string, unknown>>, (left, right) =>
            dateValue(left.accrualDate) - dateValue(right.accrualDate)), limit, cursors.accruals, {
            tool: "loan.inspect-context", parentPublicId: loanPublicId, view, collection: "accruals",
        });
    }

    return { loan, view, schedule, history, disbursements, accruals };
}

export async function matchPaymentContext(ctx: CommandContext, input: Record<string, unknown>) {
    const selector = requireSelection(input, ["paymentIntakePublicId"]);
    if (selector !== "paymentIntakePublicId") invalidCompositeInput("paymentIntakePublicId");
    const paymentIntakePublicId = String(input.paymentIntakePublicId);
    const view = viewFor(input);
    const limit = limitFor(input);
    const cursors = cursorMap(input);
    assertOnlyCursors(cursors, view === "summary"
        ? ["borrowerCandidates", "allocations"]
        : view === "schedule"
            ? ["borrowerCandidates", "allocations", "loans", "allocationCursors", "scheduleCursors"]
            : ["borrowerCandidates", "allocations", "loans", "allocationCursors", "historyCursors", "accrualCursors"]);
    const detail = await getPaymentIntake(ctx, paymentIntakePublicId);
    const latestProposal = detail.latestProposal;
    const allocationItems = latestProposal?.allocations ?? [];

    const borrowerResolution = detail.payerName
        ? await searchBorrowers(ctx, { query: detail.payerName })
        : { resolution: "none" as const, matchType: null, candidates: [] };
    if (!detail.payerName) assertNoCursor(cursors, ["borrowerCandidates"]);
    const borrowerCandidates = page(borrowerResolution.candidates as Array<Record<string, unknown>>, limit, cursors.borrowerCandidates, {
        tool: "payment.match-context", parentPublicId: paymentIntakePublicId, view, collection: "borrowerCandidates",
    });
    const allocations = page(allocationItems as Array<Record<string, unknown>>, limit, cursors.allocations, {
        tool: "payment.match-context", parentPublicId: paymentIntakePublicId, view, collection: "allocations",
    });

    const { latestProposal: _latestProposal, ...intake } = detail;
    let loanContexts: CompositePage<Record<string, unknown>> | null = null;
    if (view === "summary") {
        assertNoCursor(cursors, ["loans", "allocationCursors", "scheduleCursors", "historyCursors", "accrualCursors"]);
    } else {
        const loanIds = [...new Set(allocationItems
            .map((item) => item.loanPublicId)
            .filter((value): value is string => typeof value === "string"))].sort((left, right) => left.localeCompare(right));
        const loanPage = page(loanIds, limit, cursors.loans, {
            tool: "payment.match-context", parentPublicId: paymentIntakePublicId, view, collection: "loans",
        });
        assertNestedCursorKeys(cursors, "allocationCursors", loanPage.items);
        assertNestedCursorKeys(cursors, view === "schedule" ? "scheduleCursors" : "historyCursors", loanPage.items);
        if (view === "history") assertNestedCursorKeys(cursors, "accrualCursors", loanPage.items);
        const contexts = await Promise.all(loanPage.items.map(async (loanPublicId) => {
            const contract = await getLoanContract(ctx, loanPublicId, {
                includeSchedule: view === "schedule",
                includeAccruals: view === "history",
            });
            const { schedule: allSchedule, accruals: allAccruals = [], ...loan } = contract as typeof contract & { schedule: unknown[]; accruals?: unknown[] };
            const loanAllocations = allocationItems.filter((item) => item.loanPublicId === loanPublicId) as Array<Record<string, unknown>>;
            const loanAllocationPage = page(loanAllocations, limit, nestedCursor(cursors, "allocationCursors", loanPublicId), {
                tool: "payment.match-context", parentPublicId: loanPublicId, view, collection: "allocations",
            });
            if (view === "schedule") {
                return {
                    loanPublicId,
                    allocations: loanAllocationPage,
                    loan,
                    schedule: page(sortByPublicId(allSchedule, (left, right) =>
                        Number((left as { installmentNo?: number }).installmentNo ?? 0)
                        - Number((right as { installmentNo?: number }).installmentNo ?? 0)), limit, nestedCursor(cursors, "scheduleCursors", loanPublicId), {
                        tool: "payment.match-context", parentPublicId: loanPublicId, view, collection: "schedule",
                    }),
                    history: null,
                    accruals: null,
                };
            }
            const allHistory = await listLoanPaymentIntakes(ctx, loanPublicId);
            return {
                loanPublicId,
                allocations: loanAllocationPage,
                loan,
                schedule: null,
                history: page(sortByPublicId(allHistory, (left, right) =>
                    dateValue(right.receivedAt) - dateValue(left.receivedAt)), limit, nestedCursor(cursors, "historyCursors", loanPublicId), {
                    tool: "payment.match-context", parentPublicId: loanPublicId, view, collection: "history",
                }),
                accruals: page(sortByPublicId(allAccruals as Array<Record<string, unknown>>, (left, right) =>
                    dateValue(left.accrualDate) - dateValue(right.accrualDate)), limit, nestedCursor(cursors, "accrualCursors", loanPublicId), {
                    tool: "payment.match-context", parentPublicId: loanPublicId, view, collection: "accruals",
                }),
            };
        }));
        loanContexts = { ...loanPage, items: contexts };
    }

    const proposal = latestProposal ? {
        ...latestProposal,
        allocations,
    } : null;
    return {
        intake,
        proposal,
        borrowerResolution: {
            resolution: borrowerResolution.resolution,
            matchType: borrowerResolution.matchType,
            candidates: borrowerCandidates,
        },
        allocations,
        loanContexts,
        view,
    };
}

export const compositeReadInternals = { encodeCursor, decodeCursor, page };
