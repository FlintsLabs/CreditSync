import { expect, test } from "bun:test";

const backendRoot = `${import.meta.dir}/../../`;
const migrationTag = "0057_loan_schedule_deferrals";
const migrationPath = `${backendRoot}drizzle/${migrationTag}.sql`;
const journalPath = `${backendRoot}drizzle/meta/_journal.json`;

test("registers the additive loan schedule deferral migration", async () => {
    const journal = await Bun.file(journalPath).json() as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.tag === migrationTag)).toMatchObject({ idx: 57, tag: migrationTag });
    const migration = await Bun.file(migrationPath).text();
    expect(migration).toContain('CREATE TABLE "loan_schedule_deferrals"');
    expect(migration).toContain('"source_schedule_id"');
    expect(migration).toContain('"replacement_schedule_id"');
    expect(migration).toContain('"reason"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "loan_schedule_deferrals"');
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
});
