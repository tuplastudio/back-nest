# Análisis previo — Integración Netpay con aislamiento por tenant

> **Estado:** implementado en `src/payments/`. Las secciones 1–6 y 8–16 son el análisis de diseño original;
> el comportamiento vigente, verificado contra el sandbox de Netpay, está en §7, §17 y §18. Ninguna clave real
> aparece en este archivo.

---

## 1. Advertencia inmediata sobre las llaves

En el mensaje sePegó una llave privada de Netpay (`sk_netpay_…`). Trátala como **comprometida**:

| Acción                                                            | Motivo                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rotarla ya** en Netpay Manager, aunque sea una llave de Sandbox | Quedó escrita en el historial de una conversación y en el log del terminal. Es la única llave privada que da acceso completo a la API del comercio: permite crear transacciones, **emitir devoluciones y mover dinero**. |
| **Nunca commitearla**                                             | `.gitignore` ya cubre `.env`; las llaves por tenant irán cifradas en base de datos, no en archivos.                                                                                                                      |
| **No reutilizarla como valor por defecto**                        | Este repo acaba de eliminar precisamente ese patrón del seed (`SEED_*` y claves PII ahora son obligatorias y sin fallback). Aplicar aquí lo contrario sería incoherente.                                                 |
| **Separar por tenant desde el día uno**                           | Una llave compartida entre tenants significa que el compromiso de un tenant compromete a todos, y que Netpay no puede atribuir las transacciones a un comercio concreto.                                                 |

En este documento y en el futuro código la llave se referencia **siempre** por nombre
(`NETPAY_SK_<tenant>`), nunca por valor.

---

## 2. Contexto: qué hay que respetar del codebase actual

La integración no cae sobre un lienzo en blanco. Estos son los condicionantes que el diseño debe cumplir
porque **ya existen y están verificados**:

| Restricción del codebase                      | Dónde                                                                        | Consecuencia para Netpay                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Aislamiento por schema de tenant              | `prisma/schema.tenant.prisma`, `src/prisma/tenant-prisma.service.ts:162-168` | La configuración de pagos de un tenant debe vivir en **su schema**, no en el plano de control.                          |
| RLS `FORCE` con binding `app.current_tenant`  | `prisma/tenant-migrations/0002_tenant_rls/migration.sql`                     | Toda lectura de una orden debe pasar por `forCurrentTenantTransaction`.                                                 |
| Migraciones de tenant numeradas y versionadas | `prisma/tenant-migrations/`, aplicadas por `TenantProvisionerService`        | Los pagos necesitan una migración de tenant nueva (`0004`), no una del plano de control.                                |
| RBAC con módulos/roles/permisos               | `src/auth/permission-catalog.ts`                                             | Los pagos necesitan su propio módulo y permisos en el catálogo.                                                         |
| **Auditoría RBAC en el arranque**             | `src/common/rbac-audit.service.ts`                                           | **Cualquier ruta nueva sin política declarada hace que la app no arranque.** El webhook debe declararla explícitamente. |
| Cifrado AES-256-GCM con AAD                   | `src/pii/pii-crypto.service.ts`                                              | Es el patrón a seguir para guardar la llave privada, pero conviene una clave propia (§6.2).                             |
| `PiiRedactionService` y reglas de PII         | `docs/SECURITY.md`                                                           | Los datos que llegan en el webhook **son datos personales** y no deben pasar a logs ni almacenarse en claro.            |
| Cero llamadas salientes hoy                   | `eslint.config.mjs` solo prohíbe SQL crudo                                   | Es la **primera** integración que hace HTTP saliente. Necesita allowlist de destinos y manejo de SSRF.                  |
| Sandbox de pruebas sin red                    | el proyecto se verifica offline                                              | La integración **no se puede probar** en el CI actual. Hay que decidir cómo (§12).                                      |

---

## 3. Checkout Custom vs Checkout Hosted

|                          | **Checkout Custom**                                  | **Checkout Hosted**                                                      |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Dónde vive el formulario | Tuyo, embebido con `netpay3ds.js`                    | En Netpay, rediriges y ellos cobran                                      |
| UI y conversión          | Control total del flujo y la marca                   | -plantilla de Netpay                                                     |
| Tokenización de tarjeta  | Sí, en el navegador vía NetpayJS (`netpay.min.js`)   | No te aplica                                                             |
| Guardar tarjeta          | Sí (`saveCard: true`, perfil de cliente, 1–3 tokens) | No                                                                       |
| 3DS 2.0                  | Sí, con flujo de confirmación explícito              | Gestionado por ellos                                                     |
| Integración              | Más piezas: tokenizar → cobrar → confirmar 3DS       | Una llamada: `POST /v3.2/checkout/session/` devuelve `hostedCheckoutUrl` |
| Superficie PCI           | Mayor (el flujo pasa por tu servidor en más puntos)  | Menor                                                                    |
| Archivos de ejemplo      | SDK `netpay3ds.js` en CDN                            | Redirección pura                                                         |

**Recomendación: empezar por Hosted, y añadir Custom solo cuando haya un requisito que lo justifique.**

Razones concretas:

1. El flujo Hosted es **un endpoint y una redirección**. Custom exige orquestar tokenización → cobro → 3DS →
   confirmación, y cada salto es un estado más que persistir correctamente. En un sistema que además tiene que
   ser _multi-tenant_ y auditable, esa superficie se paga sola.
2. El problema difícil de Netpay no es el formulario, es **el webhook** (§5), y ambos modos lo comparten.
   No se reduce atacando el formulario.
3. El requerimiento de “almacenar tarjetas” puede cubrise después. Hosted primero deja el modelo de datos,
   el aislamiento y la máquina de estados ya correctos; Custom se integra después sin rediseñar.

Custom tiene sentido si más adelante necesitas: billetera propia, `saveCard: true`, MSI (meses sin intereses con
reglas de monto mínimo), o control total del UX de checkout.

---

## 4. La decisión central: ¿cómo se aísla Netpay por tenant?

Este es el punto que define todo lo demás. Hay tres modelos reales:

### Opción A — Una sola cuenta de Netpay para toda la plataforma

```
1 cuenta Netpay (1 par pk_/sk_)
   └── order_reference = <tenantId>-<uuid>
```

- **A favor:** una sola llave, un solo webhook, una conciliación.
- **En contra:** Netpay no sabe qué comercio es cada venta; el merchant es la plataforma. No se pueden dar
  llaves y liquidaciones por tenant, y un tenant no puede facturar con su propia razón social. **No cumple**
  “cada tenant tendrá su propia implementación”. Descartada.

### Opción B — Una cuenta de Netpay por tenant (recomendada) ✅

```
Tenant ACME  → cuenta Netpay A  → pk_A / sk_A  → webhook → /payments/webhook/<tokenA>
Tenant GLOBEX→ cuenta Netpay B  → pk_B / sk_B  → webhook → /payments/webhook/<tokenB>
```

- **A favor:**
  - Es literalmente el requerimiento: cada tenant aísla su configuración, sus llaves y su liquidación.
  - La documentación lo respalda de forma natural: _“Cada set de llaves utilizado para consumir los servicios
    de Netpay cuenta con un campo destinado al registro de una URL de Webhook”_. Es decir, **la URL de webhook se
    registra por juego de llaves**, que es exactamente por-tenant.
  - La atribución de fondos, las devoluciones y la conciliación por tenant salen gratis.
  - El compromiso de un tenant no toca a los demás: la llave vive cifrada en **su** schema, y cada schema es
    un ente separado.
