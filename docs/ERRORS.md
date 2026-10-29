# Contrato de errores de la API

> **Estado:** verificado contra el código (`src/common/filters/all-exceptions.filter.ts`,
> `src/common/errors/app.exception.ts`, `src/payments/decline-codes.ts` y cada punto donde se lanza un código). Si
> este documento y el código discrepan, manda el código y este archivo está mal.

---

## 1. Forma de la respuesta

Toda respuesta de error, sea cual sea la capa que la produce, tiene la misma forma (BN-REQ-API-002):

```json
{
  "error": {
    "code": "PROVIDER_OUTCOME_UNKNOWN",
    "message": "The payment provider could not be reached; the outcome is unknown.",
    "retryable": true,
    "details": { "provider": "Netpay" }
  },
  "requestId": "…",
  "timestamp": "2026-10-21T12:00:00.000Z",
  "source": "application"
}
```

| Campo             | Qué es                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error.code`      | Discriminador estable. **Es lo único sobre lo que un cliente debe ramificar**; el mensaje puede cambiar.                                                                               |
| `error.message`   | Texto legible, en inglés, sin PII (pasa por `PiiRedactionService.scrubMessage`).                                                                                                       |
| `error.retryable` | Si repetir **la misma petición** puede salir bien. Por defecto sale del status: `408`, `429`, `503` y `504` son reintentables; el resto no (`isRetryableStatus`).                      |
| `error.details`   | Opcional. Contexto estructurado y no sensible (también pasa por la redacción de PII). Su forma depende del código.                                                                     |
| `requestId`       | Id de correlación; coincide con la cabecera `X-Request-Id` de la respuesta. Es lo que hay que dar a soporte.                                                                           |
| `timestamp`       | RFC 3339 del momento del fallo.                                                                                                                                                        |
| `source`          | Capa que produjo el error, para triage: `application` (excepción deliberada), `http` (Nest/Express), `prisma` (base de datos) o `unexpected` (defecto interno, siempre `500` genérico). |

Garantías del filtro: nunca sale un stack trace ni un mensaje del driver; un error inesperado es siempre
`500 INTERNAL_SERVER_ERROR` con un mensaje fijo; la URL que se registra en el log va con el token del webhook y los
valores de la query redactados. Cuando la excepción dice cuándo volver (`TOO_MANY_REQUESTS`,
`IDEMPOTENCY_IN_PROGRESS`), el filtro escribe además la cabecera `Retry-After` en segundos (`retryAfterOf`).

---

## 2. Pagos y proveedor (Netpay)

### `PROVIDER_OUTCOME_UNKNOWN` — `504`, `retryable: true`

**Cuándo:** Netpay no dio una respuesta definitiva: timeout, fallo de red/DNS/TLS, un `5xx` de Netpay o un cuerpo
`2xx` ilegible (`NetpayTransportError`, o `NetpayRequestError` con status del proveedor ≥ 500). `details` lleva
`provider` y, si hubo respuesta, `providerStatus` y `providerMessage`.

**Lo que significa:** la operación **puede haberse ejecutado** en Netpay. Por eso el servidor **no libera** el
_claim_ de la orden tras un cobro o un reembolso con resultado desconocido (BN-REQ-PAY-011): la orden queda para
conciliación, no se reabre para un segundo intento que podría cobrar o devolver dos veces. En un **cobro** (la
petición de cargo ya salió hacia Netpay), además, la orden pasa a `CHARGE_UNKNOWN` (BN-REQ-PAY-003) y todo cobro
nuevo responde `409 ORDER_STATE_CONFLICT` hasta que una verificación la resuelva (ver
[`ORDER_STATE_CONFLICT`](#order_state_conflict--409-no-reintentable)).

**Qué debe hacer el cliente:** `retryable` aquí **no** quiere decir "repite el cobro a ciegas".

1. Consultar el estado de la orden (`GET /api/v1/t/payments/orders/:id`) y, si se conoce el id de la transacción,
   verificarla contra Netpay (`POST /api/v1/t/payments/orders/:id/verify`).
2. Solo si la orden sigue sin transacción y sin cobro, reintentar. Mientras el _claim_ siga vigente (ventana de
   2 minutos, `CLAIM_WINDOW_MS`), un nuevo `charge`/`refund`/`confirm` sobre la misma orden responde
   `409 CONFLICT` ("Another operation is in progress on this order…"); si la orden quedó `CHARGE_UNKNOWN`, un
   `charge` responde `409 ORDER_STATE_CONFLICT` hasta verificarla.
3. No crear una orden nueva para "reintentar" el mismo pago: esa es la forma de cobrar dos veces.

Si la petición llevaba `Idempotency-Key`, repetirla con la misma llave responde `409 IDEMPOTENCY_IN_PROGRESS`
durante 10 minutos (§2.1): la llave no vuelve a ejecutar una operación cuyo resultado se desconoce.

**`CHARGE_UNKNOWN` sin transacción.** Netpay **no ofrece búsqueda por `orderReference` / `merchantReferenceCode`**
(`NetpayClient` solo consulta `GET /v3/transactions/{id}`), así que una orden sin transacción ligada se resuelve con
el id de la transacción: el que muestra Netpay Manager (`POST …/verify` con `transactionId`) o el que liga la
notificación entrante de Netpay. `POST …/verify` sin `transactionId` sobre esa orden responde `400 VALIDATION_ERROR`.

### `PROVIDER_DECLINED` — `502`, no reintentable

**Cuándo:** Netpay rechazó explícitamente la petición con un `4xx` (`NetpayRequestError`, status del proveedor
< 500). Nada ocurrió en Netpay, así que el _claim_ se libera. `details`: `provider`, `providerStatus` y
`providerMessage` si Netpay lo envió.

**Ojo:** un **cobro declinado** por el emisor o por antifraude **no** es `PROVIDER_DECLINED`. Netpay lo devuelve
como `409` con la transacción en `status: "failed"`; el servidor lo trata como resultado del cobro y responde con
éxito HTTP, la orden en `FAILED` y un `failureCode` (§5).

**Qué debe hacer el cliente:** no repetir la misma petición; corregir los datos (llaves, parámetros) o escalar con
el `requestId`.

### `PROVIDER_RESULT_PENDING` — `500`, no reintentable

**Cuándo:** Netpay **confirmó** un reembolso o un cobro y la escritura local que lo registra falló
(BN-REQ-IDM-004). El resultado se guarda con un insert aparte en `pending_provider_result`, la orden **conserva su
_claim_** y ninguna operación puede reclamarla mientras exista un pendiente sin aplicar (aunque venza la ventana de
2 minutos). La conciliación lo aplica una sola vez (`PaymentOrdersService.applyPendingProviderResults`). `details`:
`{ operation: "refund" | "charge" }`.

**Qué debe hacer el cliente:** **no** repetir la operación: el dinero ya se movió. Releer la orden más tarde; la
conciliación la llevará a `REFUNDED`/`PARTIALLY_REFUNDED` o a `FAILED`/`PAID` y emitirá el evento. Si ni el
pendiente pudo escribirse, la respuesta es `500 INTERNAL_SERVER_ERROR` y el _claim_ dura su ventana: escalar con el
`requestId`.

### `UPSTREAM_PROVIDER_ERROR` — `502`

Código por defecto de `UpstreamProviderException` cuando se lanza sin una subclase. Hoy todas las rutas de Netpay
usan las dos subclases anteriores; se documenta porque el código lo define.

### `CREDENTIALS_ENVIRONMENT_MISMATCH` / `CREDENTIALS_INVALID` — `422`, no reintentables

**Cuándo:** al guardar la configuración de pagos (`POST /api/v1/t/payments/config`). Las llaves de Netpay no dicen
a qué ambiente pertenecen, así que el servidor hace una llamada autenticada de solo lectura en el ambiente elegido;
si falla, prueba el otro (`PaymentConfigService.assertCredentialsWork`).

| Código                             | Significado                                                                       | Qué hacer                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `CREDENTIALS_ENVIRONMENT_MISMATCH` | Las llaves funcionan en el **otro** ambiente (llave LIVE guardada como SANDBOX…). | Cambiar `environment` o pegar las llaves del otro panel.  |
| `CREDENTIALS_INVALID`              | Netpay las rechaza en el ambiente elegido y en el otro tampoco valen.             | Revisar/rotar las llaves en Netpay Manager.               |

Antes de esa llamada, un formato de llave incorrecto (`pk_netpay_…` / `sk_netpay_…`) es `400 VALIDATION_ERROR`.

### `BLOCKED_ADDRESS` — `422`, no reintentable

**Cuándo:** la URL de un webhook saliente (`POST /api/v1/t/webhooks`; también se revalida en cada entrega, donde no llega al cliente) está bien
formada pero apunta a un destino prohibido (`UrlRejectedError`): `PRIVATE_ADDRESS`, `METADATA_ADDRESS` o
`NOT_ALLOWED_BY_POLICY`. `details`: `{ reason, detail }`.

Cualquier otro rechazo de la URL (`INVALID_URL`, `HTTPS_REQUIRED`, `UNRESOLVED`) es `400 VALIDATION_ERROR` con el
mismo `details`.

**Qué debe hacer el cliente:** registrar una URL pública HTTPS; reintentar la misma no sirve.

### `ORDER_STATE_CONFLICT` — `409`, no reintentable

**Cuándo:** el estado de la orden no admite un **cobro**, una **confirmación 3-D Secure** o una **cancelación**
(`OrderStateConflictException`, BN-REQ-PAY-001/002/003/004). `details.status` lleva el estado; cuando el intento
anterior resultó cobrado, `details.order` lleva la orden ya `PAID`.

| Situación                                                                                               | `details`               |
| ------------------------------------------------------------------------------------------------------- | ----------------------- |
| La orden ya está liquidada (`PAID`, `PARTIALLY_REFUNDED`, `REFUNDED`)                                    | `status`                |
| La orden está `CHARGE_UNKNOWN`: un cobro anterior no tuvo respuesta definitiva                           | `status`                |
| La orden no es cobrable (`AMOUNT_MISMATCH`)                                                             | `status`                |
| El intento anterior sigue sin decidir en Netpay (`REVIEW`, `IN_PROCESS`…)                                | `status`                |
| Al verificar el intento anterior antes de recobrar, Netpay dice que **sí se cobró**: la orden pasa a `PAID` | `status`, `order`       |
| Cobrar o confirmar una orden `CANCELLED` o `EXPIRED`                                                     | `status`                |
| `POST …/orders/:id/cancel` de una orden `PAID`, `PARTIALLY_REFUNDED`, `REFUNDED`, `EXPIRED`, `AMOUNT_MISMATCH` o `CHARGE_UNKNOWN` (esta última, hasta verificarla) | `status` |
| `POST …/cancel` con un cobro ligado: Netpay dice que **sí se cobró** (la orden pasa a `PAID`), o aún no decide | `status` (+ `order` si se cobró) |

**Cancelación (BN-REQ-PAY-004).** `POST /api/v1/t/payments/orders/:id/cancel` pasa a `CANCELLED` una orden
`PENDING`, `PENDING_VERIFICATION` o `FAILED` y emite `payment.cancelled`; repetirla sobre una orden ya `CANCELLED`
devuelve la orden (`200`). Netpay no ofrece expirar una sesión alojada ni una referencia OXXO, así que si el
comprador paga después, la orden **sigue `CANCELLED`**, gana `paidAfterCancelAt` y se emite
`payment.paid_after_cancel` (auditado como `LATE_PAYMENT_ON_CANCELLED`): el consumidor debe reembolsar. Lo mismo
vale para una orden `EXPIRED`.
**Intentos (BN-REQ-PAY-001/002).** Una orden `FAILED` (rechazo definitivo) acepta un cobro con otra tarjeta: es
el intento 2 (`payment_attempt`), la orden apunta a la transacción vigente y los eventos llevan la de ese intento.
Si el intento anterior quedó en 3-D Secure (`PENDING_VERIFICATION` con una transacción `WAIT_THREEDS`), el nuevo
`charge` primero lo consulta en Netpay: si no se cobró, el intento queda `ABANDONED` y el cobro nuevo sigue; si se
cobró, esta respuesta con la orden `PAID`; si sigue indeciso, esta respuesta sin cobrar.

**Qué hacer:** releer la orden. `CHARGE_UNKNOWN` se resuelve con `POST …/verify` y el `transactionId` (§2,
`PROVIDER_OUTCOME_UNKNOWN`); con `details.order.status = PAID`, entregar el pedido, no cobrar.

### Otros conflictos de la orden — `409 CONFLICT`

El resto de conflictos de una orden salen como `ConflictException`, código genérico `CONFLICT`, y se distinguen por
el mensaje. Casos verificados en `payment-orders.service.ts`:

| Situación                                                                  | Operación                 |
| -------------------------------------------------------------------------- | ------------------------- |
| Otra operación tiene el _claim_ de la orden, ya no cumple las condiciones, o hay un resultado del proveedor pendiente de aplicar | `charge`, `refund`, `confirm`, `cancel` |
| La orden ya está liquidada                                                 | `confirm`                 |
| Solo una orden `PAID` se puede reembolsar / no hay transacción que revertir | `refund`                  |
| La transacción no está esperando confirmación 3-D Secure / la orden no tiene cobro | `confirm`                 |
| La orden ya está ligada a otra transacción / la transacción es de otra orden | `verify`                  |
| Límite de tarjetas por cliente                                             | `cards`                   |

**Qué hacer:** releer la orden y decidir sobre su estado actual. Un `409` por _claim_ se resuelve solo cuando
termina la otra operación o vence la ventana de 2 minutos.

### `RETURN_URL_NOT_ALLOWED` — `422`, no reintentable

**Cuándo:** al crear una orden alojada (`POST /api/v1/t/payments/orders`, `checkoutMode: hosted`), `successUrl` o
`cancelUrl` no son `https`, o su origen no está en `allowedReturnOrigins` del tenant (BN-REQ-PAY-007).
`details`: `{ field, origin }`. Sin `successUrl`/`cancelUrl` se usan `PAYMENT_REDIRECT_URL`/`PAYMENT_CANCEL_URL`,
que son de la configuración validada y no se comprueban aquí.

**Decisión:** mientras la lista del tenant esté **vacía** se acepta cualquier origen `https` y se registra un
aviso `return_url_origin_unrestricted` (compatibilidad con integraciones existentes); en cuanto el tenant la
configura (`PATCH /api/v1/t/payments/config` con `allowedReturnOrigins`), solo valen esos orígenes. `http://` nunca.

