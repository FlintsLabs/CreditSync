import { describe, expect, it, vi } from "vitest";
import type { HttpClient, PaymentAllocationInput } from "../../../lib/workflow-api";
import { submitReceiptForReview, type ReceiptEntrySnapshot, type ReceiptEntryProgress } from "./transaction-entry-workflow";

const allocation: PaymentAllocationInput = { borrowerPublicId: "b", loanPublicId: "l", schedulePublicId: "s", amount: "100.00" };
const receipt = { amount: "100.00", receivedAt: "2026-10-07T05:12:00.000Z", payerName: "Payer", originLoanPublicId: "l" };
const context = { idempotencyKey: "stable-key", requestId: "request-id", correlationId: "correlation-id" };
function snapshot(files: File[] = []): ReceiptEntrySnapshot { return { receipt, allocations: [allocation], files, context }; }
function file(name: string) { return new File([name], name, { type: "image/png" }); }
function makeClient(post: unknown, get: unknown = vi.fn()) { return { post, get } as unknown as HttpClient; }

describe("submitReceiptForReview", () => {
    it("creates one intake, sends all allocations to preview, and never posts", async () => {
        const post = vi.fn().mockResolvedValueOnce({ data: { publicId: "intake-1", duplicate: false } }).mockResolvedValueOnce({ data: {} });
        const progress: ReceiptEntryProgress = { files: {} };
        const result = await submitReceiptForReview(makeClient(post), snapshot(), progress, vi.fn());
        expect(result.intakePublicId).toBe("intake-1");
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[0]?.[0]).toBe("/payment-intakes");
        expect(post.mock.calls[0]?.[2]?.headers).toEqual({ "Idempotency-Key": "stable-key", "X-Request-Id": "request-id", "X-Correlation-Id": "correlation-id" });
        expect(post.mock.calls[1]?.[1]).toEqual({ allocations: [allocation] });
        expect(post.mock.calls[1]?.[2]?.headers).toEqual({ "X-Request-Id": "request-id", "X-Correlation-Id": "correlation-id" });
        expect(post.mock.calls.some(([url]) => String(url).includes("/post"))).toBe(false);
    });

    it("declares the exact selected count and prepares, puts, and finalizes each file", async () => {
        const f1 = file("one.png"), f2 = file("two.png");
        const post = vi.fn()
            .mockResolvedValueOnce({ data: { publicId: "intake-1" } })
            .mockResolvedValueOnce({ data: { publicId: "e1", uploadUrl: "https://signed.invalid", requiredHeaders: { "Content-Type": "image/png" } } })
            .mockResolvedValueOnce({ data: {} })
            .mockResolvedValueOnce({ data: { publicId: "e2", uploadUrl: "https://signed.invalid", requiredHeaders: {} } })
            .mockResolvedValueOnce({ data: {} })
            .mockResolvedValueOnce({ data: {} });
        const put = vi.fn().mockResolvedValue({ ok: true });
        const digest = vi.fn(async (f: File) => f.name === "one.png" ? "hash-1" : "hash-2");
        const progress: ReceiptEntryProgress = { files: {} };
        await submitReceiptForReview(makeClient(post), snapshot([f1, f2]), progress, vi.fn(), { put: put as unknown as typeof fetch, sha256: digest });
        expect(post.mock.calls[0]?.[1]).toMatchObject({ attachmentRequirement: { expectedCount: 2 } });
        expect(post.mock.calls.map(([url]) => url)).toEqual([
            "/payment-intakes", "/payment-intakes/intake-1/evidence/upload-intents", "/payment-intakes/intake-1/evidence/e1/finalize",
            "/payment-intakes/intake-1/evidence/upload-intents", "/payment-intakes/intake-1/evidence/e2/finalize", "/payment-intakes/intake-1/match-preview",
        ]);
        expect(put).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[1]?.[2]?.headers).toEqual({ "X-Request-Id": "request-id", "X-Correlation-Id": "correlation-id" });
        expect(post.mock.calls[2]?.[2]?.headers).toEqual({ "X-Request-Id": "request-id", "X-Correlation-Id": "correlation-id" });
    });

    it("omits the attachment requirement without evidence", async () => {
        const post = vi.fn().mockResolvedValueOnce({ data: { publicId: "intake-1" } }).mockResolvedValueOnce({ data: {} });
        await submitReceiptForReview(makeClient(post), snapshot(), { files: {} }, vi.fn());
        expect(post.mock.calls[0]?.[1]).not.toHaveProperty("attachmentRequirement");
    });

    it("calls the browser default fetch with its global receiver for signed uploads", async () => {
        const files = [file("one.png")];
        const post = vi.fn().mockResolvedValueOnce({ data: { publicId: "intake-1" } })
            .mockResolvedValueOnce({ data: { publicId: "e1", uploadUrl: "https://signed.invalid", requiredHeaders: {} } })
            .mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: {} });
        const put = vi.fn(function (this: unknown) {
            if (this !== globalThis) throw new TypeError("Illegal invocation");
            return Promise.resolve({ ok: true });
        });
        vi.stubGlobal("fetch", put);
        await submitReceiptForReview(makeClient(post), snapshot(files), { files: {} }, vi.fn());
        expect(put).toHaveBeenCalledWith("https://signed.invalid", expect.objectContaining({ method: "PUT" }));
    });

    it("classifies local file hashing failures before any create request", async () => {
        const post = vi.fn();
        await expect(submitReceiptForReview(makeClient(post), snapshot([file("one.png")]), { files: {} }, vi.fn(), {
            put: vi.fn() as unknown as typeof fetch,
            sha256: async () => { throw new Error("local file read failed"); },
        })).rejects.toMatchObject({ code: "EVIDENCE_HASH_FAILED" });
        expect(post).not.toHaveBeenCalled();
    });

    it("retains intake and ready first file after a second upload fails, then retries without recreating or reuploading", async () => {
        const files = [file("one.png"), file("two.png")];
        let failSecond = true;
        const post = vi.fn(async (url: string, body?: { sha256?: string }) => {
            if (url === "/payment-intakes") return { data: { publicId: "intake-1" } };
            if (url.endsWith("upload-intents")) {
                const id = body?.sha256 === "one.png" ? "e-one" : "e-two";
                return { data: { publicId: id, uploadUrl: "https://signed.invalid", requiredHeaders: {} } };
            }
            if (url.endsWith("/e-two/finalize") && failSecond) throw new Error("offline");
            return { data: {} };
        });
        const put = vi.fn().mockResolvedValue({ ok: true });
        const digest = vi.fn(async (f: File) => f.name);
        const progress: ReceiptEntryProgress = { files: {} };
        const onProgress = (next: ReceiptEntryProgress) => Object.assign(progress, next);
        await expect(submitReceiptForReview(makeClient(post), snapshot(files), progress, onProgress, { put: put as unknown as typeof fetch, sha256: digest })).rejects.toThrow("offline");
        expect(progress.files["one.png"]?.status).toBe("ready");
        failSecond = false;
        await submitReceiptForReview(makeClient(post), snapshot(files), progress, onProgress, { put: put as unknown as typeof fetch, sha256: digest });
        expect(post.mock.calls.filter(([url]) => url === "/payment-intakes")).toHaveLength(1);
        expect(put).toHaveBeenCalledTimes(3);
    });

    it("retries a lost create response using the same stable idempotency context", async () => {
        const post = vi.fn().mockRejectedValueOnce(new Error("network lost")).mockResolvedValueOnce({ data: { publicId: "intake-1" } }).mockResolvedValueOnce({ data: {} });
        const progress: ReceiptEntryProgress = { files: {} };
        await expect(submitReceiptForReview(makeClient(post), snapshot(), progress, vi.fn())).rejects.toThrow("network lost");
        await submitReceiptForReview(makeClient(post), snapshot(), progress, vi.fn());
        expect(post.mock.calls.slice(0, 2).map((call) => call[2]?.headers?.["Idempotency-Key"])).toEqual(["stable-key", "stable-key"]);
    });

    it("inspects idempotency replay and rejects mismatched receipt snapshots", async () => {
        const post = vi.fn().mockResolvedValue({ data: { publicId: "other-intake", duplicate: true, duplicateReason: "idempotency_key" } });
        const get = vi.fn(async (url: string) => ({ data: url === "/payment-intakes/other-intake"
            ? { publicId: "other-intake", amount: "99.00", receivedAt: receipt.receivedAt, payerName: "Payer", evidenceRequirement: { expectedCount: 0 } }
            : [] }));
        await expect(submitReceiptForReview(makeClient(post, get), snapshot(), { files: {} }, vi.fn())).rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY_MISMATCH" });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it("accepts a matching real GET DTO and verifies the originating loan through its history endpoint", async () => {
        const post = vi.fn().mockResolvedValue({ data: { publicId: "intake-1", duplicate: true, duplicateReason: "idempotency_key" } });
        const get = vi.fn(async (url: string) => ({ data: url === "/payment-intakes/intake-1"
            ? { publicId: "intake-1", amount: "100.00", receivedAt: receipt.receivedAt, payerName: "Payer", evidenceRequirement: { expectedCount: 0 } }
            : [{ publicId: "intake-1", originLoanPublicId: "l" }] }));
        await submitReceiptForReview(makeClient(post, get), snapshot(), { files: {} }, vi.fn());
        expect(get.mock.calls.map(([url]) => url)).toEqual(["/payment-intakes/intake-1", "/loans/l/payment-intakes"]);
    });

    it("stops on a duplicate ready intent without treating it as this intake evidence", async () => {
        const post = vi.fn().mockResolvedValueOnce({ data: { publicId: "intake-1" } }).mockResolvedValueOnce({ data: { publicId: "old-evidence", status: "ready", duplicate: true } });
        const progress: ReceiptEntryProgress = { files: {} };
        await expect(submitReceiptForReview(makeClient(post), snapshot([file("one.png")]), progress, vi.fn(), { put: vi.fn() as unknown as typeof fetch, sha256: async () => "hash" })).rejects.toMatchObject({ code: "DUPLICATE_EVIDENCE" });
        expect(progress.files.hash).toBeUndefined();
        expect(post.mock.calls.some(([url]) => String(url).endsWith("match-preview"))).toBe(false);
    });

    it("keeps a bank-reference duplicate target out of resumable progress", async () => {
        const reason = "bank_reference";
        const post = vi.fn().mockResolvedValue({ data: { publicId: "foreign-intake", duplicate: true, duplicateReason: reason } });
        const progress: ReceiptEntryProgress = { files: {} };
        await expect(submitReceiptForReview(makeClient(post), snapshot([file("one.png")]), progress, vi.fn(), { put: vi.fn() as unknown as typeof fetch, sha256: async () => "hash" })).rejects.toMatchObject({ reviewTargetPublicId: "foreign-intake" });
        expect(progress.intakePublicId).toBeUndefined();
        expect(post).toHaveBeenCalledTimes(1);
    });

    it("stops on duplicate evidence before allocation preview", async () => {
        const post = vi.fn().mockResolvedValueOnce({ data: { publicId: "intake-1" } }).mockResolvedValueOnce({ data: { duplicate: true } });
        await expect(submitReceiptForReview(makeClient(post), snapshot([file("one.png")]), { files: {} }, vi.fn(), { put: vi.fn() as unknown as typeof fetch, sha256: async () => "hash" })).rejects.toMatchObject({ code: "DUPLICATE_EVIDENCE" });
        expect(post.mock.calls.some(([url]) => String(url).endsWith("match-preview"))).toBe(false);
    });
    it("retains the owned intake and domain error when an evidence API call fails", async () => {
        const failure = Object.assign(new Error("request failed"), {
            code: "ERR_BAD_REQUEST", response: { status: 409, data: { code: "EVIDENCE_UPLOAD_EXPIRED" } },
        });
        const post = vi.fn().mockResolvedValueOnce({ data: { publicId: "intake-1", duplicate: false } }).mockRejectedValueOnce(failure);
        const progress: ReceiptEntryProgress = { files: {} };
        await expect(submitReceiptForReview(makeClient(post), snapshot([file("one.png")]), progress, vi.fn(), {
            put: vi.fn() as unknown as typeof fetch, sha256: async () => "a".repeat(64),
        })).rejects.toMatchObject({ code: "EVIDENCE_UPLOAD_EXPIRED", intakePublicId: "intake-1" });
        expect(progress.intakePublicId).toBe("intake-1");
    });

});
