-- One Netpay transaction settles one order.
--
-- `netpayTransactionId` was only indexed (0004), so nothing in the database
-- stopped a genuine paid transaction from being bound to a second order of the
-- same amount. Verification now refuses that too (PaymentOrdersService
-- .applyVerification); this index makes it a guarantee. Partial, so the many
-- orders that have no transaction yet are unaffected.
--
-- Not CONCURRENTLY: the runner applies each schema inside a transaction. The
-- build takes a SHARE lock on payment_orders (writes wait, reads do not) for the
-- time it takes to index the rows that have a transaction.
--
-- If a schema already holds two orders with the same transaction, the index
-- cannot be built, that schema's transaction rolls back and the run fails
-- loudly; nothing is half-applied. Find them before deploying with:
--   SELECT "netpayTransactionId", array_agg(id) FROM payment_orders
--   WHERE "netpayTransactionId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- and resolve each by hand (only one of the orders was really paid by it).

CREATE UNIQUE INDEX IF NOT EXISTS "payment_orders_netpayTransactionId_key"
    ON "payment_orders"("netpayTransactionId")
    WHERE "netpayTransactionId" IS NOT NULL;
