-- Server-issued amount token.
--
-- The buyer receives a token instead of a figure, so the amount that reaches
-- Netpay is the one the order decided. Keeping it on the order lets the button
-- be re-rendered on a retry without re-tokenising, and makes a mismatch auditable.

ALTER TABLE "payment_orders"
    ADD COLUMN IF NOT EXISTS "amountToken" VARCHAR(120);
