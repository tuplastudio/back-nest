-- PARTIALLY_REFUNDED (BN-REQ-PAY-005).
--
-- A partial refund used to leave the order PAID, which a storefront reading the
-- status could not tell apart from an untouched payment. It now moves the order
-- to PARTIALLY_REFUNDED; the refund that brings `refundedAmount` up to `amount`
-- moves it to REFUNDED.
--
-- Orders that were partly refunded before this migration stay PAID (their
-- `refundedAmount` already says how much went back); they become
-- PARTIALLY_REFUNDED or REFUNDED on their next refund.
--
-- ADD VALUE runs inside the runner's transaction (PostgreSQL 12+). The new
-- value is not used in this transaction, which is the one restriction.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED' AFTER 'PAID';
