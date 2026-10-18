# Security model

What this base defends against, how, and — equally important — what it does not
defend against.

---

## Threat model

Assumed:

- an attacker can send arbitrary HTTP requests;
- an attacker can obtain an application process's memory or, at worst, a dump of
  the database;
- tenants are semi-trusted: each tenant's own members may be hostile **to other
  tenants**, but not to their own data.

Out of scope (needs infrastructure, not application code):

- physical host compromise;
- a malicious PostgreSQL superuser;
- denial of service beyond the rate limits configured here.

---

## 1. Cross-tenant data access

**Threat.** A caller reads or writes another tenant's data by manipulating a
header, a subdomain, an id, or a stolen credential.

**Controls.**

| Control                                             | Where                           |
| --------------------------------------------------- | ------------------------------- |
| Tenant comes from the request, never from the body  | `TenantResolverService`         |
| API keys never select their own tenant              | `AuthGuard.authenticateApiKey`  |
| Clients are bound to exactly one schema             | `TenantPrismaService.forTenant` |
| Schema names must carry the `tenant_` namespace     | `SafeSqlService.tenantSchema`   |
| Schema names must match a strict identifier pattern | `TenantSchemaNamingService`     |
| Suspended tenants are rejected before any query     | `TenantGuard`                   |

The structural guarantee is the last-but-one row: a handler that holds tenant
A's client cannot express a query against tenant B's tables, because the adapter
qualifies every statement with A's schema.

Verified end to end: the e2e suite stores the _same_ e-mail in two tenants (which
a shared table would reject), then presents tenant A's valid key against tenant
B and asserts 401.

---

## 2. SQL injection

**Threat.** User input reaches a SQL statement as syntax rather than as a value.

**Controls.**

1. Prisma's query API parameterises every value it sends.
2. Raw SQL values must use tagged templates (`Prisma.sql`, `Prisma.join`).
3. Raw SQL identifiers must pass an allow-list before being quoted.
4. `Prisma.raw` is private to `SafeSqlService`.
5. The client type handed to `SafeSqlService` does not contain
   `$queryRawUnsafe` / `$executeRawUnsafe` — a compile-time guarantee.
6. ESLint bans the unsafe APIs and bare template literals inside raw calls.

```bash
# Attempt 1: interpolated value — rejected at the type checker.
prisma.$queryRawUnsafe(`SELECT * FROM users WHERE email = '${email}'`)

# Attempt 2: value through a tagged template — bound, not interpolated.
prisma.$queryRaw(Prisma.sql`SELECT * FROM users WHERE email = ${email}`)

# Attempt 3: identifier — allow-listed, then quoted.
prisma.$queryRaw(Prisma.sql`SELECT * FROM ${safe.identifier('users')} WHERE ...`)
```

The provisioner's DDL is the one place raw SQL is unavoidable (Prisma cannot
express `CREATE SCHEMA` through its API). There the only dynamic value is a
schema name that has passed both `quoteIdentifier` and the namespace check, and
`SET search_path` is transaction-local via `pg_catalog.set_config`.

---

## 3. PII exposure

**Threat.** Personal data leaks through the database, an API response or a log
aggregator.

| Vector                      | Control                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| Database dump               | AES-256-GCM ciphertext; no plaintext column exists                             |
| Duplicate detection         | ciphertext is non-deterministic; equality uses a blind index                   |
| API responses               | masked values; plaintext only via `GET /t/users/me/email`                      |
| Logs                        | recursive redaction of credential-shaped keys, plus e-mail masking in messages |
| Audit trail                 | keyed hash of the IP, SHA-256 of the user agent, PII-stripped metadata         |
| Value moved between columns | AAD binds the ciphertext to its column                                         |

Blind indexes are keyed HMACs: they keep `WHERE emailLookup = $1` a plain indexed
comparison without storing anything searchable.

Verified end to end: the suite reads the raw columns and asserts the plaintext
e-mail is absent, then confirms the application can still decrypt what it stored
and that sign-in through the blind index works.

---

## 4. Credential compromise

