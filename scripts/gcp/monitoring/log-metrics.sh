#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Métricas log-based sobre los logs JSON de la aplicación (BN-REQ-OPS-005).
#
# Los nombres de evento y los campos son el contrato de
# src/common/logging/payment-log-events.ts (y su test comprueba que este
# script los usa tal cual). JsonLogger aplana el payload en jsonPayload.
#
#   payment_status_change     contador; etiquetas `to`, `from` (órdenes por estado,
#                             tasa de aprobación = to=PAID / total)
#   netpay_latency_ms         distribución de latencyMs de cada llamada a NetPay;
#                             etiquetas `operation`, `outcome`
#   outbound_delivery_result  contador; etiqueta `result` (delivered|retry|failed|disabled)
#   charge_latency_ms         distribución de latencyMs del log de acceso de
#                             POST …/orders/:id/charge; la usa el SLO de slo.sh
#   reconcile_checked         distribución de `count` (órdenes revisadas por pasada y tenant)
#   reconcile_corrected       contador; etiquetas `from`, `to`, `action`
#   reconcile_errors          distribución de `count` (órdenes que no se pudieron revisar)
#   netpay_webhook_drift      distribución de `drift` (1 = NetPay llama a otra URL); alertar si max ≥ 1
#
#   PROJECT_ID=vondi-0q scripts/gcp/monitoring/log-metrics.sh [--apply]
# ---------------------------------------------------------------------------
# shellcheck source-path=SCRIPTDIR source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

BASE="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\""

metric() { # metric <nombre> <fichero-yaml>
  if gcloud logging metrics describe "$1" --project="$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud logging metrics update "$1" --project="$PROJECT_ID" --config-from-file="$2"
  else
    run gcloud logging metrics create "$1" --project="$PROJECT_ID" --config-from-file="$2"
  fi
  $APPLY || sed 's/^/    /' "$2" >&2
}

cat >"$TMPDIR_MON/payment_status_change.yaml" <<YAML
description: Cambios de estado de órdenes de pago (payment-log-events.ts).
filter: '$BASE AND jsonPayload.event="payment_status_change"'
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  unit: '1'
  labels:
    - key: to
      valueType: STRING
    - key: from
      valueType: STRING
labelExtractors:
  to: EXTRACT(jsonPayload.to)
  from: EXTRACT(jsonPayload.from)
YAML
metric payment_status_change "$TMPDIR_MON/payment_status_change.yaml"

cat >"$TMPDIR_MON/netpay_latency_ms.yaml" <<YAML
description: Latencia de cada llamada HTTP a NetPay, en ms (evento netpay_request).
filter: '$BASE AND jsonPayload.event="netpay_request"'
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: ms
  labels:
    - key: operation
      valueType: STRING
    - key: outcome
      valueType: STRING
valueExtractor: EXTRACT(jsonPayload.latencyMs)
labelExtractors:
  operation: EXTRACT(jsonPayload.operation)
  outcome: EXTRACT(jsonPayload.outcome)
bucketOptions:
  exponentialBuckets:
    numFiniteBuckets: 32
    growthFactor: 1.4
    scale: 10
YAML
metric netpay_latency_ms "$TMPDIR_MON/netpay_latency_ms.yaml"

cat >"$TMPDIR_MON/outbound_delivery_result.yaml" <<YAML
description: Resultado de cada intento de entrega de webhook saliente.
filter: '$BASE AND jsonPayload.event="outbound_delivery_result"'
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  unit: '1'
  labels:
    - key: result
      valueType: STRING
labelExtractors:
  result: EXTRACT(jsonPayload.result)
YAML
metric outbound_delivery_result "$TMPDIR_MON/outbound_delivery_result.yaml"

# Del log de acceso (access-log.middleware.ts): `route` es el patrón de Express,
# sin ids, y `latencyMs` el tiempo total de la petición.
cat >"$TMPDIR_MON/charge_latency_ms.yaml" <<YAML
description: Latencia de POST /t/payments/orders/:id/charge (log de acceso), en ms.
filter: '$BASE AND jsonPayload.type="access" AND jsonPayload.method="POST" AND jsonPayload.route=~"/orders/:id/charge$"'
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: ms
valueExtractor: EXTRACT(jsonPayload.latencyMs)
bucketOptions:
  explicitBuckets:
    bounds: [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 20000]
YAML
metric charge_latency_ms "$TMPDIR_MON/charge_latency_ms.yaml"

# Conciliación (BN-REQ-REC-004, src/payments/reconciliation): una línea por pasada
# y tenant con `count`; una por orden corregida con `from`/`to`.
cat >"$TMPDIR_MON/reconcile_checked.yaml" <<YAML
description: Conciliación, órdenes revisadas por pasada y tenant (valor = count).
filter: '$BASE AND jsonPayload.event="reconcile_checked"'
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: '1'
valueExtractor: EXTRACT(jsonPayload.count)
bucketOptions:
  explicitBuckets:
    bounds: [0, 1, 5, 10, 25, 50, 100, 250, 500]
YAML
metric reconcile_checked "$TMPDIR_MON/reconcile_checked.yaml"

cat >"$TMPDIR_MON/reconcile_errors.yaml" <<YAML
description: Conciliación, órdenes que la conciliación no pudo revisar (valor = count).
filter: '$BASE AND jsonPayload.event="reconcile_errors"'
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: '1'
valueExtractor: EXTRACT(jsonPayload.count)
bucketOptions:
  explicitBuckets:
    bounds: [0, 1, 5, 10, 25, 50, 100, 250, 500]
YAML
metric reconcile_errors "$TMPDIR_MON/reconcile_errors.yaml"

cat >"$TMPDIR_MON/reconcile_corrected.yaml" <<YAML
description: Órdenes que la conciliación cambió de estado.
filter: '$BASE AND jsonPayload.event="reconcile_corrected"'
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  unit: '1'
  labels:
    - key: from
      valueType: STRING
    - key: to
      valueType: STRING
    - key: action
      valueType: STRING
labelExtractors:
  from: EXTRACT(jsonPayload.from)
  to: EXTRACT(jsonPayload.to)
  action: EXTRACT(jsonPayload.action)
YAML
metric reconcile_corrected "$TMPDIR_MON/reconcile_corrected.yaml"

# Drift del webhook de NetPay (BN-REQ-CFG-004): drift=1 cuando NetPay llama a otra
# URL que la de este despliegue. La alerta (max ≥ 1 en 1 h) va al canal on-call.
cat >"$TMPDIR_MON/netpay_webhook_drift.yaml" <<YAML
description: Resultado del chequeo de drift del webhook de NetPay (1 = drift).
filter: '$BASE AND jsonPayload.event="netpay_webhook_drift"'
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: '1'
valueExtractor: EXTRACT(jsonPayload.drift)
bucketOptions:
  explicitBuckets:
    bounds: [0.5]
YAML
metric netpay_webhook_drift "$TMPDIR_MON/netpay_webhook_drift.yaml"
