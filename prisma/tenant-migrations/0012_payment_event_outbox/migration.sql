-- Transactional outbox of payment events (BN-REQ-EVT-004/005/006).
--
-- Every order state change writes its event here IN THE SAME TRANSACTION as the
-- change: a rollback leaves no event, and a commit followed by a crash leaves an
-- event the dispatcher still finds after the restart. Before this table the
-- event was queued fire-and-forget after the commit, so a crash in between lost
-- it, and the delivered body was rebuilt from the order's CURRENT row, so a
-- subscriber could receive `payment.paid` describing a refunded order.
--
-- `payload` is the snapshot delivered verbatim (eventId, eventType, occurredAt,
-- sequence, tenantId, data{…}); `occurredAt` is the moment of the change, not of
-- the delivery. `sequence` is per order and strictly increasing, assigned from
-- `payment_orders.eventSequence` with an atomic increment under the row lock.
--
-- `dispatchedAt` is set once the dispatcher has fanned the event out to one
-- `webhook_deliveries` row per subscribed endpoint; it reads pending events with
-- FOR UPDATE SKIP LOCKED, so several replicas never fan out the same event.
--
-- Additive only: a new table, a new column with a constant default and new
-- nullable columns, safe on a live schema.

ALTER TABLE "payment_orders"
    ADD COLUMN IF NOT EXISTS "eventSequence" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "payment_event_outbox" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "payment_event_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_event_outbox_orderId_fkey" FOREIGN KEY ("orderId")
        REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One event per (order, sequence): a second writer racing on the same order
-- fails instead of producing two events with one number.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_event_outbox_orderId_sequence_key"
    ON "payment_event_outbox"("orderId", "sequence");
-- The dispatcher's scan: pending first, oldest first.
CREATE INDEX IF NOT EXISTS "payment_event_outbox_dispatchedAt_occurredAt_idx"
    ON "payment_event_outbox"("dispatchedAt" NULLS FIRST, "occurredAt");

-- A delivery now points at the snapshot it delivers. Null for deliveries
-- queued before the outbox existed; those keep the previous behaviour.
ALTER TABLE "webhook_deliveries"
    ADD COLUMN IF NOT EXISTS "outboxId" UUID;
CREATE INDEX IF NOT EXISTS "webhook_deliveries_outboxId_idx" ON "webhook_deliveries"("outboxId");
ALTER TABLE "webhook_deliveries"
    DROP CONSTRAINT IF EXISTS "webhook_deliveries_outboxId_fkey";
ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_outboxId_fkey" FOREIGN KEY ("outboxId")
        REFERENCES "payment_event_outbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fan-out is idempotent: an event reaches an endpoint once, whatever replica
-- or retry produced the row (INSERT … ON CONFLICT DO NOTHING). Existing rows
-- already satisfy it: every event id was generated once per endpoint.
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_eventId_endpointId_key"
    ON "webhook_deliveries"("eventId", "endpointId");

-- Same isolation as every other table in this schema.
ALTER TABLE "payment_event_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_event_outbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payment_event_outbox_tenant_isolation" ON "payment_event_outbox";
CREATE POLICY "payment_event_outbox_tenant_isolation" ON "payment_event_outbox"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payment_event_outbox" TO mtb_app;
