-- Row-level security for payment_gateway_accounts (added in 0023).
--
-- The table holds encrypted gateway tokens, so, like every other tenant table (0002),
-- a data-plane credential must never read another tenant's row. 0023 created the
-- table without the policy and without the grant for the app role.
-- Idempotent: safe to re-run.

ALTER TABLE "payment_gateway_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_gateway_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payment_gateway_accounts_tenant_isolation" ON "payment_gateway_accounts";
CREATE POLICY "payment_gateway_accounts_tenant_isolation" ON "payment_gateway_accounts"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payment_gateway_accounts" TO mtb_app;
