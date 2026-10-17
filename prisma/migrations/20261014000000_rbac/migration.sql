-- Role-based access control: modules group permissions, roles hold permissions,
-- users hold roles. Modules confer nothing; authority always flows
-- user -> roles -> permissions.

CREATE TABLE "modules" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(320),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(320),
    "moduleId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(320),
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId", "permissionId")
);

CREATE TABLE "platform_admin_roles" (
    "adminId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admin_roles_pkey" PRIMARY KEY ("adminId", "roleId")
);

CREATE UNIQUE INDEX "modules_name_key" ON "modules"("name");
CREATE UNIQUE INDEX "permissions_name_key" ON "permissions"("name");
CREATE INDEX "permissions_moduleId_idx" ON "permissions"("moduleId");
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");
CREATE INDEX "platform_admin_roles_roleId_idx" ON "platform_admin_roles"("roleId");

ALTER TABLE "permissions"
    ADD CONSTRAINT "permissions_moduleId_fkey"
    FOREIGN KEY ("moduleId") REFERENCES "modules"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "role_permissions"
    ADD CONSTRAINT "role_permissions_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "roles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_permissions"
    ADD CONSTRAINT "role_permissions_permissionId_fkey"
    FOREIGN KEY ("permissionId") REFERENCES "permissions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_admin_roles"
    ADD CONSTRAINT "platform_admin_roles_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "platform_admins"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_admin_roles"
    ADD CONSTRAINT "platform_admin_roles_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "roles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Least privilege for the data-plane role, matching the existing policy: the RBAC
-- catalogue is control-plane state and must not be readable or writable by the
-- tenant data plane.
GRANT USAGE ON SCHEMA public TO mtb_app;
REVOKE ALL ON TABLE "modules", "permissions", "roles", "role_permissions", "platform_admin_roles" FROM mtb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mtb_control IN SCHEMA public
    REVOKE ALL ON TABLES FROM mtb_app;