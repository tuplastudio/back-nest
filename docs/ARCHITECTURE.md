# Architecture

How the pieces fit together, and — more usefully — why each one is shaped the way
it is.

---

## 1. Two planes

|                   | Control plane                                         | Data plane                                        |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Holds             | tenants, platform admins, API key metadata, audit log | everything a tenant owns                          |
| PostgreSQL schema | `public`                                              | one schema per tenant: `tenant_<slug>_<checksum>` |
| Prisma client     | `src/generated/control-plane`                         | `src/generated/tenant-plane`                      |
| Service           | `ControlPlanePrismaService`                           | `TenantPrismaService`                             |

Both live in the **same database**. The split is logical, not physical: a tenant
schema can be dumped, inspected or dropped without touching the control plane,
and the control plane can be restored without touching tenant data.

---

## 2. How schema isolation actually works

This is the load-bearing mechanism of the whole base, so it is worth being
precise about it.

`prisma/schema.tenant.prisma` declares **no** `@@schema(...)`, and its datasource
declares **no** `schemas` list. Prisma therefore emits unqualified SQL. The
driver adapter's `schema` option then decides which physical schema those
unqualified names resolve to:

```ts
new PrismaPg(pool, { schema: 'tenant_acme_1a2b3c4d' });
// every statement becomes:
//   SELECT ... FROM "tenant_acme_1a2b3c4d"."users"
```

**`search_path` does not do this.** It was the first thing tried; it has no
effect, because Prisma resolves model names against the adapter option only. All
tenants share a single `pg` pool; only the adapter binding differs.

What this buys:

- one generated client serves every tenant — no code generation per tenant;
- one pool serves every tenant — connections are not the bottleneck;
- isolation is structural rather than conventional: a request that holds tenant
  A's client _cannot_ express a query against tenant B's tables.

The cost is that raw SQL must be schema-qualified by hand, because `$queryRaw`
ignores the adapter option. That is what `SafeSqlService` is for.

### Prisma 7 notes

- `url` was removed from the `datasource` block. The CLI reads it from
  `prisma.config.ts`; the runtime supplies a driver adapter.
- `migrate diff --to-schema-datamodel` became `--to-schema`.
- Two generated clients means two generators, each with its own `output`.

---

## 3. Request lifecycle

```
HTTP request
  └─ ResponseHeadersMiddleware       correlation id, nosniff
  └─ RequestContextMiddleware        opens AsyncLocalStorage context,
                                     resolves the tenant, hashes IP / user agent
  └─ ThrottlerGuard                  rejects abusive traffic before auth
  └─ AuthGuard                       API key or JWT -> Principal in context
  └─ ApiKeyScopesGuard               enforces @RequireScopes
  └─ TenantGuard                     (per controller) tenant exists and is ACTIVE
  └─ Controller -> Service -> TenantPrismaService.forCurrentTenant()
  └─ AllExceptionsFilter            uniform, non-leaking error body
```

Guards are registered as `APP_GUARD` rather than with `@UseGuards`, so a new
controller cannot accidentally ship unauthenticated. Deny-by-default is a
structural property, not a convention: the only way to opt out is `@Public()`.

### Why the context is a singleton

`RequestContextService` wraps a single process-wide `AsyncLocalStorage`. It is
deliberately **not** request scoped: Nest would create one instance per request,
each with its own storage, and a guard would read a different store from the
middleware that populated it.

Patching mutates the stored object in place rather than calling `enterWith()`.
`enterWith` only rebinds the current execution context and its future
descendants, so a guard that patched with `enterWith` would be invisible to the
_next_ guard, which runs in a sibling async resource.

---

## 4. Tenant lifecycle

```
POST /tenants
  1. validate slug            TenantSchemaNamingService
  2. INSERT row               status = PROVISIONING      <- row first, schema second
  3. CREATE SCHEMA            TenantProvisionerService
  4. apply pending migrations prisma/tenant-migrations, tracked by schemaVersion
  5. status = ACTIVE
  6. audit: tenant.created, tenant.activated
```

