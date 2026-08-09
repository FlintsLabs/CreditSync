import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { loans } from "./schema";

// Break caught: a draft loses the term length required to create its schedule at activation.
test("loan drafts persist an optional positive term length for legacy compatibility", () => {
    const termMonths = getTableConfig(loans).columns.find((column) => column.name === "term_months");

    expect(termMonths).toBeDefined();
    expect(termMonths?.notNull).toBe(false);
    const termCheck = getTableConfig(loans).checks.find((candidate) => candidate.name === "loans_term_months_check");
    expect(termCheck).toBeDefined();
});
