import { expect, test } from "bun:test";
import { safePaymentEvidenceSummary } from "./payment-evidence-read-service";

test("safe payment evidence summaries omit hashes, URLs, keys, and internal IDs", () => {
    const result = safePaymentEvidenceSummary({
        publicId: "11111111-1111-4111-8111-111111111111",
        filePublicId: "22222222-2222-4222-8222-222222222222",
        mimeType: "image/png",
        source: "supplement",
        reason: "upload_channel_unavailable",
    });
    expect(result).toEqual({
        publicId: "11111111-1111-4111-8111-111111111111",
        filePublicId: "22222222-2222-4222-8222-222222222222",
        mimeType: "image/png",
        source: "supplement",
        reason: "upload_channel_unavailable",
    });
    expect(JSON.stringify(result)).not.toMatch(/checksum|sha256|url|key|storage|intakeId/i);
});
