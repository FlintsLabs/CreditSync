import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

const root = `${import.meta.dir}/../../`;

test("combined deployed migration lineage keeps ChatGPT evidence before allocation correction", async () => {
    const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
    const chatgpt = journal.entries.find((entry) => entry.tag === "0061_chatgpt_payment_evidence");
    const allocation = journal.entries.find((entry) => entry.tag === "0062_scheduled_payment_allocation_corrections");
    expect(chatgpt).toEqual({ idx: 61, version: "7", when: 1788739200000, tag: "0061_chatgpt_payment_evidence", breakpoints: true });
    expect(allocation).toEqual({ idx: 62, version: "7", when: 1788811800000, tag: "0062_scheduled_payment_allocation_corrections", breakpoints: true });
    expect(chatgpt!.when).toBeLessThan(allocation!.when);
    const chatgptSql = await Bun.file(`${root}drizzle/${chatgpt!.tag}.sql`).arrayBuffer();
    const allocationSql = await Bun.file(`${root}drizzle/${allocation!.tag}.sql`).arrayBuffer();
    expect(createHash("sha256").update(Buffer.from(chatgptSql)).digest("hex")).toBe("ba93514fd771bc17f323e32a20b88eb8850ffa219ca5d554ab2149642cb22230");
    expect(createHash("sha256").update(Buffer.from(allocationSql)).digest("hex")).toBe("10eb2edfb20fabb9718d6038c44f9c3748909bf59be455d30d60f9259969a39f");
});
