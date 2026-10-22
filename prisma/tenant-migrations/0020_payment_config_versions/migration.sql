-- Versioned payment configuration (BN-REQ-CFG-002/003/004, BN-REQ-PAY-007/008).
--
-- `payment_provider_config` becomes append-only: every change of keys,
-- environment or settings inserts the next `version` and makes it the only
-- `active` row. Orders already carry `configId`, so a refund or verification of
-- an old order keeps using the credentials it was charged with.
--
-- Additive only. The existing row of each schema becomes version 1 and active; a
-- schema that somehow holds several keeps the newest active.

ALTER TABLE "payment_provider_config"
    ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "allowedReturnOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "allowedCurrencies" TEXT[] NOT NULL DEFAULT ARRAY['MXN']::TEXT[],
    ADD COLUMN IF NOT EXISTS "webhookDrift" BOOLEAN,
    ADD COLUMN IF NOT EXISTS "webhookDriftCheckedAt" TIMESTAMP(3);

-- Number the rows that exist, oldest first, and keep only the newest active.
UPDATE "payment_provider_config" AS c
   SET "version" = numbered.n,
       "active" = (numbered.n = numbered.total)
  FROM (
        SELECT "id",
               row_number() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS n,
               count(*) OVER () AS total
          FROM "payment_provider_config"
       ) AS numbered
 WHERE c."id" = numbered."id";

-- One active version per tenant schema: two concurrent saves cannot both win.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_provider_config_one_active"
    ON "payment_provider_config"("active") WHERE "active";
CREATE UNIQUE INDEX IF NOT EXISTS "payment_provider_config_version_key"
    ON "payment_provider_config"("version");
CREATE INDEX IF NOT EXISTS "payment_provider_config_active_version_idx"
    ON "payment_provider_config"("active", "version");
