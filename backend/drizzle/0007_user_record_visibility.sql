ALTER TABLE "borrowers" ADD COLUMN "owner_user_id" integer;
ALTER TABLE "borrowers" ADD CONSTRAINT "borrowers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "owner_user_id" integer;
ALTER TABLE "loans" ADD CONSTRAINT "loans_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "owner_user_id" integer;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "owner_user_id" integer;
ALTER TABLE "files" ADD CONSTRAINT "files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
WITH ranked_users AS (
    SELECT
        id,
        tenant_id,
        row_number() OVER (
            PARTITION BY tenant_id
            ORDER BY
                CASE role
                    WHEN 'owner' THEN 0
                    WHEN 'manager' THEN 1
                    ELSE 2
                END,
                created_at,
                id
        ) AS rn
    FROM "users"
)
UPDATE "borrowers" AS b
SET "owner_user_id" = ru.id
FROM ranked_users AS ru
WHERE b."owner_user_id" IS NULL
  AND b."tenant_id" = ru.tenant_id
  AND ru.rn = 1;
--> statement-breakpoint
WITH ranked_users AS (
    SELECT
        id,
        tenant_id,
        row_number() OVER (
            PARTITION BY tenant_id
            ORDER BY
                CASE role
                    WHEN 'owner' THEN 0
                    WHEN 'manager' THEN 1
                    ELSE 2
                END,
                created_at,
                id
        ) AS rn
    FROM "users"
)
UPDATE "loans" AS l
SET "owner_user_id" = COALESCE(
    (
        SELECT b."owner_user_id"
        FROM "borrowers" AS b
        WHERE b."id" = l."borrower_id"
    ),
    (
        SELECT ru.id
        FROM ranked_users AS ru
        WHERE ru.tenant_id = l."tenant_id"
          AND ru.rn = 1
    )
)
WHERE l."owner_user_id" IS NULL;
--> statement-breakpoint
WITH ranked_users AS (
    SELECT
        id,
        tenant_id,
        row_number() OVER (
            PARTITION BY tenant_id
            ORDER BY
                CASE role
                    WHEN 'owner' THEN 0
                    WHEN 'manager' THEN 1
                    ELSE 2
                END,
                created_at,
                id
        ) AS rn
    FROM "users"
)
UPDATE "loans" AS l
SET "owner_user_id" = ru.id
FROM ranked_users AS ru
WHERE l."owner_user_id" IS NULL
  AND l."tenant_id" = ru.tenant_id
  AND ru.rn = 1;
--> statement-breakpoint
WITH ranked_users AS (
    SELECT
        id,
        tenant_id,
        row_number() OVER (
            PARTITION BY tenant_id
            ORDER BY
                CASE role
                    WHEN 'owner' THEN 0
                    WHEN 'manager' THEN 1
                    ELSE 2
                END,
                created_at,
                id
        ) AS rn
    FROM "users"
)
UPDATE "transactions" AS t
SET "owner_user_id" = COALESCE(
    (
        SELECT l."owner_user_id"
        FROM "loans" AS l
        WHERE l."id" = t."loan_id"
    ),
    t."recorded_by_user_id",
    (
        SELECT ru.id
        FROM ranked_users AS ru
        WHERE ru.tenant_id = t."tenant_id"
          AND ru.rn = 1
    )
)
WHERE t."owner_user_id" IS NULL;
--> statement-breakpoint
WITH ranked_users AS (
    SELECT
        id,
        tenant_id,
        row_number() OVER (
            PARTITION BY tenant_id
            ORDER BY
                CASE role
                    WHEN 'owner' THEN 0
                    WHEN 'manager' THEN 1
                    ELSE 2
                END,
                created_at,
                id
        ) AS rn
    FROM "users"
)
UPDATE "files" AS f
SET "owner_user_id" = ru.id
FROM ranked_users AS ru
WHERE f."owner_user_id" IS NULL
  AND f."tenant_id" = ru.tenant_id
  AND ru.rn = 1;