| Threat                            | Control                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Stolen database                   | Argon2id password hashes; API key secrets are Argon2id too; refresh tokens are SHA-256 digests |
| Stolen refresh token              | Rotation with family reuse detection; replay revokes every session in the family               |
| Stolen API key                    | Rotate: mints a new secret, revokes the old, links them in the audit trail                     |
| Token replay after revocation     | Guards re-read the principal, so revocation takes effect on the next request                   |
| Credential stuffing               | Per-IP throttle plus per-account lockout                                                       |
| Account enumeration               | Identical response for unknown account, wrong password and lockout                             |
| Timing attacks                    | Dummy Argon2 verification on unknown accounts and unknown key prefixes                         |
| Privilege retained after demotion | Roles are **not** in the access token; they are re-read per request                            |

### Session fixation / refresh reuse

```
sign-in        → refresh₁ (family F)
refresh(₁)     → refresh₂, refresh₁ marked replaced
refresh(₁)     → REUSE DETECTED → revoke family F
refresh(₂)     → 401 (died with the family)
```

---

## 5. Denial of service

| Vector                            | Control                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| Flood                             | Global per-IP throttle (`ThrottlerGuard`)                        |
| Password brute force              | Tighter throttle on the sign-in routes, plus account lockout     |
| Slow queries                      | `statement_timeout` on every pooled connection                   |
| Pool exhaustion                   | Bounded per-tenant pool; oversized tenant caches are evicted LRU |
| Oversized payloads                | 256 kB body cap; `forbidNonWhitelisted` validation               |
| Cache poisoning via hostile slugs | Slug allow-list, 30 s TTL, bounded cache                         |

The bounded caches matter: an unbounded map keyed by an attacker-controlled slug
would be a memory exhaustion vector.

---

## 6. Information disclosure

| Vector                    | Control                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| Stack traces in responses | Single exception filter; unexpected errors become a generic 500         |
| Driver messages           | Prisma codes translated to safe, stable error codes                     |
| Internal schema names     | Exposed only on the tenant detail route, never in listings              |
| API surface discovery     | Scalar reference disabled or behind HTTP Basic auth outside development |
| Security headers          | Helmet, HSTS outside development, `frameguard: deny`                    |
| Fingerprinting            | `X-Powered-By` removed, `nosniff` set                                   |

---

## 7. Postura de la infraestructura

Verificado con `gcloud` el 2026-10-18, no deducido del repositorio.

| Control | Estado |
| ------- | ------ |
| Identidad de despliegue | WIF, sin claves JSON. La condición de la pool de producción exige `ref == refs/heads/main`; la de staging, `environment == staging` |
| Acceso a secretos | Por secreto y por cuenta, nunca a nivel de proyecto |
| Cuentas de servicio | `netpay-runtime` / `netpay-deployer` / `netpay-migrator`. La cuenta por defecto de cómputo ya no es `roles/editor` |
| Superficie de administración | `tenants.controller.ts` solo tiene dos rutas `@Roles('OWNER')`, y el login limita a 5 intentos por minuto con bloqueo de cuenta |
| Límites del servicio | `maxScale` 4 en producción, 1 en el canario, 2 en staging. `timeout` 60 s en los tres |
| Salida por IP fija | Los tres servicios y los dos Jobs salen por el NAT de su proyecto |
| Alertas | `netpay 5xx`, `netpay login fallido` y `netpay IAM denegada` en los dos proyectos, sobre métricas de log propias |
| Filtrado en el borde | **Ninguno.** No hay balanceador ni Cloud Armor (§13) |
| Allowlist de IP en Neon | **No disponible en el plan Launch**: el máximo de entradas es 0. Requiere el plan Scale |
| Informe de readiness | Anónimo devuelve solo estado y timestamp; el detalle por base va autenticado |

### 7.1 Lo que falta y por qué no se ha hecho

1. **Sin WAF.** Cloud Armor exige el balanceador global y cuesta ~32 USD/mes
   (18,25 de forwarding rule + 3,60 de IP + 5,00 de política + 1,00 por regla).
   El compromiso actual es que la autenticación de la aplicación es
   *deny-by-default* y el limitador global rechaza el ruido: filtrar en el
   origen cuesta CPU y facturabilidad, no gratis.
2. **La base sigue siendo alcanzable desde internet.** Con Launch no hay
   allowlist. Lo que sí se hizo fue reducir la ventana: los servicios salen por
   IP fija, y las credenciales de `staging` y su `neondb_owner` se rotaron
   porque la rama los heredaba de producción.
