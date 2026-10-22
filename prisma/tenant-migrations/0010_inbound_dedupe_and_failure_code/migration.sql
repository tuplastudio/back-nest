-- Inbound notification dedupe and normalised decline codes.
--
-- `inbound_event_seen` holds, for 10 minutes, the deterministic key
-- sha256(eventType|transactionId|status) of every inbound Netpay notification.
-- A copy seen inside the window is still recorded in `payment_webhook_events` as
-- evidence but is not verified against Netpay again (BN-REQ-IDM-005), which
-- removes the amplification an unsigned, retried notification allowed.
--
-- `failureCode` is the stable decline code a storefront and an event consumer can
-- branch on (BN-REQ-PAY-006); `providerFailureCode` keeps Netpay's original code
-- for diagnosis and is never returned.
--
-- Additive only: new nullable columns and a new table, safe on a live schema.

ALTER TABLE "payment_orders"
    ADD COLUMN IF NOT EXISTS "failureCode" VARCHAR(32),
    ADD COLUMN IF NOT EXISTS "providerFailureCode" VARCHAR(16);

CREATE TABLE IF NOT EXISTS "inbound_event_seen" (
    "key" CHAR(64) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_event_seen_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "inbound_event_seen_seenAt_idx" ON "inbound_event_seen"("seenAt");

-- Same isolation as every other table in this schema.
ALTER TABLE "inbound_event_seen" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbound_event_seen" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inbound_event_seen_tenant_isolation" ON "inbound_event_seen";
CREATE POLICY "inbound_event_seen_tenant_isolation" ON "inbound_event_seen"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "inbound_event_seen" TO mtb_app;
