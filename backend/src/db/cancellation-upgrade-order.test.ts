import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

integrationTest("cancellation upgrades past the deployed service-account watermark and is replay safe", async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    // Only the disposable runner's database is permitted to create this fixture.
    expect(url.pathname).toBe("/creditsync_disbursement_test");
    const admin = postgres(url.toString(), { max: 1 });
    const name = `cancel_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    const folder = mkdtempSync(join(tmpdir(), "creditsync-cancel-upgrade-"));
    let client: ReturnType<typeof postgres> | undefined;
    try {
        await admin.unsafe(`CREATE DATABASE "${name}"`);
        url.pathname = `/${name}`;
        client = postgres(url.toString(), { max: 1 });
        const source = join(import.meta.dir, "../../drizzle");
        cpSync(source, folder, { recursive: true });
        const journalPath = join(folder, "meta/_journal.json");
        const fullJournal = readFileSync(journalPath, "utf8");
        const baseline = JSON.parse(fullJournal);
        const cancellation = baseline.entries.find((entry: { tag: string }) => entry.tag === "0073_payment_intake_cancellation");
        expect(cancellation).toBeDefined();
        // Model the deployed state before cancellation, not every migration
        // except cancellation: later migrations would advance the watermark
        // past the upgrade this regression is intended to exercise.
        baseline.entries = baseline.entries.filter((entry: { idx: number }) => entry.idx < cancellation.idx);
        writeFileSync(journalPath, JSON.stringify(baseline));
        await migrate(drizzle(client), { migrationsFolder: folder });
        const [beforeUpgrade] = await client`SELECT to_regclass('public.payment_intake_cancellations') AS name`;
        expect(beforeUpgrade!.name).toBeNull();
        // Production has this exact hash/watermark from the independently deployed branch.
        const deployedHash = "b895f899062af260b56733d9e3db7fc133399b77b2f89738302a6d57034839c8";
        await client`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${deployedHash}, 1789084800000)`;
        await client`CREATE TABLE deployment_sentinel (value text PRIMARY KEY)`;
        await client`INSERT INTO deployment_sentinel VALUES ('preserve-existing-data')`;
        writeFileSync(journalPath, fullJournal);
        await migrate(drizzle(client), { migrationsFolder: folder });
        const [result] = await client`SELECT to_regclass('public.payment_intake_cancellations') AS name`;
        expect(result!.name).toBe("payment_intake_cancellations");
        const receipts = await client`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
        await migrate(drizzle(client), { migrationsFolder: folder });
        expect([...(await client`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`)]).toEqual([...receipts]);
        expect([...(await client`SELECT value FROM deployment_sentinel`)]).toEqual([{ value: "preserve-existing-data" }]);
        expect(await client`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${deployedHash}`).toHaveLength(1);
    } finally {
        await client?.end();
        await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
        await admin.end();
        rmSync(folder, { recursive: true, force: true });
    }
}, 60000);