- **En contra (y sonserios):**
  - Alta por tenant: alguien debe crear la cuenta en Netpay Manager y el alta del webhook **es manual con
    Netpay Support** (la doc dice hay que contactar a un IT Support Engineer). No es autoprovisionable.
  - **Certificado SSL por tenant:** la doc exige SSL válido con **vigencia mínima de un año**, cargado a mano.
    Un certificado = un dominio. N tenants = N renovaciones, o un wildcard válido para todos.
  - Más superficie operativa y de soporte.

### Opción C — Híbrido: una cuenta por tenant, pero el webhook centralizado

Como Opción B, pero todas las cuentas apuntan a una **única** URL de webhook y el tenant se deduce del
`transactionId`/`merchantReferenceCode`. **Descartada**: los schemas de tenant están aislados por diseño y para
encontrar la orden habría que consultar N schemas en una petición no autenticada. Es un hot-fix de diseño.

**Recomendación: Opción B**, con dos mitigaciones a la fricción operativa:

1. **Un dominio de webhook por plataforma con token opaco por tenant** (§5.2), de modo que registrar N webhooks
   es N `PUT /v3/webhooks/` y no N dominios.
2. **Un proceso de alta guides** (checklist en el doc) porque Netpay no permite automatizar el alta del webhook.

---

## 5. Seguridad — el webhook es el problema central

### 5.1 El webhook **no viene firmado**. Esto no es una suposición.

De la documentación oficial, el payload de ejemplo de `sessionLink.paid` es:

```
{ "data": { sessionId, transactionId, amount, status, cardHolderName,
            lastFourDigits, bankName, responseCode, procRetMsg,
            customerEmail, cartType, cardNature, authDate, authCode, orderId },
  "event": "sessionLink.paid", "type": null, "createdAt": 1618267390617 }
```

**No hay `hash`, ni HMAC, ni campo de firma, ni secreto de webhook en el payload.** Los eventos observados son
`cep.created`, `cep.paid`, `sessionLink.paid`, `sessionLink.failed`.

Consecuencias directas:

1. **Cualquiera que conozca la URL puede enviar un `sessionLink.paid` falso** y con un `transactionId`
   inventado. Si el sistema confía en ese payload para marcar un pedido como pagado, entrega mercancía sin
   cobrar. Esto es un fallo de negocio, no un detalle de robustez.
2. `customerEmail`, `cardHolderName`, `lastFourDigits` y `bankName` son **datos personales**. El ejemplo oficial
   los escribe completos a un archivo de log en disco. Eso no se copia.

### 5.2 El patrón correcto: el webhook solo despierta, la API confirma

Es exactamente lo que hace el propio ejemplo de la doc —y por eso hay que leerlo con cuidado—: tras recibir el
evento **vuelve a consultar a Netpay** (`GET /v3/transactions/{transactionId}`) con la llave secreta y decide
sobre **esa** respuesta.

**Regla de diseño innegociable:**

> El webhook es una _pista_ de trabajo, nunca una prueba. El estado de un pago se cambia **únicamente** con lo
> que responde `GET /v3/transactions/{id}` usando la llave del tenant. Si la verificación no se puede hacer, el
> pago queda en un estado pendiente y el sistema **no** entrega.

Corolarios:

- El endpoint de webhook responde **202 Accepted** rápido y encola la verificación. Nunca muta el pedido
  dentro de la petición entrante.
- Idempotencia obligatoria: Netpay reintenta entregas. La clave de idempotencia natural es `transactionId`.
- **Desacoplar el tenant del header.** El `X-Tenant-Id` es del cliente y no está firmado: no sirve para
  resolver el tenant de un webhook. El tenant se resuelve con un **token opaco por tenant embebido en la URL**
  (`/payments/webhook/<token>`), que es aleatorio, rotable y **distinto** de la llave secreta de Netpay.
- Limitar el trabajo por petición: el endpoint no debe poder usarse para amplificar consultas contra la API de
  Netpay.

### 5.3 Dos errores del ejemplo oficial que no se deben copiar

| Error en el ejemplo de la doc                                       | Por qué es grave                                                                              | Qué hacer                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `CURLOPT_SSL_VERIFYPEER = FALSE` y `CURLOPT_SSL_VERIFYHOST = FALSE` | Desactiva la validación del certificado: habilita MITM contra la llamada que confirma el pago | Nunca. Validación estricta de TLS, y `rejectUnauthorized` explícito |
| Log a disco del payload completo                                    | Persiste datos personales en texto plano                                                      | Nunca. Log solo identificadores de correlación; PII ni a logs       |
| Llave secreta escrita en el código de ejemplo                       | Fuga por copiar-pegar                                                                         | Llave solo desde el almacén cifrado                                 |

### 5.4 Donde va cada dato del webhook

| Campo                                               | Clasificación                | Destino propuesto                                                                                                                         |
| --------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `transactionId`, `orderId`, `merchantReferenceCode` | No personal, identificadores | Columnas indexadas, en claro                                                                                                              |
| `amount`, `status`, `responseCode`, `createdAt`     | No personal                  | En claro; el estado real se sobrescribe con lo de la API                                                                                  |
| `cardHolderName`, `customerEmail`                   | **Personal**                 | No persistir en claro. Si se necesitan: cifrado con el mismo patrón de PII (ciphertext + índice + máscara). Decisión de negocio explícita |
| `lastFourDigits`, `bankName`, `cardNature`          | Personal-financiero          | Considerar no persistir; para comprobantes suelen bastar los últimos 4                                                                    |
| `sessionId`, `authCode`                             | No personal, sensibles       | No persistir salvo necesidad; nunca en logs                                                                                               |

Recomendación por defecto: **persistir solo identificadores y estado verificado**; el resto se descarta tras la
verificación. Menos datos guardados, menos superficie.

### 5.5 El importe se valida contra la orden, nunca contra el cliente

El webhook trae `amount`, pero ese valor no se usa para marcar el pago: se usa el de la orden, y el importe de la
API se compara contra él. Si no coinciden → estado `AMOUNT_MISMATCH`, no entrega. Es la defensa contra que un
cliente manipule el precio entre la creación de la orden y el cobro.

### 5.6 Idempotencia y máquina de estados

Estados propuestos para una orden:

```
PENDING ──(verificación OK, importe coincide)──> PAID
   │                                                   │
   ├──(API dice FAILURE/DECLINED)──> FAILED           └──(reembolso)──> REFUNDED
   ├──(verificación no posible)────> PENDING_VERIFICATION_RETRY
   └──(importe no coincide)────────> AMOUNT_MISMATCH   (terminal, requiere revisión)
```

- La transición a `PAID` solo ocurre desde la verificación.
- Reintentos con backoff acotado; tras N fallos, revisión manual y alerta.
- `PAID` es idempotente: reprocesar el mismo `transactionId` no vuelve a cobrar ni a entregar.
- La entrega de mercancía y la notificación al usuario ocurren **después** de `PAID`, nunca antes.

### 5.7 Almacenamiento de la llave privada (`sk_`)

Requisito del modelo: cifrada en reposo, en el schema del tenant, nunca devuelta al cliente, nunca en logs.