**Qué hacer:** usar una URL `https` de un origen de la lista, o añadir el origen con `PATCH …/config`.

### `CURRENCY_NOT_ENABLED` — `422`, no reintentable

**Cuándo:** la moneda de la orden no está en `allowedCurrencies` del tenant (por defecto `["MXN"]`,
BN-REQ-PAY-008). `details`: `{ currency, allowed }`. Una orden alojada u OXXO en otra moneda sigue siendo
`400 VALIDATION_ERROR` (Netpay solo liquida esas en MXN), y se comprueba antes.

**Qué hacer:** cobrar en una moneda habilitada, o habilitarla con `PATCH /api/v1/t/payments/config`
(`allowedCurrencies`).

### 2.1 Idempotencia: `Idempotency-Key`

`POST /api/v1/t/payments/orders`, `POST /api/v1/t/payments/orders/:id/charge`, `…/confirm` y `…/refund` aceptan
la cabecera **opcional** `Idempotency-Key` (1 a 255 caracteres ASCII imprimibles; un UUID es lo recomendado). Sin
ella, todo se comporta como antes. Con ella (`IdempotencyInterceptor`, tabla `idempotency_record` del esquema del
tenant, BN-REQ-IDM-001/002/003):

| Caso                                                          | Respuesta                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Primera petición con la llave                                 | Se ejecuta. El éxito y un `4xx` definitivo se guardan (`DONE`) **24 h**.                          |
| Misma llave, mismo cuerpo, ya terminada                       | La respuesta guardada (mismo status y cuerpo, o el mismo error), con `Idempotency-Replayed: true`. **No se llama a Netpay.** |
| Misma llave, **otro** cuerpo                                  | `422 IDEMPOTENCY_KEY_REUSED`, no reintentable.                                                    |
| Misma llave mientras la primera sigue en curso                | `409 IDEMPOTENCY_IN_PROGRESS`, `retryable: true`, cabecera `Retry-After: 2`.                       |
| La primera terminó en `5xx`/`504` (p. ej. `PROVIDER_OUTCOME_UNKNOWN`) | La llave **sigue `IN_PROGRESS` 10 minutos**: los reintentos reciben `409 IDEMPOTENCY_IN_PROGRESS` mientras la conciliación/verificación resuelve la orden; después la llave vuelve a ejecutar y responde según el estado real (p. ej. `409 ORDER_STATE_CONFLICT` o la orden ya `PAID`). |
| La primera terminó en un `4xx` reintentable (`408`, `429`)     | La llave se libera: nada ocurrió.                                                                  |

