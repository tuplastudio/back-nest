-- Charge attempts per order (BN-REQ-PAY-001/002).
--
-- An order used to hold a single transaction for life: once a charge was bound,
-- a buyer whose card was declined or who abandoned 3-D Secure could not pay the
-- same order with another card. Every charge sent to Netpay now gets a row here,
-- numbered per order; the order's `netpayTransactionId` points at the current
-- attempt, and the events describe that attempt.
--
-- `status` is the attempt's own outcome: SUBMITTED (sent, Netpay answered and
-- did not decline), UNKNOWN (sent, no definitive answer), FAILED (declined, with
-- `declineCode`), PAID, or ABANDONED (a 3-D Secure challenge never confirmed,
-- verified as not charged before the next attempt was accepted).
--
-- Additive only: a new table, safe on a live schema. Orders charged before this
-- migration have no row; their bound transaction counts as attempt 1.

CREATE TABLE IF NOT EXISTS "payment_attempt" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "netpayTransactionId" VARCHAR(120),
    "status" VARCHAR(32) NOT NULL,
    "declineCode" VARCHAR(32),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_attempt_orderId_fkey" FOREIGN KEY ("orderId")
        REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One number per attempt of an order: two writers racing cannot both be attempt 2.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_attempt_orderId_attemptNo_key"
    ON "payment_attempt"("orderId", "attemptNo");
CREATE INDEX IF NOT EXISTS "payment_attempt_netpayTransactionId_idx"
    ON "payment_attempt"("netpayTransactionId");

-- Same isolation as every other table in this schema.
ALTER TABLE "payment_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_attempt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payment_attempt_tenant_isolation" ON "payment_attempt";
CREATE POLICY "payment_attempt_tenant_isolation" ON "payment_attempt"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payment_attempt" TO mtb_app;
