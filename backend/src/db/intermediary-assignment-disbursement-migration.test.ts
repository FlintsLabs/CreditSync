import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../db";
import { borrowers, intermediaries, loans, users } from "./schema";
import * as schema from "./schema";

const backendRoot = `${import.meta.dir}/../../`;
const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

type Seed = Awaited<ReturnType<typeof seed>>;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`
        TRUNCATE TABLE
            intermediated_disbursement_group_previews,
            intermediated_transfer_evidence,
            intermediated_transfer_evidence_intents,
            intermediated_transfer_events,
            intermediated_disbursement_groups,
            loan_intermediary_assignments,
            intermediary_bank_accounts,
            loans,
            borrowers,
            intermediaries,
            users
        RESTART IDENTITY CASCADE
    `);
}

async function seed(tenantId: string, suffix: string) {
    const actor = await db.insert(users).values({
        tenantId,
        email: `${tenantId}-${suffix}@intermediated-migration.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: actor.id,
        name: `${tenantId} Borrower`,
    }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "5000.00",
        interestRate: "0.00",
        repaymentType: "floating",
        outstandingPrincipal: "5000.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const intermediary = await db.insert(intermediaries).values({
        tenantId,
        ownerUserId: actor.id,
        name: `${tenantId} Intermediary`,
        normalizedName: `${tenantId}-intermediary`,
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    return { actor, borrower, loan, intermediary };
}

async function insertAccount(owner: Seed, suffix: string) {
    return db.execute(sql`
        INSERT INTO intermediary_bank_accounts
            (tenant_id, intermediary_id, bank_name, account_name, account_number_last4,
             account_number_hash, status, created_by_user_id, updated_by_user_id)
        VALUES
            (${owner.actor.tenantId}, ${owner.intermediary.id}, 'KBank', 'Intermediary Account',
             '1234', ${`account-hash-${owner.actor.tenantId}-${suffix}`}, 'active',
             ${owner.actor.id}, ${owner.actor.id})
        RETURNING id
    `).then((rows) => rows[0]!);
}

async function insertAssignment(owner: Seed, role = "both", from = "2026-08-01T00:00:00+07:00", to: string | null = null) {
    return db.execute(sql`
        INSERT INTO loan_intermediary_assignments
            (tenant_id, loan_id, intermediary_id, role, effective_from, effective_to, status,
             idempotency_key, created_by_user_id, updated_by_user_id)
        VALUES
            (${owner.actor.tenantId}, ${owner.loan.id}, ${owner.intermediary.id}, ${role},
             ${from}::timestamptz, ${to}::timestamptz, ${to === null ? "active" : "ended"},
             ${`assignment-${owner.actor.tenantId}-${role}-${from}`}, ${owner.actor.id}, ${owner.actor.id})
        RETURNING id
    `).then((rows) => rows[0]!);
}

async function insertGroup(owner: Seed, suffix: string, status = "draft") {
    return db.execute(sql`
        INSERT INTO intermediated_disbursement_groups
            (tenant_id, loan_id, intermediary_id, expected_funding_amount,
             expected_borrower_payout_amount, expected_advance_interest_return_amount,
             retained_balance_amount, status, idempotency_key, created_by_user_id, updated_by_user_id,
             post_idempotency_key, posted_at)
        VALUES
            (${owner.actor.tenantId}, ${owner.loan.id}, ${owner.intermediary.id}, 5000.00,
             4400.00, 600.00, 0.00, ${status}, ${`group-${owner.actor.tenantId}-${suffix}`},
             ${owner.actor.id}, ${owner.actor.id},
             ${status === "posted" ? `post-group-${owner.actor.tenantId}-${suffix}` : null},
             ${status === "posted" ? sql`now()` : sql`NULL`})
        RETURNING id
    `).then((rows) => rows[0]!);
}

async function insertEvent(owner: Seed, groupId: unknown, accountId: unknown, suffix: string, status = "draft") {
    return db.execute(sql`
        INSERT INTO intermediated_transfer_events
            (tenant_id, group_id, intermediary_bank_account_id, role, channel, amount,
             sender_hint, payee_hint, bank_reference, bank_reference_hash, transferred_at,
             status, idempotency_key, created_by_user_id, updated_by_user_id, posted_at)
        VALUES
            (${owner.actor.tenantId}, ${groupId}, ${accountId}, 'funding_to_intermediary', 'bank_transfer', 5000.00,
             'Lender', 'Intermediary', ${`REF-${suffix}`}, ${`ref-hash-${owner.actor.tenantId}-${suffix}`},
             '2026-08-13T09:00:00+07:00', ${status}, ${`event-${owner.actor.tenantId}-${suffix}`},
             ${owner.actor.id}, ${owner.actor.id}, ${status === "posted" ? sql`now()` : sql`NULL`})
        RETURNING id
    `).then((rows) => rows[0]!);
}

async function expectDatabaseCode(operation: () => Promise<unknown>, code: string) {
    // Drizzle raw queries are PromiseLike rather than native Promise instances;
    // normalize them so Bun's rejects matcher awaits the database operation.
    await expect(Promise.resolve(operation())).rejects.toMatchObject({ cause: { code } });
}

test("exports and journals the additive intermediary assignment and disbursement schema", async () => {
    // Break caught: schema generation or deployment can omit one of the new ledgers or overwrite migration 0027.
    const expectedExports = [
        "intermediaryBankAccounts",
        "loanIntermediaryAssignments",
        "intermediatedDisbursementGroups",
        "intermediatedTransferEvents",
        "intermediatedTransferEvidenceIntents",
        "intermediatedTransferEvidence",
        "intermediatedDisbursementGroupPreviews",
    ] as const;
    for (const exportName of expectedExports) {
        const table = (schema as Record<string, unknown>)[exportName];
        expect(table, `${exportName} must be exported from schema.ts`).toBeDefined();
        if (table) expect(typeof getTableConfig(table as never).name).toBe("string");
    }

    expect(await Bun.file(`${backendRoot}drizzle/0028_intermediary_assignments_disbursement_groups.sql`).exists()).toBe(true);
    const journal = await Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json();
    const migrationIndex = journal.entries.findIndex((entry: { tag?: string }) =>
        entry.tag === "0028_intermediary_assignments_disbursement_groups");
    expect(journal.entries[migrationIndex - 1]?.tag).toBe("0027_floating_interest_period_policy");
});

test("keeps migration 0028 additive and declares tenant, lifecycle, money, and immutability protections", async () => {
    // Break caught: source migration drift can drop a database protection even when TypeScript still compiles.
    const migration = await Bun.file(`${backendRoot}drizzle/0028_intermediary_assignments_disbursement_groups.sql`).text();
    for (const table of [
        "intermediary_bank_accounts",
        "loan_intermediary_assignments",
        "intermediated_disbursement_groups",
        "intermediated_transfer_events",
        "intermediated_transfer_evidence_intents",
        "intermediated_transfer_evidence",
        "intermediated_disbursement_group_previews",
    ]) expect(migration).toContain(`CREATE TABLE "${table}"`);

    expect(migration).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) "?intermediary_(?:collections|remittances)"?/);
    expect(migration).toContain("loan_intermediary_assignments_disbursement_no_overlap");
    expect(migration).toContain("loan_intermediary_assignments_collection_no_overlap");
    expect(migration).toContain("intermediated_transfer_events_tenant_idempotency_unique");
    expect(migration).toContain("intermediated_transfer_events_tenant_reference_unique");
    expect(migration).toContain("intermediated_transfer_evidence_event_file_unique");
    expect(migration).toContain("intermediated_transfer_evidence_intents_tenant_hash_unique");
    expect(migration).toContain("reject_immutable_intermediated_disbursement_mutation");
    expect(migration).toContain("reject_immutable_intermediated_evidence_link_mutation");
    expect(migration).toMatch(/scale\("intermediated_transfer_events"\."amount"\) <= 2/);
    for (const [column, target] of [
        ["intermediary_id", "intermediaries"],
        ["loan_id", "loans"],
        ["group_id", "intermediated_disbursement_groups"],
        ["intermediary_bank_account_id", "intermediary_bank_accounts"],
        ["event_id", "intermediated_transfer_events"],
        ["file_id", "files"],
        ["created_by_user_id", "users"],
    ]) expect(migration).toContain(`FOREIGN KEY ("tenant_id","${column}") REFERENCES "public"."${target}"("tenant_id","id")`);
});

describe("intermediary assignment and intermediated disbursement database contract", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("enforces role-aware effective assignment ranges without blocking different roles", async () => {
        // Break caught: one loan can gain two simultaneous disbursement or collection owners, or separate roles cannot coexist.
        const owner = await seed("tenant-assignment", "roles");
        await insertAssignment(owner, "disbursement", "2026-08-01T00:00:00+07:00", "2026-09-01T00:00:00+07:00");
        await insertAssignment(owner, "collection", "2026-08-15T00:00:00+07:00", null);

        await expectDatabaseCode(
            () => insertAssignment(owner, "both", "2026-08-20T00:00:00+07:00", null),
            "23P01",
        );
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO loan_intermediary_assignments
                (tenant_id, loan_id, intermediary_id, role, effective_from, effective_to,
                 idempotency_key, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-assignment', ${owner.loan.id}, ${owner.intermediary.id}, 'unsupported',
                 '2026-10-01T00:00:00+07:00', NULL, 'invalid-role', ${owner.actor.id}, ${owner.actor.id})
        `), "23514");
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO loan_intermediary_assignments
                (tenant_id, loan_id, intermediary_id, role, effective_from, effective_to,
                 idempotency_key, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-assignment', ${owner.loan.id}, ${owner.intermediary.id}, 'both',
                 '2026-11-01T00:00:00+07:00', '2026-11-01T00:00:00+07:00',
                 'invalid-range', ${owner.actor.id}, ${owner.actor.id})
        `), "23514");
    });

    integrationTest("rejects cross-tenant intermediary, loan, account, event, file, and actor references", async () => {
        // Break caught: a valid numeric ID from another tenant can be attached to a financial row.
        const first = await seed("tenant-safe-a", "first");
        const second = await seed("tenant-safe-b", "second");
        const firstAccount = await insertAccount(first, "first");
        await insertAssignment(first);

        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO loan_intermediary_assignments
                (tenant_id, loan_id, intermediary_id, role, effective_from, idempotency_key,
                 created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-safe-a', ${second.loan.id}, ${first.intermediary.id}, 'both', now(),
                 'cross-tenant-assignment', ${first.actor.id}, ${first.actor.id})
        `), "23503");
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediary_bank_accounts
                (tenant_id, intermediary_id, bank_name, account_name, account_number_last4,
                 account_number_hash, status, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-safe-a', ${second.intermediary.id}, 'SCB', 'Cross tenant', '9999',
                 'cross-tenant-account', 'active', ${first.actor.id}, ${first.actor.id})
        `), "23503");

        const group = await insertGroup(first, "safe");
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_transfer_events
                (tenant_id, group_id, intermediary_bank_account_id, role, channel, amount,
                 transferred_at, status, idempotency_key, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-safe-b', ${group.id}, ${firstAccount.id}, 'funding_to_intermediary', 'bank_transfer',
                 5000.00, now(), 'draft', 'cross-tenant-event', ${second.actor.id}, ${second.actor.id})
        `), "23503");
    });

    integrationTest("accepts only supported transfer lifecycles and exact non-negative money", async () => {
        // Break caught: unsupported roles/statuses, negative THB, or fractional satang reach the ledger.
        const owner = await seed("tenant-money", "constraints");
        const account = await insertAccount(owner, "money");
        await insertAssignment(owner);
        const group = await insertGroup(owner, "money");

        for (const [role, channel, amount, status] of [
            ["unsupported", "bank_transfer", "1.00", "draft"],
            ["funding_to_intermediary", "wire", "1.00", "draft"],
            ["borrower_net_payout", "cash", "-0.01", "draft"],
            ["advance_interest_return", "cash", "0.001", "draft"],
            ["funding_to_intermediary", "cash", "1.00", "unsupported"],
        ]) {
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_transfer_events
                    (tenant_id, group_id, role, channel, amount, transferred_at, status,
                     idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-money', ${group.id}, ${role}, ${channel}, ${amount}::numeric, now(),
                     ${status}, ${`invalid-${role}-${channel}-${amount}-${status}`}, ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
        }

        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_disbursement_groups
                (tenant_id, loan_id, intermediary_id, expected_funding_amount,
                 expected_borrower_payout_amount, expected_advance_interest_return_amount,
                 retained_balance_amount, status, idempotency_key, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-money', ${owner.loan.id}, ${owner.intermediary.id}, 5000.001,
                 4400.00, 600.00, 0.001, 'draft', 'invalid-group-money', ${owner.actor.id}, ${owner.actor.id})
        `), "23514");
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_disbursement_groups
                (tenant_id, loan_id, intermediary_id, expected_funding_amount,
                 expected_borrower_payout_amount, expected_advance_interest_return_amount,
                 retained_balance_amount, status, idempotency_key, posted_at,
                 created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-money', ${owner.loan.id}, ${owner.intermediary.id}, 5000.00,
                 4400.00, 600.00, 0.00, 'posted', 'posted-without-command-key', now(),
                 ${owner.actor.id}, ${owner.actor.id})
        `), "23514");

        expect(await insertEvent(owner, group.id, account.id, "valid")).toBeDefined();
    });

    integrationTest("rejects null or whitespace-only reversal provenance", async () => {
        // Break caught: PostgreSQL CHECK treats a NULL expression as passing, and btrim(text) does not remove tabs or newlines.
        const owner = await seed("tenant-reversal-shape", "provenance");
        const account = await insertAccount(owner, "reversal");
        await insertAssignment(owner);
        const originalGroup = await insertGroup(owner, "original", "posted");
        const originalEvent = await insertEvent(owner, originalGroup.id, account.id, "original", "posted");

        for (const [suffix, reversalKey, requestHash, reason] of [
            ["null-hash", "reversal-key-1", null, "operator correction"],
            ["null-reason", "reversal-key-2", "reversal-hash-2", null],
        ] as const) {
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_disbursement_groups
                    (tenant_id, loan_id, intermediary_id, expected_funding_amount,
                     expected_borrower_payout_amount, expected_advance_interest_return_amount,
                     retained_balance_amount, status, idempotency_key, reversed_group_id,
                     reversal_idempotency_key, reversal_request_hash, reversal_reason,
                     posted_at, reversed_at, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-reversal-shape', ${owner.loan.id}, ${owner.intermediary.id}, 5000.00,
                     4400.00, 600.00, 0.00, 'reversed', ${`reversal-group-${suffix}`}, ${originalGroup.id},
                     ${reversalKey}, ${requestHash}, ${reason}, now(), now(), ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
        }

        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_transfer_events
                (tenant_id, group_id, intermediary_bank_account_id, role, channel, amount,
                 transferred_at, status, idempotency_key, reversed_event_id, reversal_reason,
                 posted_at, reversed_at, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-reversal-shape', ${originalGroup.id}, ${account.id}, 'funding_to_intermediary',
                 'adjustment', 5000.00, now(), 'reversed', 'reversal-event-null',
                 ${originalEvent.id}, NULL, now(), now(), ${owner.actor.id}, ${owner.actor.id})
        `), "23514");

        const whitespaceOnlyValues = [
            ["empty", ""],
            ["space", "   "],
            ["tab", "\t"],
            ["newline", "\n"],
            ["mixed", "\t \n"],
        ] as const;
        for (const [suffix, value] of whitespaceOnlyValues) {
            for (const [field, reversalKey, requestHash, reason] of [
                ["key", value, `reversal-hash-${suffix}-key`, "operator correction"],
                ["hash", `reversal-key-${suffix}-hash`, value, "operator correction"],
                ["reason", `reversal-key-${suffix}-reason`, `reversal-hash-${suffix}-reason`, value],
            ] as const) {
                await expectDatabaseCode(() => db.execute(sql`
                    INSERT INTO intermediated_disbursement_groups
                        (tenant_id, loan_id, intermediary_id, expected_funding_amount,
                         expected_borrower_payout_amount, expected_advance_interest_return_amount,
                         retained_balance_amount, status, idempotency_key, reversed_group_id,
                         reversal_idempotency_key, reversal_request_hash, reversal_reason,
                         posted_at, reversed_at, created_by_user_id, updated_by_user_id)
                    VALUES
                        ('tenant-reversal-shape', ${owner.loan.id}, ${owner.intermediary.id}, 5000.00,
                         4400.00, 600.00, 0.00, 'reversed', ${`reversal-group-${suffix}-${field}`}, ${originalGroup.id},
                         ${reversalKey}, ${requestHash}, ${reason}, now(), now(), ${owner.actor.id}, ${owner.actor.id})
                `), "23514");
            }

            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_transfer_events
                    (tenant_id, group_id, intermediary_bank_account_id, role, channel, amount,
                     transferred_at, status, idempotency_key, reversed_event_id, reversal_reason,
                     posted_at, reversed_at, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-reversal-shape', ${originalGroup.id}, ${account.id}, 'funding_to_intermediary',
                     'adjustment', 5000.00, now(), 'reversed', ${`reversal-event-${suffix}`},
                     ${originalEvent.id}, ${value}, now(), now(), ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
        }
    });

    integrationTest("rejects empty or whitespace-only mandatory identity and command keys", async () => {
        // Break caught: NOT NULL alone admits unusable command keys that collapse retry identity and provenance.
        const owner = await seed("tenant-key-shape", "keys");
        const assignmentOwner = await seed("tenant-key-assignment", "assignment");
        await insertAssignment(owner);
        const group = await insertGroup(owner, "keys");
        const event = await insertEvent(owner, group.id, null, "keys");

        const whitespaceOnlyValues = [
            ["empty", ""],
            ["space", "   "],
            ["tab", "\t"],
            ["newline", "\n"],
            ["mixed", "\t \n"],
        ] as const;
        for (const [index, [suffix, key]] of whitespaceOnlyValues.entries()) {
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO loan_intermediary_assignments
                    (tenant_id, loan_id, intermediary_id, role, effective_from, idempotency_key,
                     created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-key-assignment', ${assignmentOwner.loan.id}, ${assignmentOwner.intermediary.id}, 'collection',
                     ${`2027-01-${String(index + 1).padStart(2, "0")}`}::timestamptz, ${key},
                     ${assignmentOwner.actor.id}, ${assignmentOwner.actor.id})
            `), "23514");
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_disbursement_groups
                    (tenant_id, loan_id, intermediary_id, expected_funding_amount,
                     expected_borrower_payout_amount, expected_advance_interest_return_amount,
                     retained_balance_amount, status, idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-key-shape', ${owner.loan.id}, ${owner.intermediary.id}, 5000.00,
                     4400.00, 600.00, 0.00, 'draft', ${key}, ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_disbursement_groups
                    (tenant_id, loan_id, intermediary_id, expected_funding_amount,
                     expected_borrower_payout_amount, expected_advance_interest_return_amount,
                     retained_balance_amount, status, idempotency_key, post_idempotency_key,
                     posted_at, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-key-shape', ${owner.loan.id}, ${owner.intermediary.id}, 5000.00,
                     4400.00, 600.00, 0.00, 'posted', ${`posted-group-${suffix}`}, ${key},
                     now(), ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_transfer_events
                    (tenant_id, group_id, role, channel, amount, transferred_at, status,
                     idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-key-shape', ${group.id}, 'borrower_net_payout', 'cash', 1.00,
                     now(), 'draft', ${key}, ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_transfer_events
                    (tenant_id, group_id, role, channel, amount, bank_reference_hash,
                     transferred_at, status, idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-key-shape', ${group.id}, 'borrower_net_payout', 'cash', 1.00, ${key},
                     now(), 'draft', ${`bank-reference-${suffix}`}, ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
            for (const [field, bankName, accountName, accountNumberHash] of [
                ["bank-name", key, "Intermediary", `account-hash-${suffix}-bank-name`],
                ["account-name", "KBank", key, `account-hash-${suffix}-account-name`],
                ["account-hash", "KBank", "Intermediary", key],
            ] as const) {
                await expectDatabaseCode(() => db.execute(sql`
                    INSERT INTO intermediary_bank_accounts
                        (tenant_id, intermediary_id, bank_name, account_name, account_number_last4,
                         account_number_hash, status, note, created_by_user_id, updated_by_user_id)
                    VALUES
                        ('tenant-key-shape', ${owner.intermediary.id}, ${bankName}, ${accountName}, '1234',
                         ${accountNumberHash}, 'active', ${field}, ${owner.actor.id}, ${owner.actor.id})
                `), "23514");
            }

            const file = await db.execute(sql`
                INSERT INTO files (tenant_id, owner_user_id, bucket, key, mime_type, size)
                VALUES ('tenant-key-shape', ${owner.actor.id}, 'evidence', ${`key-shape-${suffix}.jpg`}, 'image/jpeg', 10)
                RETURNING id
            `).then((rows) => rows[0]!);
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_transfer_evidence_intents
                    (tenant_id, event_id, file_id, status, evidence_hash, mime_type, declared_size,
                     upload_expires_at, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-key-shape', ${event.id}, ${file.id}, 'pending', ${key}, 'image/jpeg', 10,
                     now() + interval '5 minutes', ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_transfer_evidence_intents
                    (tenant_id, event_id, file_id, status, evidence_hash, mime_type, declared_size,
                     upload_expires_at, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-key-shape', ${event.id}, ${file.id}, 'pending', ${`evidence-hash-${suffix}`}, ${key}, 10,
                     now() + interval '5 minutes', ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_disbursement_group_previews
                    (tenant_id, group_id, version, status, expected_funding_amount, actual_funding_amount,
                     expected_borrower_payout_amount, actual_borrower_payout_amount,
                     expected_advance_interest_return_amount, actual_advance_interest_return_amount,
                     retained_balance_amount, variance_amount, evidence_ready, preview_hash, expires_at,
                     created_by_user_id)
                VALUES
                    ('tenant-key-shape', ${group.id}, ${index + 1}, 'needs_review',
                     5000.00, 0.00, 4400.00, 0.00, 600.00, 0.00, 0.00, 0.00, false, ${key},
                     now() + interval '5 minutes', ${owner.actor.id})
            `), "23514");
        }
    });

    integrationTest("rejects non-finite numeric money including signed preview variance", async () => {
        // Break caught: PostgreSQL numeric NaN/Infinity values can satisfy ordinary comparison and scale checks.
        const owner = await seed("tenant-finite-money", "money");
        await insertAssignment(owner);
        const group = await insertGroup(owner, "finite");

        for (const [suffix, amount] of [["nan", "NaN"], ["infinity", "Infinity"], ["negative-infinity", "-Infinity"]] as const) {
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_transfer_events
                    (tenant_id, group_id, role, channel, amount, transferred_at, status,
                     idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-finite-money', ${group.id}, 'borrower_net_payout', 'cash', ${amount}::numeric,
                     now(), 'draft', ${`non-finite-event-${suffix}`}, ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
        }

        for (const [suffix, funding, borrower, advance, retained] of [
            ["nan", "NaN", "NaN", "0", "0"],
            ["infinity", "Infinity", "Infinity", "0", "0"],
            ["negative-infinity", "0", "Infinity", "0", "-Infinity"],
        ] as const) {
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_disbursement_groups
                    (tenant_id, loan_id, intermediary_id, expected_funding_amount,
                     expected_borrower_payout_amount, expected_advance_interest_return_amount,
                     retained_balance_amount, status, idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-finite-money', ${owner.loan.id}, ${owner.intermediary.id}, ${funding}::numeric,
                     ${borrower}::numeric, ${advance}::numeric, ${retained}::numeric, 'draft',
                     ${`non-finite-group-${suffix}`}, ${owner.actor.id}, ${owner.actor.id})
            `), "23514");
        }

        for (const [suffix, expectedFunding, expectedBorrower, actualFunding, actualBorrower, variance] of [
            ["nan", "NaN", "NaN", "NaN", "0", "NaN"],
            ["infinity", "Infinity", "Infinity", "Infinity", "0", "Infinity"],
            ["negative-infinity", "5000", "4400", "0", "Infinity", "-Infinity"],
        ] as const) {
            await expectDatabaseCode(() => db.execute(sql`
                INSERT INTO intermediated_disbursement_group_previews
                    (tenant_id, group_id, version, status, expected_funding_amount, actual_funding_amount,
                     expected_borrower_payout_amount, actual_borrower_payout_amount,
                     expected_advance_interest_return_amount, actual_advance_interest_return_amount,
                     retained_balance_amount, variance_amount, evidence_ready, preview_hash, expires_at,
                     created_by_user_id)
                VALUES
                    ('tenant-finite-money', ${group.id}, ${suffix === "nan" ? 1 : suffix === "infinity" ? 2 : 3},
                     'needs_review', ${expectedFunding}::numeric, ${actualFunding}::numeric,
                     ${expectedBorrower}::numeric, ${actualBorrower}::numeric,
                     ${suffix === "negative-infinity" ? "600" : "0"}::numeric, 0.00,
                     0.00, ${variance}::numeric, false, ${`non-finite-preview-${suffix}`},
                     now() + interval '5 minutes', ${owner.actor.id})
            `), "23514");
        }
    });

    integrationTest("accepts every supported role and freezes ready evidence intents", async () => {
        // Break caught: a documented transfer role is rejected, or finalized upload provenance remains mutable.
        const owner = await seed("tenant-positive-enums", "roles");
        const account = await insertAccount(owner, "roles");
        await insertAssignment(owner);
        const group = await insertGroup(owner, "roles");
        for (const [index, role] of ["funding_to_intermediary", "borrower_net_payout", "advance_interest_return"].entries()) {
            await db.execute(sql`
                INSERT INTO intermediated_transfer_events
                    (tenant_id, group_id, intermediary_bank_account_id, role, channel, amount,
                     transferred_at, status, idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES
                    ('tenant-positive-enums', ${group.id}, ${account.id}, ${role}, 'bank_transfer',
                     1.00, now(), 'ready', ${`positive-role-${index}`}, ${owner.actor.id}, ${owner.actor.id})
            `);
        }

        const event = await insertEvent(owner, group.id, account.id, "intent");
        const file = await db.execute(sql`
            INSERT INTO files (tenant_id, owner_user_id, bucket, key, mime_type, size)
            VALUES ('tenant-positive-enums', ${owner.actor.id}, 'evidence', 'ready-intent.jpg', 'image/jpeg', 10)
            RETURNING id
        `).then((rows) => rows[0]!);
        const intent = await db.execute(sql`
            INSERT INTO intermediated_transfer_evidence_intents
                (tenant_id, event_id, file_id, status, evidence_hash, mime_type, declared_size,
                 upload_expires_at, finalized_at, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-positive-enums', ${event.id}, ${file.id}, 'ready', 'ready-intent-sha',
                 'image/jpeg', 10, now() + interval '5 minutes', now(), ${owner.actor.id}, ${owner.actor.id})
            RETURNING id
        `).then((rows) => rows[0]!);
        await expectDatabaseCode(() => db.execute(sql`
            UPDATE intermediated_transfer_evidence_intents SET evidence_hash = 'changed'
            WHERE id = ${intent.id}
        `), "P0001");
        await expectDatabaseCode(() => db.execute(sql`
            DELETE FROM intermediated_transfer_evidence_intents WHERE id = ${intent.id}
        `), "P0001");
    });

    integrationTest("keeps event command keys and bank references unique within a tenant", async () => {
        // Break caught: command replay or the same transfer reference creates a second cash movement.
        const owner = await seed("tenant-event-unique", "events");
        const account = await insertAccount(owner, "event-unique");
        await insertAssignment(owner);
        const group = await insertGroup(owner, "event-unique");
        await insertEvent(owner, group.id, account.id, "unique");

        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_transfer_events
                (tenant_id, group_id, intermediary_bank_account_id, role, channel, amount,
                 bank_reference, bank_reference_hash, transferred_at, status, idempotency_key,
                 created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-event-unique', ${group.id}, ${account.id}, 'borrower_net_payout', 'bank_transfer',
                 4400.00, 'OTHER', 'other-reference-hash', now(), 'draft',
                 'event-tenant-event-unique-unique', ${owner.actor.id}, ${owner.actor.id})
        `), "23505");
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_transfer_events
                (tenant_id, group_id, intermediary_bank_account_id, role, channel, amount,
                 bank_reference, bank_reference_hash, transferred_at, status, idempotency_key,
                 created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-event-unique', ${group.id}, ${account.id}, 'borrower_net_payout', 'bank_transfer',
                 4400.00, 'REF-unique', 'ref-hash-tenant-event-unique-unique', now(), 'draft',
                 'other-event-key', ${owner.actor.id}, ${owner.actor.id})
        `), "23505");
    });

    integrationTest("keeps event evidence provenance unique and finalized links immutable", async () => {
        // Break caught: a slip is linked twice, reused for another event, or detached after finalization.
        const owner = await seed("tenant-evidence", "evidence");
        const account = await insertAccount(owner, "evidence");
        await insertAssignment(owner);
        const group = await insertGroup(owner, "evidence");
        const event = await insertEvent(owner, group.id, account.id, "evidence");
        const file = await db.execute(sql`
            INSERT INTO files (tenant_id, owner_user_id, bucket, key, mime_type, size)
            VALUES ('tenant-evidence', ${owner.actor.id}, 'evidence', 'transfer/evidence.jpg', 'image/jpeg', 10)
            RETURNING id
        `).then((rows) => rows[0]!);

        await db.execute(sql`
            INSERT INTO intermediated_transfer_evidence_intents
                (tenant_id, event_id, file_id, status, evidence_hash, mime_type, declared_size,
                 upload_expires_at, finalized_at, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-evidence', ${event.id}, ${file.id}, 'ready', 'evidence-sha', 'image/jpeg', 10,
                 now() + interval '5 minutes', now(), ${owner.actor.id}, ${owner.actor.id})
        `);
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_transfer_evidence_intents
                (tenant_id, event_id, file_id, status, evidence_hash, mime_type, declared_size,
                 upload_expires_at, finalized_at, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-evidence', ${event.id}, ${file.id}, 'ready', 'evidence-sha', 'image/jpeg', 10,
                 now() + interval '5 minutes', now(), ${owner.actor.id}, ${owner.actor.id})
        `), "23505");

        await db.execute(sql`
            INSERT INTO intermediated_transfer_evidence (tenant_id, event_id, file_id, created_by_user_id)
            VALUES ('tenant-evidence', ${event.id}, ${file.id}, ${owner.actor.id})
        `);
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_transfer_evidence (tenant_id, event_id, file_id, created_by_user_id)
            VALUES ('tenant-evidence', ${event.id}, ${file.id}, ${owner.actor.id})
        `), "23505");
        await expectDatabaseCode(() => db.execute(sql`
            DELETE FROM intermediated_transfer_evidence
            WHERE tenant_id = 'tenant-evidence' AND event_id = ${event.id} AND file_id = ${file.id}
        `), "P0001");
    });

    integrationTest("requires expiring hashed versioned previews with exact totals", async () => {
        // Break caught: a stale or unidentifiable preview can be selected for financial posting.
        const owner = await seed("tenant-preview", "preview");
        await insertAssignment(owner);
        const group = await insertGroup(owner, "preview");

        await db.execute(sql`
            INSERT INTO intermediated_disbursement_group_previews
                (tenant_id, group_id, version, status, expected_funding_amount, actual_funding_amount,
                 expected_borrower_payout_amount, actual_borrower_payout_amount,
                 expected_advance_interest_return_amount, actual_advance_interest_return_amount,
                 retained_balance_amount, variance_amount, evidence_ready, preview_hash, expires_at,
                 created_by_user_id)
            VALUES
                ('tenant-preview', ${group.id}, 1, 'ready', 5000.00, 5000.00, 4400.00, 4400.00,
                 600.00, 600.00, 0.00, 0.00, true, 'preview-hash', now() + interval '5 minutes',
                 ${owner.actor.id})
        `);

        for (const [version, hash, expiry, amount] of [
            [0, "hash", "now() + interval '5 minutes'", "5000.00"],
            [2, "", "now() + interval '5 minutes'", "5000.00"],
            [2, "hash", "now() - interval '1 second'", "5000.00"],
            [2, "hash", "now() + interval '5 minutes'", "5000.001"],
        ]) {
            await expectDatabaseCode(() => db.execute(sql.raw(`
                INSERT INTO intermediated_disbursement_group_previews
                    (tenant_id, group_id, version, status, expected_funding_amount, actual_funding_amount,
                     expected_borrower_payout_amount, actual_borrower_payout_amount,
                     expected_advance_interest_return_amount, actual_advance_interest_return_amount,
                     retained_balance_amount, variance_amount, evidence_ready, preview_hash, expires_at,
                     created_by_user_id)
                VALUES
                    ('tenant-preview', ${group.id}, ${version}, 'ready', ${amount}, 5000.00, 4400.00, 4400.00,
                     600.00, 600.00, 0.00, 0.00, true, '${hash}', ${expiry}, ${owner.actor.id})
            `)), "23514");
        }
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_disbursement_group_previews
                (tenant_id, group_id, version, status, expected_funding_amount, actual_funding_amount,
                 expected_borrower_payout_amount, actual_borrower_payout_amount,
                 expected_advance_interest_return_amount, actual_advance_interest_return_amount,
                 retained_balance_amount, variance_amount, evidence_ready, preview_hash, expires_at,
                 created_by_user_id)
            VALUES
                ('tenant-preview', ${group.id}, 2, 'ready', 5000.00, 4999.00, 4400.00, 4400.00,
                 600.00, 600.00, 0.00, -1.00, false, 'not-ready-hash', now() + interval '5 minutes',
                 ${owner.actor.id})
        `), "23514");
        await expectDatabaseCode(() => db.execute(sql`
            INSERT INTO intermediated_disbursement_group_previews
                (tenant_id, group_id, version, status, expected_funding_amount, actual_funding_amount,
                 expected_borrower_payout_amount, actual_borrower_payout_amount,
                 expected_advance_interest_return_amount, actual_advance_interest_return_amount,
                 retained_balance_amount, variance_amount, evidence_ready, preview_hash, expires_at,
                 created_by_user_id)
            VALUES
                ('tenant-preview', ${group.id}, 1, 'ready', 5000.00, 5000.00, 4400.00, 4400.00,
                 600.00, 600.00, 0.00, 0.00, true, 'other-hash', now() + interval '5 minutes',
                 ${owner.actor.id})
        `), "23505");
    });

    integrationTest("allows draft posting transitions then freezes posted and compensating reversal rows", async () => {
        // Break caught: posted financial facts can be edited/deleted, or the draft-to-post transition is accidentally blocked.
        const owner = await seed("tenant-immutable", "immutability");
        const account = await insertAccount(owner, "immutability");
        await insertAssignment(owner);
        const group = await insertGroup(owner, "draft");
        const event = await insertEvent(owner, group.id, account.id, "draft");

        await db.execute(sql`
            UPDATE intermediated_transfer_events SET status = 'posted', posted_at = now()
            WHERE id = ${event.id}
        `);
        await db.execute(sql`
            UPDATE intermediated_disbursement_groups
            SET status = 'posted', post_idempotency_key = 'immutable-post-key', posted_at = now()
            WHERE id = ${group.id}
        `);
        await expectDatabaseCode(() => db.execute(sql`
            UPDATE intermediated_transfer_events SET amount = 4999.00 WHERE id = ${event.id}
        `), "P0001");
        await expectDatabaseCode(() => db.execute(sql`
            DELETE FROM intermediated_disbursement_groups WHERE id = ${group.id}
        `), "P0001");

        const reversalGroup = await db.execute(sql`
            INSERT INTO intermediated_disbursement_groups
                (tenant_id, loan_id, intermediary_id, expected_funding_amount,
                 expected_borrower_payout_amount, expected_advance_interest_return_amount,
                 retained_balance_amount, status, idempotency_key, reversed_group_id,
                 reversal_idempotency_key, reversal_request_hash, reversal_reason,
                 posted_at, reversed_at, created_by_user_id, updated_by_user_id)
            VALUES
                ('tenant-immutable', ${owner.loan.id}, ${owner.intermediary.id}, 5000.00,
                 4400.00, 600.00, 0.00, 'reversed', 'reversal-group', ${group.id},
                 'reversal-key', 'reversal-hash', 'operator correction', now(), now(),
                 ${owner.actor.id}, ${owner.actor.id})
            RETURNING id
        `).then((rows) => rows[0]!);
        await expectDatabaseCode(() => db.execute(sql`
            UPDATE intermediated_disbursement_groups SET reversal_reason = 'changed'
            WHERE id = ${reversalGroup.id}
        `), "P0001");
    });
});