Punto de diseño: **usar una clave de cifrado propia para pagos**, distinta de `PII_ENCRYPTION_KEY`.
Este repo ya separa dominios con AAD (`pii:blind-index:v1`, `pii:ip:v1`), y la misma disciplina aplica aquí:
si una llave de pagos se compromete, el radio de impacto no debe incluir los datos PII de los tenants, ni al
contrario. Son credenciales de dos dominios distintos con importante rotación distinta.

Consecuencias a documentar: rotación de `NETPAY_ENCRYPTION_KEY` obliga a re-cifrar todas las llaves de tenant
(cifrado en cascada), igual que ya pasa con rotación de claves PII en este proyecto.

### 5.8 SSRF y destinos de red

Será la primera salida HTTP del proyecto. Controles mínimos:

- **Allowlist estricta**: solo `gateway-154.netpaydev.com` (Sandbox) y `suite.netpay.com.mx` (Live).
  El host viene de configuración por tenant, **no** de un campo libre de la base de datos.
- Redirecciones: o se deshabilitan, o se revalidan contra la allowlist en cada salto. Una allowlist sin
  control de redirecciones no es una allowlist.
- Prohibido seguir redirecciones hacia IPs privadas.
- Tiempo de espera y tamaño de respuesta acotados; sin streaming de la respuesta al cliente.
- Distinguir Sandbox de Live por configuración explícita, nunca por detección automática.

### 5.9 Exposición de información

- El webhook responde **202** a cualquier petición bien formada, tenga o no orden conocida. Distinguir “orden no
  encontrada” de “orden de otro tenant” en el cuerpo sería un oráculo de enumeración.
- `GET /payments/orders/:id` debe usar el mismo patrón de “no encontrado o no autorizado → 404” que ya usa el
  resto del codebase, para no confirmar la existencia de órdenes ajenas.

---

## 6. Modelo de datos propuesto

### 6.1 Dónde vive cada cosa

| Entidad                           | Plano      | Razón                                   |
| --------------------------------- | ---------- | --------------------------------------- |
| Configuración Netpay del tenant   | **Tenant** | Es dato del tenant. Aislado por schema. |
| Órdenes de pago                   | **Tenant** | Igual que `users` y `projects`.         |
| Eventos de webhook                | **Tenant** | Pertenecen a una orden del tenant.      |
| Tokens de cliente/tarjeta         | **Tenant** | Son del cliente final del tenant.       |
| Comisión de plataforma, si la hay | Control    | Es del operador, no del tenant          |

Poner la configuración en el plano de control y unir por `tenantId` sería más fácil de consultar, pero
rompería el aislamiento que el resto del sistema ya garantiza: una lectura equivocada expondría las llaves de
un tenant a otro.

### 6.2 Tablas (solo definición de campos; sin código)

**`payment_provider_config`** — una fila por tenant, en el schema del tenant.

| Campo                     | Tipo                | Nota                                                                    |
| ------------------------- | ------------------- | ----------------------------------------------------------------------- |
| `id`                      | uuid                | PK                                                                      |
| `tenantId`                | uuid                | Redundante dentro del propio schema; útil para auditoría y para el log  |
| `environment`             | `sandbox` \| `live` | Determina el host. No autodetectable                                    |
| `publicKey`               | texto               | `pk_netpay_…`. Es pública por diseño: viaja al navegador para tokenizar |
| `secretKeyCiphertext`     | texto               | **Cifrada**, con clave propia de pagos                                  |
| `orderReferencePrefix`    | texto               | Prefijo de `order_reference`, único por tenant                          |
| `webhookTokenHash`        | texto               | **Hash** del token opaco de la URL de webhook (nunca el token en claro) |
| `webhookRegisteredAt`     | timestamptz         | Cuándo se hizo el `PUT /v3/webhooks/`                                   |
| `enabled`                 | bool                | Apagado = el tenant no procesa pagos                                    |
| `createdAt` / `updatedAt` | timestamptz         |                                                                         |

`webhookTokenHash` y no el token en claro: si alguien lee la tabla no obtiene una credencial utilizable. El token
completo se muestra **una vez** al guardarlo, igual que ya hace el sistema con el secreto de las API keys
(`api-key.service.ts`).

**`payment_order`**

| Campo                     | Tipo                          | Nota                                                                           |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `id`                      | uuid                          | PK, interno                                                                    |
| `orderReference`          | texto, **único en el schema** | Es lo que reconcilia con Netpay. Unicidad es una garantía de integridad        |
| `netpayTransactionId`     | texto, indexado               | Clave de idempotencia                                                          |
| `merchantReferenceCode`   | texto                         | Código propio de la orden                                                      |
| `amount`                  | decimal(12,2)                 | **Fuente de verdad**. El del webhook nunca se usa para marcar pagado           |
| `currency`                | texto                         | `MXN`. No hardcodear en el cliente                                             |
| `status`                  | enum                          | La máquina de estados de §5.6                                                  |
| `checkoutUrl`             | texto, nullable               | Solo Checkout Hosted. **Considerar no persistir**: contiene la sesión de cobro |
| `customerId` (Netpay)     | texto, nullable               | Para clientes con token guardado                                               |
| `checkoutMode`            | `hosted` \| `custom`          | Permite convivir ambos modos por tenant                                        |
| `lastVerifiedAt`          | timestamptz, nullable         | Trazabilidad de la verificación                                                |
| `verifiedAmount`          | decimal(12,2), nullable       | Lo que devolvió la API, para comparar con `amount`                             |
| `failureReason`           | texto, nullable               | Sin datos personales                                                           |
| `createdAt` / `updatedAt` | timestamptz                   |                                                                                |

**`payment_webhook_event`** — bitácora cruda para auditoría y depuración.

| Campo                 | Tipo                  | Nota                                         |
| --------------------- | --------------------- | -------------------------------------------- |
| `id`                  | uuid                  | PK                                           |
| `eventId`             | texto, **único**      | Clave de deduplicación de entregas repetidas |
| `eventType`           | texto                 | `cep.created`, `sessionLink.paid`, …         |
| `netpayTransactionId` | texto, indexado       | Para localizar la orden                      |
| `receivedAt`          | timestamptz           |                                              |
| `processedAt`         | timestamptz, nullable |                                              |
| `outcome`             | texto, nullable       | Resultado de la verificación                 |
| `payloadSanitized`    | jsonb, nullable       | **Solo campos no personales**, por auditoría |

Restricción: **una fila por evento recibido**, incluso si está duplicado o fallido. Es la evidencia para
soportar una disputa.

**`payment_customer`** (solo si se guarda tarjeta)

| Campo                                        | Nota                                          |
| -------------------------------------------- | --------------------------------------------- |
| `netpayCustomerId`                           | Identificador del perfil de cliente en Netpay |
| `defaultTokenId`                             | Token de un solo uso por defecto              |
| `tokens`                                     | Relación 1–3 tokens (límite de Netpay)        |
| `lastFourDigits` / `cardNature` / `bankName` | Solo si hay requerimiento de comprobante      |

**Nunca** se almacena PAN ni CVV: Netpay tokeniza en el navegador (NetpayJS) y solo entrega un token. El CVV de
una tarjeta guardada pasa por el backend hacia Netpay (lo exige su API), pero no se guarda, no se loguea y no se
devuelve (§17).
Guardar el token es correcto; guardar datos de tarjeta es un incidente PCI.

---

## 7. Flujos

### 7.1 Endpoints usados (verificados contra el sandbox)

