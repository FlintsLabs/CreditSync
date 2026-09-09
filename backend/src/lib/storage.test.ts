import { describe, expect, test } from "bun:test";
import { signedPutRequiredHeaders, signedPutSigningOptions, type SignedPutRequest } from "./storage";

describe("signed evidence upload contract", () => {
    test("requires exactly the content and metadata headers covered by S3 signing", () => {
        const request: SignedPutRequest = {
            key: "payment-evidence/tenant-a/intake-a/file",
            contentType: "image/jpeg",
            contentLength: 12,
            checksumSha256: "a".repeat(64),
            metadata: { tenant: "tenant-a", intake: "intake-a" },
        };
        const headers = signedPutRequiredHeaders(request);
        const options = signedPutSigningOptions(request, 300);

        expect(headers).toEqual({
            "content-type": "image/jpeg",
            "x-amz-checksum-sha256": Buffer.from("a".repeat(64), "hex").toString("base64"),
            "x-amz-meta-tenant": "tenant-a",
            "x-amz-meta-intake": "intake-a",
        });
        expect(options.signableHeaders).toContain("content-type");
        for (const header of Object.keys(headers).filter((name) => name.startsWith("x-amz-"))) {
            expect(options.unhoistableHeaders).toContain(header);
        }
    });
});
