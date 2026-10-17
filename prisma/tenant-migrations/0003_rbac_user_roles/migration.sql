-- RBAC role assignment for tenant members.
--
-- `modules`, `permissions` and `roles` live in the control plane: they are a
-- platform-wide catalogue, so every tenant governs its members with the same
-- vocabulary instead of inventing its own. Only the *assignment* lives here,
-- inside the tenant's own schema, because that is where the member it describes
-- lives — the assignment is as isolated as the member.
--
-- `roleId` therefore has no foreign key: it points across schemas, and
-- PostgreSQL cannot express a cross-database foreign key. The id is resolved
-- against `public.roles` by `AuthorizationService`. Referential integrity for
-- this one column is an application concern, which is why removing a role from
-- the catalogue must be refused while assignments still reference it.

CREATE TABLE "user_roles" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "assignedById" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId", "roleId")
);

CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: role assignments are tenant data and follow the same
-- policy as every other table in this schema, so a query issued without the
-- `app.current_tenant` binding reads nothing.
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_roles_tenant_isolation" ON "user_roles"
    USING (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__)
    WITH CHECK (current_setting('app.current_tenant', true) = __TENANT_SCHEMA_LITERAL__);

-- The data-plane role needs to resolve its members' roles; it gets no more than
-- that, and no ownership and no CREATE.
GRANT USAGE ON SCHEMA __TENANT_SCHEMA__ TO mtb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user_roles" TO mtb_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA __TENANT_SCHEMA__
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mtb_app;