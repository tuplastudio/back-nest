-- Migration ledger of this tenant schema (BN-REQ-OPS-002).
--
-- One row per tenant migration applied here, with the SHA-256 of the script as
-- it was when it ran. `scripts/migrate-tenants.ts` and the provisioner refuse
-- to continue when a recorded checksum differs from the file on disk: an
-- applied migration that was edited afterwards means this schema and a schema
-- provisioned tomorrow no longer agree.
--
-- `baseline` marks versions adopted without execution: schemas that already
-- had them, per `tenants.schemaVersion`, before the ledger existed.
--
-- The runner also creates this table (same definition, IF NOT EXISTS) before
-- reading it, so a schema that predates this migration can be adopted; this
-- file is what gives schemas provisioned from scratch the same table.

CREATE TABLE IF NOT EXISTS "tenant_schema_migrations" (
    "version" INTEGER NOT NULL PRIMARY KEY,
    "name" VARCHAR(255) NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The default privileges of 0002 grant the data-plane role DML on every table
-- in the schema. Migration history is not application data.
REVOKE ALL ON TABLE "tenant_schema_migrations" FROM mtb_app;

-- Row-level security, forced like every other tenant table, but keyed on the
-- role rather than on `app.current_tenant`: the only legitimate reader and
-- writer is the role that owns the table (the migrator / provisioner), which
-- never sets a tenant. FORCE makes the owner go through the policy too, and the
-- policy lets exactly the owner's role (and its members) through.
ALTER TABLE "tenant_schema_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_schema_migrations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ledger_owner_only" ON "tenant_schema_migrations";
CREATE POLICY "ledger_owner_only" ON "tenant_schema_migrations"
  USING (pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class
                                     WHERE oid = '__TENANT_SCHEMA__."tenant_schema_migrations"'::regclass), 'MEMBER'))
  WITH CHECK (pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class
                                     WHERE oid = '__TENANT_SCHEMA__."tenant_schema_migrations"'::regclass), 'MEMBER'));
