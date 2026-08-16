import { expect, test } from "bun:test";

test("keeps the funding drawdown journal entries valid and ordered", async () => {
    const journal = await Bun.file(new URL("../../drizzle/meta/_journal.json", import.meta.url)).json() as {
        entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.filter(({ tag }) => tag.startsWith("004")).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
        { idx: 40, tag: "0040_bank_drawdown_command_hardening" },
        { idx: 41, tag: "0041_funding_allocation_idempotency" },
    ]);
});
