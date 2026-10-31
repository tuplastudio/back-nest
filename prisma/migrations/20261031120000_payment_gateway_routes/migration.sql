-- Routing table for gateway webhooks (docs 33).
--
-- A Stripe / Mercado Pago webhook names the connected account (`event.account`,
-- `user_id`), never the tenant; a Conekta / Openpay one carries an opaque
-- per-tenant token in its URL, kept here only as its SHA-256. This is the index
-- that turns either into a tenant schema. No credential lives here.
--
-- Additive: one new table.

CREATE TABLE "payment_gateway_routes" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "externalAccountId" VARCHAR(64) NOT NULL,
    "tenantId" UUID NOT NULL,
    "schemaName" VARCHAR(63) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "payment_gateway_routes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_gateway_routes_externalAccountId_key" ON "payment_gateway_routes"("externalAccountId");
CREATE INDEX "payment_gateway_routes_tenantId_idx" ON "payment_gateway_routes"("tenantId");

-- Control-plane state: the tenant role has no business routing webhooks.
REVOKE ALL ON TABLE "payment_gateway_routes" FROM mtb_app;
