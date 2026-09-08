import { describe, expect, test } from "bun:test";

import { downloadChatGptFile, type ChatGptFileParam } from "./chatgpt-file-evidence-service";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const file: ChatGptFileParam = {
    downloadUrl: "https://files.openai.test/download/token",
    fileId: "platform-file-id",
    mimeType: "image/png",
    fileName: "slip.png",
};

function dependencies(response: Response) {
    return {
        allowedHosts: new Set(["files.openai.test"]),
        maxBytes: 32,
        resolveHost: async () => ["203.0.113.10"],
        fetch: async (_url: string, init: RequestInit) => {
            expect(init.redirect).toBe("error");
            return response;
        },
    };
}

describe("bounded ChatGPT file download", () => {
    test("accepts a trusted HTTPS file and returns verified bytes without source identifiers", async () => {
        const result = await downloadChatGptFile(file, dependencies(new Response(png, {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(png.byteLength) },
        })));
        expect(result).toMatchObject({ mimeType: "image/png", size: png.byteLength });
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(result)).not.toContain(file.downloadUrl);
        expect(JSON.stringify(result)).not.toContain(file.fileId);
    });

    test.each([
        ["HTTP", { ...file, downloadUrl: "http://files.openai.test/x" }, new Response(png, { headers: { "content-type": "image/png" } })],
        ["untrusted host", { ...file, downloadUrl: "https://evil.test/x" }, new Response(png, { headers: { "content-type": "image/png" } })],
        ["redirect", file, new Response(null, { status: 302, headers: { location: "https://files.openai.test/elsewhere" } })],
        ["unsupported MIME", file, new Response(png, { headers: { "content-type": "text/html" } })],
        ["MIME mismatch", file, new Response(png, { headers: { "content-type": "image/jpeg" } })],
        ["signature mismatch", file, new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })],
        ["oversize", file, new Response(new Uint8Array(33).fill(1), { headers: { "content-type": "image/png" } })],
    ])("rejects %s", async (_name, candidate, response) => {
        await expect(downloadChatGptFile(candidate as ChatGptFileParam, dependencies(response))).rejects.toMatchObject({
            code: expect.stringMatching(/^CHATGPT_FILE_/),
        });
    });

    test("rejects a host resolving to a private address before fetch", async () => {
        let fetched = false;
        await expect(downloadChatGptFile(file, {
            ...dependencies(new Response(png)),
            resolveHost: async () => ["127.0.0.1"],
            fetch: async () => { fetched = true; return new Response(png); },
        })).rejects.toMatchObject({ code: "CHATGPT_FILE_UNTRUSTED_HOST" });
        expect(fetched).toBe(false);
    });
});
