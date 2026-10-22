# Database Migration Strategy

This document explains the complete migration strategy for the Vondi API, including local development, CI/CD integration, and production deployment with Neon.tech.

## Table of Contents

1. [Overview](#overview)
2. [Local Development](#local-development)
3. [Migration Validation](#migration-validation)
4. [CI/CD Integration](#cicd-integration)
5. [Production Deployment](#production-deployment)
   - [Tenant migrations](#tenant-migrations)
6. [Migration Best Practices](#migration-best-practices)
7. [Rollback Strategy](#rollback-strategy)
8. [Troubleshooting](#troubleshooting)

## Overview

The migration strategy follows these principles:

- **Safety First**: All migrations are validated before deployment
- **Non-Breaking**: Prefer additive changes over destructive ones
- **Staging First**: Always test migrations in staging before production
- **Manual Approval**: Production migrations require explicit approval
- **Audit Trail**: All migrations are tracked and logged

### Architecture

```
┌─────────────────┐
│   Developer     │
│  (Local Dev)    │
└────────┬────────┘
         │ prisma migrate dev
         ↓
┌─────────────────┐
│   Local DB      │
│  (Docker)       │
└────────┬────────┘
         │ git push
         ↓
┌─────────────────┐
│   GitHub CI     │
│  (Validation)  │
└────────┬────────┘
         │ Auto-migrate to staging
         ↓
┌─────────────────┐
│  Staging DB     │
│  (Neon)         │
└────────┬────────┘
         │ Manual approval
         ↓
┌─────────────────┐
│ Production DB  │
│  (Neon)         │
└─────────────────┘
```

## Local Development

### Creating a New Migration

```bash
# 1. Make changes to prisma/schema.prisma
# 2. Create migration
npm run prisma:migrate

# This will:
# - Generate migration SQL
# - Apply it to local database
# - Update _prisma_migrations table
```

### Prisma Migrate vs Prisma Push

- **`prisma migrate dev`**: Use in development. Creates and applies migrations.
- **`prisma migrate deploy`**: Use in production. Applies existing migrations without creating new ones.
- **`prisma db push`**: Use for prototyping. Syncs schema without migration history. **DO NOT USE IN PRODUCTION**.

### Development Workflow

```bash
# Start local database
npm run db:up

# Create migration
npm run prisma:migrate

# Test locally
npm run start:dev

# Verify migration
npx prisma migrate status

# Generate tenant migration (if needed)
npm run prisma:tenant:diff
```

## Migration Validation

### Automated Validation

The `migrations:validate` script checks for:

1. **Destructive Changes**: DROP TABLE, DROP COLUMN, TRUNCATE
2. **Unsafe Operations**: Long-running ALTER statements
3. **Naming Conventions**: Migration filename format
4. **SQL Syntax**: Valid Prisma schema
5. **Conflicts**: Unapplied migrations

### Running Validation

```bash
# Validate all migrations
npm run migrations:validate

# This checks:
# - Migration filenames (YYYYMMDDHHMMSS_description.sql)
# - No destructive operations
# - SQL syntax validity
# - Schema consistency
```

### Validation Rules

#### Forbidden in Production

- ❌ `DROP TABLE` - Use soft deletes instead
- ❌ `DROP COLUMN` - Add new column, migrate data, then deprecate old one
- ❌ `TRUNCATE TABLE` - Use DELETE with WHERE clause
- ❌ `DELETE FROM table WHERE 1=1` - Always specify conditions

#### Requires Careful Planning

- ⚠️ `ALTER TABLE ... ALTER COLUMN TYPE` - May lock table and rewrite data
- ⚠️ `ALTER TABLE ... ADD COLUMN DEFAULT` - May lock large tables
- ⚠️ `ALTER TABLE ... ADD CONSTRAINT UNIQUE` - May lock table
- ⚠️ `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` - May lock table

### Pre-commit Hook (Optional)

Add to `.husky/pre-commit`:

```bash
#!/bin/bash
# Validate migrations before commit
git diff --cached --name-only | grep -q "prisma/migrations" && npm run migrations:validate
```

## CI/CD Integration

### GitHub Actions Workflows

#### 1. Pipeline canónico (.github/workflows/deploy.yml)

Existe **un solo** workflow que aplica migraciones y otro que despliega: el mismo
`deploy.yml`. No hay un workflow de migraciones aparte, y no debe añadirse: dos
 runners ejecutando `prisma migrate deploy` contra la misma base es una carrera, y
 una ruta que migra por el endpoint pooled de Neon (PgBouncer) falla o, peor,
aplica la mitad de la migración.

```
ci ─► build ─► migrate ─► deploy (--no-traffic --tag rc-<sha8>) ─► smoke (URL del tag) ─► promote 10 → 50 → 100
```

```
- ci  (ci.yml, workflow_call; los despliegues lo esperan con `needs`)
  ├─ Secrets: set commiteable + histórico completo (gitleaks)
  ├─ format:check, lint, typecheck
  ├─ migrations:validate  (plano de control + tenants; con MIGRATIONS_BASE_REF,
  │                        falla si una migración ya mergeada cambió)
  ├─ test:cov             (umbral de líneas en src/payments)
  ├─ test:int             (runner de tenants: 3 esquemas, concurrencia, checksum)
  ├─ prisma:seed, test:e2e
  └─ scan: Trivy HIGH/CRITICAL bloqueante (árbol + imagen)

- build
  └─ runtime + migrate por digest, con SBOM y provenance

- migrate
  └─ Cloud Run Job `npm run db:migrate:all`: plano de control y después
     tenants ACTIVE; --tasks=1 --parallelism=1 --max-retries=0

- deploy
  └─ revisión con --no-traffic y tag rc-<sha8>, flags de .github/cloudrun/flags.json

- smoke
  └─ /health/live, /health/ready y ruta protegida contra la URL del tag

- promote
  ├─ 10 → 50 → 100 (producción) / 100 (staging), 5xx de la revisión por escalón
  └─ si algo falla, update-traffic --to-revisions=<anterior>=100
```

**Key Features**:
- Las migraciones corren **antes** del deploy, en un Job con una sola ejecución
- Un deploy nunca entrega tráfico sin pasar por el smoke de su URL etiquetada
- El rollback de código no revierte migraciones: las migraciones deben ser
  compatibles hacia atrás (docs/DEPLOY-GCP.md §12.4)
- `concurrency` sin cancelación: cortar entre migrar y promover deja esquema y
  código descuadrados
- El deploy usa el **digest**, no el tag, porque un tag es mutable

Operaciones manuales (re-resolver una migración fallida, ver el estado) ya **no**
tienen workflow propio: se hacen con `prisma migrate status` /
`prisma migrate resolve` sobre la conexión sin pooler, o relanzando el pipeline
con `workflow_dispatch` e `skip_migrations` si lo que hace falta es desplegar sin
migrar.

### Required GitHub Secrets

Configure these in GitHub repository settings:

#### General

```
GCP_CREDENTIALS           # Service account JSON with appropriate permissions
GCP_PROJECT_ID           # Google Cloud project ID
```

#### Staging

```
STAGING_CONTROL_PLANE_DATABASE_URL
STAGING_CONTROL_PLANE_DATABASE_URL_UNPOOLED
STAGING_TENANT_PLANE_DATABASE_URL
STAGING_TENANT_PLANE_DATABASE_URL_UNPOOLED
```

#### Production

```
PRODUCTION_CONTROL_PLANE_DATABASE_URL
PRODUCTION_CONTROL_PLANE_DATABASE_URL_UNPOOLED
PRODUCTION_TENANT_PLANE_DATABASE_URL
PRODUCTION_TENANT_PLANE_DATABASE_URL_UNPOOLED
```

### Setting Up GitHub Environments

1. Go to Repository Settings → Environments
2. Create `staging` environment (no approval required)
3. Create `production` environment (require approval)
4. Add required reviewers for production

## Production Deployment

### Strategy Overview

```
┌─────────────────────────────────────────────────────────┐
│  Migration Lifecycle                                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. Local Development                                    │
│     ├─ Create migration locally                         │
│     ├─ Test with local data                             │
│     └─ Validate                                         │
│                                                          │
│  2. Commit & Push                                        │
│     ├─ Push to develop branch                           │
│     ├─ CI validates migration                           │
│     └─ Auto-applies to staging                          │
│                                                          │
│  3. Staging Verification                                 │
│     ├─ Test application in staging                      │
│     ├─ Verify data integrity                            │
│     └─ Monitor for issues                               │
│                                                          │
│  4. Production Approval                                   │
│     ├─ Create PR to main                                │
│     ├─ Review changes                                   │
│     └─ Approve deployment                               │
│                                                          │
│  5. Production Migration                                 │
│     ├─ Merge to main                                    │
│     ├─ CI validates again                              │
│     ├─ Manual approval required                         │
│     └─ Migration applied to production                 │
│                                                          │
│  6. Post-Deployment Verification                         │
│     ├─ Health checks                                    │
│     ├─ Monitor application logs                         │
│     └─ Verify data consistency                          │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Step-by-Step Deployment

#### Step 1: Create Migration Locally

```bash
# Make schema changes
vim prisma/schema.prisma

# Create migration
npm run prisma:migrate -- --name add_user_profile

# Validate
npm run migrations:validate

# Test locally
npm run start:dev
```

#### Step 2: Push to Develop

```bash
git add prisma/migrations/
git commit -m "Add user profile table"
git push origin develop
```

**What happens automatically**:
1. CI runs validation
2. Migration is applied to staging
3. Tests run against staging
4. Notification posted to commit

#### Step 3: Verify in Staging

```bash
# Check staging migration status
NEON_PROJECT_ID=staging-project ./scripts/run-migrations-neon.sh

# Or via GitHub Actions:
# 1. Go to Actions tab
# 2. Select "Auto Database Migrations"
# 3. Click "Run workflow"
# 4. Select environment: staging
# 5. Select action: status
```

#### Step 4: Deploy to Production

```bash
# Create PR to main
gh pr create --base main --head develop --title "Add user profile table"

# After review and approval:
git checkout main
git merge develop
git push origin main
```

**What happens automatically**:
1. CI runs validation
2. Docker image built and deployed
3. Migration workflow triggered
4. **Manual approval required** in GitHub
5. After approval, migration applied to production

#### Step 5: Manual Migration (If Needed)

If auto-migration fails or you need more control:

```bash
# Via GitHub Actions:
# 1. Go to Actions tab
# 2. Select "Manual Migration"
# 3. Click "Run workflow"
# 4. Select environment: production
# 5. Select action: deploy
```

Or locally:

```bash
NEON_PROJECT_ID=prod-project ./scripts/run-migrations-neon.sh
```

### Neon-Specific Considerations

#### Connection Strings

Neon provides two types of connection strings:

```bash
# Pooled (for application runtime)
postgresql://user:password@project-id.pooler.neon.tech/database?sslmode=require

# Unpooled (for migrations)
postgresql://user:password@project-id.neon.tech/database?sslmode=require
```

**Important**: Always use **unpooled** for migrations. PgBouncer's transaction pooling doesn't support migration operations.

#### Branching

Neon supports database branching. For complex migrations:

```bash
# Create a branch for testing migration
neon branches create migration-test --parent-id main

# Test migration on branch
CONTROL_PLANE_DATABASE_URL_UNPOOLED=<branch-url> npm run db:migrate:all

# If successful, merge branch
neon branches merge migration-test --into main
```

### Tenant migrations

`prisma/tenant-migrations/<version>_<nombre>/migration.sql` se aplican a cada
esquema `tenant_*`. Las renderiza `npm run prisma:tenant:diff` desde
`prisma/schema.tenant.prisma`; los placeholders `__TENANT_SCHEMA__` (identificador)
y `__TENANT_SCHEMA_LITERAL__` (literal) se sustituyen por esquema.

**Quién las aplica.** Dos caminos con el mismo código
(`src/tenancy/tenant-migrations.ts`):

- **Release** — el Job de migraciones ejecuta `npm run db:migrate:all`:
  `scripts/migrate.ts` (plano de control) y después `scripts/migrate-tenants.ts`
  sobre **todo tenant ACTIVE**, antes de que la revisión nueva reciba tráfico.
- **Alta o migración puntual** — `TenantProvisionerService` al aprovisionar y
  `POST /tenants/:id/migrate` (p. ej. un tenant SUSPENDED que se reactiva).

**Cómo.** Por esquema, en una transacción:

1. `pg_advisory_xact_lock(hashtext('<esquema>'))`: dos ejecuciones concurrentes
   se serializan; la segunda encuentra el trabajo hecho.
2. Ledger `<esquema>.tenant_schema_migrations (version, name, checksum, baseline, appliedAt)`,
   creado si falta. `checksum` es el SHA-256 del fichero (finales de línea
   normalizados). Solo el rol dueño de la tabla (el que migra) puede leerla:
   RLS forzado con política de dueño y sin privilegios para `mtb_app`.
3. Se aplican, en orden, las versiones que no están en el ledger; cada una deja
   su fila y `tenants.schemaVersion` se actualiza en la misma transacción.

El script hace antes un **preflight** de solo lectura sobre todos los tenants
y, al final, **verifica** que todos estén en la versión máxima. Aborta (exit 1,
el pipeline se detiene) si:

- un checksum registrado no coincide con el fichero → **una migración aplicada
  se editó**. Nunca se editan migraciones aplicadas: se revierte la edición y se
  añade una migración nueva;
- hay una versión registrada sin fichero (se borró o renombró una migración);
- una versión pendiente es menor que una ya aplicada (se insertó por debajo del
  historial): renumerarla por encima de la última;
- un tenant ACTIVE no queda en la versión máxima.

Un esquema anterior al ledger se **adopta**: las versiones hasta su
`schemaVersion` se registran con `baseline = true` sin ejecutarse.

**Reglas para escribir una.** Sin `BEGIN`/`COMMIT` (el runner abre la
transacción), sin nombres de esquema (`public.`, `tenant_x.`): usar nombres sin
calificar o los placeholders; idempotente cuando sea barato (`IF NOT EXISTS`);
expand/contract como las del plano de control. `npm run migrations:validate` lo
comprueba, junto con versiones duplicadas y nombres mal formados.

```bash
# Local, contra la base de docker compose:
CONTROL_PLANE_DATABASE_URL_UNPOOLED=postgresql://… npm run db:migrate:tenants
# Integración (Postgres desechable en 55436, ver el test):
docker run -d --name bn-e2e-c2 -p 127.0.0.1:55436:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine
npm run test:int
```

Diagnóstico de un esquema:

```sql
SELECT version, name, baseline, "appliedAt" FROM "tenant_acme_1a2b3c4d".tenant_schema_migrations ORDER BY version;
SELECT slug, "schemaVersion", status FROM tenants ORDER BY "schemaVersion";
```

## Migration Best Practices

### 1. Design Principles

#### Prefer Additive Changes

✅ **Good**:
```sql
ALTER TABLE users ADD COLUMN phone VARCHAR(20);
```

❌ **Bad**:
```sql
ALTER TABLE users DROP COLUMN email;
```

#### Use Migration Functions for Complex Changes

For multi-step migrations, use Prisma migration SQL:

```sql
-- 001_add_phone.sql
ALTER TABLE users ADD COLUMN phone VARCHAR(20);

-- 002_migrate_data.sql
UPDATE users SET phone = old_phone_column FROM temp_table WHERE users.id = temp_table.user_id;

-- 003_add_constraint.sql
ALTER TABLE users ADD CONSTRAINT unique_phone UNIQUE (phone);
```

#### Use Transaction Blocks

```sql
BEGIN;

ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT false;
CREATE INDEX idx_users_email_verified ON users(email_verified);

COMMIT;
```

### 2. Testing Migrations

#### Test with Realistic Data

```bash
# Use staging with production-like data
# Or create a test database with anonymized production data
```

#### Rollback Testing

Before deploying to production:

1. Apply migration to staging
2. Verify application works
3. Create rollback migration
4. Test rollback
5. Re-apply migration
6. Verify again

### 3. Zero-Downtime Migrations

For large tables, use multi-step approach:

#### Example: Add Column with Default

**Step 1**: Add nullable column
```sql
ALTER TABLE users ADD COLUMN phone VARCHAR(20);
```

**Step 2**: Backfill data
```sql
UPDATE users SET phone = '555-0100' WHERE phone IS NULL;
```

**Step 3**: Make column NOT NULL
```sql
ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
```

#### Example: Rename Column

**Step 1**: Add new column
```sql
ALTER TABLE users ADD COLUMN email_address VARCHAR(255);
```

**Step 2**: Copy data
```sql
UPDATE users SET email_address = email;
```

**Step 3**: Update application to use new column
```Step 4**: Deploy application
**Step 5**: Remove old column
```sql
ALTER TABLE users DROP COLUMN email;
```

### 4. Monitoring

#### Monitor Migration Duration

```sql
-- Track migration execution time
SELECT migration_name, started_at, finished_at,
       EXTRACT(EPOCH FROM (finished_at - started_at)) as duration_seconds
FROM _prisma_migrations
ORDER BY started_at DESC;
```

#### Monitor Application Errors

After migration:

```bash
# Check Cloud Run logs
gcloud logs tail /run.googleapis.com/netpay-api --region=us-central1

# Look for database errors
gcloud logging read "resource.type=cloud_run_revision AND protoPayload.@type:type.googleapis.com/google.cloud.audit.AuditLog"
```

## Rollback Strategy

### Prisma Migration Rollback

Prisma doesn't have automatic rollback. You have two options:

#### Option 1: Create Rollback Migration

```bash
# Create rollback migration
npx prisma migrate dev --name rollback_add_phone

# Manually write SQL to reverse the change
-- DROP COLUMN phone
```

#### Option 2: Use migrate resolve

If migration failed partway through:

```bash
# Mark as rolled back
npx prisma migrate resolve --rolled-back <migration_name>

# Then fix and re-apply
npx prisma migrate deploy
```

### Database-Level Rollback

For critical failures:

```bash
# Option 1: Restore from backup (Neon supports point-in-time recovery)
neon databases restore <database-id> --timestamp <timestamp>

# Option 2: Use database branch
neon branches create pre-migration --parent-id main --timestamp <timestamp>
```

### Application Rollback

If migration succeeded but application fails:

```bash
# Deploy previous Docker image
gcloud run services update netpay-api \
  --image=us-central1-docker.pkg.dev/project-id/repo/netpay-api:previous-tag \
  --region=us-central1
```

## Troubleshooting

### Common Issues

#### 1. Migration Fails in Production

**Symptoms**:
- GitHub Action fails
- Migration shows as failed in `_prisma_migrations`

**Solutions**:
```bash
# Check what failed
npx prisma migrate status

# If partially applied, resolve
npx prisma migrate resolve --rolled-back <migration_name>

# Fix the migration file
vim prisma/migrations/<migration_name>/migration.sql

# Re-apply
npx prisma migrate deploy
```

#### 2. Connection Timeout

**Symptoms**:
- "Connection timeout" error
- Migration hangs

**Solutions**:
```bash
# Use unpooled connection string
export CONTROL_PLANE_DATABASE_URL_UNPOOLED="postgresql://user:pass@project-id.neon.tech/db"

# Increase timeout
npx prisma migrate deploy --schema prisma/schema.prisma
```

#### 3. Lock Timeout

**Symptoms**:
- "Lock timeout" error
- Migration fails on ALTER TABLE

**Solutions**:
```sql
-- Check for locks
SELECT * FROM pg_locks WHERE relation IS NOT NULL;

-- Kill blocking locks
SELECT pg_terminate_backend(pid)
FROM pg_locks
WHERE relation = 'table_name'::regclass;
```

#### 4. Schema Drift

**Symptoms**:
- Production schema doesn't match Prisma schema
- Migration fails with "schema mismatch"

**Solutions**:
```bash
# Compare schemas
npx prisma migrate diff \
  --from-schema-datasource <production-url> \
  --to-schema-datamodel prisma/schema.prisma \
  --script

# Create migration to sync
npx prisma migrate dev --name sync_production
```

### Getting Help

1. Check GitHub Actions logs
2. Check Cloud Run logs
3. Check Neon console for database logs
4. Review migration files
5. Test migration locally with production-like data

## Summary

### Quick Reference

| Task | Command |
|------|---------|
| Create migration | `npm run prisma:migrate` |
| Validate migrations | `npm run migrations:validate` |
| Apply migrations (local) | `npm run prisma:deploy` |
| Apply migrations (Neon) | `NEON_PROJECT_ID=xxx ./scripts/run-migrations-neon.sh` |
| Check migration status | `npx prisma migrate status` |
| Resolve failed migration | `npx prisma migrate resolve --rolled-back <name>` |

### Checklist Before Production Migration

- [ ] Migration validated locally
- [ ] Migration passes CI validation
- [ ] Migration applied to staging
- [ ] Application tested in staging
- [ ] Data integrity verified
- [ ] Rollback plan documented
- [ ] Team notified
- [ ] Maintenance window scheduled (if needed)
- [ ] Monitoring configured
- [ ] Backup verified

### Emergency Contacts

- Database Administrator: [Contact]
- DevOps Engineer: [Contact]
- On-call Engineer: [Contact]
