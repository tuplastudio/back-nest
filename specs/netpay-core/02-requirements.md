# 02 — Requisitos (EARS)

Formato: `BN-REQ-<ÁREA>-nnn`.

| Área | Qué cubre |
|---|---|
| EVT | Eventos salientes |
| IDM | Idempotencia |
| REC | Conciliación |
| PAY | Flujos de pago |
| CFG | Credenciales y config |
| SEC | Seguridad y authz |
| OPS | Operación, CI/CD y observabilidad |
| API | Contrato con consumidores |
| DOC | Documentación |

Prioridades:
- **P0:** bloquea ir a producción con dinero real.
- **P1:** necesario para operar.
- **P2:** mejora.

La columna "Verificación" dice cómo se demuestra el requisito (tipo de test).

---

## A. Eventos salientes (EVT)

| ID | Requisito | THR | P | Verificación |
|---|---|---|---|---|
| BN-REQ-EVT-001 | Cuando el hostname de un endpoint resuelva a varias direcciones, el sistema deberá validar **cada** dirección contra la política SSRF y aceptar la URL si todas son públicas. Deberá fijar (pin) la conexión a una dirección validada (preferir IPv4) y probar la siguiente validada si falla la conexión. | THR-003 | P0 | Unit con resolver falso (8 A + 8 AAAA públicas → OK; una privada → rechazo) e integración contra un host con varias IP |
| BN-REQ-EVT-002 | Si en el momento de entregar la resolución DNS falla o devuelve una dirección no permitida, el sistema deberá tratarlo como un **fallo reintentable**. No deberá auto-deshabilitar el endpoint, salvo que el fallo persista 24 h. | THR-003 | P0 | Unit del dispatcher |
| BN-REQ-EVT-003 | Mientras un tenant tenga al menos un endpoint ACTIVE, el sistema deberá entregar eventos. Si `OUTBOUND_WEBHOOK_ENABLED=false` en un ambiente con endpoints activos, `/health/ready` deberá reportar `degraded` con la causa. El valor por defecto en prod y staging deberá ser `true`. | THR-004 | P0 | e2e + test de config |
| BN-REQ-EVT-004 | Cuando una orden cambie de estado, el sistema deberá escribir el evento (payload completo y `sequence` incrementado) en una tabla outbox **dentro de la misma transacción** que el cambio de estado. | THR-008 | P0 | Integración: un fallo después del commit no pierde el evento; un rollback no deja evento |
| BN-REQ-EVT-005 | El sistema deberá entregar el **snapshot** del evento persistido, no reconstruirlo del estado actual. Campos mínimos: `eventId`, `eventType`, `occurredAt` (momento del cambio), `sequence`, `tenantId`, `data.{orderId, orderReference, merchantReferenceCode, amount, currency, status, previousStatus, refundedAmount, fullyRefunded, netpayTransactionId, paymentMethod, failureCode, failureReason}`. | THR-008 | P0 | Unit de serialización + contrato JSON Schema publicado |
| BN-REQ-EVT-006 | Cuando ocurra un reembolso parcial, el sistema deberá emitir `payment.refunded` con un `sequence` mayor que el del evento anterior de la misma orden. | THR-008 | P1 | Unit |
| BN-REQ-EVT-007 | El sistema deberá reintentar las entregas al menos 24 h con backoff exponencial con tope (1 s → 1 h) y jitter, antes de marcarlas DEAD. | — | P1 | Unit del calendario de reintentos |
| BN-REQ-EVT-008 | En cada ciclo de polling, el dispatcher deberá drenar de forma justa a **todos** los tenants activos (round-robin con lote por tenant) y entregar en paralelo con concurrencia acotada. Un endpoint lento no deberá bloquear a otros. | THR-025 | P1 | Unit con 300 tenants y un endpoint lento |
| BN-REQ-EVT-009 | El sistema deberá entregar a la URL suscrita exacta: esquema, host, puerto, path **y query**. | — | P1 | Unit de `http.transport` |
| BN-REQ-EVT-010 | Cuando se haga replay de una entrega, el sistema deberá conservar el número de intento original y registrar quién la reenvió (auditoría). | THR-021 | P2 | Unit |
| BN-REQ-EVT-011 | El sistema deberá publicar el catálogo de eventos y el JSON Schema de cada uno en `docs/events/` y en OpenAPI (`x-webhooks`). | — | P1 | Test que valida payloads reales contra el schema |

