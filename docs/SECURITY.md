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

**Keyring versionado** (`src/pii/keyring.ts`, BN-REQ-SEC-007). `PII_KEYS_JSON` y `NETPAY_KEYS_JSON`
tienen la forma `{"current":"2","keys":{"1":"<base64 32 bytes>","2":"<base64 32 bytes>"}}`. Cada
ciphertext lleva el prefijo `v<n>:` de la llave que lo escribió: se descifra con cualquier llave del
anillo y se cifra siempre con `current`. Sin definir, el anillo tiene una sola llave
(`PII_ENCRYPTION_KEY` / `NETPAY_ENCRYPTION_KEY`), que también lee los valores sin prefijo anteriores
al keyring. Rotar: añadir la llave `n+1`, hacerla `current`, ejecutar
`node dist/pii/reencrypt.command.js` (`--dry-run`, `--batch=<n>`, `--only=netpay`; idempotente, sale
con 1 si algún valor no descifra) y retirar la llave vieja cuando no quede nada por migrar. El HMAC del
blind index (`PII_HMAC_KEY`) no entra en este proceso.

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

### MFA, cambio de contraseña y step-up (administradores de plataforma)

Reglas en `src/auth/admin-session-policy.ts`, aplicadas por `AuthGuard` (BN-REQ-SEC-006/008):

- **MFA (TOTP).** `MFA_REQUIRED_FOR_ADMINS=true|false`; sin definir, es obligatorio cuando
  `NODE_ENV=production` y opcional en otro caso. Si aplica (obligatorio, o el admin se enroló), toda
  ruta exige un access token emitido tras verificar TOTP o un código de recuperación; si no,
  `403` (error de MFA requerida). Endpoints: `POST /auth/mfa/enroll`, `/auth/mfa/confirm` (devuelve códigos de
  recuperación una sola vez), `/auth/mfa/verify`, `/auth/mfa/recovery-codes`, `/auth/mfa/disable`.
- **Cambio de contraseña forzado.** Mientras `mustChangePassword` esté activo solo responden
  `POST /auth/change-password` y los endpoints de MFA; el resto da `403 PASSWORD_CHANGE_REQUIRED`.
  El cambio revoca las demás sesiones y devuelve una nueva.
- **Step-up.** Una escritura (no `GET`/`HEAD`/`OPTIONS`) de un admin de plataforma a una ruta con
  scope `payments:*`, o marcada con `@RequireStepUp()`, exige una verificación MFA de hace como
  máximo 5 minutos (`POST /auth/mfa/verify`); si no, `403 STEP_UP_REQUIRED`.

### Invitación de miembros y llaves de API

- Un miembro creado sin contraseña queda `INVITED` y `POST /t/users` devuelve, una sola vez, un token
  de invitación (JWT con clave y audiencia propias, 7 días). El miembro fija su contraseña con
  `POST /t/auth/accept-invitation`; el token es de un solo uso (solo actualiza un miembro aún
  `INVITED` sin contraseña).
- Una llave de API (`users:write`) **no puede** enviar contraseña (`422 PASSWORD_NOT_ACCEPTED`) ni
  otorgar un rol por encima de `MEMBER` (BN-REQ-SEC-002): una llave filtrada no puede crear un
  administrador que controle.
- `/t/webhooks*` exige el scope `webhooks:read` (lecturas) o `webhooks:write` (mutaciones, incluidas
  rotación y reenvío) además del permiso RBAC. `webhooks:write` no se concede a `tenant-admin`.

---

## 5. Denial of service

| Vector                            | Control                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| Flood                             | Global per-IP throttle (`ThrottlerGuard`)                        |
| Password brute force              | Tighter `auth` throttle on credential routes, plus account lockout |
| Slow queries                      | `statement_timeout` on every pooled connection                   |
| Pool exhaustion                   | Bounded per-tenant pool; oversized tenant caches are evicted LRU |
| Oversized payloads                | 256 kB body cap; `forbidNonWhitelisted` validation               |
| Cache poisoning via hostile slugs | Slug allow-list, 30 s TTL, bounded cache                         |

The bounded caches matter: an unbounded map keyed by an attacker-controlled slug
would be a memory exhaustion vector.

**Throttlers** (`src/auth/throttling.ts`, BN-REQ-SEC-004): `default` aplica a toda ruta; `auth`
aplica **solo** a las rutas marcadas con `@AuthThrottle()` (sign-in, refresh, confirmación, verificación
y gestión de MFA, cambio de contraseña, aceptación de invitación). Los health checks (`/health`, `/health/*`) quedan exentos de
ambos. Con `THROTTLER_REDIS_URL` (`redis://` o `rediss://`) los contadores se comparten entre
instancias; sin ella viven en la memoria de cada proceso.

