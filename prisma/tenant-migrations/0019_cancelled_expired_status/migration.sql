-- CANCELLED and EXPIRED (BN-REQ-PAY-004, BN-REQ-REC-002/003).
--
-- CANCELLED: the merchant withdrew an unpaid order (`POST …/orders/:id/cancel`).
-- EXPIRED: reconciliation found it never paid in time (3-D Secure abandoned for
-- 30 min, or a cash reference past its expiry).
--
-- Both are terminal and unpaid. A payment Netpay reports afterwards keeps the
-- status and sets `paidAfterCancelAt` (migration 0021).
--
-- ADD VALUE runs inside the runner's transaction (PostgreSQL 12+). The new
-- values are not used in this transaction, which is the one restriction.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELLED' AFTER 'AMOUNT_MISMATCH';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'EXPIRED' AFTER 'CANCELLED';
