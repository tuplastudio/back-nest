-- Audited replay of an outbound delivery (BN-REQ-EVT-010).
--
-- A replay used to reset `attempt` to 0, which erased how many times the
-- subscriber had already been tried and made the `X-MTBPay-Attempt` header lie.
-- The attempt counter now keeps counting; `replayedAt` restarts the retry
-- window (a replayed delivery is DEAD only after the window has passed since
-- the replay, not since the original event), and `attemptsBeforeReplay` (the
-- attempts made before it) lets the attempt cap count only those made since.
--
-- Who replayed it is recorded in the control-plane audit log.
--
-- Additive only: a nullable column and a column with a constant default.

ALTER TABLE "webhook_deliveries"
    ADD COLUMN IF NOT EXISTS "replayedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "attemptsBeforeReplay" INTEGER NOT NULL DEFAULT 0;
