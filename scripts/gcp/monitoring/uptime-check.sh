#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Uptime check contra /health/live y su alerta, notificando al canal on-call
# (BN-REQ-OPS-003).
#
#   PROJECT_ID=vondi-0q HOST=netpay.tupla.dev CHANNEL=projects/…/notificationChannels/… \
#     scripts/gcp/monitoring/uptime-check.sh [--apply]
#
# /health/live y no /health/ready: ready devuelve 503 mientras Neon despierta el
# compute y despertaría a alguien por un arranque en frío; la base se vigila
# con la alerta de 5xx y con el SLO. HOST es el dominio público (LB) o, mientras
# no exista, el host run.app del servicio.
# ---------------------------------------------------------------------------
# shellcheck source-path=SCRIPTDIR source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

: "${HOST:?Define HOST (dominio público o host run.app).}"
: "${CHANNEL:?Define CHANNEL (salida de notification-channel.sh).}"
CHECK_ID="${CHECK_ID:-$SERVICE-live}"

run gcloud monitoring uptime create "$CHECK_ID" --project="$PROJECT_ID" \
  --resource-type=uptime-url \
  --resource-labels="host=$HOST,project_id=$PROJECT_ID" \
  --path=/health/live --protocol=https --port=443 \
  --period=1 --timeout=10 \
  --regions=usa-oregon,usa-virginia,usa-iowa

POLICY_FILE="$TMPDIR_MON/uptime-policy.json"
cat >"$POLICY_FILE" <<JSON
{
  "displayName": "$SERVICE: /health/live no responde",
  "combiner": "OR",
  "conditions": [{
    "displayName": "uptime check $CHECK_ID falla desde más de una región",
    "conditionThreshold": {
      "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND resource.label.host=\"$HOST\"",
      "aggregations": [{
        "alignmentPeriod": "60s",
        "perSeriesAligner": "ALIGN_NEXT_OLDER",
        "crossSeriesReducer": "REDUCE_COUNT_FALSE",
        "groupByFields": ["resource.label.host"]
      }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 1,
      "duration": "120s",
      "trigger": { "count": 1 }
    }
  }],
  "notificationChannels": ["$CHANNEL"],
  "documentation": { "content": "Runbook: docs/RUNBOOK-PAYMENTS.md (respuesta a incidentes).", "mimeType": "text/markdown" }
}
JSON
run gcloud alpha monitoring policies create --project="$PROJECT_ID" --policy-from-file="$POLICY_FILE"
$APPLY || { echo "--- política ---" >&2; cat "$POLICY_FILE" >&2; }
