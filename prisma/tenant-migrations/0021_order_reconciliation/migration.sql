-- Reconciliation and late payments (BN-REQ-REC-001…005, BN-REQ-PAY-004).
--
-- `paidAfterCancelAt`: Netpay reported a payment for an order already CANCELLED
-- or EXPIRED. The status stays (the merchant decided), the flag records the
-- money, and `payment.paid_after_cancel` tells the consumer to refund.
--
-- `reconcileLeaseUntil`: the reconciliation worker takes a short lease on each
-- order it checks (`FOR UPDATE SKIP LOCKED` + this column), so two instances
-- never ask Netpay about the same order in the same pass. Written with raw SQL,
-- so it never moves `updatedAt`.
--
-- Additive only.

ALTER TABLE "payment_orders"
    ADD COLUMN IF NOT EXISTS "paidAfterCancelAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "reconcileLeaseUntil" TIMESTAMP(3);

-- Reconciliation scans non-terminal statuses by age; the consumer list pages by
-- (updatedAt, id).
CREATE INDEX IF NOT EXISTS "payment_orders_status_updatedAt_idx" ON "payment_orders"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "payment_orders_updatedAt_id_idx" ON "payment_orders"("updatedAt", "id");
