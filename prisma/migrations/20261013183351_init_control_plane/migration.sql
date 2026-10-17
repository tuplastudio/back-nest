-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('OWNER', 'ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DEPRECATED', 'DELETED');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('PLATFORM_ADMIN', 'TENANT_USER', 'API_KEY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "emailCiphertext" TEXT NOT NULL,
    "emailLookup" VARCHAR(64) NOT NULL,
    "emailMasked" VARCHAR(320) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "role" "PlatformRole" NOT NULL DEFAULT 'ADMIN',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastKnownIpHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_refresh_tokens" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByTokenHash" VARCHAR(64),
    "ipHash" VARCHAR(64),
    "userAgentHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "schemaName" VARCHAR(63) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'PROVISIONING',
    "plan" VARCHAR(32) NOT NULL DEFAULT 'standard',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "locale" VARCHAR(16) NOT NULL DEFAULT 'en-US',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "schemaVersion" INTEGER NOT NULL DEFAULT 0,
    "provisionedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "supportContact" VARCHAR(120),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "prefix" VARCHAR(32) NOT NULL,
    "secretHash" VARCHAR(255) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIpHash" VARCHAR(64),
    "usageCount" BIGINT NOT NULL DEFAULT 0,
    "rotatedFromId" UUID,
    "createdByType" "AuditActorType" NOT NULL DEFAULT 'PLATFORM_ADMIN',
    "createdById" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" VARCHAR(64),
    "actorLabel" VARCHAR(120),
    "action" VARCHAR(64) NOT NULL,
    "resourceType" VARCHAR(64) NOT NULL,
    "resourceId" VARCHAR(64),
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "metadata" JSONB,
    "ipHash" VARCHAR(64),
    "userAgentHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_emailLookup_key" ON "platform_admins"("emailLookup");

-- CreateIndex
CREATE INDEX "platform_admins_status_idx" ON "platform_admins"("status");

-- CreateIndex
CREATE UNIQUE INDEX "admin_refresh_tokens_tokenHash_key" ON "admin_refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_adminId_idx" ON "admin_refresh_tokens"("adminId");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_familyId_idx" ON "admin_refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_expiresAt_idx" ON "admin_refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_schemaName_key" ON "tenants"("schemaName");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenants_createdAt_idx" ON "tenants"("createdAt");

-- CreateIndex
CREATE INDEX "api_keys_tenantId_status_idx" ON "api_keys"("tenantId", "status");

-- CreateIndex
CREATE INDEX "api_keys_expiresAt_idx" ON "api_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_tenantId_prefix_key" ON "api_keys"("tenantId", "prefix");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorType_actorId_createdAt_idx" ON "audit_logs"("actorType", "actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "admin_refresh_tokens" ADD CONSTRAINT "admin_refresh_tokens_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "platform_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rotatedFromId_fkey" FOREIGN KEY ("rotatedFromId") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