## B. Idempotencia (IDM)

| ID | Requisito | THR | P | Verificación |
|---|---|---|---|---|
| BN-REQ-IDM-001 | Cuando un `POST /t/payments/orders/:id/refund` traiga un `Idempotency-Key` ya visto para ese tenant y esa ruta en las últimas 24 h con el **mismo** cuerpo, el sistema deberá devolver la respuesta guardada sin llamar a NetPay. Si el cuerpo es distinto, deberá responder 422 `IDEMPOTENCY_KEY_REUSED`. | THR-005 | P0 | e2e de doble envío concurrente |
| BN-REQ-IDM-002 | Lo mismo que IDM-001 para `POST /t/payments/orders` (crear orden) y `POST …/charge`. | THR-006 | P0 | e2e |
| BN-REQ-IDM-003 | Mientras una operación con un `Idempotency-Key` esté en curso, una segunda petición con la misma llave deberá recibir 409 `IDEMPOTENCY_IN_PROGRESS` con `Retry-After`. | THR-005 | P0 | e2e |
| BN-REQ-IDM-004 | Si NetPay confirma un reembolso y después falla la escritura local, el sistema deberá registrar el resultado en una tabla de "pendientes de aplicar" y aplicarlo en el siguiente ciclo de conciliación. No deberá liberar el claim mientras el estado sea incierto. | THR-005 | P0 | Integración con fallo de BD inyectado |
| BN-REQ-IDM-005 | Cuando el webhook entrante repita `(eventType, transactionId)`, el sistema deberá omitir la re-verificación con NetPay dentro de una ventana de 10 min. | THR-015 | P1 | Unit con la clave de dedupe determinista (sin UUID aleatorio) |

## C. Conciliación (REC)

| ID | Requisito | THR | P | Verificación |
|---|---|---|---|---|
| BN-REQ-REC-001 | El sistema deberá re-verificar con NetPay, cada 5 min, las órdenes no terminales (`PENDING`, `PENDING_VERIFICATION`, `WAIT_THREEDS`, `CHARGE_UNKNOWN`, refund pendiente) con más de N min de antigüedad. Deberá aplicar el estado resultante y emitir su evento. | THR-007 | P0 | Integración con NetPay simulado |
| BN-REQ-REC-002 | Mientras una orden siga en `WAIT_THREEDS` o `PENDING_VERIFICATION` más de 30 min sin confirmación, el sistema deberá consultar a NetPay y, si no hay cargo, marcarla `EXPIRED` y emitir `payment.expired`. | THR-010 | P0 | Integración |
| BN-REQ-REC-003 | Cuando venza `paymentReferenceExpiresAt` de una orden OXXO no pagada, el sistema deberá marcarla `EXPIRED` y emitir el evento. | THR-007 | P1 | Integración |
| BN-REQ-REC-004 | El job de conciliación deberá ser seguro con varias instancias: lock advisory por orden o `SKIP LOCKED`. Deberá estar acotado por tasa contra NetPay y exponer métricas (órdenes revisadas, corregidas, en error). | THR-007 | P0 | Integración con 2 workers |
| BN-REQ-REC-005 | El sistema deberá exponer `GET /t/payments/orders` con paginación por cursor y filtros `updatedSince`, `status`, `merchantReferenceCode` para que el consumidor pueda conciliar. | — | P1 | e2e |
| BN-REQ-REC-006 | El sistema deberá exponer `verifiedAmount`, `netpayTransactionId`, `refundedAmount` y `failureCode` en `GET /t/payments/orders/:id`. | — | P1 | Test de contrato |