| Endpoint                                                                                                        | Uso                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v3.2/checkout/session/`                                                                                  | **Hosted.** Devuelve `hostedCheckoutUrl` y `sessionId`. Sin `billing`, Netpay pide los datos del comprador en su página.                                   |
| `POST /v3/token/amount`                                                                                         | **Plus.** Tokeniza el importe en el servidor; el botón de Netpay cobra ese token.                                                                          |
| `POST /v4/clients`                                                                                              | Crea el perfil del comprador, con o sin tarjeta.                                                                                                           |
| `POST /v3.5/charges/`                                                                                           | **Custom.** Cobro con token; exige `source`, datos de dispositivo y `User-Agent`. Una declinada responde **409** con la transacción en `status: "failed"`. |
| `POST /v3.5/charges/{id}/confirm?processorTransactionId=`                                                       | Confirmación tras 3DS (`null` en frictionless).                                                                                                            |
| `GET /v3/transactions/{id}`                                                                                     | Verificación autoritativa del estado.                                                                                                                      |
| `GET/PUT/DELETE /v3/clients/{id}[/token[/{card}]]`                                                              | Tarjetas guardadas.                                                                                                                                        |
| `GET/PUT /v3/webhooks/`                                                                                         | URL de webhook por juego de llaves.                                                                                                                        |
| `GET /v3/get/{id}/transactionId` + `PUT /v2/transactions/{id}/refund` (servicio de reportes, `X-Netpay-Apikey`) | Reembolso.                                                                                                                                                 |

`POST /checkout`, que aparece en el diagrama de Hosted, **no existe** (`"No message available"`).

### 7.2 Flujos

**Hosted.** El servidor crea la orden `PENDING` (el importe de la orden es la fuente de verdad), abre la sesión
con `merchantRefCode` = referencia única de la orden y guarda `sessionId`. El comprador paga en la página de
Netpay. La redirección a `successUrl` no confirma nada: la orden cambia solo cuando llega el webhook
`sessionLink.*` y `GET /v3/transactions/{id}` confirma estado e importe.

**Custom.**

1. El navegador tokeniza la tarjeta con NetpayJS y genera `deviceFingerPrint` y `deviceInformation`.
2. El servidor crea un perfil con esa tarjeta (Netpay no cobra un token sin cliente), cobra, y si el comprador
   no pidió guardarla, borra la tarjeta del perfil.
3. Respuesta de Netpay:
   - `success` → se verifica la transacción y la orden pasa a `PAID`.
   - Declinada (409) → orden `FAILED` con el motivo de Netpay (`declineReason`).
   - `review` con `threeDSecureResponse` → 3DS 2.0. Frictionless (`responseCode` 100, sin `acsUrl`): el
     navegador confirma con `processorTransactionId: null`. Challenge (`475`, con `acsUrl`): el navegador lleva al
     comprador al banco con `netpay3ds.proceed` y confirma con el id que devuelve.
4. Tras la confirmación se verifica la transacción: `DONE` → `PAID`, `FAILED` → `FAILED`.

**Plus.** Igual que Hosted, pero el importe se tokeniza en el servidor y el navegador muestra el botón.

En los tres casos el webhook solo despierta la verificación; nunca es prueba de pago (§5).

### 7.3 Reembolso / cancelación

Requiere `transactionId` y llamar al endpoint de cancelación con la llave del tenant. Reglas:

- Un reembolso es un evento nuevo con su propia referencia, no una edición del estado original.
- Idempotente por `transactionId` + referencia del reembolso: nunca reembolsar dos veces.
- Solo desde `PAID`. Un reembolso de un pago no verificado es imposible por construcción.
- Autorización: permiso dedicado, no reutilizar el de lectura (§8).

---

## 8. RBAC — encaje con el sistema que ya existe

Los pagos **(expuestos en el catálogo de permisos)** encajan directamente con
`PERMISSION_CATALOG` de `src/auth/permission-catalog.ts`:

| Módulo     | Permisos             | Quién debería llevarlos por defecto                               |
| ---------- | -------------------- | ----------------------------------------------------------------- |
| `payments` | `payments:read`      | `platform-auditor`, `tenant-admin`, `tenant-owner`                |
|            | `payments:write`     | `platform-owner`, `tenant-admin`, `tenant-owner`                  |
|            | `payments:refund`    | `platform-owner`, `tenant-admin`                                  |
|            | `payments:configure` | `platform-owner` (y `tenant-owner` si el tenant gestiona lo suyo) |

Y los roles de sistema quedan así:

| Rol                | Módulos                                                         |
| ------------------ | --------------------------------------------------------------- |
| `platform-owner`   | `tenants`, `api-keys`, `users`, `projects`, `audit`, `payments` |
| `platform-admin`   | ídem (el permiso de pago es lo que discrimina, no el rol)       |
| `platform-auditor` | solo `*:read`, incluido `payments:read`                         |
| `tenant-owner`     | `api-keys`, `users`, `projects`, `payments`                     |
| `tenant-admin`     | `api-keys`, `users`, `projects`, `payments`                     |
| `tenant-member`    | `projects`                                                      |
| `tenant-viewer`    | solo lectura                                                    |

**Punto importante:** `payments:configure` gestiona la llave privada del tenant. Debe quedar **solo** en
`platform-owner` por defecto. Es la operación más sensible del módulo: quien puede escribir `secretKeyCiphertext`
puede cobrar, reembolsar y mover fondos de ese tenant.

Sobre el decorator: usar `@RequirePermissions('payments:write')` y nada más. **No** introducir un
`@MinimumTenantRole` nuevo para pagos. Ese control responde a "¿qué plan de rol tiene este tenant?", mientras
que el permiso responde a "¿qué autoridad tiene esta persona?", y mantener los dos como decisión independiente
es justamente la clase de problema que ya corregimos a mano en `api-keys`: allí un mínimo a nivel de clase
llegaba a bloquear rutas de solo lectura que el permiso sí autorizaba. Que un solo control decida evita
que las dos fuentes de verdad diverjan.

---

## 9. Encaje con las rutas y los guards existentes

Puntos de inserción, todos ya existentes:

| Punto                                     | Qué implica                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tenant-api/tenant-api.controller.ts` | Los endpoints de pago del tenant van aquí, junto a `t/users` y `t/projects`, con `@Controller('t/payments')` + `@UseGuards(TenantGuard)` |
| **`src/common/rbac-audit.service.ts`**    | Toda ruta nueva **debe** declarar política o la app **no arranca**. El webhook iría con `@Public()`, que ya cuenta como declaración      |
| `src/auth/permissions.guard.ts`           | Aplica los permisos sin cambios: ya resuelve la unión de roles del tenant                                                                |
| `src/tenancy/tenant-resolver.service.ts`  | El token del webhook **no** debe resolverse por `X-Tenant-Id` (§5.2)                                                                     |
| `src/common/errors/app.exception.ts`      | Nuevo tipo de error de pagos, o reutilizar `DomainException` para estado inválido                                                        |
| `src/audit/audit-log.service.ts`          | Los cambios de estado de un pago deben auditarse: quién pidió, contra qué orden, con qué resultado                                       |
| `src/main.ts:86`                          | El listener es `0.0.0.0`. El webhook **debe** quedar accesible desde internet, lo que interactúa con el requisito de SSL de Netpay       |

