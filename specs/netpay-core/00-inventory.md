# 00 — Inventario (estado actual, solo lectura)

Rutas relativas a `back-nest/`. Fecha: 2026-10-21. Commit `99a6d4e`.

## 1. Stack y despliegue

| Capa | Valor | Evidencia |
|---|---|---|
| Runtime | NestJS (Node), Prisma con dos planos: control-plane DB y tenant-plane con esquema por tenant (`tenant_<slug>_<id>`) | `docs/ARCHITECTURE.md` |
| BD | Neon Postgres. El rol de la app es `mtb_app` (NOBYPASSRLS). FORCE RLS en tablas de tenant (migraciones 0002–0004) | `prisma/tenant-migrations/*` |
| Prod | Cloud Run `netpay-api`, proyecto `vondi-0q`, `us-east5`. min 0 / max 4, 1 vCPU / 512 Mi, CPU throttled, ingress `all`, invoker `allUsers`, VPC egress all-traffic con NAT `vondi-nat` e IP `vondi-egress` | `gcloud run services describe` |
| Staging | Cloud Run `netpay-api-staging`, proyecto `vondi-0q-staging`. Revisión manual `netpay-api-staging-00033-k95`, desplegada por un usuario y no por el pipeline | idem |
| CI/CD | `ci.yml` (lint, test, e2e, Trivy con `continue-on-error`). `deploy.yml` y `deploy-environment.yml` hacen build, migrate job, canary y promoción | `.github/workflows/*` |
| Secretos | Secret Manager por secreto. WIF de prod limitado a `main`. Imágenes fijadas por digest, con SBOM y provenance | idem |

## 2. Endpoints públicos

Orden de los guards globales: Throttler → Auth → ApiKeyScopes → Permissions (`src/app.module.ts:64-69`).

| Método / ruta | Auth | Permiso / scope |
|---|---|---|
| GET `/health`, `/health/live`, `/health/ready` | Público | — |
| POST `/auth/sign-in`, `/auth/refresh`, `/auth/sign-out`; GET `/auth/session` | Público (admin de plataforma) | — |
| `/tenants*` (CRUD, `stats`, `suspend`, `reactivate`, `migrate`, `purge`) | JWT de admin | OWNER/ADMIN(/AUDITOR) |
| POST `/t/auth/sign-in`, `/t/auth/refresh` | Público + TenantGuard | — |
| `/t/users*`, `/t/projects*` | JWT de tenant o API key | `users:*` / `projects:*` |
| `/api-keys*` | Tenant | `api-keys:*` + scope `admin:*` |
| POST `/t/payments/orders`, `…/verify`, `…/charge`, `…/confirm`, `/cards`; PUT/DELETE de tokens de tarjeta | Tenant | `payments:write` |
| GET `/t/payments/orders`, `/orders/:id`, `/cards/:clientId`, `/installments`, `/config` | Tenant | `payments:read` |
| POST `/t/payments/orders/:id/refund` | Tenant | `payments:refund` |
| `/t/payments/config*` (`webhook-token`, `webhook-register`, `webhook`) | Tenant (no se puede otorgar a API keys) | `payments:configure` |
| `/t/webhooks*` (CRUD, `events`, `rotate-secret`, `end-rotation`, `status`, `deliveries`, `replay`) | Tenant | `webhooks:*` como permiso, **sin `@RequireScopes`** |
| POST `/payments/webhook/:token` | Público (token en el path) | — |

## 3. Capacidades NetPay

