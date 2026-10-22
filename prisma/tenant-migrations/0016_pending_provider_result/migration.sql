-- Provider results waiting to be applied locally (BN-REQ-IDM-004).
--
-- When Netpay confirms a refund or a charge and the local write that records it
-- fails, the result is not lost: it is written here with a separate, minimal
-- insert, and the order keeps its operation claim. While a row of an order has
-- no `appliedAt`, no other money-moving operation can claim that order.
-- Reconciliation applies each row once (`applyPendingProviderResults`): the row
-- is locked with FOR UPDATE SKIP LOCKED and marked applied in the same
-- transaction that changes the order.
--
-- `providerPayload` holds only what is needed to apply the result (operation,
-- transaction id, amounts, decline code); never card data.
--
-- Additive only: a new table, safe on a live schema.

CREATE TABLE IF NOT EXISTS "pending_provider_result" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "operation" VARCHAR(16) NOT NULL,
    "providerPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "outcome" VARCHAR(32),

    CONSTRAINT "pending_provider_result_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_provider_result_orderId_fkey" FOREIGN KEY ("orderId")
        REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The applier's scan: unapplied first, oldest first.
CREATE INDEX IF NOT EXISTS "pending_provider_result_appliedAt_createdAt_idx"
    ON "pending_provider_result"("appliedAt" NULLS FIRST, "createdAt");
CREATE INDEX IF NOT EXISTS "pending_provider_result_orderId_idx" ON "pending_provider_result"("orderId");

-- Same isolation as every other table in this schema.
ALTER TABLE "pending_provider_result" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_provider_result" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pending_provider_result_tenant_isolation" ON "pending_provider_result";
CREATE POLICY "pending_provider_result_tenant_isolation" ON "pending_provider_result"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pending_provider_result" TO mtb_app;