Sobre el último punto: la doc exige **certificado SSL válido, vigencia mínima de un año, cargado manualmente**.
Hoy la app sirve HTTP plano. Esto implica que **el webhook necesita terminar TLS en un reverse proxy o
ingress**, no en Nest. Queda como requisito de despliegue, y conviene dejarlo escrito en `docs/SECURITY.md`
cuando se implemente.

---

## 10. Notificaciones salientes (avisar a otras plataformas)

Hasta aquí el webhook era **entrante**: Netpay nos avisa. Falta el otro sentido, y es el que permite que
otras plataformas reaccionen cuando algo termina: **notificar que un pago se cobró, se rechazó o se
devolvió**, aunque no estén escritas en este sistema.

Es una capacidad transversal, no específica de Netpay: el mismo mecanismo debería servir más adelante para
`order.completed` o `subscription.renewed`. Se define aquí sobre pagos porque es el primer consumidor real.

### 10.1 Semántica de entrega: al menos una vez, con firma

| Promesa                  | Detalle                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| **Al menos una vez**     | Se reintenta hasta agotar los intentos. **Nunca** "exactamente una vez": no es alcanzable      |
| **Orden no garantizado** | Entregas simultáneas pueden llegar desordenadas. Por eso va un número de secuencia por recurso |
| **El receptor decide**   | Confirmar con `2xx` significa “recibido”. Cualquier otro código dispara reintento              |
| **Sin bloqueo**          | La entrega es asíncrona. Un receptor lento nunca debe retener un cobro ni un worker            |

En el encabezado de cada entrega viaja `X-MTBPay-Event-Id`, **estable entre reintentos**, para que el receptor
deduplique. Y `X-MTBPay-Attempt`, que incrementa, para diagnóstico.

> Consecuencia de “al menos una vez”: el receptor **debe** ser idempotente. Eso se documenta como
> responsabilidad de quien integra, y es la primera pregunta que debe responder cualquier integrador.

### 10.2 Qué eventos se emiten

| Evento             | Se emite cuando                                          | Estado previo verificado |
| ------------------ | -------------------------------------------------------- | ------------------------ |
| `payment.paid`     | La API de Netpay confirma el cobro y el importe coincide | Sí, siempre              |
| `payment.failed`   | La verificación devuelve un estado de rechazo            | Sí                       |
| `payment.mismatch` | El importe de Netpay no coincide con el de la orden      | Sí                       |
| `payment.refunded` | Se completa un reembolso                                 | Sí                       |

**Regla que no se negocia:** los eventos se emiten **solo desde estado verificado**, nunca desde el payload
del webhook entrante (§5.2). Una plataforma externa no debe enterarse de un pago hasta que la API de Netpay lo haya
confirmado. Publicar “cobrado” a partir de una notificación sin firmar sería propagar exactamente el defecto
que §5.2 evita.

Cada carga útil incluye `eventId`, `eventType`, `occurredAt`, `sequence`, `tenantId` y `data` con el
identificador de la orden. **Sin datos de tarjeta, nunca.**

### 10.3 Firma de la entrega

El receptor tiene que poder autenticarnos. Sin firma, un atacante que descubra la URL puede inyectar
`payment.paid` en el sistema del integrador.

Encabezados de la entrega:

| Encabezado            | Contenido                           |
| --------------------- | ----------------------------------- |
| `X-MTBPay-Signature`  | `t=<unix>,v1=<hex>`                 |
| `X-MTBPay-Event-Id`   | Identificador estable del evento    |
| `X-MTBPay-Event-Type` | Tipo, p. ej. `payment.paid`         |
| `X-MTBPay-Attempt`    | Número de intento, desde 1          |
| `X-MTBPay-Delivery`   | `v1` (versión del esquema de firma) |

La firma es `HMAC-SHA256(secret, "<t>.<cuerpo crudo exacto>")` en hexadecimal.

**Procedimiento exacto para el receptor**, que debe ir en su documentación:

1. Leer el cuerpo **crudo**, antes de cualquier parseo JSON. Si se serializa de nuevo, la firma no cuadra.
2. Separar `t` y `v1` del encabezado `X-MTBPay-Signature`.
3. Rechazar si `|ahora − t| > 300` segundos (tolerancia de reloj). Esto corta la repetición de una entrega
   capturada.
4. Recalcular `HMAC-SHA256(secret, t + "." + cuerpo)` y comparar en **tiempo constante**.
5. Solo entonces parsear y procesar.
6. Deduplicar por `X-MTBPay-Event-Id`.

El secreto se entrega **una sola vez** al crearse el endpoint, igual que ya hace el sistema con el secreto de
las API keys. Se guarda **cifrado**, nunca en claro ni hasheado — a diferencia del token del webhook
entrante (§5.2), aquí sí necesitamos el valor para firmar.

### 10.4 SSRF — el riesgo dominante de esta sección

La URL del receptor la configura un tenant. Eso convierte cada entrega en un intento de acceso a la red
interna desde nuestros servers. Es el vector de exfiltración más obvia del diseño, y hay que tratarlo como
tal, no como una validación de formato.

Controles, todos obligatorios:

| Control                                | Detalle                                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTPS obligatorio**                  | Por defecto. Sin excepciones en producción                                                                                                                                          |
| **Resolver y validar la IP**           | Resolver DNS y rechazar el destino si la IP cae en rangos no globales                                                                                                               |
| **Fijar la conexión a la IP validada** | Si se valida la IP pero luego se conecta por nombre, hay una ventana de DNS rebinding. Se conecta a la IP ya validada                                                               |
| **Rangos bloqueados**                  | Loopback, privada RFC1918, link-local, CGNAT, multicast, reservada, `0.0.0.0/8`. **Y `169.254.169.254`**, que es el endpoint de metadatos de la nube: el objetivo típico de un SSRF |
| **IPv6 y IPv4 mapeado**                | `::1`, `fc00::/7`, y sobre todo `::ffff:127.0.0.1`, que evade validaciones que solo miran IPv4                                                                                      |
| **Revalidar en cada intento**          | La validación no se cachea entre reintentos: un dominio puede resolver distinto después                                                                                             |
| **Sin redirecciones**                  | O máximo 2, revalidando destino, método y cuerpo en cada salto                                                                                                                      |
| **Allowlist opcional de egreso**       | Variables de configuración para despliegues restrictivos: permitir solo ciertos destinos                                                                                            |
| **Límite de respuesta**                | No leer más de N bytes y jamás relayar la respuesta al tenant                                                                                                                       |

Una validación que solo compruebe el prefijo textual de la URL (`https://`) no sirve de nada: es exactamente
lo que se salta con un nombre que resuelve a `127.0.0.1`.

### 10.5 Secretos del suscriptor

- Se generan al crear el endpoint, se muestran **una vez** y se guardan cifrados con la clave de pagos (§5.7),
  nunca hasheados.
- **Rotación con solapamiento:** durante una ventana ambos secretos son válidos, para que el receptor pueda
  cambiar sin cortes. Tras la ventana, el antiguo queda inválido.
- El secreto **nunca** aparece en una respuesta de la API salvo en el momento de la creación, ni en logs, ni
  en eventos emitidos.

### 10.6 Modelo de datos (añadido al de §6, también en el schema del tenant)

**`webhook_endpoint`**

