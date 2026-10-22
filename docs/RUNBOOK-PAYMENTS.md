# Runbook — Operación de pagos

Procedimientos paso a paso para operar el módulo de pagos NetPay (BN-REQ-DOC-005). Complementa los runbooks de
infraestructura de [`DEPLOY-GCP.md` §18](DEPLOY-GCP.md#18-runbooks) y el diseño de
[`NETPAY-INTEGRATION.md`](NETPAY-INTEGRATION.md).

Regla de lectura: **solo se citan endpoints que existen en los controladores**. Lo que la especificación exige y
todavía no está implementado aparece marcado como **pendiente**, con su tarea en
`specs/netpay-core/04-tasks.md`. No improvisar un sustituto de algo pendiente en producción.

---

## 0. Convenciones

```bash
export PROJECT_ID="vondi-0q"
export REGION="us-east5"
export SERVICE="netpay-api"
export MIGRATE_JOB="netpay-migrate"
export BASE="https://netpay.tupla.dev/api/v1"
export TENANT_ID="<uuid del tenant>"
export TOKEN="<JWT de administrador o API key del tenant>"
```

| Tipo de ruta                              | Autenticación                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/tenants`, `/api-keys`                   | JWT de administrador de plataforma (`POST /auth/sign-in`); `/api-keys` además `X-Tenant-Id`       |
| `/t/payments/...`, `/t/webhooks/...`      | `Authorization: Bearer <JWT o API key>` + `X-Tenant-Id`. Cada ruta exige permiso **y** scope      |
| `/payments/webhook/:token`                | Pública. Solo la llama NetPay; el token opaco identifica al tenant                                |
| `/health`, `/health/live`, `/health/ready` | Sin prefijo `/api/v1`                                                                             |
| `POST /internal/tick`                     | Sin prefijo. Solo token OIDC de Google de `INTERNAL_TICK_SA_EMAIL` con audiencia = URL del servicio (§1.2) |

Permisos relevantes: `payments:read|write|refund|configure` y `webhooks:read|write|rotate-secret|replay`.
`payments:configure` no es otorgable a una API key: la configuración de NetPay la hace un operador con JWT.

Toda respuesta lleva `X-Request-Id`. Cítalo en cualquier escalamiento; es la llave para encontrar la petición en
Cloud Logging (`jsonPayload.requestId`).

---

## 1. Conciliación manual

**Cuándo:** una orden se queda en `PENDING` o `PENDING_VERIFICATION`, el comprador dice que pagó, NetPay muestra
la transacción y nosotros no; o tras un incidente en el que se perdieron webhooks. NetPay **no reintenta** el
webhook, así que una notificación perdida no se recupera sola.

La **conciliación automática** (BN-TASK-016, `src/payments/reconciliation/`) cubre lo que tiene transacción ligada:
re-verifica con NetPay cada orden no terminal sin cambios en `RECONCILE_MIN_AGE_MS` (5 min) — `PENDING` con
transacción, `PENDING_VERIFICATION`, `CHARGE_UNKNOWN`, reembolsos con resultado desconocido —, pasa a `EXPIRED`
(`payment.expired`) un 3-D Secure abandonado más de 30 min o una referencia OXXO vencida sin pagar, aplica los
resultados pendientes (§1.1) y detecta pagos tardíos de órdenes `CANCELLED`/`EXPIRED`. Corre mientras haya una
instancia viva y, en staging, cada 15 min por Cloud Scheduler (§1.2). Este procedimiento manual queda para lo que
la conciliación no puede ver: una orden **sin** transacción ligada cuyo webhook se perdió (NetPay no permite
buscar por referencia).

1. **Localizar las órdenes candidatas.** `GET /t/payments/orders?status=PENDING,PENDING_VERIFICATION&limit=100`
   pagina con cursor (`nextCursor` → `cursor`); `updatedSince=<ISO>` las da de la más antigua a la más reciente.
   Para un barrido completo, consulta de solo lectura sobre el esquema del tenant
   (conexión directa, rol de solo lectura):

   ```sql
   SELECT "id", "orderReference", "status", "netpayTransactionId", "paymentReference", "createdAt"
     FROM "tenant_<slug>"."payment_orders"
    WHERE "status" IN ('PENDING', 'PENDING_VERIFICATION', 'CHARGE_UNKNOWN')
      AND "createdAt" < now() - interval '30 minutes'
    ORDER BY "createdAt";
   ```

2. **Leer la orden:**

   ```bash
   curl -sS "$BASE/t/payments/orders/<orderId>" \
     -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID"
   ```

3. **Verificar contra NetPay y asentar.** Si la orden ya tiene `netpayTransactionId`, el cuerpo puede ir vacío.
   Si no (webhook perdido), buscar la transacción en NetPay Manager por `orderReference` y pasarla:

   ```bash
   curl -sS -X POST "$BASE/t/payments/orders/<orderId>/verify" \
     -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID" \
     -H "Content-Type: application/json" \
     -d '{"transactionId":"<transactionId de NetPay Manager>"}'
   ```

   La verificación es idempotente: una transacción ya reflejada no se aplica dos veces. El estado final sale
   **solo** de la respuesta de la API de NetPay (`PAID`, `FAILED`, `AMOUNT_MISMATCH`…), nunca del webhook.

4. **Revisar el resultado.**

   | Resultado         | Acción                                                                                                  |
   | ----------------- | ------------------------------------------------------------------------------------------------------- |
   | `PAID`            | Se emite `payment.paid` a los suscriptores. Confirmar la entrega (§2, paso 1)                          |
   | `AMOUNT_MISMATCH` | **No entregar.** Escalar a negocio: el importe cobrado no coincide con la orden. Valorar reembolso      |
   | `FAILED`          | Informar al comprador; la orden no se reabre                                                            |
   | Sigue pendiente   | NetPay aún no tiene un estado final (p. ej. OXXO sin pagar). Reintentar más tarde, no forzar el estado  |
   | `504`             | Ver §5.2                                                                                                |

5. **Nunca** cambiar `status` con SQL. Un `UPDATE` a mano se salta la verificación, el evento saliente y la
   auditoría.

### 1.1 Órdenes `CHARGE_UNKNOWN` y resultados pendientes de aplicar

**`CHARGE_UNKNOWN`** (BN-REQ-PAY-003): la petición de cargo salió hacia NetPay y no hubo respuesta definitiva
(timeout, red, `5xx`). La orden rechaza cobros nuevos con `409 ORDER_STATE_CONFLICT` hasta verificarla. NetPay
**no permite buscar por referencia desde la API**, así que:

1. Buscar en NetPay Manager la transacción por `orderReference` (es el `merchantReferenceCode` del cargo).
2. Si existe, `POST /t/payments/orders/<orderId>/verify` con su `transactionId` (paso 3 de §1): la orden queda
   `PAID`, `FAILED` (acepta otro cobro) o `PENDING_VERIFICATION`.
3. Si NetPay Manager no muestra ninguna transacción, no hubo cargo. **Política automática:** la conciliación
   devuelve a `PENDING` una orden `CHARGE_UNKNOWN` sin transacción conocida pasado
   `RECONCILE_CHARGE_UNKNOWN_GRACE_MS` (1 h por defecto): libera el _claim_, quita la transacción ligada, marca el
   intento como `UNRESOLVED` y no emite evento (`PENDING` no es visible para suscriptores). El comprador puede
   volver a pagar la misma orden, o el comercio cancelarla (`POST …/orders/<orderId>/cancel`).
   **Riesgo asumido:** como NetPay no se puede consultar por referencia, esto es una política, no una prueba. Si
   el cargo sí ocurrió, su notificación sigue llegando, liga la transacción y asienta la orden (`PAID`); si para
   entonces se cobró de nuevo con otra tarjeta, el segundo cobro queda ligado y el primero hay que reembolsarlo
   desde NetPay Manager. Buscar `reconcile_corrected` con `action="charge_unknown_reset"` para revisar cuáles se
   liberaron.

**Resultados pendientes** (BN-REQ-IDM-004): una respuesta `500 PROVIDER_RESULT_PENDING` significa que NetPay
reembolsó o cobró y la escritura local falló. La fila queda en `pending_provider_result` con `appliedAt` nulo y la
orden no admite otra operación hasta que se aplique:

```sql
SELECT "id", "orderId", "operation", "createdAt"
  FROM "tenant_<slug>"."pending_provider_result"
 WHERE "appliedAt" IS NULL
 ORDER BY "createdAt";
```

Cada pasada de conciliación los aplica primero, una sola vez (`FOR UPDATE SKIP LOCKED` y `appliedAt`). Si urge,
dispararla con `POST /internal/tick` (§1.2). **No** repetir el reembolso o el cobro.

**Reembolso con resultado desconocido** (`504` en `…/refund`, el _claim_ `refund` sigue puesto): la conciliación
consulta la transacción; si NetPay la reporta `CANCELED`, la orden pasa a `REFUNDED` con `payment.refunded`. Si
sigue `DONE` no se puede saber si un reembolso parcial por el servicio de reportes ocurrió: queda un aviso
`reconcile_manual_review` y hay que revisarlo en NetPay Manager antes de reintentar.

### 1.2 Cuándo corre la conciliación (y por qué en producción no hay scheduler)

| Disparador | Staging | Producción |
| --- | --- | --- |
| Temporizador en proceso (`RECONCILE_ENABLED=true`, cada `RECONCILE_INTERVAL_MS` = 5 min, con jitter) | Sí, mientras haya una instancia viva | Sí, mientras haya una instancia viva |
| Cloud Scheduler → `POST /internal/tick` cada 15 min (una pasada de conciliación + un ciclo de despacho de webhooks) | Sí: `scripts/gcp/scheduler-internal-tick.sh --apply` (requiere aprobación; no se ejecuta desde CI) | **No**, por decisión del dueño |

Ambos entornos escalan a cero con CPU throttling (`.github/cloudrun/flags.json`). **Consecuencia en producción:**
sin tráfico no hay instancia, y sin instancia no corren ni la conciliación ni el despacho de eventos salientes. Una
orden pagada cuyo webhook se perdió, un 3-D Secure abandonado o una referencia OXXO vencida no se corrigen ni se
anuncian hasta la siguiente petición que despierte una instancia (y luego hasta 5 min más). Mitigaciones, por
orden de costo: (a) cualquier tráfico real ya las dispara; (b) un operador puede forzar una pasada con un token de
la cuenta de servicio:

```bash
URL="$(gcloud run services describe netpay-api --region=us-east5 --format='value(status.url)')"
TOKEN_TICK="$(gcloud auth print-identity-token \
  --impersonate-service-account="$INTERNAL_TICK_SA_EMAIL" --audiences="$URL")"
curl -sS -X POST "$URL/internal/tick" -H "Authorization: Bearer $TOKEN_TICK"
```

(requiere `INTERNAL_TICK_SA_EMAIL`/`INTERNAL_TICK_AUDIENCE` configurados en el servicio y permiso
`iam.serviceAccounts.getOpenIdToken` sobre la cuenta); (c) aplicar el mismo script de scheduler a producción, lo
que es un cambio de decisión del dueño. Un `401` en `/internal/tick` es un token ausente, de otra audiencia o
caducado; un `403`, un token de Google válido de otra identidad.

Señales: `reconcile_checked` (órdenes revisadas por pasada y tenant), `reconcile_corrected` (`from`, `to`,
`action`) y `reconcile_errors`. Un `reconcile_errors` sostenido suele ser NetPay caído (§5.1).

### 1.3 Cancelar una orden no pagada

`POST $BASE/t/payments/orders/<orderId>/cancel` (`payments:write`). Procede desde `PENDING`,
`PENDING_VERIFICATION` y `FAILED`; con un cobro ligado consulta antes a NetPay y responde `409
ORDER_STATE_CONFLICT` si se cobró (la orden queda `PAID`) o si aún no decide. Emite `payment.cancelled`.
NetPay no permite expirar una sesión alojada ni una referencia OXXO: si el comprador paga después, la orden
**sigue `CANCELLED`**, gana `paidAfterCancelAt`, se emite `payment.paid_after_cancel` y queda una entrada de
auditoría `payment.paid_after_cancel` (`LATE_PAYMENT_ON_CANCELLED`). El consumidor debe reembolsar; desde aquí,
reembolsar una orden `CANCELLED` no está soportado: hacerlo desde NetPay Manager con el `netpayTransactionId`.

---

## 2. Reproceso de outbox / reenvío de webhooks salientes

**Cuándo:** un suscriptor no recibió eventos (entregas en `FAILED`/`DEAD`), o su endpoint quedó
`AUTO_DISABLED` tras `OUTBOUND_WEBHOOK_AUTO_DISABLE_AFTER` fallos seguidos.

Los eventos salen del outbox transaccional (`payment_event_outbox`, snapshot con `sequence` por orden,
BN-TASK-004) y el reenvío conserva el número de intento y deja auditoría de quién lo pidió (BN-TASK-008).

1. **Confirmar que el dispatcher está encendido.** Requiere `OUTBOUND_WEBHOOK_ENABLED=true` en el servicio
   (es `true` por defecto desde `scripts/provision-cloudrun.sh`):

   ```bash
   gcloud run services describe "$SERVICE" --region="$REGION" \
     --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep OUTBOUND_WEBHOOK_ENABLED
   ```

2. **Ver el estado del endpoint y sus entregas:**

   ```bash
   curl -sS "$BASE/t/webhooks" -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID"
   curl -sS "$BASE/t/webhooks/<endpointId>/deliveries" \
     -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID"
   ```

   `error` y `responseStatus` dicen por qué falló, sin el cuerpo del receptor. Si el motivo es de destino
   (`PRIVATE_ADDRESS`, `NOT_ALLOWED_BY_POLICY`, `AMBIGUOUS_ADDRESS`), reenviar no sirve: el suscriptor tiene que
   corregir su URL.

3. **Corregir la causa con el suscriptor** (URL caída, certificado, firma mal verificada) antes de reenviar.

4. **Reactivar el endpoint** si quedó `AUTO_DISABLED` o `DISABLED`:

   ```bash
   curl -sS -X POST "$BASE/t/webhooks/<endpointId>/status" \
     -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID" \
     -H "Content-Type: application/json" -d '{"enabled":true}'
   ```

5. **Reenviar cada entrega** (requiere `webhooks:replay`, por defecto solo `platform-owner`):

   ```bash
   curl -sS -X POST "$BASE/t/webhooks/deliveries/<deliveryId>/replay" \
     -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID"     # 204
   ```

   El `eventId` es el mismo: el receptor deduplica por `X-MTBPay-Event-Id`. Avisar al suscriptor de que va a
   recibir eventos antiguos, posiblemente desordenados.

6. **Verificar** con `GET /t/webhooks/<endpointId>/deliveries` que pasan a `DELIVERED` en la siguiente ronda
   (`OUTBOUND_WEBHOOK_POLL_INTERVAL_MS`, 5 s por defecto).

Si el evento nunca se generó (la orden está en estado final pero no hay entrega), no hay forma de regenerarlo
desde la API: el suscriptor debe conciliar leyendo `GET /t/payments/orders/:id`.

---

## 3. Rotación de llaves

### 3.1 Llaves NetPay de un tenant (`pk_`/`sk_`) y re-registro del webhook

**Cuándo:** filtración o sospecha de la `sk_`, cambio de SANDBOX a LIVE, o NetPay emitió llaves nuevas.

1. Generar las llaves nuevas en NetPay Manager. **No** revocar todavía las antiguas.
2. Guardar las nuevas (JWT de operador, `payments:configure`):

   ```bash
   curl -sS -X POST "$BASE/t/payments/config" \
     -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID" \
     -H "Content-Type: application/json" \
     -d '{"publicKey":"pk_netpay_...","secretKey":"sk_netpay_...","environment":"LIVE"}'
   ```

   Las llaves se prueban contra NetPay antes de guardarse. `422 CREDENTIALS_ENVIRONMENT_MISMATCH` = son del otro
   ambiente; `422 CREDENTIALS_INVALID` = NetPay las rechaza. En ambos casos no se guarda nada.

3. **Rotar el token del webhook entrante.** El token anterior queda revocado al instante, así que hacer el paso 4
   inmediatamente después:

   ```bash
   curl -sS -X POST "$BASE/t/payments/config/webhook-token" \
     -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID"
   # → { "token": "...", "urlPath": "/api/v1/payments/webhook/<token>" }   se muestra UNA vez
   ```

4. **Registrar la URL en NetPay** con las llaves nuevas:

   ```bash
   curl -sS -X POST "$BASE/t/payments/config/webhook-register" \
     -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://netpay.tupla.dev/api/v1/payments/webhook/<token>"}'
   ```

5. **Comprobar** lo que NetPay tiene registrado y que `webhookRegisteredAt` cambió:

   ```bash
   curl -sS "$BASE/t/payments/config/webhook" -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID"
   curl -sS "$BASE/t/payments/config"         -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID"
   ```

6. Revocar las llaves antiguas en NetPay Manager.
7. Conciliar (§1) las órdenes creadas durante la ventana entre los pasos 3 y 4: sus webhooks pudieron perderse.

La configuración es **versionada** (BN-TASK-024): cada cambio escribe una versión nueva y la anterior queda
inactiva, pero las órdenes creadas con ella siguen verificándose, reembolsándose y conciliándose con **sus**
llaves y su ambiente. Pasar de SANDBOX a LIVE ya no deja huérfanas las órdenes de sandbox. Cambiar el ambiente o la
`sk_` emite un token de webhook nuevo (devuelto una vez), retira los anteriores y pone `webhookRegisteredAt` en
`null`: registrar la URL nueva (pasos 4–5). Las llaves propias por ambiente frente a NetPay siguen siendo
BN-TASK-027 (INFRA).

### 3.2 Secreto de firma de un suscriptor saliente

1. `POST /t/webhooks/<endpointId>/rotate-secret` → devuelve el secreto nuevo **una vez**. Durante la ventana
   `X-MTBPay-Signature` lleva dos valores `v1` (uno por secreto), así que el receptor valida con cualquiera.
2. El suscriptor despliega el secreto nuevo.
3. `POST /t/webhooks/<endpointId>/end-rotation` (204) retira el antiguo.

### 3.3 `NETPAY_ENCRYPTION_KEY` (clave de plataforma)

Keyring versionado (BN-TASK-035): `NETPAY_KEYS_JSON` con `{current, keys}`; se lee con cualquier llave del anillo
y se escribe con la actual, y el job de re-cifrado deja todo en la versión nueva. **No** sustituir
`NETPAY_ENCRYPTION_KEY` sin pasar antes por el anillo: dejaría ilegibles las `sk_` cifradas (RB-04 de
`DEPLOY-GCP.md`). Si la clave se filtró, además rotar las llaves NetPay de los tenants (§3.1).

---

## 4. Alta de tenant

Ver también `NETPAY-INTEGRATION.md` §19.

1. **Crear el tenant** (JWT de plataforma, rol `OWNER` o `ADMIN`). Provisiona el esquema y aplica las
   migraciones de tenant:

   ```bash
   curl -sS -X POST "$BASE/tenants" -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d '{"slug":"pl-acme","name":"Acme"}'
   ```

   Si falla a medias, el tenant queda en `PROVISIONING` y la misma llamada se puede reintentar. Comprobar con
   `GET /tenants/<id>` que el estado es `ACTIVE`.

2. **Emitir la API key de runtime** de la plataforma consumidora:

   ```bash
   curl -sS -X POST "$BASE/api-keys" -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID" \
     -H "Content-Type: application/json" \
     -d '{"name":"runtime","scopes":["payments:read","payments:write","payments:refund"]}'
   ```

   El secreto se muestra una vez. Entregarlo por un canal seguro, nunca por chat ni ticket.

3. **Configurar NetPay** (`POST /t/payments/config`, §3.1 paso 2). La primera configuración devuelve
   `webhookToken` y `webhookUrlPath` **una sola vez**.
4. **Registrar el webhook** (`POST /t/payments/config/webhook-register`, §3.1 paso 4) y comprobarlo con
   `GET /t/payments/config/webhook`.
5. **Suscribir a la plataforma** a los eventos salientes:

   ```bash
   curl -sS -X POST "$BASE/t/webhooks" -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://plataforma.example/hooks/netpay","events":["payment.paid","payment.failed","payment.mismatch","payment.refunded"]}'
   ```

   Lista de eventos válidos: `GET /t/webhooks/events`.

6. **Prueba de humo en SANDBOX:** crear una orden (`POST /t/payments/orders`), pagarla con la tarjeta de
   `accept@netpay.com.mx` (ver `NETPAY-INTEGRATION.md` §18) y confirmar `PAID` y la entrega `DELIVERED`.

---

## 5. Respuesta a incidentes de pago

Primer paso en todos los casos: abrir el ticket con hora de inicio, tenants afectados y los `X-Request-Id`
disponibles.

### 5.1 NetPay caído o degradado

**Síntomas:** muchos `502 PROVIDER_DECLINED` o `504 PROVIDER_OUTCOME_UNKNOWN` en `/t/payments/...`; logs
`Netpay <método> <ruta> failed`; el resto de la API sana (`/health/ready` en verde).

1. Confirmar que es el proveedor y no nosotros: probar varios tenants y ambos ambientes; revisar la página de
   estado de NetPay y escalar a NetPay Support con hora y `orderReference` de ejemplo.
2. **No** desplegar ni hacer rollback por esto: el código no es la causa.
3. Avisar a las plataformas consumidoras: deben mostrar "pago no confirmado", nunca "pagado".
4. Al recuperarse NetPay, conciliar (§1) todas las órdenes creadas durante la ventana.

> No hay interruptor global para apagar pagos (`NETPAY-INTEGRATION.md` §11). Para un tenant concreto, la
> configuración tiene `enabled`, pero no hay endpoint para cambiarlo.

### 5.2 `504 PROVIDER_OUTCOME_UNKNOWN`

Significa que NetPay **pudo haber ejecutado** la operación (timeout de 10 s, 5xx, TLS, cuerpo ilegible). La orden
conserva el bloqueo de la operación; tras 2 minutos se considera abandonado.

1. **No** recobrar a ciegas: un segundo cargo puede duplicar el cobro.
2. Buscar la transacción en NetPay Manager por `orderReference`.
3. Si existe, `POST /t/payments/orders/:id/verify` con ese `transactionId` (§1, paso 3).
4. Si NetPay confirma que no existe, la orden se puede reintentar pasados los 2 minutos.
5. Para un reembolso con 504, verificar en NetPay Manager **antes** de pedirlo otra vez: reembolsar dos veces
   se rechaza, pero un reembolso ejecutado y no registrado sí puede quedar desalineado.

Un cargo sin respuesta deja la orden `CHARGE_UNKNOWN` (BN-TASK-014) y un resultado confirmado que no se pudo
escribir queda en `pending_provider_result` (BN-TASK-011); ambos los resuelve la conciliación (§1.1, §1.2).

### 5.3 Drift del webhook (NetPay apunta a otra URL)

**Síntomas:** órdenes que se quedan en `PENDING` aunque NetPay las muestra pagadas; ningún `POST
/payments/webhook/...` en los logs para ese tenant.

**Detección (BN-TASK-026):** `GET /t/payments/config/webhook` compara la URL que NetPay tiene registrada con
`${PUBLIC_BASE_URL}/api/v1/payments/webhook/{token}` (origen, ruta y hash del token vigente) y responde
`drift: true|false` con `reason` (`match`, `none_registered`, `origin`, `path`, `token`); la URL registrada sale con
el token redactado. Además la conciliación revisa cada tenant una vez por hora. Cada chequeo guarda el veredicto en
la config activa y emite `netpay_webhook_drift` (`drift` 1/0, métrica de `log-metrics.sh`; alertar con máx ≥ 1).
El `/health/ready` autenticado incluye `netpayWebhookDrift` (resumen de los veredictos guardados, cacheado 60 s, sin
llamar a NetPay); no vuelve `degraded` la instancia. Sin `PUBLIC_BASE_URL` solo se compara el token.

1. Comparar lo registrado con lo esperado:

   ```bash
   curl -sS "$BASE/t/payments/config/webhook" -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT_ID"
   ```

2. Si `drift` es `true`: con `reason` `origin`/`path`, NetPay llama a otro despliegue (p. ej. un integrador
   anterior); con `token`, a un token retirado; con `none_registered`, a nada. Rotar el token y volver a registrar
   (§3.1 pasos 3–5). El token en claro no se puede leer: si nadie lo tiene, rotarlo es la única salida. Cambiar el
   ambiente o la llave secreta (`POST /t/payments/config`) ya emite un token nuevo y deja `webhookRegisteredAt`
   en `null` (BN-REQ-CFG-003).
3. Conciliar (§1) las órdenes del periodo sin webhooks.

### 5.4 Pico de 5xx

**Síntomas:** alerta "Errores 5xx > 2 % en 5 min" (`DEPLOY-GCP.md` §14.3).

1. Separar 502/504 (proveedor, §5.1/§5.2) de 500/503 (nuestros):

   ```bash
   gcloud logging read \
     'resource.type="cloud_run_revision" AND resource.labels.service_name="netpay-api" AND httpRequest.status>=500' \
     --project="$PROJECT_ID" --freshness=30m --limit=50 \
     --format='table(timestamp, httpRequest.status, httpRequest.requestUrl, resource.labels.revision_name)'
   ```

2. Si los 500 empezaron con una revisión nueva → **rollback** (§6).
3. Si `/health/ready` falla → base de datos: RB-05 (IP de salida) y RB-06 (pooler) de `DEPLOY-GCP.md`.
4. Si solo afecta a un tenant → revisar su esquema (¿migración a medias? §7).
5. Tras mitigar, conciliar (§1) las órdenes con operaciones fallidas en la ventana.

---

## 6. Rollback de despliegue

Igual que RB-01 de `DEPLOY-GCP.md`. Segundos; no toca la base de datos.

```bash
gcloud run revisions list --service="$SERVICE" --region="$REGION" \
  --format='table(name, active, creationTimestamp)'
gcloud run services update-traffic "$SERVICE" --region="$REGION" \
  --to-revisions=<revisión-anterior>=100
curl -fsS https://netpay.tupla.dev/health/ready
```

- El rollback **no** revierte migraciones. Funciona porque las migraciones son compatibles hacia atrás
  (`DEPLOY-GCP.md` §12.4); si una no lo fue, la salida es restaurar la base (§16.2), no el código.
- Después del rollback el pipeline seguirá intentando promover la revisión mala en el siguiente push: bloquear
  el merge hasta tener el arreglo.

---

## 7. Fallo de migración de tenant

El Job `netpay-migrate` corre `scripts/migrate.ts` (plano de control) y después
`npx tsx scripts/migrate-tenants.ts`, que aplica `prisma/tenant-migrations/` a todo tenant `ACTIVE`:

- por esquema, toma `pg_advisory_xact_lock(hashtext(schema))` y aplica en **una transacción**;
- registra cada migración como `(version, checksum sha256)` en la tabla `tenant_schema_migrations` del esquema;
- antes de tocar nada compara los checksums registrados con los ficheros y **aborta** si alguno no coincide;
- usa la conexión directa (`CONTROL_PLANE_DATABASE_URL_UNPOOLED`), nunca el pooler.

Un despliegue cuya migración falla no recibe tráfico: la revisión actual sigue sirviendo.

1. **Leer el error del Job:**

   ```bash
   gcloud run jobs executions list --job="$MIGRATE_JOB" --region="$REGION" --limit=5
   gcloud logging read \
     'resource.type="cloud_run_job" AND resource.labels.job_name="netpay-migrate" AND severity>=ERROR' \
     --project="$PROJECT_ID" --freshness=1h --limit=20
   ```

2. **Según la causa:**

   | Error                                                     | Significa                                                     | Acción                                                                                                                                                                                                 |
   | --------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | Checksum mismatch (`TenantMigrationMismatchError`)        | Se **editó** un fichero de migración después de aplicarlo     | Restaurar el fichero a su contenido original (`git log -p prisma/tenant-migrations/<version>`). El cambio va en una migración **nueva**. **Nunca** editar migraciones aplicadas ni el ledger a mano |
   | `apunta al pooler de Neon`                                | El secreto `*-unpooled` tiene el host `-pooler`               | Corregir la versión del secreto con el host directo                                                                                                                                                  |
   | `schema outside the tenant_ namespace`                    | Un tenant `ACTIVE` tiene un `schemaName` inválido             | Incidente de datos: investigar el registro antes de seguir                                                                                                                                           |
   | Error SQL en un esquema                                   | La migración no aplica sobre los datos de ese tenant          | Su transacción hizo rollback; los tenants ya migrados se quedan en la versión nueva. Corregir con una migración nueva compatible y relanzar                                                           |
   | Lock / timeout                                            | Otra ejecución tiene el lock del esquema                      | Esperar a que termine; no lanzar dos Jobs a la vez                                                                                                                                                   |

3. **Relanzar** el Job (es idempotente: lo ya registrado no se reaplica):

   ```bash
   gcloud run jobs execute "$MIGRATE_JOB" --region="$REGION" --wait
   ```

4. Para un único tenant con la app sana existe `POST /tenants/<id>/migrate` (JWT de plataforma), que aplica las
   migraciones pendientes de ese esquema.
5. Si una migración de riesgo rompió datos: RB-09 y §16.2 de `DEPLOY-GCP.md` (rama de respaldo y restauración).

---

## 8. Observabilidad de pagos

| Señal                                      | Dónde                                                                                         | Estado                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------- |
| Métricas log-based `payment_status_change`, `netpay_latency_ms`, `outbound_delivery_result`, `charge_latency_ms`, `reconcile_checked`, `reconcile_corrected`, `reconcile_errors`, `netpay_webhook_drift` | Creadas por `scripts/gcp/monitoring/log-metrics.sh` sobre los eventos de `src/common/logging/payment-log-events.ts` | Script listo; aplicar con `--apply`. Una métrica vacía indica que su emisor aún no se llama desde pagos/entregas |
| Canal on-call, uptime check `/health/live`, SLO 99,9 % y p95 de `charge` < 1,5 s con burn rate | `scripts/gcp/monitoring/{notification-channel,uptime-check,slo}.sh` (orden en `DEPLOY-GCP.md` §14.3) | Script listo; aplicar con `--apply` |
| Logs JSON con `severity`, `requestId`, `tenantId`, trace y log de acceso por petición | Cloud Logging, `jsonPayload.*` (`type="access"` para el acceso) | Disponible |
| Alertas de infraestructura                 | `DEPLOY-GCP.md` §14.3                                                                         | Según §14.3                  |

`/health/ready` responde 200 también en estado `degraded`: no usarlo para decidir
si una instancia sale de rotación. Mientras las métricas no estén aplicadas, los
procedimientos de §5 se apoyan en `gcloud logging read`.
