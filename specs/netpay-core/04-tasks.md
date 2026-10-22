# 04 — Tasks auditables

Cada task: test que falla antes del cambio (rojo) y pasa después (verde), evidencia en `specs/netpay-core/evidence/<ID>/`, un PR pequeño por task y commit `fix(<ID>): …`.

**Orden de ejecución por olas:**

1. **Ola 1 (P0, desbloquea plane):** 001, 002, 003, 029, 031, 023, 013, 041.
2. **Ola 2 (P0 de dinero):** 004, 010, 011, 014, 015, 016, 024, 026, 027, 042, 043.
3. **Ola 3 (P1):** el resto de P1.
4. **Ola 4 (P2).**

La certificación (055) cierra la Ola 2.

### BN-TASK-001 — Aceptar hosts con varias IP públicas y fijar la conexión
- **Requisitos:** BN-REQ-EVT-001
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** src/payments/outbound/url-guard.ts, http.transport.ts, url-guard.spec.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given `hooks.example` resuelve a 8 A + 8 AAAA públicas, When se registra el endpoint, Then 201 y la entrega conecta a una IP validada
  - Given una de las IP es 10.0.0.1, Then 422 `BLOCKED_ADDRESS`
- **Test:** unit url-guard.spec.ts + integración contra un servicio Cloud Run real en staging
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-001/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-001/`

### BN-TASK-002 — Fallas DNS en entrega como reintentables, no deshabilitar
- **Requisitos:** BN-REQ-EVT-002
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** src/payments/outbound/outbound-dispatcher.service.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given DNS falla en una entrega, When el dispatcher procesa, Then la entrega queda RETRY y el endpoint sigue ACTIVE
- **Test:** unit outbound-dispatcher.spec.ts
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-002/`
- **Dependencias:** BN-TASK-001
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-002/`

### BN-TASK-003 — Encender entregas por defecto y reportar degradado
- **Requisitos:** BN-REQ-EVT-003
- **Prioridad:** P0
- **Tipo:** CODE+CONFIG
- **Archivos:** src/config/env.validation.ts, health.service.ts, workflows (env de staging/prod)
- **Criterios de aceptación (Given/When/Then):**
  - Given endpoints activos y OUTBOUND_WEBHOOK_ENABLED=false, When GET /health/ready (autenticado), Then status `degraded` con `outboundDisabled`
- **Test:** unit config + e2e health
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-003/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-003/`

### BN-TASK-004 — Outbox transaccional de eventos con sequence y snapshot
- **Requisitos:** BN-REQ-EVT-004, BN-REQ-EVT-005, BN-REQ-EVT-006
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** prisma/tenant-migrations/00xx_payment_event_outbox.sql, payment-events.ts, payment-orders.service.ts, outbound-dispatcher.service.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given un cambio PAID dentro de tx que hace rollback, Then no hay evento
  - Given commit y caída del proceso antes de despachar, When reinicia, Then el evento se entrega
  - Given refund parcial, Then `payment.refunded` con sequence+1 y `refundedAmount`