Detalles: la llave se acota al tenant y a la ruta concreta (método + path con el id de la orden); el cuerpo se
compara por SHA-256 de su JSON canónico (el orden de las claves no cuenta). Una llave `IN_PROGRESS` de una
instancia que murió vence a los 10 minutos. Dos peticiones **concurrentes** con la misma llave: una ejecuta y la
otra recibe `409 IDEMPOTENCY_IN_PROGRESS`; al reintentarla tras `Retry-After` recibe la misma respuesta que la
primera. Una llave mal formada es `400 VALIDATION_ERROR`.

### `AMOUNT_MISMATCH` — no es un código de error

`AMOUNT_MISMATCH` es un **estado de la orden** (`PaymentStatus`), no un `error.code`: la verificación lo asigna
cuando el importe que reporta Netpay no coincide con el de la orden, y emite el evento correspondiente. La llamada
que lo descubre no falla; hay que leer `status` en la respuesta o en la orden.

---

## 3. Autenticación y sesión

| Código                     | HTTP  | `retryable` | Cuándo                                                                                                                                              | Qué hacer                                                         |
| -------------------------- | ----- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `UNAUTHORIZED`             | `401` | no          | Ruta protegida sin credencial (`UnauthorizedException` de Nest en `auth.guard.ts`; el filtro deriva el código del campo `error`).                    | Enviar token o API key.                                           |
| `UNAUTHENTICATED`          | `401` | no          | `POST /internal/tick` sin un token OIDC de Google válido para su audiencia (o sin `INTERNAL_TICK_SA_EMAIL` configurado). Una API key o un JWT de la API tampoco valen. | Solo Cloud Scheduler la llama.                                    |
| `INVALID_CREDENTIALS`      | `401` | no          | Usuario/contraseña incorrectos, cuenta bloqueada, o refresh token desconocido/caducado. Idéntico para "no existe", "contraseña mala" y "bloqueada" a propósito (el bloqueo se revisa antes que la contraseña: no hay oráculo). También `currentPassword` incorrecto al cambiar las llaves de Netpay desde una sesión de miembro.| Volver a iniciar sesión.                                          |
| `TOKEN_REUSE_DETECTED`     | `401` | no          | Se reutilizó un refresh token ya rotado; toda la familia de sesiones queda revocada.                                                                | Iniciar sesión de nuevo; tratarlo como posible robo de token.     |
| `INVALID_API_KEY`          | `401` | no          | API key ausente, malformada, caducada, revocada, o de un tenant inactivo.                                                                           | Revisar/rotar la key.                                             |
| `ACCOUNT_LOCKED`           | `423` | no          | Reservado; ya no se emite: el inicio de sesión de una cuenta bloqueada responde `401 INVALID_CREDENTIALS`, igual que una contraseña incorrecta.| —                                                                 |
| `FORBIDDEN`                | `403` | no          | Principal conocido sin permiso (permisos RBAC, rol de tenant, rol a conceder mayor que el propio…). En `POST /internal/tick`: token de Google válido de otra identidad. | No reintentar; pedir el permiso.                                  |
| `MISSING_SCOPE`            | `403` | no          | La API key no tiene el scope de la ruta. `details`: `{ required, granted }`.                                                                        | Emitir una key con el scope.                                      |
| `MFA_REQUIRED`             | `403` | no          | Admin de plataforma sin segundo factor verificado en el token (obligatorio por configuración o porque lo enroló). `details.enrolled`.                | Enrolar (`POST /api/v1/auth/mfa/enroll` + `/api/v1/auth/mfa/confirm`) o verificar (`POST /api/v1/auth/mfa/verify`). |
| `PASSWORD_CHANGE_REQUIRED` | `403` | no          | El admin tiene `mustChangePassword`; solo responde el cambio de contraseña (y MFA).                                                                 | `POST /api/v1/auth/change-password`.                              |
| `STEP_UP_REQUIRED`         | `403` | no          | Un admin de plataforma escribe pagos de un tenant y su MFA tiene más de 5 minutos. `details.maxAgeSeconds = 300`.                                   | `POST /api/v1/auth/mfa/verify` y repetir.                         |
| `TENANT_REQUIRED`          | `400` | no          | No se resolvió tenant (`X-Tenant-Id`, `X-Tenant-Slug` o subdominio).                                                                                | Enviar el tenant.                                                 |
| `TENANT_UNAVAILABLE`       | `403` | no          | El tenant existe pero no está `ACTIVE`. `details.status`.                                                                                           | Escalar.                                                          |
| `PASSWORD_NOT_ACCEPTED`    | `422` | no          | Una API key intenta fijar la contraseña al crear un miembro (`POST /api/v1/t/users`); por API key el miembro nace `INVITED` y recibe invitación.     | Omitir `password`.                                                |
| `INVALID_INVITATION`       | `400` | no          | Token de invitación inválido o ya usado (`POST /api/v1/t/auth/accept-invitation`).                                                                  | Pedir una invitación nueva.                                       |

