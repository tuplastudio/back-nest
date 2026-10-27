-- Quick links públicos de cobro (vondi.tupla.dev/l/<code>).
--
-- Additiva: una tabla nueva en el plano de control. El código resuelve tenant y orden
-- para la ruta pública sin sesión; la URL de checkout de Netpay se persiste porque el
-- proveedor no la devuelve después de crear la sesión.

CREATE TABLE "payment_quick_links" (
    "id" UUID NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "tenantId" UUID NOT NULL,
    "schemaName" VARCHAR(63) NOT NULL,
    "orderId" UUID NOT NULL,
    "hostedCheckoutUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_quick_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_quick_links_code_key" ON "payment_quick_links"("code");
CREATE INDEX "payment_quick_links_tenantId_idx" ON "payment_quick_links"("tenantId");
CREATE INDEX "payment_quick_links_tenantId_orderId_idx" ON "payment_quick_links"("tenantId", "orderId");
