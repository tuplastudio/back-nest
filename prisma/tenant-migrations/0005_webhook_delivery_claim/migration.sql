-- Claim columns for the shared outbound webhook queue.
--
-- The dispatcher runs on every instance, so two replicas can see the same due
-- delivery at the same time. `lockedAt` / `lockedBy` let a worker claim a row
-- before acting on it, and the pair is released on completion. A claim older
-- than the lock window is treated as abandoned, so a crashed instance strands
-- nothing.

ALTER TABLE "webhook_deliveries"
    ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lockedBy" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_lockedAt_idx"
    ON "webhook_deliveries"("status", "lockedAt");