3. **Sin alertas de coste.** Los presupuestos de Cloud Billing no se pueden
   crear en una cuenta de facturación heredada (`016863-…`); requiere migrar a
   una cuenta de tipo nuevo.
4. **`run.developer` a nivel de proyecto.** Necesario para que el pipeline
   despliegue, y no se puede acotar por servicio: los roles de IAM que Cloud Run
   admite sobre un servicio concreto son `run.invoker` y `run.viewer`.
5. **`main` no fuerza revisiones.** `enforce_admins` está desactivado porque
   hasta ahora hay una sola persona: exigir un aprobador bloquearía el trabajo.

### 7.2 Rotar un secreto: el detalle que costó una caída

Un secreto referenciado con `:latest` **no cambia de valor en un servicio en
marcha**: la instancia resuelve la referencia al arrancar. Además
`gcloud run services update` se niega a crear una revisión si nada más cambia,
así que la rotación no se aplica y el servicio se queda con la contraseña
antigua —que ya no vale— y ambos planos de base caen.

El procedimiento que funciona, y que conviene dejar escrito:

```bash
# 1. Añadir la versión nueva al secreto (no sobrescribir la anterior).
printf '%s' "$NUEVO" | gcloud secrets versions add control-plane-db-url --data-file=-

# 2. Fijar la versión explícitamente en el servicio. Fijar, no :latest: es lo
#    que fuerza la revisión nueva.
gcloud run services update netpay-api-staging   --set-secrets="CONTROL_PLANE_DATABASE_URL=control-plane-db-url:2,…"
```

Fijar la versión numérica tiene un segundo beneficio: deja constancia de qué
secrete se usó en cada revisión.

### 7.3 Credenciales expuestas en canales no confiables

Las claves `PII_HMAC_KEY`, `PII_ENCRYPTION_KEY` y `NETPAY_ENCRYPTION_KEY` de
producción **no son rotables** (ver limitaciones 1 y 2): cambiarlas deja
indescifrable el PII ya escrito. Si se han transcrito fuera del almacén de
secretos, la única salida correcta es un proyecto de recifrado por lotes
(RB-04), no un `secrets versions add`. Lo que sí se puede hacer de inmediato es
sacarlas de la transcripción y custodiarlas fuera de GCP.

Las de `staging` sí se rotaron sin coste, porque esa base no tiene datos.
## 8. Known limitations

Stated plainly, because a base that hides these is worse than one that names
them.

1. **Encryption keys are environment variables.** There is no KMS envelope
   encryption, so a compromised environment yields the keys. For production,
   wrap them in a KMS or a secrets manager.
2. **Blind-index rotation is manual.** Rotating `PII_HMAC_KEY` invalidates every
   stored index; a re-encryption job must be written before rotating it.
3. **Tenant schema names are immutable.** Changing a slug means a new tenant;
   there is no rename migration.
4. **Provisioning is synchronous.** Creating a tenant runs DDL inline, which is
   fine up to a few thousand tenants and should become a queue beyond that.
5. **The audit trail is append-only by convention.** The model has no cascades
   and the service exposes no update or delete, but nothing prevents a
   superuser from editing rows. Ship it to immutable storage if that matters.
6. **Rate limiting is in-memory.** A multi-instance deployment needs the Redis
   storage backend for `ThrottlerModule`, or the limits are per instance.
7. **No CSRF protection on cookie-authenticated routes.** The refresh cookie is
   `HttpOnly; SameSite=Strict`, which covers the common cases, but a browser
   client performing state-changing requests with a session cookie should add a
   CSRF token.
8. **`app.current_tenant` is set by the client, so RLS bounds bugs, not a stolen
   credential.** Schema-per-tenant is the primary isolation boundary and
   `prisma/tenant-migrations/0002_tenant_rls/migration.sql` adds `FORCE ROW LEVEL
SECURITY` underneath it. The policy compares the transaction-scoped setting with
   the schema's own name, and denies when the setting is absent, so an unwrapped
   client or a forgotten binding reads nothing rather than reading another tenant.
   What it does **not** do is bound a stolen data-plane credential: `mtb_app` holds
   `USAGE` on every tenant schema and can set the variable to any of them.
   Per-tenant database logins are the control that would close that, and this base
   does not implement them.
