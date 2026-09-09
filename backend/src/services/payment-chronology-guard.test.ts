import { describe, expect, test } from "bun:test";
import { evaluatePaymentChronology } from "./payment-chronology-guard";

describe("payment chronology guard", () => {
    test("sorts by transfer timestamp and blocks a later item behind an older pending draft", () => {
        const result = evaluatePaymentChronology({
            now: "2026-09-09T04:00:00.000Z",
            borrowerId: "borrower-a",
            pending: [{ itemId: "old-draft", borrowerId: "borrower-a", receivedAt: "2026-09-07T04:00:00.000Z", status: "draft" }],
            incoming: [
                { itemId: "new", borrowerId: "borrower-a", receivedAt: "2026-09-09T03:00:00.000Z", evidenceReady: true },
            ],
        });

        expect(result.status).toBe("chronology_conflict");
        expect(result.blockers).toEqual([{ code: "OLDER_PENDING_PAYMENT", itemId: "new", blockingItemId: "old-draft" }]);
        expect(result.orderedItemIds).toEqual(["new"]);
    });

    test("treats a calendar evidence gap as a warning and does not invent an obligation", () => {
        const result = evaluatePaymentChronology({
            now: "2026-09-09T04:00:00.000Z",
            borrowerId: "borrower-a",
            pending: [],
            incoming: [
                { itemId: "07", borrowerId: "borrower-a", receivedAt: "2026-09-07T04:00:00.000Z", evidenceReady: true },
                { itemId: "09", borrowerId: "borrower-a", receivedAt: "2026-09-09T04:00:00.000Z", evidenceReady: true },
            ],
        });

        expect(result.status).toBe("ready");
        expect(result.warnings).toEqual([{ code: "MISSING_CALENDAR_EVIDENCE", fromDate: "2026-09-08", toDate: "2026-09-08" }]);
        expect(result.blockers).toEqual([]);
    });

    test("separates unknown transfer time, advance obligation, and future transfer", () => {
        const result = evaluatePaymentChronology({
            now: "2026-09-09T04:00:00.000Z",
            borrowerId: "borrower-a",
            pending: [],
            incoming: [
                { itemId: "unknown", borrowerId: "borrower-a", receivedAt: null, evidenceReady: true },
                { itemId: "future", borrowerId: "borrower-a", receivedAt: "2026-09-10T04:00:00.000Z", evidenceReady: true },
            ],
            obligationDates: { future: "2026-09-11" },
        });

        expect(result.status).toBe("chronology_conflict");
        expect(result.blockers.map((blocker) => blocker.code)).toEqual(["FUTURE_TRANSFER_TIMESTAMP", "UNKNOWN_TRANSFER_TIME"]);
        expect(result.decisions).toEqual([{ itemId: "future", kind: "advance_obligation", obligationDate: "2026-09-11" }]);
    });

    test("does not apply a tenant-wide lock to another borrower", () => {
        const result = evaluatePaymentChronology({
            now: "2026-09-09T04:00:00.000Z",
            borrowerId: "borrower-a",
            pending: [{ itemId: "other", borrowerId: "borrower-b", receivedAt: "2026-09-07T04:00:00.000Z", status: "draft" }],
            incoming: [{ itemId: "new", borrowerId: "borrower-a", receivedAt: "2026-09-09T03:00:00.000Z", evidenceReady: true }],
        });

        expect(result.status).toBe("ready");
        expect(result.blockers).toEqual([]);
    });

    test("orders equivalent offset representations by the same instant, not lexical text", () => {
        const result = evaluatePaymentChronology({
            now: "2026-09-09T12:00:00.000Z",
            borrowerId: "borrower-a",
            pending: [],
            incoming: [
                { itemId: "zulu", borrowerId: "borrower-a", receivedAt: "2026-09-07T11:00:00+07:00", evidenceReady: true },
                { itemId: "utc", borrowerId: "borrower-a", receivedAt: "2026-09-07T04:00:00.000Z", evidenceReady: true },
            ],
        });

        expect(result.orderedItemIds).toEqual(["utc", "zulu"]);
        expect(result.warnings).toEqual([]);
    });

    test("skips invalid timestamps when calculating calendar gaps", () => {
        const result = evaluatePaymentChronology({
            now: "2026-09-09T12:00:00.000Z",
            borrowerId: "borrower-a",
            pending: [],
            incoming: [
                { itemId: "bad", borrowerId: "borrower-a", receivedAt: "not-a-timestamp", evidenceReady: true },
                { itemId: "later", borrowerId: "borrower-a", receivedAt: "2026-09-09T04:00:00.000Z", evidenceReady: true },
            ],
        });

        expect(result.blockers).toEqual([{ code: "UNKNOWN_TRANSFER_TIME", itemId: "bad" }]);
        expect(result.warnings).toEqual([]);
    });

    test("uses the Bangkok business date when evaluating an obligation advance", () => {
        const result = evaluatePaymentChronology({
            now: "2026-09-09T12:00:00.000Z",
            borrowerId: "borrower-a",
            pending: [],
            incoming: [{ itemId: "payment", borrowerId: "borrower-a", receivedAt: "2026-09-07T17:30:00.000Z", evidenceReady: true }],
            obligationDates: { payment: "2026-09-08" },
        });

        expect(result.decisions).toEqual([]);
    });

    test("filters terminal pending statuses at runtime", () => {
        const result = evaluatePaymentChronology({
            now: "2026-09-09T12:00:00.000Z",
            borrowerId: "borrower-a",
            pending: [
                { itemId: "posted", borrowerId: "borrower-a", receivedAt: "2026-09-07T04:00:00.000Z", status: "posted" },
                { itemId: "draft", borrowerId: "borrower-a", receivedAt: "2026-09-08T04:00:00.000Z", status: "draft" },
            ],
            incoming: [{ itemId: "payment", borrowerId: "borrower-a", receivedAt: "2026-09-09T04:00:00.000Z", evidenceReady: true }],
        });

        expect(result.blockers).toEqual([{ code: "OLDER_PENDING_PAYMENT", itemId: "payment", blockingItemId: "draft" }]);
    });
});
