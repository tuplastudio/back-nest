-- Payments and outbound webhooks.
--
-- Payment credentials, orders and webhook endpoints are tenant data, so they
-- live inside the tenant's own schema: the same isolation guarantee that covers
-- `users` covers a tenant's `sk_netpay_…` and its money.
--
-- The catalog of what a role may do lives in the control plane
-- (`public.permissions`), but no credential and no order ever does.

CREATE TYPE "PaymentEnvironment" AS ENUM ('SANDBOX', 'LIVE');

CREATE TYPE "PaymentStatus" AS ENUM (
  'PENDING',
  'PENDING_VERIFICATION',
  'PAID',
  'FAILED',
  'REFUNDED',
  'AMOUNT_MISMATCH'
);

CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED', 'AUTO_DISABLED');

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'DEAD');

-- --------------------------------------------------------------------------
-- Payments
-- --------------------------------------------------------------------------

CREATE TABLE "payment_provider_config" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "environment" "PaymentEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "publicKey" VARCHAR(200) NOT NULL,
    "secretKeyCiphertext" TEXT NOT NULL,
    "orderReferencePrefix" VARCHAR(24) NOT NULL,
    "webhookTokenHash" VARCHAR(64) NOT NULL,
    "webhookRegisteredAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_provider_config_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderReference" VARCHAR(120) NOT NULL,
    "merchantReferenceCode" VARCHAR(120) NOT NULL,
    "netpayTransactionId" VARCHAR(120),
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'MXN',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "checkoutMode" VARCHAR(16) NOT NULL DEFAULT 'hosted',
    "checkoutUrl" TEXT,
    "netpayCustomerId" VARCHAR(120),
    "verifiedAmount" DECIMAL(12,2),
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TIMESTAMP(3),
    "failureReason" VARCHAR(240),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "configId" UUID,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL,
    "eventId" VARCHAR(120) NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "netpayTransactionId" VARCHAR(120),
    "orderId" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "outcome" VARCHAR(64),
    "payloadSanitized" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_customers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID,
    "netpayCustomerId" VARCHAR(120) NOT NULL,
    "defaultTokenId" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_customers_pkey" PRIMARY KEY ("id")
);

-- --------------------------------------------------------------------------
-- Outbound webhooks
-- --------------------------------------------------------------------------

CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" VARCHAR(160),
    "secretCiphertext" TEXT NOT NULL,
    "previousSecretCiphertext" TEXT,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" VARCHAR(240),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "orderId" UUID,
    "eventId" VARCHAR(120) NOT NULL,
    "eventType" VARCHAR(64) NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "responseStatus" INTEGER,
    "durationMs" INTEGER,
    "error" VARCHAR(240),
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- --------------------------------------------------------------------------
-- Constraints and indexes
-- --------------------------------------------------------------------------

CREATE UNIQUE INDEX "payment_orders_orderReference_key" ON "payment_orders"("orderReference");
CREATE INDEX "payment_orders_tenantId_status_idx" ON "payment_orders"("tenantId", "status");
CREATE INDEX "payment_orders_netpayTransactionId_idx" ON "payment_orders"("netpayTransactionId");
CREATE INDEX "payment_provider_config_tenantId_idx" ON "payment_provider_config"("tenantId");
CREATE UNIQUE INDEX "payment_webhook_events_eventId_key" ON "payment_webhook_events"("eventId");
CREATE INDEX "payment_webhook_events_netpayTransactionId_idx" ON "payment_webhook_events"("netpayTransactionId");
CREATE INDEX "payment_webhook_events_orderId_idx" ON "payment_webhook_events"("orderId");
CREATE UNIQUE INDEX "payment_customers_netpayCustomerId_key" ON "payment_customers"("netpayCustomerId");
CREATE INDEX "payment_customers_tenantId_idx" ON "payment_customers"("tenantId");
CREATE INDEX "webhook_endpoints_tenantId_status_idx" ON "webhook_endpoints"("tenantId", "status");
CREATE INDEX "webhook_deliveries_endpointId_status_idx" ON "webhook_deliveries"("endpointId", "status");
CREATE INDEX "webhook_deliveries_orderId_idx" ON "webhook_deliveries"("orderId");
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");
CREATE INDEX "webhook_deliveries_eventId_idx" ON "webhook_deliveries"("eventId");

ALTER TABLE "payment_orders"
    ADD CONSTRAINT "payment_orders_configId_fkey"
    FOREIGN KEY ("configId") REFERENCES "payment_provider_config"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_webhook_events"
    ADD CONSTRAINT "payment_webhook_events_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "payment_orders"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_endpointId_fkey"
    FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "payment_orders"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- Row-level security
--
-- Same isolation as every other table in this schema: the policy compares the
-- transaction-scoped `app.current_tenant` with this schema's own name, so a
-- query issued without the binding reads nothing rather than reading another
-- tenant.
-- --------------------------------------------------------------------------

ALTER TABLE "payment_provider_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_provider_config" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_orders" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_webhook_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_customers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;

CREATE POLICY "payment_provider_config_tenant_isolation" ON "payment_provider_config"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

CREATE POLICY "payment_orders_tenant_isolation" ON "payment_orders"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

CREATE POLICY "payment_webhook_events_tenant_isolation" ON "payment_webhook_events"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

CREATE POLICY "payment_customers_tenant_isolation" ON "payment_customers"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

CREATE POLICY "webhook_endpoints_tenant_isolation" ON "webhook_endpoints"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

CREATE POLICY "webhook_deliveries_tenant_isolation" ON "webhook_deliveries"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

-- Data-plane grants: read and write the tenant's own payments, no ownership and
-- no CREATE.
GRANT USAGE ON SCHEMA __TENANT_SCHEMA__ TO mtb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "payment_provider_config", "payment_orders", "payment_webhook_events",
  "payment_customers", "webhook_endpoints", "webhook_deliveries"
  TO mtb_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA __TENANT_SCHEMA__
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mtb_app;