| Capacidad | Estado | Evidencia | Nota |
|---|---|---|---|
| Credenciales por tenant | ✅/⚠️ | `payment-config.service.ts:134-193`; AES-256-GCM con AAD = tenant (`payment-secret-box.ts:38`) | Se valida solo el prefijo de la llave, no el ambiente. Un solo registro de config que se sobrescribe |
| API keys de consumidores | ✅ | `api-key.service.ts:19-32,116-123`; `auth.guard.ts:147-183` | Argon2id, scopes, expiración, rotación y revocación |
| Tokenización + cargo | ✅ | `payment-orders.service.ts:596-826` | Una orden FAILED no se puede recobrar (`:690-693`, `:763`) |
| 3-D Secure 2.0 | ⚠️ | `:1018-1060`, `:1095` | Sin expiración de `WAIT_THREEDS`. El claim no se libera si `confirm` lanza error |
| Checkout alojado | ✅/⚠️ | `:218-249`; `controller:144-153` | URLs de retorno sin allowlist. No se registra la expiración de la sesión |
| OXXO / efectivo (CEP) | ✅/⚠️ | `:250-277`; `netpay-webhook.service.ts:122-140` | Sin job de expiración de referencia |
| Reembolso total/parcial | ✅/⚠️ | `:840-959` | Sin `Idempotency-Key`. Sin estado PARTIALLY_REFUNDED. Posible doble reembolso si la BD falla después de NetPay |
| Void / cancelación | ⚠️ | solo dentro de refund (`:935`) | No hay endpoint de cancelación ni estado CANCELLED |
| Pre-auth / captura | ❌ | `transactionType:'Auth'` (`:714`) | NO VERIFICADO si NetPay lo soporta |
| Tarjetas guardadas / recurrentes | ⚠️ | `controller:573-641` | Requiere CVV en cada cargo; no hay MIT ni suscripciones. `lastFourDigits` = últimos 4 del token (`:581`), dato incorrecto |
| Consulta / conciliación | ⚠️ | `POST verify` manual | **Sin job programado** |
| Webhook entrante de NetPay | ⚠️ | `netpay-webhook.controller.ts:33-40`; `netpay-webhook.service.ts:89-151` | Sin firma (solo funciona como disparador). `eventId` aleatorio, así que la deduplicación no funciona (`:112`, `:207`) |
| Eventos salientes | ⚠️ | `outbound-*`; `signature.ts:33-35` | HMAC correcto, pero: varias IP → rechazo; entregas apagadas por defecto; payload delgado y reconstruido al momento de enviar; encolado fuera de la transacción; drena solo los primeros 200 tenants |
| Montos / moneda | ✅ | `Decimal(12,2)`, regex de monto, AMOUNT_MISMATCH (`:448`) | En custom/plus se acepta una moneda ≠ MXN (`controller:106`) |
| Mapeo de códigos de rechazo | ❌ | `netpay.client.ts:174-196` | Solo devuelve `message` crudo |
| Datos de tarjeta en logs | ⚠️ | `netpay.client.ts:~600-605` | `subErrors[].value` entra a errores y `failureReason` |

## 4. Gates de calidad (corridos el 2026-10-21)

| Gate | Resultado |
|---|---|
| `npm run lint` (max-warnings 0) | PASS |
| `npm run typecheck` | PASS |
| `npm run format:check` | PASS |
| Build | PASS |
| Unit (`test:cov`) | 27 suites, **446 pass**, 0 fail. Cobertura: stmts 50.6 %, branches 48.4 %, funcs 41.4 %. Al 0 %: `outbound-webhook.service/controller`, `tenants.service`, `health.controller`. Sin umbral |
| e2e | **157 pass**, 26 skip (`netpay-sandbox.e2e-spec.ts` sin llaves), 0 fail |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| `scripts/scan-secrets.sh` / gitleaks (44 commits) | 0 hallazgos |

## 5. Staging en vivo (2026-10-21)

- **Health:** 200. Arranque en frío de 11.2 s (escala a cero). `/health/ready` autenticado reporta las dos BD arriba. No hay endpoint de versión ni de commit.
- **TLS y headers:**
  - TLS 1.3 únicamente, con redirección de HTTP a HTTPS.
  - Headers: CSP, HSTS preload, XFO DENY, nosniff, COOP/CORP y `no-store`.
  - **Bug:** se envía `X-Powered-By: masked`.
- **CORS:**
  - Solo están permitidos localhost:3000, 127.0.0.1:3000 y localhost:5173.
  - `https://vondi.tupla.dev` **no** está permitido.
  - Un preflight rechazado responde 404 "Cannot OPTIONS".
- **Throttler:** `x-ratelimit-limit-auth: 10` aparece en `/health/ready` y en `/api/v1/tenants`, así que el throttler de auth se aplica en **todas** las rutas.
- **Owner de staging:** sigue marcado con `mustChangePassword: true`.
- **Tenants:** 3, todos ACTIVE (`acme`, `pl-demo`, `pl-demo-store`).
- **`pl-demo-store` (`4a4b30d9…`):**
  - Config SANDBOX activa.
  - 13 órdenes: 5 PAID, 6 PENDING, 1 FAILED, 1 REFUNDED.
  - Endpoints salientes: **0**.
  - **Webhook registrado en NetPay: `https://betydeliv.replit.app/api/payments/webhook`.** Es una app ajena: la llave sandbox es compartida o alguien la sobrescribió.

## 6. Costos de prod (inferidos)

| Concepto | Detalle |
|---|---|
| Cloud Run | min 0, así que en reposo cuesta casi $0 y escala con el tráfico. Canary min 0 |
| NAT + IP estática | ~$1–4/mes más $0.045/GB procesado |
| Neon | Probablemente el mayor rubro: 1 CU, autosuspend NO VERIFICADO. `/health/ready` sin cache mantiene el compute despierto |
| Artifact Registry | ~1.17 GB y crece sin política de limpieza. El escaneo de contenedores ya se apagó (2026-10-21) |
| Logging | Los logs de probes y requests van a `_Default` |
