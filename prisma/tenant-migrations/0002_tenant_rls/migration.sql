-- Row-level security for the tenant data plane.
--
-- Schema-per-tenant already isolates tenants structurally: a client bound to
-- one schema cannot address another schema's tables. This migration adds the
-- second, independent layer underneath, so that a mistake, a hand-written raw
-- query, or a stolen credential that reaches *another* tenant's schema still
-- reads nothing.
--
-- The policy compares the transaction-scoped `app.current_tenant` setting with
-- this schema's own name. `TenantPrismaService.forCurrentTenantTransaction()`
-- sets that value on the same connection the query runs on. When it is absent —
-- an unwrapped client, a direct psql session, a bug — the policy denies, so the
-- failure mode is "no rows" rather than "someone else's rows".
--
-- SCOPE OF THIS CONTROL, stated precisely because it is easy to overclaim:
-- `app.current_tenant` is set BY THE CLIENT. These policies therefore stop
-- application-level mistakes -- an unwrapped query, a wrong schema binding, a
-- header mix-up, a forgotten tenant -- from reading another tenant's rows.
--
-- They do NOT bound a stolen database credential. mtb_app holds USAGE on every
-- tenant schema, so anyone able to execute SQL with it can set the variable to
-- another schema and read that schema. Containing credential theft requires a
-- distinct database login per tenant, which this base does not implement. Treat
-- the database credential as a trusted component of the application, and treat
-- these policies as bug containment, not as a second line against an attacker
-- who already holds one.
--
-- FORCE is required: the tables are owned by the provisioning role, and a table
-- owner bypasses RLS unless it is forced.

-- Users. No index-only shortcut is possible here: the tenant lives in the schema
-- name, so the comparison cannot be pushed into the table.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "users";
CREATE POLICY "tenant_isolation" ON "users"
  USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
  WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

ALTER TABLE "user_refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_refresh_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_refresh_tokens";
CREATE POLICY "tenant_isolation" ON "user_refresh_tokens"
  USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
  WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "projects";
CREATE POLICY "tenant_isolation" ON "projects"
  USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
  WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

-- ---------------------------------------------------------------------------
-- Data-plane grants.
--
-- These live in the migration rather than in the provisioner on purpose: a
-- tenant schema can be created by anything that applies these templates, not
-- only by TenantProvisionerService (prisma/seed.ts builds one directly). Putting
-- the grants here means every tenant schema that has the tables also has the
-- role privileges, so no provisioning path can produce a schema the data plane
-- is locked out of.
--
-- Usage on the schema plus DML on its tables and sequences. No CREATE, so the
-- role cannot add objects here, and no ownership, so RLS above is enforced.
GRANT USAGE ON SCHEMA __TENANT_SCHEMA__ TO mtb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA __TENANT_SCHEMA__ TO mtb_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA __TENANT_SCHEMA__ TO mtb_app;

-- Cover objects a later migration adds, without another grant round.
ALTER DEFAULT PRIVILEGES IN SCHEMA __TENANT_SCHEMA__
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mtb_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA __TENANT_SCHEMA__
  GRANT USAGE, SELECT ON SEQUENCES TO mtb_app;