`MFA_REQUIRED`, `PASSWORD_CHANGE_REQUIRED` y `STEP_UP_REQUIRED` salen de `evaluateAdminSession`
(`src/auth/admin-session-policy.ts`) y se evalúan en ese orden.

---

## 4. Validación, recursos y genéricos

| Código                    | HTTP  | `retryable` | Origen                                                                                                                                                                         |
| ------------------------- | ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BAD_REQUEST`             | `400` | no          | `ValidationPipe` global (DTO inválido, propiedades no permitidas). `details.violations` es la lista de fallos por campo. `source: "http"`.                                      |
| `VALIDATION_ERROR`        | `400` | no          | Validación de negocio (`ValidationException`): importes, moneda, tokens de tarjeta, formato de llaves, URL de webhook no válida…                                               |
| `MALFORMED_BODY`          | `400` | no          | JSON ilegible (body-parser).                                                                                                                                                   |
| `PAYLOAD_TOO_LARGE`       | `413` | no          | Cuerpo por encima del límite.                                                                                                                                                  |
| `NOT_FOUND`               | `404` | no          | Recurso inexistente **o que el llamante no debe saber que existe** (las órdenes de otro tenant responden igual), y rutas desconocidas.                                          |
| `CONFLICT`                | `409` | no          | Conflicto con el estado actual (§2, slugs/e-mails duplicados, keys no activas…).                                                                                               |
| `DOMAIN_VIOLATION`        | `422` | no          | Invariante de dominio (`DomainException`).                                                                                                                                     |
| `HTTP_ERROR`              | —     | según status | `HttpException` con payload de texto. En la práctica, el rate limit de `@nestjs/throttler` sale como `429 HTTP_ERROR`, `retryable: true`.                                       |
| `TOO_MANY_REQUESTS`       | `429` | sí          | Definido (`TooManyRequestsException`, `details.retryAfterSeconds` y cabecera `Retry-After`), pero hoy no se lanza en ninguna ruta.                                            |
| `P2000`, `P2002`, `P2003`, `P2025`, `P2034` | `422`/`409`/`409`/`404`/`409` | solo `P2034` | Errores de Prisma visibles al cliente con mensaje fijo; `P2034` (conflicto de serialización) se reintenta tal cual. `source: "prisma"`. |
| `DATABASE_ERROR`          | según | según status | Cualquier otro error de Prisma; `P1001`/`P1002`/`P1008`/`P1017` son `503` y reintentables.                                                                                     |
| `INVALID_QUERY`           | `400` | no          | `PrismaClientValidationError`.                                                                                                                                                 |
| `DATABASE_UNAVAILABLE`    | `503` | sí          | `PrismaClientInitializationError`.                                                                                                                                             |
| `INTERNAL_SERVER_ERROR`   | `500` | no          | Cualquier otra cosa. Se registra con el `requestId`; el cliente solo ve un mensaje fijo.                                                                                       |

---

## 5. `failureCode`: por qué se declinó un cobro

Un cobro declinado no es un error HTTP (§2). La respuesta del `charge` (`ChargeResult`) y la orden llevan un
`failureCode` estable (BN-REQ-PAY-006), y también viaja en los eventos salientes. `declineReason` lleva el texto de
Netpay para mostrar. El código original de Netpay se guarda internamente (`providerFailureCode`) y **nunca** sale
en una respuesta.

`classifyDecline` (`src/payments/decline-codes.ts`) busca primero el `responseCode` en una tabla que une los
códigos de emisor ISO 8583 y los _reason codes_ del gateway; si no hay código conocido, cae a reglas sobre el
mensaje (español e inglés, sin acentos).

| `failureCode`           | Significado                                    | Códigos de Netpay que lo producen                                     |
| ----------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `INSUFFICIENT_FUNDS`    | Fondos insuficientes.                          | `51`, `204`                                                           |
| `CARD_EXPIRED`          | Tarjeta vencida.                               | `33`, `54`, `202`                                                     |
| `DO_NOT_HONOR`          | El emisor rechaza sin dar motivo.              | `01`, `02`, `05`, `12`, `57`, `62`, `203`, `233`                      |
| `FRAUD_SUSPECTED`       | Antifraude, tarjeta robada/extraviada, Decision Manager. | `04`, `07`, `34`, `41`, `43`, `59`, `63`, `205`, `400`, `481`, `520` |
| `AUTHENTICATION_FAILED` | Falló la autenticación 3-D Secure.            | `476`, `478`                                                          |
| `INVALID_CARD`          | Tarjeta, token o datos de tarjeta no válidos.  | `14`, `15`, `56`, `82`, `N7`, `211`, `231`, `232`                      |
| `LIMIT_EXCEEDED`        | Límite de la tarjeta excedido.                 | `61`, `65`, `121`, `210`                                              |
| `PROCESSOR_ERROR`       | Error del procesador o del sistema.            | `06`, `19`, `91`, `92`, `94`, `96`, `150`, `151`, `152`, `236`, `250` |
| `UNKNOWN`               | No reconocido; el código original queda guardado para añadirlo a la tabla. | —                                     |

Para el comprador: `INSUFFICIENT_FUNDS`, `CARD_EXPIRED`, `INVALID_CARD` y `LIMIT_EXCEEDED` se resuelven con otra
tarjeta; `AUTHENTICATION_FAILED`, repitiendo 3-D Secure; `PROCESSOR_ERROR` admite un nuevo intento más tarde;
`DO_NOT_HONOR` y `FRAUD_SUSPECTED` no se deben reintentar con la misma tarjeta.

---

## 6. Pendiente

Códigos que se mencionaron para este contrato pero **no existen en el código** a fecha de esta revisión. No se les
asigna comportamiento hasta que se implementen:

- **`AMOUNT_MISMATCH` como `error.code`**: solo existe como estado de la orden (§2).
- **`ORDER_STATE_CONFLICT` fuera de `charge`, `confirm` y `cancel`**: los demás conflictos de orden (`refund`,
  `verify`, el _claim_) siguen saliendo como `409 CONFLICT` genérico (§2).
- **Búsqueda de una transacción por referencia**: Netpay no la ofrece; una orden `CHARGE_UNKNOWN` sin transacción
  ligada depende del id que dé Netpay Manager o la notificación (§2). La conciliación (BN-TASK-016) la devuelve a
  `PENDING` pasado `RECONCILE_CHARGE_UNKNOWN_GRACE_MS` (1 h por defecto); ver RUNBOOK-PAYMENTS §1.1.