## D. Flujos de pago (PAY)

| ID | Requisito | THR | P | Verificación |
|---|---|---|---|---|
| BN-REQ-PAY-001 | Cuando una orden esté `FAILED` (rechazo definitivo), el sistema deberá permitir un nuevo cargo con otra tarjeta, ligar la nueva transacción y conservar el historial de intentos (`PaymentAttempt`). | THR-009 | P0 | e2e: rechazo y luego éxito |
| BN-REQ-PAY-002 | Cuando un reto 3DS falle o se abandone y el consumidor llame `POST …/charge` de nuevo, el sistema deberá verificar la transacción previa con NetPay. Si no se cobró, deberá liberar el claim y aceptar el nuevo intento; si se cobró, deberá responder 409 con la orden PAID. | THR-010 | P0 | e2e |
| BN-REQ-PAY-003 | Si la llamada de cargo a NetPay falla sin respuesta definitiva (timeout o transporte), el sistema deberá dejar la orden en `CHARGE_UNKNOWN` y rechazar nuevos cargos hasta verificarla con NetPay, consultando también por `orderReference`. | THR-006 | P0 | Integración con timeout inyectado |
| BN-REQ-PAY-004 | Cuando se reciba `POST /t/payments/orders/:id/cancel` para una orden no pagada, el sistema deberá expirar la sesión alojada o la referencia en NetPay (si NetPay lo soporta; si no, marcar la orden y rechazar la conciliación posterior como pago tardío **auditado**), pasarla a `CANCELLED` y emitir `payment.cancelled`. | THR-024 | P1 | e2e |
| BN-REQ-PAY-005 | Cuando un reembolso parcial deje saldo, el sistema deberá usar el estado `PARTIALLY_REFUNDED`. Cuando llegue a cero, `REFUNDED`. | — | P1 | Unit de la máquina de estados |
| BN-REQ-PAY-006 | El sistema deberá normalizar los códigos de rechazo de NetPay a un enum estable (`INSUFFICIENT_FUNDS`, `CARD_EXPIRED`, `DO_NOT_HONOR`, `FRAUD_SUSPECTED`, `AUTHENTICATION_FAILED`, `INVALID_CARD`, `LIMIT_EXCEEDED`, `PROCESSOR_ERROR`, `UNKNOWN`) en respuestas y eventos, conservando el código original en un campo interno. | — | P1 | Unit con la tabla de códigos de NetPay |
| BN-REQ-PAY-007 | Cuando se cree una orden alojada, el sistema deberá aceptar solo URLs `https` cuyo origen esté en la allowlist del tenant. | THR-023 | P1 | Unit |
| BN-REQ-PAY-008 | El sistema deberá rechazar monedas distintas de MXN salvo que el tenant esté habilitado para ellas. | THR-026 | P2 | Unit |
| BN-REQ-PAY-009 | El sistema nunca deberá incluir valores de campo devueltos por el proveedor (`subErrors[].value`) en errores, logs ni `failureReason` persistido. | THR-014 | P0 | Unit con fixture que contiene PAN/CVV |
| BN-REQ-PAY-010 | El sistema deberá devolver `lastFourDigits` reales (de NetPay) al guardar tarjeta, no derivados del token. | — | P2 | Unit |
| BN-REQ-PAY-011 | Cuando NetPay no responda de forma definitiva, el sistema deberá responder **504** `PROVIDER_OUTCOME_UNKNOWN` (no 502), conservar el claim y dejar la operación para la conciliación. 502 se reserva para el rechazo explícito del proveedor. | THR-005 | P0 | Unit de `netpay.client` y del filtro de excepciones |
| BN-REQ-PAY-012 | El sistema deberá validar `clientId` de las tarjetas guardadas contra los `PaymentCustomer` del tenant. | — | P2 | Unit |
| BN-REQ-PAY-013 | NO VERIFICADO: si NetPay ofrece pre-autorización con captura o liberación, el sistema deberá exponerla (`capture`, `release`) con idempotencia. | — | P2 | Pendiente de confirmar con NetPay |

