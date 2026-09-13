import { describe, expect, test } from "bun:test";
import { collectToolListPages } from "./contract-snapshot";

const tool = (name: string) => ({ name, inputSchema: {}, outputSchema: {} });

describe("MCP contract page collection", () => {
    test("follows an empty-string cursor and preserves page order", async () => {
        const cursors: Array<string | undefined> = [];
        const pages = new Map<string | undefined, { tools: ReturnType<typeof tool>[]; nextCursor?: string | null }>([
            [undefined, { tools: [tool("first")], nextCursor: "" }],
            ["", { tools: [tool("second")], nextCursor: null }],
        ]);
        const collected = await collectToolListPages(async (cursor) => {
            cursors.push(cursor);
            return pages.get(cursor)!;
        });
        expect(cursors).toEqual([undefined, ""]);
        expect(collected.map(({ name }) => name)).toEqual(["first", "second"]);
    });

    test("rejects repeated cursors and duplicate tool names", async () => {
        await expect(collectToolListPages(async (cursor) => cursor === undefined
            ? { tools: [tool("first")], nextCursor: "loop" }
            : { tools: [tool("second")], nextCursor: "loop" })).rejects.toThrow("cursor repeated");
        await expect(collectToolListPages(async () => ({ tools: [tool("same"), tool("same")] }))).rejects.toThrow("duplicate");
    });
});