- **Test:** integración e2e outbox.e2e-spec.ts
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-004/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-004/`

### BN-TASK-005 — Calendario de reintentos de 24 h con tope y jitter
- **Requisitos:** BN-REQ-EVT-007
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** outbound-dispatcher.service.ts, env.validation.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given 10 fallos consecutivos, Then siguiente intento ≤ 1 h y DEAD solo tras 24 h
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-005/`
- **Dependencias:** BN-TASK-004
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-005/`

### BN-TASK-006 — Dispatcher justo entre tenants y entregas concurrentes
- **Requisitos:** BN-REQ-EVT-008
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** outbound-dispatcher.service.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given 300 tenants con eventos y un endpoint con 8 s de latencia, When corre un ciclo, Then todos los tenants avanzan y el lento no bloquea
- **Test:** unit con reloj simulado
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-006/`
- **Dependencias:** BN-TASK-004
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-006/`

### BN-TASK-007 — Conservar query y esquema de la URL suscrita
- **Requisitos:** BN-REQ-EVT-009
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** http.transport.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given URL `https://h/x?a=1`, Then la petición sale a `/x?a=1`
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-007/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-007/`

### BN-TASK-008 — Replay auditado sin reiniciar el contador
- **Requisitos:** BN-REQ-EVT-010, BN-REQ-OPS-011
- **Prioridad:** P2
- **Tipo:** CODE
- **Archivos:** outbound-webhook.service.ts, audit
- **Criterios de aceptación (Given/When/Then):**
  - Given replay, Then attempt conserva el histórico y existe registro de auditoría con el actor
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-008/`
- **Dependencias:** BN-TASK-030
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-008/`

### BN-TASK-009 — Catálogo y JSON Schema de eventos en docs y OpenAPI
- **Requisitos:** BN-REQ-EVT-011, BN-REQ-API-001
- **Prioridad:** P1
- **Tipo:** DOC+TEST
- **Archivos:** docs/events/*.json, docs/openapi.json, test de contrato
- **Criterios de aceptación (Given/When/Then):**
  - Given un payload real de cada evento, Then valida contra su schema
  - CI falla si openapi.json difiere del generado
- **Test:** contract test + CI
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-009/`
- **Dependencias:** BN-TASK-004
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-009/`

### BN-TASK-010 — Interceptor de idempotencia (refund, orden, cargo, confirm)
- **Requisitos:** BN-REQ-IDM-001, BN-REQ-IDM-002, BN-REQ-IDM-003
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** src/common/idempotency/*, tenant migration idempotency_record, controllers de pagos
- **Criterios de aceptación (Given/When/Then):**
  - Given dos refunds concurrentes con la misma llave, Then un solo llamado a NetPay y ambas respuestas iguales
  - Given misma llave y otro cuerpo, Then 422
  - Given llave en curso, Then 409 + Retry-After
- **Test:** e2e idempotency.e2e-spec.ts
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-010/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-010/`

### BN-TASK-011 — Resultados del proveedor pendientes de aplicar
- **Requisitos:** BN-REQ-IDM-004
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** payment-orders.service.ts, tenant migration pending_provider_result
- **Criterios de aceptación (Given/When/Then):**
  - Given NetPay confirma refund y la escritura local falla, Then queda un pendiente, el claim no se libera, y la conciliación lo aplica una sola vez
- **Test:** integración con fallo inyectado
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-011/`
- **Dependencias:** BN-TASK-016
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-011/`

### BN-TASK-012 — Dedupe determinista del webhook entrante
- **Requisitos:** BN-REQ-IDM-005
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** netpay-webhook.service.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given la misma notificación 5 veces en 1 min, Then una sola verificación a NetPay
- **Test:** unit netpay-webhook.spec.ts
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-012/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-012/`

### BN-TASK-013 — Respuesta 504 PROVIDER_OUTCOME_UNKNOWN en timeouts
- **Requisitos:** BN-REQ-PAY-011, BN-REQ-API-002
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** netpay.client.ts, app.exception.ts, all-exceptions.filter.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given timeout de NetPay en refund, Then 504 `PROVIDER_OUTCOME_UNKNOWN` retryable:true y el claim se conserva
  - Given rechazo explícito, Then 502 `PROVIDER_DECLINED`
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-013/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-013/`

### BN-TASK-014 — Estado CHARGE_UNKNOWN y verificación antes de recobrar
- **Requisitos:** BN-REQ-PAY-003
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** payment-orders.service.ts, máquina de estados
- **Criterios de aceptación (Given/When/Then):**
  - Given timeout en el cargo, Then la orden queda CHARGE_UNKNOWN y un nuevo cargo recibe 409 hasta que verify resuelve
- **Test:** integración
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-014/`
- **Dependencias:** BN-TASK-013
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-014/`

### BN-TASK-015 — Intentos múltiples por orden (recobrar tras rechazo o 3DS fallido)
- **Requisitos:** BN-REQ-PAY-001, BN-REQ-PAY-002
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** tenant migration payment_attempt, payment-orders.service.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given cargo rechazado, When se envía otra tarjeta, Then se crea intento 2 y puede quedar PAID
  - Given 3DS abandonado, When nuevo cargo, Then se verifica el intento previo y se acepta si no hubo cobro
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-015/`
- **Dependencias:** BN-TASK-014
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-015/`