## E. Credenciales y config (CFG)

| ID | Requisito | THR | P | Verificación |
|---|---|---|---|---|
| BN-REQ-CFG-001 | Cuando se guarden credenciales, el sistema deberá validarlas contra el ambiente elegido con una llamada inocua a NetPay antes de persistirlas, y rechazar llaves de otro ambiente. | THR-016 | P1 | Integración con sandbox |
| BN-REQ-CFG-002 | El sistema deberá versionar la config de pagos (`PaymentConfig` versionada). Toda operación sobre una orden deberá usar las credenciales y el ambiente de `order.configId`. | THR-016 | P0 | e2e: SANDBOX → LIVE y luego refund de una orden vieja |
| BN-REQ-CFG-003 | Cuando cambie el ambiente o la llave secreta, el sistema deberá emitir un nuevo token de webhook, limpiar `webhookRegisteredAt` y exigir re-registro. | THR-016 | P1 | Unit |
| BN-REQ-CFG-004 | Al registrar o consultar el webhook de NetPay, el sistema deberá comparar la URL registrada con `PUBLIC_BASE_URL/api/v1/payments/webhook/{token}` de este despliegue, reportar `drift:true` si difieren y alertar. | THR-017 | P0 | Unit + check en `/health/ready` autenticado |
| BN-REQ-CFG-005 | Cada ambiente (staging, prod) deberá usar llaves NetPay propias y no compartidas con otros integradores. | THR-017 | P0 | INFRA: checklist con NetPay |
| BN-REQ-CFG-006 | El sistema deberá leer `PAYMENT_REDIRECT_URL` y `PAYMENT_CANCEL_URL` solo de la config validada y negarse a crear checkout si faltan. No se permite `process.env` directo. | — | P1 | Unit + regla de lint |

## F. Seguridad (SEC)

| ID | Requisito | THR | P | Verificación |
|---|---|---|---|---|
| BN-REQ-SEC-001 | Cuando una API key llame a cualquier `/t/webhooks*`, el sistema deberá exigir `webhooks:read` o `webhooks:write`. El `RbacAuditService` deberá impedir el arranque si una ruta declara `@RequirePermissions` sin `@RequireScopes`. | THR-001 | P0 | e2e: key `payments:read` recibe 403 + test de arranque |
| BN-REQ-SEC-002 | Cuando una API key cree un miembro, el sistema deberá rechazar roles por encima de MEMBER y no deberá aceptar contraseña enviada por el llamador (flujo de invitación). | THR-002 | P0 | e2e |
| BN-REQ-SEC-003 | `POST /t/users` deberá exigir `users:write` a nivel de método. | THR-027 | P0 | e2e: VIEWER recibe 403 |
| BN-REQ-SEC-004 | El throttler `auth` deberá aplicarse solo a sign-in y refresh. Las rutas de health deberán quedar exentas de todos los throttlers. El storage deberá ser compartido entre instancias (Redis/Memorystore) en prod. | THR-018 | P1 | e2e con headers `x-ratelimit-*` |
| BN-REQ-SEC-005 | Al registrar una URL de petición en logs, el sistema deberá redactar el segmento después de `/payments/webhook/`. | THR-015 | P1 | Unit del filtro |
| BN-REQ-SEC-006 | El sistema deberá exigir TOTP o WebAuthn a los admins de plataforma, y step-up auth para escrituras de pago entre tenants. | THR-019 | P1 | e2e |
| BN-REQ-SEC-007 | El ciphertext deberá llevar prefijo de versión de llave. El sistema deberá descifrar con cualquier llave del keyring y cifrar con la actual. Deberá existir un job de re-cifrado. Las llaves de datos deberían envolverse con Cloud KMS. | THR-020 | P1 | Unit + job de re-cifrado en staging |
| BN-REQ-SEC-008 | Mientras un admin tenga `mustChangePassword`, el sistema deberá restringirlo al endpoint de cambio de contraseña. | — | P1 | e2e |
| BN-REQ-SEC-009 | `/health/ready` deberá cachear 5 s y mostrar detalles solo a principales verificados (no basta con que exista el header `Authorization`). | THR-028 | P2 | Unit |
| BN-REQ-SEC-010 | En staging, CORS deberá incluir los orígenes reales de los front-ends (`https://vondi.tupla.dev`) y no los de localhost. Un preflight rechazado deberá responder 403 y no 404. | — | P1 | e2e de CORS |
| BN-REQ-SEC-011 | El sistema no deberá enviar el header `X-Powered-By` (hoy envía `X-Powered-By: masked`). | — | P2 | Test de headers |
| BN-REQ-SEC-012 | La suspensión de un tenant y la revocación de roles deberán propagarse en ≤5 s entre instancias. | THR-030 | P2 | Integración con 2 instancias |