Ordering matters. The registry row is written **before** the schema, so a crash
mid-provisioning leaves an auditable, retryable state instead of an orphan schema
nobody owns.

- `POST /tenants/:id/suspend` revokes every API key in the same operation.
  Reactivation restores service but **does not** restore keys: credentials must
  be re-issued deliberately.
- `DELETE /tenants/:id` is a soft delete. `POST /tenants/:id/purge` drops the
  schema and requires the slug as confirmation.

### Tenant migrations

Prisma Migrate manages one schema at a time, so tenant DDL cannot live in the
control plane's migration history:

1. `prisma/schema.tenant.prisma` is the single source of truth.
2. `npm run prisma:tenant:diff` renders it with `migrate diff --from-empty`.
3. The provisioner applies versions newer than `Tenant.schemaVersion`, inside a
   transaction with `SET LOCAL search_path`.

`src/prisma/tenant-ddl.ts` rewrites the rendered SQL: it strips `CREATE SCHEMA`
(the provisioner owns that) and **qualifies `CREATE TYPE` with the target
schema**, because PostgreSQL enums are schema-scoped objects. Without that
qualification the enum would land in whichever schema is first on the
`search_path`, and the tables would then reference the wrong type.

---

## 5. PII

| Concern                 | Mechanism                                                           |
| ----------------------- | ------------------------------------------------------------------- |
| Confidentiality at rest | AES-256-GCM, fresh nonce per value                                  |
| Equality lookups        | keyed HMAC-SHA256 blind index (`emailLookup`)                       |
| Duplicate detection     | impossible from ciphertext (it is non-deterministic)                |
| Rendering               | masked value stored alongside; plaintext returned only to its owner |
| Logs                    | recursive redaction of credential-shaped keys                       |
| IPs / user agents       | keyed hash or unkeyed SHA-256, never the raw value                  |

Ciphertext is deliberately **not** deterministic: an attacker with read access to
the database must not be able to spot duplicate records by comparing bytes.
Equality is served by the blind index instead.

AAD binds a ciphertext to its logical column, so a value moved from `email` to
`phone` fails to decrypt rather than silently decrypting.

Keys are derived per purpose from distinct domain labels, so the blind-index key
and the encryption key can never be confused, and compromising one does not
compromise the other.

**Keyring versionado** (`src/pii/keyring.ts`): los secretos de PII y de NetPay se cifran con un
anillo de llaves (`PII_KEYS_JSON`, `NETPAY_KEYS_JSON`; sin definir, una sola llave
`PII_ENCRYPTION_KEY` / `NETPAY_ENCRYPTION_KEY`). El ciphertext lleva el prefijo `v<n>:`: se descifra
con cualquier llave del anillo y se cifra con la `current`. `node dist/pii/reencrypt.command.js`
reescribe los valores con la llave vigente. Detalle de la rotación en `SECURITY.md` §3.

---

## 6. SQL injection

Prisma's query API parameterises everything, so ordinary queries are safe. The
risk is raw SQL, and the base closes it structurally:

- **Values** go through tagged templates (`Prisma.sql`, `Prisma.join`). Values
  always travel as bind parameters.
- **Identifiers** cannot be bound, so they must pass an allow-list
  (`SafeSqlService.identifier`) or a namespace check
  (`SafeSqlService.tenantSchema`) _before_ being quoted.
- **`Prisma.raw` is private** to `SafeSqlService`; it is the only way to obtain
  a raw fragment.
- **The injected client type has no unsafe methods.** `SafeSqlService` accepts
  `SqlClient = { $queryRaw; $executeRaw }`, so `$queryRawUnsafe` does not exist
  on it — a compile-time guarantee rather than a lint rule.