| Campo                           | Nota                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `id`                            | PK                                                     |
| `url`                           | Destino. Se valida en cada entrega, no solo al guardar |
| `description`                   | Para que el operador lo identifique                    |
| `secretCiphertext`              | Cifrado. Se muestra una vez                            |
| `previousSecretCiphertext`      | Para la rotación con solapamiento                      |
| `events`                        | Lista de tipos a los que se suscribe                   |
| `enabled`                       | bool                                                   |
| `consecutiveFailures`           | Alimenta el marcado automático como inviable           |
| `disabledAt` / `disabledReason` | Para que "dejó de funcionar" sea explicable            |
| `createdAt` / `updatedAt`       |                                                        |

**`webhook_delivery`**

| Campo                       | Nota                                               |
| --------------------------- | -------------------------------------------------- |
| `id`                        | PK                                                 |
| `endpointId`                | FK                                                 |
| `eventId`                   | **Estable entre reintentos**                       |
| `eventType`                 |                                                    |
| `sequence`                  | Secuencia del recurso, para detectar huecos        |
| `attempt`                   | 1, 2, 3…                                           |
| `status`                    | `pending`, `delivered`, `failed`, `dead`           |
| `responseStatus`            | Código HTTP recibido                               |
| `error`                     | Motivo, **sin** cuerpo de respuesta del suscriptor |
| `durationMs`                |                                                    |
| `nextAttemptAt`             | Para la cola                                       |
| `createdAt` / `deliveredAt` |                                                    |

Es la evidencia para una disputa ("¿me llegó el evento o no?") y para no reenviar a ciegas.

### 10.7 RBAC

Se extiende `PERMISSION_CATALOG` con un módulo propio:

| Módulo     | Permisos                 | Quién por defecto                  |
| ---------- | ------------------------ | ---------------------------------- |
| `webhooks` | `webhooks:read`          | `platform-auditor`, `tenant-owner` |
|            | `webhooks:write`         | `platform-owner`, `tenant-owner`   |
|            | `webhooks:rotate-secret` | `platform-owner`, `tenant-owner`   |
|            | `webhooks:replay`        | `platform-owner`                   |

**`webhooks:write` deliberadamente no incluye a `tenant-admin`.** Escribir un endpoint de salida es abrir un
canal de exfiltración de datos del tenant hacia un tercero, además de una superficie SSRF. Esa decisión le
corresponde a quien controla el tenant, no a un administrador operativo. Conviene dejarlo explícito en el
catálogo, porque es la clase de privilegio que se reparte sin querer.

### 10.8 Configuración

| Variable                                     | Para qué                                       |
| -------------------------------------------- | ---------------------------------------------- |
| `OUTBOUND_WEBHOOKS_ENABLED`                  | Interruptor global                             |
| `OUTBOUND_WEBHOOK_REQUIRE_HTTPS`             | Por defecto `true`                             |
| `OUTBOUND_WEBHOOK_TIMEOUT_MS`                | Límite por entrega                             |
| `OUTBOUND_WEBHOOK_MAX_ATTEMPTS`              | Intentos antes de `dead`                       |
| `OUTBOUND_WEBHOOK_BACKOFF_MS` / `_JITTER_MS` | Política de reintento                          |
| `OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES`        | Tope de lectura de respuesta                   |
| `OUTBOUND_WEBHOOK_ALLOWED_CIDRS`             | Allowlist de egreso, opcional pero recomendada |
| `OUTBOUND_WEBHOOK_SIGNATURE_TOLERANCE_MS`    | Ventana de reloj, por defecto 300 000          |

### 10.9 Operación

| Situación                                                | Comportamiento                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Suscriptor que falla N veces seguidas                    | Se marca `disabled` con motivo, se notifica al operador. **Nunca** se borra en silencio |
| Evento muerto (`dead`)                                   | Se conserva el registro. No se descarta en silencio                                     |
| Reenvío manual                                           | `webhooks:replay`, con auditoría de quién y qué                                         |
| Suscriptor que se subscribe a un evento que ya no existe | Rechazo explícito, no silencio                                                          |
| Volumen                                                  | Cola con tope y alerta al saturarse. Un pico de eventos no debe degradar el cobro       |

### 10.10 Pruebas

Se suman a la matriz de §13, sin red, con el transporte inyectado:

