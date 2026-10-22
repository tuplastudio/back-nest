-- CHARGE_UNKNOWN (BN-REQ-PAY-003).
--
-- A charge request that was sent to Netpay and got no definitive answer (timeout,
-- transport failure, 5xx) may or may not have charged the buyer. The order now
-- records that doubt as CHARGE_UNKNOWN instead of staying PENDING: a new charge
-- is refused with 409 ORDER_STATE_CONFLICT until a verification against Netpay
-- (`POST …/verify`, the inbound notification or reconciliation) resolves it to
-- PAID, FAILED or PENDING_VERIFICATION.
--
-- ADD VALUE runs inside the runner's transaction (PostgreSQL 12+). The new
-- value is not used in this transaction, which is the one restriction.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CHARGE_UNKNOWN' AFTER 'PENDING_VERIFICATION';
