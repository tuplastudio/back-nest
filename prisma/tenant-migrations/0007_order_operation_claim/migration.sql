-- Claim columns for operations that move money on an order.
--
-- A refund or a charge calls the provider before the order row changes, so two
-- concurrent requests could both pass the status check and both reach the
-- provider. `operationClaim` / `operationClaimedAt` let one request claim the
-- order with a conditional update before it acts, and the pair is released when
-- the operation ends. A claim older than the claim window is treated as
-- abandoned, so a crashed instance cannot lock an order forever.

ALTER TABLE "payment_orders"
    ADD COLUMN IF NOT EXISTS "operationClaim" VARCHAR(16),
    ADD COLUMN IF NOT EXISTS "operationClaimedAt" TIMESTAMP(3);
