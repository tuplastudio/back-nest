# ---------------------------------------------------------------------------

# NestJS + Prisma multitenancy base

# ---------------------------------------------------------------------------

# Architecture

# * Control plane (PostgreSQL `public` schema): platform administrators, the

# tenant registry, per-tenant API key metadata and the audit trail.

# * Data plane (one PostgreSQL schema per tenant): everything a tenant owns.

# The same Prisma model lives in a different physical schema per tenant.

#

# Getting started

# 1. cp .env.example .env and fill in the secrets (see below)

# 2. npm run db:up starts PostgreSQL

# 3. npm run prisma:deploy applies the control plane migration

# 4. npm run prisma:seed creates an owner, a demo tenant and a member

# 5. npm run start:dev serves the API on http://localhost:3000

# 6. open http://localhost:3000/docs for the Scalar API reference

#

# Documentation

# docs/ARCHITECTURE.md how the pieces fit together and why

# docs/SECURITY.md threat model and the controls that back it

# docs/DEPLOY-GCP.md topología real, IAM, canario y pipeline de despliegue

# docs/DEPLOYMENT.md guía histórica de Cloud Build (sustituida por DEPLOY-GCP.md)

docs/MIGRATIONS.md database migration strategy and best practices

docs/GITHUB_ACTIONS_SETUP.md GitHub Actions CI/CD and migration setup

# ---------------------------------------------------------------------------

# --- Prerequisites -----------------------------------------------------------

# Node.js >= 22.13 (NestJS 12 ships ESM only)

# PostgreSQL 15+ (17 recommended); Docker users can rely on `npm run db:up`

# --- Setup -------------------------------------------------------------------

npm install
npm run prisma:generate # generates both Prisma clients (control + tenant planes)
cp .env.example .env

# Generate the secrets the application refuses to start without:

openssl rand -base64 48 # JWT_ACCESS_SECRET
openssl rand -base64 48 # JWT_REFRESH_SECRET
openssl rand -base64 24 # PII_HMAC_KEY
openssl rand -base64 32 # PII_ENCRYPTION_KEY

npm run db:up # or point CONTROL_PLANE_DATABASE_URL at your own PostgreSQL
npm run prisma:deploy # control plane migration (prisma/migrations)
npm run prisma:seed # optional: owner + demo tenant + member

# --- Run ---------------------------------------------------------------------

npm run start:dev # tsc --watch + node --watch, hot reload
npm run build && npm start # production-style build and run
docker compose up -d # or: docker build -t mtb . && docker run -p 3000:3000 ...

# --- Quality gates -----------------------------------------------------------

npm run typecheck # tsc --noEmit
npm run lint # eslint, zero warnings tolerated
npm test # 89 unit tests
npm run test:e2e # 23 end-to-end tests against a real PostgreSQL

# --- Documentation -----------------------------------------------------------

npm run docs:openapi # regenerates docs/openapi.json from the DTOs
DOCS_ENABLED=false # disables the reference entirely (recommended off in prod)

# =============================================================================

# MULTITENANCY IN ONE PARAGRAPH

# =============================================================================

#

# Every tenant gets its own PostgreSQL schema (`tenant_<slug>_<checksum>`). The

# tenant datamodel declares no `@@schema`, and the Prisma driver adapter is bound

# to the tenant's schema, so the identical generated client reads and writes a

# different physical schema depending on which tenant the request resolved to:

#

# new PrismaPg(pool, { schema: 'tenant_acme_1a2b3c4d' })

# // -> SELECT ... FROM "tenant_acme_1a2b3c4d"."users"

#

# Requests select a tenant by `X-Tenant-Id`, `X-Tenant-Slug` or a subdomain, in

# that order. An API key never selects its own tenant, so a leaked key cannot be

# replayed against a different one.

# =============================================================================