### BN-TASK-016 — Job de conciliación de órdenes no terminales
- **Requisitos:** BN-REQ-REC-001, BN-REQ-REC-002, BN-REQ-REC-003, BN-REQ-REC-004
- **Prioridad:** P0
- **Tipo:** CODE+INFRA
- **Archivos:** src/payments/reconciliation/*, src/internal/* (`POST /internal/tick`, OIDC), scripts/gcp/scheduler-internal-tick.sh (Cloud Scheduler solo en staging: producción sin scheduler por decisión del dueño)
- **Criterios de aceptación (Given/When/Then):**
  - Given orden PENDING pagada en NetPay sin webhook, When corre la conciliación, Then queda PAID y emite `payment.paid`
  - Given WAIT_THREEDS > 30 min sin cargo, Then EXPIRED
  - Given 2 workers simultáneos, Then cada orden se procesa una vez
- **Test:** integración test/reconciliation.int-spec.ts (PostgreSQL real, 2 workers) + unit + e2e de `/internal/tick`
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-016/`
- **Dependencias:** BN-TASK-004
- **Estado:** REQUIERE APROBACIÓN — código HECHO (worker, `POST /internal/tick` con OIDC, evidencia unit/int/e2e); falta ejecutar `scripts/gcp/scheduler-internal-tick.sh --apply` en staging (solo impreso: `evidence/BN-TASK-016/infra-scheduler-print.txt`). Producción sin scheduler por decisión del dueño.

### BN-TASK-017 — Listado por cursor con filtros y campos verificados en GET
- **Requisitos:** BN-REQ-REC-005, BN-REQ-REC-006
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** payment-orders.controller.ts/service.ts, DTOs
- **Criterios de aceptación (Given/When/Then):**
  - Given 250 órdenes, When se pagina con cursor y updatedSince, Then se obtienen todas sin duplicados
  - GET /orders/:id incluye verifiedAmount y netpayTransactionId
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-017/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-017/`

### BN-TASK-018 — Cancelación de órdenes no pagadas
- **Requisitos:** BN-REQ-PAY-004
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** controller/service, evento payment.cancelled
- **Criterios de aceptación (Given/When/Then):**
  - Given orden PENDING alojada, When POST /cancel, Then CANCELLED y evento
  - Given pago tardío detectado por conciliación, Then `payment.paid_after_cancel` auditado
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-018/`
- **Dependencias:** BN-TASK-016
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-018/`

### BN-TASK-019 — Estado PARTIALLY_REFUNDED
- **Requisitos:** BN-REQ-PAY-005
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** enum + migración + servicio
- **Criterios de aceptación (Given/When/Then):**
  - Given refund parcial, Then PARTIALLY_REFUNDED
  - Given refund del resto, Then REFUNDED
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-019/`
- **Dependencias:** BN-TASK-004
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-019/`

### BN-TASK-020 — Mapeo de códigos de rechazo a enum estable
- **Requisitos:** BN-REQ-PAY-006
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** netpay.client.ts, decline-codes.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given respuesta NetPay con código de fondos insuficientes, Then `failureCode: INSUFFICIENT_FUNDS` en respuesta y evento
- **Test:** unit con tabla de códigos
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-020/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-020/`

### BN-TASK-021 — Allowlist de URLs de retorno por tenant
- **Requisitos:** BN-REQ-PAY-007
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** payment-config (campo allowedReturnOrigins), controller
- **Criterios de aceptación (Given/When/Then):**
  - Given successUrl con host no listado, Then 422
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-021/`
- **Dependencias:** BN-TASK-024
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-021/`

### BN-TASK-022 — Solo MXN salvo habilitación
- **Requisitos:** BN-REQ-PAY-008
- **Prioridad:** P2
- **Tipo:** CODE
- **Archivos:** controller DTO
- **Criterios de aceptación (Given/When/Then):**
  - Given currency USD sin habilitar, Then 422
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-022/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-022/`

### BN-TASK-023 — Quitar valores devueltos por el proveedor de errores y logs
- **Requisitos:** BN-REQ-PAY-009
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** netpay.client.ts (providerMessageOf)
- **Criterios de aceptación (Given/When/Then):**
  - Given subErrors con un PAN de prueba, Then ni la respuesta, ni el log, ni failureReason contienen dígitos de tarjeta
- **Test:** unit con fixture
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-023/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-023/`

### BN-TASK-024 — Config de pagos versionada y operaciones con la config de la orden
- **Requisitos:** BN-REQ-CFG-002, BN-REQ-CFG-003
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** payment-config.service.ts, migración, payment-orders.service.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given orden SANDBOX y cambio a LIVE, When refund de la orden vieja, Then usa credenciales SANDBOX
  - al cambiar llave, nuevo webhook token y webhookRegisteredAt null
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-024/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-024/`

### BN-TASK-025 — Validar credenciales contra NetPay al guardar
- **Requisitos:** BN-REQ-CFG-001, BN-REQ-API-004
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** payment-config.service.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given llave live en ambiente SANDBOX, Then 422 `CREDENTIALS_ENVIRONMENT_MISMATCH`
- **Test:** integración sandbox
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-025/`
- **Dependencias:** BN-TASK-024
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-025/`

### BN-TASK-026 — Detección de drift del webhook registrado en NetPay
- **Requisitos:** BN-REQ-CFG-004
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** payment-orders.controller.ts, health.service.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given NetPay apunta a `https://betydeliv.replit.app/...`, When GET /t/payments/config/webhook, Then `drift:true` y la métrica `netpay_webhook_drift=1`
- **Test:** unit + smoke staging
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-026/`
- **Dependencias:** BN-TASK-024
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-026/`

### BN-TASK-027 — Llaves NetPay propias por ambiente y re-registro del webhook
- **Requisitos:** BN-REQ-CFG-005
- **Prioridad:** P0
- **Tipo:** INFRA
- **Archivos:** NetPay (portal), Secret Manager
- **Criterios de aceptación (Given/When/Then):**
  - Given staging, When se consulta el webhook en NetPay, Then apunta a netpay-api-staging/.../payments/webhook/{token}
- **Test:** script de verificación (curl + jq)
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-027/`
- **Dependencias:** BN-TASK-026
- **Estado:** PENDIENTE — INFRA manual con NetPay (llaves propias por ambiente y re-registro). Bloqueo externo: no hay llaves de staging propias. La verificación ya existe: `GET /t/payments/config/webhook` (drift, BN-TASK-026).

### BN-TASK-028 — Redirect y cancel URL desde config validada
- **Requisitos:** BN-REQ-CFG-006
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** payment-orders.service.ts:222-223,1467-1468, netpay-endpoints.ts:95-96, eslint no-process-env
- **Criterios de aceptación (Given/When/Then):**
  - Given variable faltante, Then el arranque falla con mensaje claro
  - lint prohíbe process.env fuera de config
- **Test:** unit + lint
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-028/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-028/`

### BN-TASK-029 — Scopes obligatorios en /t/webhooks y auditoría de rutas al arrancar
- **Requisitos:** BN-REQ-SEC-001
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** outbound-webhook.controller.ts, rbac-audit.service.ts, scopes
- **Criterios de aceptación (Given/When/Then):**
  - Given API key con payments:read, When POST /t/webhooks, Then 403
  - Given ruta con @RequirePermissions sin @RequireScopes, Then el arranque falla
- **Test:** e2e + unit rbac-audit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-029/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-029/`

### BN-TASK-030 — Bitácora de auditoría de pagos
- **Requisitos:** BN-REQ-OPS-011
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** src/payments/** → AuditLogService
- **Criterios de aceptación (Given/When/Then):**
  - Given cambio PENDING→PAID, Then registro con actor (sistema/usuario/key), tenant, orden y de→a
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-030/`
- **Dependencias:** BN-TASK-004
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-030/`

### BN-TASK-031 — Alta de usuarios con API key: techo MEMBER e invitación
- **Requisitos:** BN-REQ-SEC-002, BN-REQ-SEC-003
- **Prioridad:** P0
- **Tipo:** CODE
- **Archivos:** tenant-users.service.ts, tenant-api.controller.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given key users:write, When crea ADMIN, Then 403
  - When envía password, Then 422
  - Given VIEWER, When POST /t/users, Then 403
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-031/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-031/`

### BN-TASK-032 — Throttler de auth solo en login y storage compartido
- **Requisitos:** BN-REQ-SEC-004
- **Prioridad:** P1
- **Tipo:** CODE+INFRA
- **Archivos:** app.module.ts, health.controller.ts, Memorystore (prod)
- **Criterios de aceptación (Given/When/Then):**
  - Given 30 GET /health/ready por minuto, Then nunca 429
  - Given 11 sign-in por minuto, Then 429 en el 11.º
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-032/`
- **Dependencias:** —
- **Estado:** REQUIERE APROBACIÓN — código HECHO (throttlers y storage Redis); falta provisionar Memorystore y fijar `THROTTLER_REDIS_URL` en producción.

### BN-TASK-033 — Redactar token del webhook entrante en logs
- **Requisitos:** BN-REQ-SEC-005
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** all-exceptions.filter.ts, logger
- **Criterios de aceptación (Given/When/Then):**
  - Given 500 en /payments/webhook/abc, Then el log muestra /payments/webhook/[REDACTED]
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-033/`
- **Dependencias:** BN-TASK-036
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-033/`

### BN-TASK-034 — MFA para admins de plataforma y step-up
- **Requisitos:** BN-REQ-SEC-006, BN-REQ-SEC-008
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** auth (TOTP), guards
- **Criterios de aceptación (Given/When/Then):**
  - Given admin sin MFA, When accede a /tenants, Then 403 `MFA_REQUIRED`
  - Given mustChangePassword, Then solo se permite el cambio de contraseña
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-034/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-034/`

### BN-TASK-035 — Keyring versionado y re-cifrado
- **Requisitos:** BN-REQ-SEC-007
- **Prioridad:** P1
- **Tipo:** CODE+INFRA
- **Archivos:** pii-crypto.service.ts, payment-secret-box.ts, job reencrypt, KMS opcional
- **Criterios de aceptación (Given/When/Then):**
  - Given llave v2 activa, Then se lee lo cifrado con v1 y se escribe con v2
  - el job deja 0 registros en v1
- **Test:** unit + job en staging
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-035/`
- **Dependencias:** —
- **Estado:** REQUIERE APROBACIÓN — código HECHO (keyring y job de re-cifrado); falta correr el job en staging y, opcional, envolver con Cloud KMS.

### BN-TASK-036 — Logs JSON estructurados y log de acceso
- **Requisitos:** BN-REQ-OPS-004
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** main.ts, logger, middleware
- **Criterios de aceptación (Given/When/Then):**
  - Given una petición, Then una línea JSON con severity, requestId, tenantId, route, status, latencyMs y trace
  - respeta LOG_LEVEL
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-036/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-036/`

### BN-TASK-037 — Health: cache, detalles solo autenticados, versión y SHA
- **Requisitos:** BN-REQ-SEC-009, BN-REQ-OPS-010
- **Prioridad:** P2
- **Tipo:** CODE
- **Archivos:** health.controller/service.ts, build args
- **Criterios de aceptación (Given/When/Then):**
  - Given header Authorization falso, Then sin detalles
  - Given principal válido, Then versión y SHA
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-037/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-037/`

### BN-TASK-038 — CORS de staging con orígenes reales y 403 en preflight
- **Requisitos:** BN-REQ-SEC-010
- **Prioridad:** P1
- **Tipo:** CONFIG+CODE
- **Archivos:** apply-http-settings.ts, env de staging
- **Criterios de aceptación (Given/When/Then):**
  - Given Origin https://vondi.tupla.dev, Then 204 con ACAO
  - Given evil.example, Then 403
- **Test:** e2e CORS
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-038/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-038/`

### BN-TASK-039 — Quitar X-Powered-By
- **Requisitos:** BN-REQ-SEC-011, BN-REQ-DOC-004
- **Prioridad:** P2
- **Tipo:** CODE
- **Archivos:** bootstrap
- **Criterios de aceptación (Given/When/Then):**
  - Given cualquier respuesta, Then sin X-Powered-By
- **Test:** test de headers
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-039/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-039/`

### BN-TASK-040 — Invalidación de caches entre instancias ≤5 s
- **Requisitos:** BN-REQ-SEC-012
- **Prioridad:** P2
- **Tipo:** CODE
- **Archivos:** tenant-resolver, authorization
- **Criterios de aceptación (Given/When/Then):**
  - Given tenant suspendido, Then 403 en ≤5 s en todas las instancias
- **Test:** integración
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-040/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-040/`

### BN-TASK-041 — Gate de CI en deploy y protección de environments
- **Requisitos:** BN-REQ-OPS-001
- **Prioridad:** P0
- **Tipo:** CONFIG
- **Archivos:** workflows, settings del repo (gh api)
- **Criterios de aceptación (Given/When/Then):**
  - Given push a main con tests fallando, Then no hay deploy
  - prod espera aprobación
- **Test:** verificación gh api + workflow de prueba
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-041/`
- **Dependencias:** —
- **Estado:** REQUIERE APROBACIÓN — workflows HECHOS (policy test); falta aplicar la protección de `main` y del environment con `scripts/github/protect-repo.sh --apply` (solo simulado).

### BN-TASK-042 — Migraciones de tenant en pipeline con lock y checksum
- **Requisitos:** BN-REQ-OPS-002
- **Prioridad:** P0
- **Tipo:** CODE+CI
- **Archivos:** scripts/migrate-tenants.ts, job netpay-migrate, CI
- **Criterios de aceptación (Given/When/Then):**
  - Given 3 tenants en v8 y release con v9, Then los 3 quedan en v9 antes de mover tráfico
  - ejecución concurrente aplica una vez
  - checksum alterado aborta
- **Test:** integración
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-042/`
- **Dependencias:** BN-TASK-041
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-042/`

### BN-TASK-043 — Alertas con canal, uptime check y SLO
- **Requisitos:** BN-REQ-OPS-003
- **Prioridad:** P0
- **Tipo:** INFRA
- **Archivos:** Cloud Monitoring (staging y prod)
- **Criterios de aceptación (Given/When/Then):**
  - Given 5xx > umbral, Then llega notificación al canal on-call
- **Test:** gcloud monitoring + simulacro
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-043/`
- **Dependencias:** BN-TASK-036
- **Estado:** REQUIERE APROBACIÓN — scripts listos y probados en simulación; falta `--apply` de canal on-call, uptime check y SLO en staging y prod.

### BN-TASK-044 — Métricas de pago (log-based)
- **Requisitos:** BN-REQ-OPS-005
- **Prioridad:** P1
- **Tipo:** CODE+INFRA
- **Archivos:** logger + métricas
- **Criterios de aceptación (Given/When/Then):**
  - Given cargos en staging, Then métricas de aprobación y latencia visibles en el dashboard
- **Test:** inspección
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-044/`
- **Dependencias:** BN-TASK-036
- **Estado:** REQUIERE APROBACIÓN — código HECHO (eventos de log); falta `scripts/gcp/monitoring/log-metrics.sh --apply` (incluye las métricas nuevas de conciliación y drift).

### BN-TASK-045 — Promoción gradual con smoke a la revisión y rollback
- **Requisitos:** BN-REQ-OPS-006
- **Prioridad:** P1
- **Tipo:** CI
- **Archivos:** deploy-environment.yml
- **Criterios de aceptación (Given/When/Then):**
  - Given revisión con 5xx en el smoke, Then no recibe tráfico
  - Given 5xx al 10 %, Then rollback automático
- **Test:** ensayo en staging
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-045/`
- **Dependencias:** BN-TASK-041
- **Estado:** REQUIERE APROBACIÓN — workflow HECHO (policy test y simulación de promoción/rollback); falta el ensayo en staging con un despliegue real.

### BN-TASK-046 — Flags de despliegue declarados y verificación de drift
- **Requisitos:** BN-REQ-OPS-007
- **Prioridad:** P1
- **Tipo:** CI
- **Archivos:** workflows, DEPLOY-GCP.md
- **Criterios de aceptación (Given/When/Then):**
  - Given revisión manual con flags distintos, Then el job de drift falla
- **Test:** job programado
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-046/`
- **Dependencias:** BN-TASK-041
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-046/`

### BN-TASK-047 — Trivy bloqueante y limpieza de Artifact Registry
- **Requisitos:** BN-REQ-OPS-008
- **Prioridad:** P2
- **Tipo:** CI+INFRA
- **Archivos:** ci.yml, cleanup policy
- **Criterios de aceptación (Given/When/Then):**
  - Given HIGH en imagen, Then CI falla
  - repositorio conserva N digests
- **Test:** CI
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-047/`
- **Dependencias:** —
- **Estado:** REQUIERE APROBACIÓN — Trivy bloqueante HECHO en CI; falta `scripts/gcp/apply-artifact-cleanup.sh --dry-run`/`--apply` (solo impreso).

### BN-TASK-048 — Umbral de cobertura en src/payments
- **Requisitos:** BN-REQ-OPS-009
- **Prioridad:** P1
- **Tipo:** CI+TEST
- **Archivos:** jest config, tests de outbound
- **Criterios de aceptación (Given/When/Then):**
  - Given cobertura < 80 % en payments, Then CI falla
  - outbound-webhook.service ≥ 80 %
- **Test:** CI
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-048/`
- **Dependencias:** BN-TASK-004
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-048/`

### BN-TASK-049 — Cloud Armor + LB en prod
- **Requisitos:** BN-REQ-OPS-012
- **Prioridad:** P2
- **Tipo:** INFRA
- **Archivos:** GCP
- **Criterios de aceptación (Given/When/Then):**
  - Given 200 req/s desde una IP, Then 429 en el edge
- **Test:** prueba de carga en staging
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-049/`
- **Dependencias:** —
- **Estado:** PENDIENTE — INFRA de producción (HTTPS LB + Cloud Armor + ingress `internal-and-cloud-load-balancing`); no hay script ni aprobación de costo. Cambiar el ingress antes rompe `run.app`.

### BN-TASK-050 — Error estable y revocación de keys/endpoints para consumidores
- **Requisitos:** BN-REQ-API-002, BN-REQ-API-003
- **Prioridad:** P1
- **Tipo:** CODE
- **Archivos:** filters, api-keys, outbound-webhook.controller
- **Criterios de aceptación (Given/When/Then):**
  - Given consumidor que se desconecta, When revoca key y deshabilita endpoint, Then deja de recibir eventos y la key da 401
- **Test:** e2e
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-050/`
- **Dependencias:** BN-TASK-013
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-050/`

### BN-TASK-051 — Actualizar documentación
- **Requisitos:** BN-REQ-DOC-001, BN-REQ-DOC-002, BN-REQ-DOC-003, BN-REQ-DOC-004
- **Prioridad:** P2
- **Tipo:** DOC
- **Archivos:** docs/*.md, env.validation.ts
- **Criterios de aceptación (Given/When/Then):**
  - Given docs, Then sin rutas inexistentes ni variables huérfanas (script de verificación)
- **Test:** script docs-lint
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-051/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-051/`

### BN-TASK-052 — Runbook de operación de pagos
- **Requisitos:** BN-REQ-DOC-005
- **Prioridad:** P1
- **Tipo:** DOC
- **Archivos:** docs/RUNBOOK-PAYMENTS.md
- **Criterios de aceptación (Given/When/Then):**
  - Given incidente de pago, Then hay procedimiento paso a paso (conciliar, reprocesar outbox, rotar llaves)
- **Test:** revisión
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-052/`
- **Dependencias:** BN-TASK-016
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-052/`

### BN-TASK-053 — lastFourDigits reales y validación de clientId
- **Requisitos:** BN-REQ-PAY-010, BN-REQ-PAY-012
- **Prioridad:** P2
- **Tipo:** CODE
- **Archivos:** payment-orders.service.ts:581, cards
- **Criterios de aceptación (Given/When/Then):**
  - Given guardar tarjeta, Then lastFourDigits viene de NetPay
  - Given clientId de otro customer, Then 404
- **Test:** unit
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-053/`
- **Dependencias:** —
- **Estado:** HECHO — evidencia en `evidence/BN-TASK-053/`

### BN-TASK-054 — Investigar pre-autorización y captura en NetPay
- **Requisitos:** BN-REQ-PAY-013
- **Prioridad:** P2
- **Tipo:** RESEARCH
- **Archivos:** —
- **Criterios de aceptación (Given/When/Then):**
  - Given respuesta de NetPay, Then decisión documentada (implementar o descartar)
- **Test:** —
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-054/`
- **Dependencias:** —
- **Estado:** PENDIENTE — RESEARCH: requiere respuesta de NetPay sobre pre-autorización/captura; sin ella no hay decisión que documentar.

### BN-TASK-055 — Certificación NetPay 22/22 + evidencias manuales
- **Requisitos:** BN-REQ-EVT-003, BN-REQ-PAY-002, BN-REQ-CFG-005
- **Prioridad:** P0
- **Tipo:** TEST
- **Archivos:** script de certificación (en plane) + evidencias
- **Criterios de aceptación (Given/When/Then):**
  - Given ambiente staging con llaves propias, Then 22/22 escenarios con veredicto y evidencia OXXO/alojado/refund/webhook
- **Test:** netpay-certification.mjs + checklist
- **Evidencia requerida:** salida roja y verde del test en `evidence/BN-TASK-055/`
- **Dependencias:** BN-TASK-015, BN-TASK-027
- **Estado:** PENDIENTE — TEST en staging con llaves propias (depende de BN-TASK-027) y despliegue; no ejecutable desde este repositorio.
