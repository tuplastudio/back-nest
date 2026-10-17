-- Checkout Hosted session id.
--
-- The `sessionLink.paid` notification identifies the payment by `sessionId` and
-- carries neither the order reference nor the merchant reference code, so the
-- session id is the only way to find the order a hosted payment belongs to.

ALTER TABLE "payment_orders"
    ADD COLUMN IF NOT EXISTS "checkoutSessionId" VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_orders_checkoutSessionId_key"
    ON "payment_orders"("checkoutSessionId");