## G. Operación (OPS)

| ID | Requisito | THR | P | Verificación |
|---|---|---|---|---|
| BN-REQ-OPS-001 | El deploy deberá depender (`needs`) de CI como job reutilizable. El environment de producción deberá exigir aprobación de revisor y solo `main`. `main` deberá exigir al menos 1 revisión. | THR-011 | P0 | Inspección con `gh api` + workflow de prueba |
| BN-REQ-OPS-002 | Cuando un release incluya `prisma/tenant-migrations/*` nuevas, el job de migración deberá aplicarlas a todo tenant ACTIVE con `pg_advisory_xact_lock(hash(schema))` antes de mover tráfico, registrar checksum por versión y fallar si hay desajuste. CI deberá validar las migraciones de tenant. | THR-012 | P0 | Integración con 3 esquemas + migración concurrente |
| BN-REQ-OPS-003 | Toda política de alerta deberá tener canal de notificación (on-call). Deberán existir un uptime check de `/health/ready` y SLO de disponibilidad (99.9 %) y latencia (p95 < 1.5 s en `charge`), con alertas de burn-rate. | THR-013 | P0 | Inspección con `gcloud` |
| BN-REQ-OPS-004 | El sistema deberá emitir logs JSON (`severity`, `requestId`, `tenantId`, `route`, `status`, `latencyMs`, `trace`) al `LOG_LEVEL` configurado, con un log de acceso por petición. | THR-013 | P1 | Unit del logger |
| BN-REQ-OPS-005 | El sistema deberá emitir métricas de pago: órdenes por estado, tasa de aprobación, latencia de NetPay, entregas por resultado, profundidad del outbox y órdenes conciliadas o corregidas. | THR-013 | P1 | Inspección |
| BN-REQ-OPS-006 | Al promover, el pipeline deberá hacer smoke a la URL de la **revisión etiquetada**, mover tráfico 10 → 50 → 100 vigilando la tasa de errores y revertir automáticamente. Las migraciones deberán seguir expand/contract. | THR-022 | P1 | Ensayo en staging |
| BN-REQ-OPS-007 | Los flags de despliegue (`--min-instances`, `--cpu-throttling`, ingress, egress) deberán declararse en el workflow, verificarse contra drift y coincidir con `docs/DEPLOY-GCP.md`. | — | P1 | Job de verificación de drift |
| BN-REQ-OPS-008 | Trivy deberá bloquear CI ante hallazgos HIGH/CRITICAL. Artifact Registry deberá conservar solo los últimos N digests. | THR-029 | P2 | CI |
| BN-REQ-OPS-009 | CI deberá fallar si la cobertura de líneas de `src/payments/**` baja de 80 % (`outbound-webhook.service/controller` hoy está en 0 %). | — | P1 | CI |
| BN-REQ-OPS-010 | `/health/ready` autenticado deberá exponer versión de build y SHA del commit. | — | P2 | e2e |
| BN-REQ-OPS-011 | El sistema deberá auditar en AuditLog cada cambio de estado de pago, cambio de config de pago o webhook y replay (actor, tenant, orderId, de → a, resultado). | THR-021 | P1 | e2e |
| BN-REQ-OPS-012 | Prod deberá tener HTTPS LB + Cloud Armor (rate limit por IP y reglas OWASP) e ingress `internal-and-cloud-load-balancing`. | THR-018 | P2 | INFRA |