---

## 6. Information disclosure

| Vector                    | Control                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| Stack traces in responses | Single exception filter; unexpected errors become a generic 500         |
| Driver messages           | Prisma codes translated to safe, stable error codes                     |
| Internal schema names     | Exposed only on the tenant detail route, never in listings              |
| API surface discovery     | Scalar reference disabled or behind HTTP Basic auth outside development |
| Security headers          | Helmet 8 (`src/bootstrap/apply-http-settings.ts`), see the table below  |
| Fingerprinting            | No `X-Powered-By` at all (see the table below)                          |

Response headers actually emitted, as configured in `applyHttpSettings` (Helmet) and
`ResponseHeadersMiddleware` (`src/bootstrap/response-headers.middleware.ts`):

| Header                              | Value                                                                                            | Source                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `Strict-Transport-Security`         | `max-age=31536000; includeSubDomains; preload`, only when `NODE_ENV` is not `development`         | Helmet `hsts`                           |
| `X-Frame-Options`                   | `DENY`                                                                                           | Helmet `frameguard`                     |
| `X-Content-Type-Options`            | `nosniff`                                                                                        | Helmet `noSniff` and the middleware     |
| `Referrer-Policy`                   | `strict-origin-when-cross-origin`                                                                | Helmet `referrerPolicy`                 |
| `Content-Security-Policy`           | Only when `DOCS_ENABLED=true`: `default-src 'self'`, scripts/styles/fonts from `cdn.jsdelivr.net`, `frame-ancestors 'none'`, `object-src 'none'`. Absent otherwise (the API serves JSON only) | Helmet `contentSecurityPolicy`          |
| `Cross-Origin-Opener-Policy`        | `same-origin`                                                                                    | Helmet default                          |
| `Cross-Origin-Resource-Policy`      | `same-origin`                                                                                    | Helmet default                          |
| `Cross-Origin-Embedder-Policy`      | Not sent (`crossOriginEmbedderPolicy: false`)                                                    | Helmet                                  |
| `Origin-Agent-Cluster`              | `?1`                                                                                             | Helmet default                          |
| `X-DNS-Prefetch-Control`            | `off`                                                                                            | Helmet default                          |
| `X-Download-Options`                | `noopen`                                                                                         | Helmet default                          |
| `X-Permitted-Cross-Domain-Policies` | `none`                                                                                           | Helmet default                          |
| `X-XSS-Protection`                  | `0`                                                                                              | Helmet default                          |
| `X-Powered-By`                      | Not sent: `express.disable('x-powered-by')`, and Helmet strips it too                            | `applyHttpSettings`                     |
| `X-Request-Id`                      | Correlation id (echoed if the caller sent a valid one)                                           | `RequestContextMiddleware`              |
| CORS                                | Allow-listed origins only (`CORS_ORIGINS`), credentials, `maxAge` 600 s; exposes `X-Request-Id` and `Retry-After` | `app.enableCors`                        |

**Preflight rechazado = 403.** Un `OPTIONS` con `Access-Control-Request-Method` desde un origen fuera
de `CORS_ORIGINS` se responde `403` (error de origen CORS no permitido) en `applyHttpSettings`, antes de llegar
al router (BN-REQ-SEC-010). Antes, el middleware `cors` solo omitía sus cabeceras y el navegador veía
un 404 engañoso. Las peticiones no-preflight de un origen no permitido siguen sin cabeceras CORS.

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
| Escaneo de vulnerabilidades | **Artifact Analysis** activo en los dos registros (`SCANNING_ACTIVE`). Sin gate bloqueante, por diseño (§7.3) |
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

### 7.3 Por qué no hay un gate de vulnerabilidades que bloquee

El pipeline no detiene un despliegue por vulnerabilidades, y es una decisión
consciente, no un descuido.

El primer intento era escanear la imagen en el job de build de producción con
`trivy-action` y `exit-code: 1`. En el run `39169632356` —el primer despliegue a
producción— ese paso falló, y no por un CVE:

```
installing Trivy binary
aquasecurity/trivy info checking GitHub for tag 'v0.65.0'
aquasecurity/trivy info found version: 0.65.0
##[error]Process completed with exit code 1
```