| Caso                                                                          | Expectativa                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Firma válida, dentro de la ventana                                            | El receptor acepta                                             |
| Firma alterada                                                                | Rechazo                                                        |
| Timestamp fuera de la ventana                                                 | Rechazo, aunque la firma sea correcta                          |
| Cuerpo re-serializado antes de verificar                                      | La firma **no** cuadra: documenta por qué se verifica el crudo |
| Mismo `eventId` reintentado                                                   | Deduplicación en el receptor                                   |
| Destino `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `::1`, `::ffff:127.0.0.1` | Rechazo **antes** de abrir conexión                            |
| Dominio que resuelve a privada y luego a pública                              | Rechazo: la validación es por intento                          |
| Redirección 302 a privada                                                     | Rechazo en el salto                                            |
| HTTP sin TLS                                                                  | Rechazo cuando `REQUIRE_HTTPS` está activo                     |
| Receptor que devuelve 500 tres veces                                          | `dead`, reintentos con backoff, registro conservado            |
| Receptor que tarda más que el timeout                                         | Se corta; no bloquea al worker                                 |

Las cinco primeras filas son **la prueba de que la firma sirve de algo**; conviene escribirlas primero.

---

## 11. Configuración

**Plataforma (env, `.env.example`):**

| Variable                                    | Para qué                                                         |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `NETPAY_PLATFORM_ENCRYPTION_KEY`            | Cifra las `sk_` por tenant. **Clave propia, separada de PII**    |
| `NETPAY_ALLOWED_HOSTS`                      | Allowlist de destinos: solo los dos hosts documentados           |
| `NETPAY_TIMEOUT_MS`                         | Límite de tiempo por llamada                                     |
| `NETPAY_MAX_ATTEMPTS` / `NETPAY_BACKOFF_MS` | Política de reintentos de verificación                           |
| `PAYMENTS_ENABLED`                          | Interruptor global, para apagar el módulo entero sin despliegues |

**Por tenant (base de datos, cifrada):** ambiente, `pk_`, `sk_` cifrada, prefijo de `order_reference`, token de
webhook (hash).

**Nunca en el mismo sitio:** `pk_` es pública y viaja al navegador; `sk_` es secreta y solo existe en servidor.

---

## 12. Pruebas — el punto más delicado

El proyecto se verification **sin red** (el `README` y el CI lo asumen). Una integración de pagos rompe esa
premisa. Decisión necesaria:

| Opción                                                    | Qué cubre                                                                                                     | Costo                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **A. Solo unitario con fixtures** (recomendado como base) | Máquina de estados, idempotencia, comparación de importes, validación de referencia, sanitización del payload | No prueba la integración real                                        |
| **B. Cliente HTTP inyectado + fixtures**                  | Igual que A, y cubre **todo el código de integración** sin red: serialización, allowlist, timeouts, errores   | Hay que diseñar el cliente para inyectar el transporte               |
| **C. E2E contra Sandbox, fuera del CI**                   | El flujo real extremo a extremo                                                                               | Requiere red y llaves de Sandbox; **no** debe correr en el CI normal |

Recomendación: **B en el CI, C como script manual opcional**. La opción B es la que de verdad da confianza sin
convertir el CI en dependiente de un tercero. Implica que `NetpayHttpClient` reciba su transporte por
inyección (igual que los specs existentes inyectan collaborators).

Matriz mínima de pruebas, sin código:

| Caso                                               | Expectativa                                      |
| -------------------------------------------------- | ------------------------------------------------ |
| Webhook con orden desconocida                      | 202, evento registrado, sin cambios de estado    |
| Webhook repetido (mismo `eventId`)                 | Un solo registro, un solo trabajo                |
| Webhook con `transactionId` de otro tenant         | 202, no toca ninguna orden                       |
| Verificación devuelve `PAID` con importe distinto  | `AMOUNT_MISMATCH`, nunca `PAID`                  |
| Verificación devuelve `PAID` con importe igual     | `PAID`, entrega una sola vez                     |
| Verificación falla                                 | Reintento acotado, luego alerta, nunca `PAID`    |
| Respuesta de Netpay con host fuera de la allowlist | Rechazo antes de la conexión                     |
| Redirección hacia host no permitido                | Rechazo en el salto                              |
| TLS inválido                                       | Fallo, sin degradar a “aceptar el certificado”   |
| `secretKeyCiphertext` intenta salir por la API     | Nunca; prueba explícita de que no está en el DTO |

Y un caso de **seguridad que conviene añadir al modelo existente**: ninguna ruta de pagos puede devolver
`secretKeyCiphertext`. Es el mismo tipo de invariante que ya cubre `assertGrantableScopes` para las API keys.

---

## 13. Decisiones abiertas — necesito tus respuestas antes de implementar

1. **¿Un comercio en Netpay por tenant, o una cuenta con `order_reference` por tenant?**
   Recomendación fuerte: una cuenta por tenant (§4-B). Pero implica el proceso manual de alta y el certificado.
   Si el negocio es un solo comercio que revende a varias marcas, la opción A es más simple — pero entonces
   “cada tenant aísla su configuración” significa otra cosa y hay que redefinirlo.

2. **¿Guardar tarjetas (`saveCard`) entra en esta fase?**
   Recomiendo **no**. Añade tabla de clientes, tokens, y superficie PCI. Se puede sumar después sin rediseñar.

3. **¿Se guardan datos personales del tarjetero (`cardHolderName`, `customerEmail`)?**
   Recomendación: no, salvo requerimiento explícito de comprobante. Si sí, pasan por el patrón de PII del
   proyecto (cifrado + índice + máscara).

4. **¿La plataforma cobra comisión sobre cada venta?**
   Si sí, hay que decidir dónde se calcula: es dinero que sale de la cuenta Netpay **del tenant**, así que
   implica un segundo cobro o un acuerdo de liquidación distinto. No es un detalle de configuración.

5. **¿Dónde termina el TLS del webhook?**
   Hoy no hay TLS en la app. Hace falta un proxy/ingress, y hay que documentarlo.

6. **¿Se guardan las llaves de Sandbox en el entorno de desarrollo?**
   Recomendación: no en `.env`. Sandbox también se configura por tenant, cifrado, igual que producción. Evita
   que un entorno de desarrollo se convierta en una vía a una cuenta real.

---

## 14. Riesgos principales

| Riesgo                                | Impacto                                | Mitigación                                               |
| ------------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| **Confiar en el payload del webhook** | Entrega sin cobro. Pérdida directa     | Verificar siempre contra la API (§5.2)                   |
| **`sk_` en claro o filtrada**         | Movimientos de dinero no autorizados   | Cifrado con clave propia, nunca en logs ni en respuestas |
| Reutilización de la llave pegada aquí | Compromiso de la cuenta                | Rotar ya (§1)                                            |
| SSRF en el cliente HTTP               | Acceso a la red interna                | Allowlist estricta + control de redirecciones (§5.8)     |
| Amount manipulation                   | Cobro de menos o entrega de más        | Fuente de verdad en la orden + comparación (§5.5)        |
| Webhook duplicado o desordenado       | Entrega doble, cobros dobles           | Idempotencia por `eventId` y `transactionId` (§5.6)      |
| Sin TLS en el listener                | Webhook no registrable; datos en claro | Proxy con SSL (§9)                                       |
| PII del webhook a disco               | Incidente de privacidad                | No persistir ni loguear PII (§5.4)                       |
| Onboarding manual por tenant          | Fricción operativa alta y silenciosa   | Checklist documentado + verificación automática de alta  |

---

## 15. Fases sugeridas

1. **Decisiones** (§13) y modelo de datos aprobado. Nada de código antes.
2. **Infraestructura:** migraciones (`0004` de tenant), módulo de permisos `payments`, roles del sistema,
   cifrado de la llave de pagos.
3. **Núcleo sin red:** `NetpayHttpClient` con transporte inyectado, estado de órdenes, idempotencia,
   comparación de importes. Todo cubierto por unit tests.
4. **Checkout Hosted:** creación de orden, redirección, webhook con token opaco y verificación asíncrona.
5. **Permisos y rutas**, con la auditoría RBAC verificando que cada ruta declara su política.
6. **Script manual de E2E contra Sandbox**, fuera del CI.
7. **Auditoría y docs:** eventos de estado en `AuditLogService`, y `docs/SECURITY.md` con el requisito de TLS
   y el alcance de PCI real.
8. **Checkout Custom**, solo si aparece el requerimiento (§3).

---

## 16. Nota final

Este análisis se apoya en la documentación pública de Netpay v1.2.1
(`docs.netpay.com.mx/v1.2.1`) leída hoy, y en el código de este repositorio en `bf32371`.

Dos advertencias sobre la fuente:

- **La documentación de Netpay no es una referencia de seguridad.** Su propio ejemplo desactiva la
  verificación de TLS y escribe el payload completo a disco. La referencia útil es la **API**, no el ejemplo.
- **El webhook sin firma está documentado como tal**, pero antes de construir sobre eso conviene confirmarlo
  directamente con Netpay Support: si existe un mecanismo de firma o un secreto de webhook adicional que no
  aparece en la documentación pública, cambia la parte más importante de este diseño (§5).

Ningún código fue escrito ni ejecutado como parte de este análisis, y ninguna llave real se incluye en este
archivo.

---

## 17. Revisión contra la documentación v1.2.1

Cambios hechos tras cotejar la implementación con las páginas de Checkout Custom y Hosted:

| Tema                        | Comportamiento                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cvv`                       | Obligatorio en cada cobro con tarjeta guardada (`clientId`), con `saveCard: false`. Se reenvía a Netpay y no se guarda, loguea ni devuelve. Con token de un solo uso se rechaza.                                    |
| Datos de 3DS 2.0            | `deviceFingerPrint` y `deviceInformation` (los 8 campos) son obligatorios; ya no hay valores de relleno.                                                                                                            |
| `referenceID`, `User-Agent` | Se aceptan los del navegador (`referenceId` de `netpay3ds.config()`, `navigator.userAgent`); si no llegan, se usan la referencia de la orden y un valor fijo.                                                       |
| Confirmación 3DS            | `processorTransactionId: null` cuando `canProceed` dice que no hay desafío; se envía como `null`. Verificado en sandbox: la transacción pasa a `DONE`.                                                              |
| Tarjeta de un solo uso      | El perfil que se crea para poder cobrar se limpia con `DELETE /v3/clients/{id}/token/{card}` justo después del cobro si `saveCard` no se pidió, también con 3DS: el sandbox confirma la transacción sin la tarjeta. |
| Tarjetas guardadas          | `GET /t/payments/cards/:clientId`, `PUT …/token` (máx. 3), `DELETE …/token/:token`.                                                                                                                                 |
| Webhook                     | `GET /t/payments/config/webhook` lee la URL registrada.                                                                                                                                                             |
| MSI                         | 18 meses solo Visa/Mastercard cuando se informa `cardBrand`.                                                                                                                                                        |