## H. Contrato con consumidores (API)

| ID | Requisito | P | Verificación |
|---|---|---|---|
| BN-REQ-API-001 | El sistema deberá publicar `docs/openapi.json` sincronizado con el código (generado en CI y verificado contra diff), incluyendo esquemas de error y `x-webhooks`. | P1 | CI |
| BN-REQ-API-002 | Los errores deberán tener forma estable `{ error: { code, message, retryable, details? }, requestId }` y códigos documentados (`PROVIDER_OUTCOME_UNKNOWN`, `PROVIDER_DECLINED`, `IDEMPOTENCY_*`, `ORDER_STATE_CONFLICT`, `AMOUNT_MISMATCH`…). | P1 | Test de contrato |
| BN-REQ-API-003 | El sistema deberá exponer `DELETE`/`revoke` de API keys usable por el consumidor al desconectar, y `POST /t/webhooks/:id/disable`. | P1 | e2e |
| BN-REQ-API-004 | Las llaves NetPay deberán validarse con un patrón documentado y compartido con los consumidores (`^(pk|sk)_netpay_[A-Za-z0-9]+$`). | P2 | Test de contrato |

## I. Documentación (DOC)

| ID | Requisito | P |
|---|---|---|
| BN-REQ-DOC-001 | `NETPAY-INTEGRATION.md` §13 y §15 deberán reflejar lo implementado, no "decisiones abiertas" ni un plan por fases. | P2 |
| BN-REQ-DOC-002 | Las variables documentadas (`NETPAY_ALLOWED_HOSTS`, `NETPAY_TIMEOUT_MS`, `NETPAY_MAX_ATTEMPTS`, `PAYMENTS_ENABLED`, `OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES`, `OUTBOUND_WEBHOOK_SIGNATURE_TOLERANCE_MS`) deberán existir en `env.validation.ts` o retirarse del doc. `NETPAY_PLATFORM_ENCRYPTION_KEY` vs `NETPAY_ENCRYPTION_KEY` deberá unificarse. | P2 |
| BN-REQ-DOC-003 | `DEPLOY-GCP.md` no deberá referir rutas inexistentes (`/api/v1/payments/return`). | P2 |
| BN-REQ-DOC-004 | `SECURITY.md` §6 deberá coincidir con los headers reales. | P2 |
| BN-REQ-DOC-005 | Deberá existir un runbook: conciliación manual, reproceso de outbox, rotación de llaves, alta de tenant y respuesta a incidentes de pago. | P1 |

## Resumen

| Área | P0 | P1 | P2 |
|---|---|---|---|
| EVT | 5 | 5 | 1 |
| IDM | 4 | 1 | 0 |
| REC | 3 | 3 | 0 |
| PAY | 5 | 4 | 4 |
| CFG | 3 | 3 | 0 |
| SEC | 3 | 6 | 3 |
| OPS | 3 | 6 | 3 |
| API | 0 | 3 | 1 |
| DOC | 0 | 1 | 4 |
| **Total (74)** | **26** | **32** | **16** |
