#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SLOs del servicio y alertas de burn-rate (BN-REQ-OPS-003):
#
#   * disponibilidad 99,9 % a 30 días (SLI básico de Cloud Run: respuestas no 5xx);
#   * latencia de `charge`: 95 % de las peticiones por debajo de 1,5 s a 30
#     días (equivale a p95 < 1,5 s), sobre la métrica log-based
#     `charge_latency_ms` que crea log-metrics.sh — ejecutarlo antes.
#
# Alertas multi-ventana sobre cada SLO, ambas al canal on-call:
#   rápida  burn rate > 14,4 en 1 h (2 % del presupuesto mensual en una hora)
#   lenta   burn rate > 6 en 6 h    (5 % del presupuesto en seis horas)
#
#   PROJECT_ID=vondi-0q CHANNEL=projects/…/notificationChannels/… \
#     scripts/gcp/monitoring/slo.sh [--apply]
#
# Service Monitoring no tiene subcomando estable en gcloud, así que se usa la API
# REST con el token de gcloud.
# ---------------------------------------------------------------------------
# shellcheck source-path=SCRIPTDIR source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

: "${CHANNEL:?Define CHANNEL (salida de notification-channel.sh).}"
SERVICE_ID="${SERVICE_ID:-$SERVICE}"
API="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID"

api() { # api <método> <ruta> <fichero-json>
  local method="$1" path="$2" body="$3"
  if $APPLY; then
    curl -sS --fail-with-body -X "$method" \
      -H "Authorization: Bearer $(gcloud auth print-access-token)" \
      -H 'Content-Type: application/json' \
      "$API/$path" --data-binary "@$body"
    echo
  else
    printf '[dry-run] %s %s/%s\n' "$method" "$API" "$path" >&2
    sed 's/^/    /' "$body" >&2
  fi
}

jq -n --arg svc "$SERVICE" --arg region "$REGION" '{
  displayName: $svc,
  basicService: { serviceType: "CLOUD_RUN", serviceLabels: { service_name: $svc, location: $region } }
}' >"$TMPDIR_MON/service.json"
api POST "services?serviceId=$SERVICE_ID" "$TMPDIR_MON/service.json"

jq -n '{
  displayName: "Disponibilidad 99,9 % (30 d)",
  goal: 0.999,
  rollingPeriod: "2592000s",
  serviceLevelIndicator: { basicSli: { availability: {} } }
}' >"$TMPDIR_MON/slo-availability.json"
api POST "services/$SERVICE_ID/serviceLevelObjectives?serviceLevelObjectiveId=availability" "$TMPDIR_MON/slo-availability.json"

jq -n --arg svc "$SERVICE" '{
  displayName: "charge p95 < 1,5 s (30 d)",
  goal: 0.95,
  rollingPeriod: "2592000s",
  serviceLevelIndicator: { requestBased: { distributionCut: {
    distributionFilter: ("metric.type=\"logging.googleapis.com/user/charge_latency_ms\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"" + $svc + "\""),
    range: { min: 0, max: 1500 }
  } } }
}' >"$TMPDIR_MON/slo-latency.json"
api POST "services/$SERVICE_ID/serviceLevelObjectives?serviceLevelObjectiveId=charge-latency" "$TMPDIR_MON/slo-latency.json"

for SLO in availability charge-latency; do
  SLO_NAME="projects/$PROJECT_ID/services/$SERVICE_ID/serviceLevelObjectives/$SLO"
  jq -n --arg slo "$SLO_NAME" --arg id "$SLO" --arg ch "$CHANNEL" '{
    displayName: ("SLO " + $id + ": burn rate"),
    combiner: "OR",
    conditions: [
      { displayName: "rápida: > 14,4 en 1 h",
        conditionThreshold: { filter: ("select_slo_burn_rate(\"" + $slo + "\", \"3600s\")"),
          comparison: "COMPARISON_GT", thresholdValue: 14.4, duration: "0s" } },
      { displayName: "lenta: > 6 en 6 h",
        conditionThreshold: { filter: ("select_slo_burn_rate(\"" + $slo + "\", \"21600s\")"),
          comparison: "COMPARISON_GT", thresholdValue: 6, duration: "0s" } }
    ],
    notificationChannels: [$ch],
    documentation: { content: "Runbook: docs/RUNBOOK-PAYMENTS.md", mimeType: "text/markdown" }
  }' >"$TMPDIR_MON/burn-$SLO.json"
  run gcloud alpha monitoring policies create --project="$PROJECT_ID" --policy-from-file="$TMPDIR_MON/burn-$SLO.json"
  $APPLY || sed 's/^/    /' "$TMPDIR_MON/burn-$SLO.json" >&2
done