- **ESLint bans the unsafe APIs** outright, plus bare template literals inside
  raw calls (the forgotten `Prisma.sql` tag).

The one sanctioned escape hatch is the provisioner's DDL, where the only dynamic
value is a schema name that has passed `quoteIdentifier` and the `tenant_`
namespace check.

---

## 7. Authentication

| Caller         | Credential                      | Endpoint                | Refresh                  |
| -------------- | ------------------------------- | ----------------------- | ------------------------ |
| Platform admin | JWT access token                | `POST /auth/sign-in`    | rotating, family-tracked |
| Tenant member  | JWT access token                | `POST /t/auth/sign-in`  | rotating, family-tracked |
| Machine        | API key `mtb_<public>_<secret>` | any tenant-scoped route | rotate the key           |

- **Access tokens** are short-lived and stateless. They carry **no roles**:
  guards re-read the principal on every request, so a suspension takes effect
  immediately instead of when the token happens to expire.
- **Refresh tokens** are rotated on every use. Presenting an already-rotated
  token is treated as theft and revokes the whole family. They carry a `jti`,
  because every other JWT claim is second-resolution and two refreshes in the
  same second would otherwise mint byte-identical tokens.
- **API keys** store only an Argon2id hash of the secret. The clear-text value is
  returned exactly once, at creation and rotation. Verification burns equivalent
  CPU on an unknown prefix, so response timing cannot be used to discover which
  prefixes exist.
- **Brute force** is handled by two independent layers: per-account lockout
  stored on the row, and the per-IP `auth` throttler on the routes marked
  `@AuthThrottle()` (shared across instances with `THROTTLER_REDIS_URL`). Failure
  responses are identical for an unknown account, a wrong password and a locked
  account.
- **Passwords** use Argon2id (RFC 9106). `needsRehash` is checked on every
  successful verification, so raising the cost parameters upgrades hashes
  incrementally instead of forcing a global reset.
- **Admins de plataforma**: MFA TOTP (`MFA_REQUIRED_FOR_ADMINS`; por defecto obligatorio en
  producción) vía `/auth/mfa/*`, cambio de contraseña forzado (`mustChangePassword` →
  solo `POST /auth/change-password`) y step-up: escribir pagos exige una verificación MFA de menos de
  5 minutos. Ver `SECURITY.md` §4.
- **Invitaciones**: un miembro creado sin contraseña queda `INVITED` y la activa con
  `POST /t/auth/accept-invitation`. Las llaves de API no pueden fijar contraseñas ni otorgar roles por
  encima de `MEMBER`; `/t/webhooks*` exige los scopes `webhooks:read` / `webhooks:write`.

---

## 8. Module layout

```
src/
  config/      validated configuration (Zod) — nothing else reads process.env
  bootstrap/   middleware and shared HTTP settings
  common/      decorators, errors, exception filter
  tenancy/     tenant resolution, naming, guard, provisioning, administration
  prisma/      control-plane + tenant clients, SafeSql, DDL rendering
  pii/         crypto, masking, log redaction
  auth/        passwords, tokens, guards, admin sign-in
  api-keys/    tenant-scoped machine credentials
  tenant-api/  tenant-facing endpoints (members, example resource)
  audit/       append-only trail
  docs/        OpenAPI generation + Scalar mounting
  health/      liveness and readiness
```

---

## 9. Testing strategy

- **Unit** — the security primitives: PII crypto, masking, redaction, SQL
  identifier validation, schema naming, DDL rewriting. These are the pieces
  where a regression silently leaks data.
- **End to end** — the compiled application started as a separate process and
  driven over real HTTP against a real PostgreSQL. It asserts the properties
  that only exist end to end: two tenants holding the same unique value, a valid
  key for tenant A failing against tenant B, PII being ciphertext at rest, and an
  injection payload being stored as data.

  Running in-process would share Jest's module graph with the code under test and
  hide packaging and bootstrap failures.
