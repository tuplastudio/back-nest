-- Cash payments (OXXO Pay) and partial refunds on a payment order.
--
-- `paymentMethod` / `paymentReference` record how the buyer paid and, for cash,
-- the reference they take to the store. A reference created by the buyer on the
-- hosted page is reported by Netpay (`cep.created`) and attached here so the
-- later `oxxopay.paid` notification can be matched to the order.
--
-- `refundedAmount` is the running total returned to the buyer. A refund can be
-- partial; the order only becomes REFUNDED when the total reaches `amount`.

ALTER TABLE "payment_orders"
    ADD COLUMN IF NOT EXISTS "paymentMethod" VARCHAR(16),
    ADD COLUMN IF NOT EXISTS "paymentReference" VARCHAR(64),
    ADD COLUMN IF NOT EXISTS "paymentReferenceExpiresAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "payment_orders_paymentReference_idx"
    ON "payment_orders"("paymentReference");
