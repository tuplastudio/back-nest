-- Idempotency keys for the money-moving routes (BN-REQ-IDM-001/002/003).
--
-- `POST /t/payments/orders`, `…/charge`, `…/confirm` and `…/refund` accept an
-- optional `Idempotency-Key` header. The first request with a key inserts its row
-- here as IN_PROGRESS (INSERT … ON CONFLICT DO NOTHING decides the winner in the
-- database, so it holds across instances) and stores the response once it is
-- known (DONE). A repeat with the same key and the same body gets the stored
-- response without the provider being called; with a different body it is
-- refused (422 IDEMPOTENCY_KEY_REUSED); while the first is still running it is
-- refused with 409 IDEMPOTENCY_IN_PROGRESS and `Retry-After`.
--
-- `route` is the method and the concrete path (order id included), so one key
-- cannot be replayed against another order. `requestHash` is the SHA-256 of the
-- canonical JSON body. `expiresAt` is 24 h after a DONE response; an IN_PROGRESS
-- row (still running, or a 5xx/504 whose outcome is unknown) expires 10 min
-- after it was last touched, so reconciliation can settle the order before the
-- key may be used again. Expired rows are replaced on the way in.
--
-- Additive only: a new table, safe on a live schema.

CREATE TABLE IF NOT EXISTS "idempotency_record" (
    "key" VARCHAR(255) NOT NULL,
    "route" VARCHAR(255) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("key", "route"),
    CONSTRAINT "idempotency_record_status_check" CHECK ("status" IN ('IN_PROGRESS', 'DONE'))
);

CREATE INDEX IF NOT EXISTS "idempotency_record_expiresAt_idx" ON "idempotency_record"("expiresAt");

-- Same isolation as every other table in this schema.
ALTER TABLE "idempotency_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_record" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idempotency_record_tenant_isolation" ON "idempotency_record";
CREATE POLICY "idempotency_record_tenant_isolation" ON "idempotency_record"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "idempotency_record" TO mtb_app;
