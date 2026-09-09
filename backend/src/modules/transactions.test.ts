import { expect, test } from "bun:test";
import { safePaymentEvidenceSummary } from "../services/payment-evidence-read-service";

test("transaction evidence projection exposes only safe public fields", () => {
    expect(Object.keys(safePaymentEvidenceSummary({ publicId: crypto.randomUUID(), filePublicId: crypto.randomUUID(), mimeType: "application/pdf", source: "primary" })).sort())
        .toEqual(["filePublicId", "mimeType", "publicId", "source"]);
});