No implementado, por necesitar decisión de producto o de modelo de datos: PreAuth/PostAuth/ReAuth (Check-in/out) y reembolso parcial (requiere registrar el monto devuelto por orden).

---

## 18. Certificación Netpay

Fuente: "Requisitos para una certificación exitosa" y "Matriz de certificación Netpay" (v1.2.1).

**Reglas de formulario (aplican a Custom, Hosted y Plus)**

| Regla                                                                       | Dónde se cumple                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Campos obligatorios vacíos no envían nada a Netpay                          | Consola de pruebas (`ui/src/pages/index.astro`) y DTOs del backend. Un storefront propio debe replicarlo en su front.                                                              |
| Numéricos (teléfono, código postal, monto) solo `[0-9]`                     | DTOs (`NETPAY_DIGITS_PATTERN`) y máscara en la consola                                                                                                                             |
| Texto sin `! # $ % & * < > ? /` ni caracteres de control                    | Se **filtran** (no se rechazan) en lo que se envía a Netpay con `netpayText()`: nombres, dirección, descripción, identificadores. Netpay acepta `#` y `S/N` en direcciones reales. |
| `country` y `state` en ISO 3166 solo el segmento (`MX`, `NLE`, no `MX-NLE`) | DTOs (`NETPAY_COUNTRY_PATTERN`, `NETPAY_STATE_PATTERN`)                                                                                                                            |

**Matriz de tarjetas.** El correo de `billing` elige el escenario: `accept@netpay.com.mx` aprueba, `review@netpay.com.mx` activa 3DS 2.0 y `reject@netpay.com.mx` declina. Fecha de expiración futura; CVV de 3 dígitos (4 en Amex).
`test/netpay-sandbox.e2e-spec.ts` (bloque `certification matrix`) recorre aceptadas, MSI, declinadas y Frictionless. Se corre con llaves sandbox:

    NETPAY_PK=pk_netpay_... NETPAY_SK=sk_netpay_... npm run test:e2e -- test/netpay-sandbox.e2e-spec.ts

Las filas **Step-Up (Challenge)** exigen completar la página del emisor en un navegador y se hacen a mano desde la consola (tarjetas `4000000000002503`, `5200000000002151`, `340000000002534` para éxito; `4000000000002370`, `5200000000002490`, `340000000002237` para fallo).

Después de pasar todo, el último paso es agendar la llamada de certificación con Netpay.

**Comportamiento observado en sandbox (2026-10-14), matriz automática 16/16:**

- Declinada: `POST /v3.5/charges/` responde **409** con `transactionTokenId`, `status: "failed"` y `error` (p. ej. "Rejected by Decision Manager"). Se registra como orden `FAILED` y se devuelve `declineReason`; ya no es un 502.
- 3DS: la respuesta trae `status: "review"` y `threeDSecureResponse`. Frictionless llega con `responseCode: 100` y `acsUrl: null`; la orden se confirma con `processorTransactionId: null` y Netpay la deja en `DONE`. Challenge llega con `responseCode: 475` y `acsUrl`.
- Frictionless fallido: `review` y luego la transacción queda `FAILED` (orden `FAILED`).

---

## 19. Uso como servicio de pagos de otras plataformas (2026-10-14)

Este servicio es el **único** lugar que habla con Netpay para las plataformas que lo consumen
(la primera es `netpay-plane`, ADR-020 de ese repo). Cada plataforma tiene un tenant homólogo aquí,
con su propia cuenta de Netpay, su propio webhook y su propio historial.

**Aprovisionamiento** (lo hace la plataforma con un administrador de plataforma, una vez por tenant):

1. `POST /tenants` crea el tenant homólogo (`pl-<slug>`).
2. `POST /api-keys` (con `X-Tenant-Id`) emite la API key de runtime con los scopes
   `payments:read`, `payments:write` y `payments:refund`. `payments:configure` no es otorgable a una key:
   las llaves de Netpay las fija el operador.
3. `POST /t/payments/config` guarda `pk_`/`sk_` (la `sk_` cifrada; nunca vuelve a salir) y devuelve el
   token del webhook de Netpay **una vez**; `POST /t/payments/config/webhook-register` lo registra en Netpay.
4. `POST /t/webhooks` suscribe a la plataforma a `payment.paid|failed|mismatch|refunded`; el secreto de firma
   se muestra una vez. La URL pasa por la protección SSRF: HTTPS, un solo registro DNS y nunca una
   dirección privada (un host detrás de un CDN con varias IPs se rechaza con `AMBIGUOUS_ADDRESS`).

**Runtime** (API key + `X-Tenant-Id`):

| Operación                                        | Ruta                                                       | Scope             |
| ------------------------------------------------ | ---------------------------------------------------------- | ----------------- |
| Leer configuración (llave pública, ambiente)     | `GET /t/payments/config`                                   | `payments:read`   |
| Crear orden: link de pago, tarjeta propia u OXXO | `POST /t/payments/orders`                                  | `payments:write`  |
| Leer una orden                                   | `GET /t/payments/orders/:id`                               | `payments:read`   |
| Cobrar con token de NetpayJS / confirmar 3DS     | `POST /t/payments/orders/:id/charge` · `/confirm`          | `payments:write`  |
| Verificar contra Netpay y asentar                | `POST /t/payments/orders/:id/verify`                       | `payments:write`  |
| Reembolsar, total o parcial                      | `POST /t/payments/orders/:id/refund` `{ motive, amount? }` | `payments:refund` |

- `checkoutMode`: `hosted` (con `paymentMethods: ["card","cep"]`), `custom` (tarjeta propia) u `oxxo`
  (referencia OXXO Pay; requiere `buyer` y acepta `expirationDays`).
- Una orden `oxxo` crea la referencia de inmediato; en `hosted` con `cep`, la referencia la elige el comprador en
  la página de Netpay y Netpay la anuncia (`oxxopay.new` / `cep.created`), con lo que se liga a la orden.
- Los reembolsos pueden ser parciales: la orden sigue `PAID` con `refundedAmount` creciente y pasa a
  `REFUNDED` solo al llegar al total. `payment.refunded` se emite en cada reembolso.
- Los eventos salientes llevan `paymentMethod`, `paymentReference`, `netpayTransactionId`, `refundedAmount` y
  `failureReason`; nunca datos del titular. Quien los recibe debe **conciliar** (`GET /orders/:id`) en vez de
  asentar por el contenido, y puede hacerlo también sin evento si el aviso no llega.
- Todo texto que viaja a Netpay se manda **sin acentos** (OXXO Pay responde 400 «Name is invalid» a «Díaz»), y los
  4xx de Netpay incluyen el campo que falló (`Argument not valid (name: Name is invalid)`).

Observado en sandbox: Netpay SÍ envía `oxxopay.new` al crear una referencia (con `merchantReferenceCode` y
`reference`, sin `transactionId`); `oxxopay.paid` llega al pagarse en caja. El servicio de reportes del sandbox
respondió 500 (código 1011) a los reembolsos en las pruebas del 2026-10-14: es del lado de Netpay.
