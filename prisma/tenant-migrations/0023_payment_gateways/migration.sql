-- Alternative payment gateways: Stripe Connect, Mercado Pago, Conekta and Openpay (docs 33).
--
-- `provider` says which gateway holds an order's payment. Existing rows are all
-- Netpay, which is what the default says. For a gateway order the gateway's own
-- id (`pi_…`, MP payment, Conekta order, Openpay charge) goes in `netpayTransactionId`, so the partial unique
-- index of 0022 (one transaction settles one order) covers it unchanged.
--
-- The `gateway*` card columns hold what a Stripe Checkout with `saveCard` left
-- behind (customer, payment method, brand, last four) for charge-stored. Never
-- a card number.
--
-- `payment_gateway_accounts`: the tenant's connected account, one row per
-- provider. Mercado Pago tokens and Conekta / Openpay private keys are stored
-- encrypted (PaymentSecretBox); `webhookId` is the webhook registered with a
-- keys gateway, deleted again on disconnect.
--
-- Additive only. The constant DEFAULT is a catalog-only change in PostgreSQL 11+,
-- no table rewrite.

ALTER TABLE "payment_orders"
    ADD COLUMN IF NOT EXISTS "provider" VARCHAR(16) NOT NULL DEFAULT 'NETPAY',
    ADD COLUMN IF NOT EXISTS "gatewayCustomerId" VARCHAR(120),
    ADD COLUMN IF NOT EXISTS "gatewayPaymentMethodId" VARCHAR(120),
    ADD COLUMN IF NOT EXISTS "gatewayCardBrand" VARCHAR(32),
    ADD COLUMN IF NOT EXISTS "gatewayCardLast4" VARCHAR(4);

CREATE TABLE IF NOT EXISTS "payment_gateway_accounts" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "externalAccountId" VARCHAR(64) NOT NULL,
    "environment" VARCHAR(8) NOT NULL,
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "publicKey" VARCHAR(255),
    "webhookId" VARCHAR(64),
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_gateway_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_gateway_accounts_provider_key"
    ON "payment_gateway_accounts"("provider");
