# back-nest — Spec del core de pagos NetPay (gap analysis SDD)

**Fecha:** 2026-10-21
**Commit base:** `99a6d4e` (rama `staging`, árbol limpio)
**Alcance:** back-nest es el core de NetPay del ecosistema Vondi/Tupla. Toda capacidad de cobro, reembolso, conciliación y notificación vive aquí. Los consumidores (hoy: plane / Vondi) **no** deben compensar huecos del core.

Spec del consumidor (lo que le toca a plane): `../../../netpay-plane-sdd-v2/specs/backnest-integration/README.md`.

## Cómo se construyó

Hubo 4 auditorías de solo lectura y verificación en vivo de staging (`netpay-api-staging`, proyecto `vondi-0q-staging`):

1. Flujos de pago contra las capacidades de NetPay.
2. Seguridad, multi-tenancy e infraestructura (con `gcloud` y `gh` en modo lectura).
3. Gates de calidad, documentación contra código y smoke en vivo.
4. Contrato con plane.

Todo hallazgo cita `archivo:línea`. Lo que no se pudo comprobar se marca **NO VERIFICADO**.

## Documentos

| Archivo | Contenido |
|---|---|
| `00-inventory.md` | Estado actual: endpoints, capacidades, gates, staging en vivo, costos |
| `01-threat-model.md` | Amenazas `BN-THR-xxx` con STRIDE y severidad |
| `02-requirements.md` | Requisitos EARS `BN-REQ-<ÁREA>-nnn`, con prioridad, amenaza y criterio de verificación |
| `03-design.md` | Diseño de cada grupo de requisitos, decisiones y alternativas descartadas |
| `04-tasks.md` | Tasks `BN-TASK-nnn` con Given/When/Then, test, dependencias y orden |
| `05-traceability.md` | Matriz REQ → THR → TASK → test → estado |

## Resumen ejecutivo

| Severidad | Hallazgos | Ejemplos |
|---|---|---|
| **Crítica** | 4 | UrlGuard rechaza todo host con varias IP (`AMBIGUOUS_ADDRESS`), lo que bloquea Cloud Run, Vercel y ngrok. Entregas salientes apagadas por defecto (`OUTBOUND_WEBHOOK_ENABLED=false`). Cualquier API key administra webhooks salientes. Una API key con `users:write` puede crear ADMIN, lo que da toma total del tenant. |
| **Alta** | 11 | Reembolsos sin idempotencia (doble reembolso posible). Sin job de conciliación. Eventos que se pierden (encolado fuera de la transacción). Timeout de NetPay reportado como rechazo (502). Una orden rechazada no se puede recobrar (409). Deploy a prod sin gate de CI ni aprobación. Migraciones por tenant fuera del pipeline. Alertas sin canal de notificación. |
| **Media** | 16 | Webhook de NetPay en staging apuntando a una app ajena. Throttler de auth global. Pagos sin auditoría. Llaves sin versión ni KMS. Token del webhook en los logs. Sin MFA para admins. Refund y verify usan la config actual en lugar de la de la orden. Sin cancelación de órdenes. |
| **Baja** | 9 | Query string perdido en las entregas. `lastFourDigits` incorrecto. Docs desactualizadas. Health sin cache. Trivy que no bloquea. |

**Gates actuales**, todos en verde:

| Gate | Resultado |
|---|---|
| Lint | 0 errores |
| Typecheck | 0 errores |
| Unit tests | 446 pasan |
| e2e | 157 pasan, 26 skip (sandbox) |
| `npm audit` | 0 vulnerabilidades |
| gitleaks | 0 hallazgos |

El problema no es lo que existe, sino **lo que falta**: conciliación, idempotencia, entrega confiable de eventos, cancelación y gates de despliegue.

## Definición de terminado (DoD) del core

1. Todos los `BN-REQ` P0 y P1 en HECHO, con test automatizado en rojo antes y en verde después, y evidencia en `specs/netpay-core/evidence/BN-TASK-nnn/`.
2. Certificación NetPay: 22/22 escenarios con veredicto, incluidos los 6 de reto 3DS, más evidencia OXXO, alojado, reembolso y webhook.
3. Un consumidor en Cloud Run recibe eventos firmados extremo a extremo en staging (`payment.paid`, `payment.refunded`) sin intervención manual.
4. Prueba de caos: matar la instancia a mitad de un cargo o reembolso no produce doble cargo, doble reembolso ni evento perdido.
5. CI bloquea el merge, prod requiere aprobación, y las migraciones de tenant se aplican en el pipeline con verificación de drift.