Murió tres décimas de segundo después de resolver la versión, descargando su
propio binario desde GitHub. No llegó a escanear la imagen. El pipeline paró,
que es lo correcto, pero por una causa que no tenía nada que ver con la
seguridad de la imagen.

El problema de fondo: **`trivy-action` devuelve el mismo código de salida si
encuentra un CVE y si no puede ejecutarse.** Un control así no es un control de
seguridad, es un paso que se relanza hasta que pasa, y el día que alguien no lo
re-lanza porque va con prisa, el "aseguramiento" era-fiction.

Lo que hay ahora, repartido donde un fallo no puede costar un despliegue:

| Dónde | Qué | ¿Bloquea? |
| --- | --- | --- |
| `ci.yml`, job `scan` | Trivy sobre el lockfile en cada PR, informe como artefacto | No, y con `continue-on-error` en el paso: si Trivy no baja, el job sigue en verde y lo dice con un `::warning` |
| Artifact Registry | **Artifact Analysis**: Google escanea cada imagen al subirla | No puede tumbar nada: no hay descarga de terceros, usa las credenciales del proyecto |
| `provision-environment.sh` | Activa el escaneo al provisionar | — |

Cómo consultar el resultado del escaneo nativo:

```bash
gcloud artifacts docker images describe IMAGE@sha256:DIGEST \
  --project=vondi-0q --format='value(vulnerabilityAnalysis)'
```

**Lo que esto deja sin cubrir**, y hay que decirlo: no hay un bloqueo
automático por CVE antes de producción. Hoy lo cubren la revisión del PR y que
Artifact Analysis esté activo. Si en el futuro se quiere un gate duro, el
camin correcto es *On-Demand Scanning* —que también es nativo y por tanto
determinista— consultado desde el pipeline, no un escáner que se descarga por
internet en el momento de decidir.

### 7.4 La verificación de la promoción leía mal la salud de la revisión

El primer despliegue completo a producción (run `39182072940`) promovió la
revisión nueva, leyó su salud como **vacía** y revirtió a la anterior. La
revisión estaba perfectamente sana: el rollback se ejecutó porque el chequeo
mintió.

```
PREVIOUS: netpay-api-00010-c4p
Revisión netpay-api-rfd9ddbb…-1 no sana (Ready=); revirtiendo a netpay-api-00010-c4p
100% netpay-api-00010-c4p
```

La causa está en el comando, no en la imagen:

```bash
# Devuelve cadena vacía aunque la revisión esté Ready=True
gcloud run revisions describe "$REV" \
  --format='value(status.conditions[?@.type=="Ready"].status)'

# Esto sí funciona
gcloud run revisions describe "$REV" --format=json \
  | jq -r '([.status.conditions[]? | select(.type=="Ready") | .status] | first) // ""'
```

Un valor vacío leído como «no sana» es la peor forma de fallo posible en un gate:
**revierte todos los despliegues, incluidos los buenos**. Un gate que siempre
dice «mal» entrena aIgnorarlo en dos semanas, y el día que de verdad haya un
problema ya nadie lo mira.

El mismo tipo de trampa está en el paso anterior: `status.traffic` viene vacío
cuando el servicio sirve una sola revisión sin reparto explícito —que es lo
normal—, así que leer `status.traffic[0].revisionName` a secas deja al rollback
sin destino. Ahora tiene respaldo a `latestReadyRevisionName` y **aborta antes
de desplegar** si tampoco así lo consigue, en vez de desplegar sin red de
seguridad.

Las dos cosas se comprobaron contra la revisión real antes de arreglar nada:
`Ready=True` por la vía JSON y vacío por el filtro, con la misma revisión.

### 7.5 Credenciales expuestas en canales no confiables

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
   wrap them in a KMS or a secrets manager. The versioned keyring (§3) makes
   rotation possible, but wrapping its keys with Cloud KMS is still pendiente.
2. **Blind-index rotation is manual.** Rotating `PII_HMAC_KEY` invalidates every
   stored index; a re-encryption job must be written before rotating it.
3. **Tenant schema names are immutable.** Changing a slug means a new tenant;
   there is no rename migration.
4. **Provisioning is synchronous.** Creating a tenant runs DDL inline, which is
   fine up to a few thousand tenants and should become a queue beyond that.
5. **The audit trail is append-only by convention.** The model has no cascades
   and the service exposes no update or delete, but nothing prevents a
   superuser from editing rows. Ship it to immutable storage if that matters.
6. **Rate limiting is in-memory unless `THROTTLER_REDIS_URL` is set.** Without
   it, a multi-instance deployment counts limits per instance (§5).
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
