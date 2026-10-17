-- Routing table for inbound Netpay notifications.
--
-- The inbound notification is unsigned, so the `X-Tenant-Id` header cannot be
-- trusted to name a tenant, and the per-tenant configuration rows live inside
-- each tenant's own schema where they cannot be searched. This is the single
-- index that turns an opaque webhook token into a tenant.
--
-- It holds no credential: only a hash of the opaque token and a pointer to the
-- schema that holds the encrypted key.

CREATE TYPE "PaymentWebhookEnvironment" AS ENUM ('SANDBOX', 'LIVE');

CREATE TABLE "payment_webhook_registry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "schemaName" VARCHAR(63) NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "environment" "PaymentWebhookEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "payment_webhook_registry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_webhook_registry_tokenHash_key" ON "payment_webhook_registry"("tokenHash");
CREATE INDEX "payment_webhook_registry_tenantId_idx" ON "payment_webhook_registry"("tenantId");
CREATE INDEX "payment_webhook_registry_schemaName_idx" ON "payment_webhook_registry"("schemaName");

-- Deliberately no uniqueness on (tenantId, schemaName): rotating the token has
-- to be able to register the replacement while the previous one is still
-- accepted, so more than one row per tenant is expected and legitimate.
-- `revokedAt` is what stops an old token from routing.

-- Data-plane least privilege: the tenant role has no business routing webhooks,
-- and a registry entry is control-plane state.
REVOKE ALL ON TABLE "payment_webhook_registry" FROM mtb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mtb_control IN SCHEMA public
    REVOKE ALL ON TABLES FROM mtb_app;