#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ¿La revisión nueva sirve 5xx por encima del umbral? (BN-REQ-OPS-006)
#
# Lo usa el job `promote` de deploy-environment.yml después de cada escalón de
# tráfico (10 → 50 → 100). Lee de Cloud Monitoring la métrica
# run.googleapis.com/request_count de ESA revisión en la ventana observada,
# separa 5xx del total y sale con 1 si la proporción supera MAX_5XX_RATIO.
# El job revierte el tráfico a la revisión anterior cuando este script falla.
#
# Entorno:
#   PROJECT_ID, SERVICE, REVISION   qué mirar
#   WINDOW_SECONDS                  ventana hacia atrás (por defecto 300)
#   MAX_5XX_RATIO                   umbral, fracción (por defecto 0.02 = 2 %)
#   MIN_REQUESTS                    por debajo de esto no se juzga la proporción,
#                                   pero cualquier 5xx falla (por defecto 20)
#   MONITORING_RESPONSE_FILE        (tests) JSON de timeSeries.list en vez de
#                                   llamar a la API
#
# La identidad necesita roles/monitoring.viewer en el proyecto.
# ---------------------------------------------------------------------------
set -euo pipefail

WINDOW_SECONDS="${WINDOW_SECONDS:-300}"
MAX_5XX_RATIO="${MAX_5XX_RATIO:-0.02}"
MIN_REQUESTS="${MIN_REQUESTS:-20}"

fetch() {
  if [[ -n "${MONITORING_RESPONSE_FILE:-}" ]]; then
    cat "$MONITORING_RESPONSE_FILE"
    return
  fi
  : "${PROJECT_ID:?}" "${SERVICE:?}" "${REVISION:?}"
  local end start filter
  end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  start=$(date -u -d "-${WINDOW_SECONDS} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -v-"${WINDOW_SECONDS}"S +%Y-%m-%dT%H:%M:%SZ)
  filter="metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND resource.labels.revision_name=\"${REVISION}\""
  curl -sS --fail-with-body --get \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    "https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries" \
    --data-urlencode "filter=${filter}" \
    --data-urlencode "interval.startTime=${start}" \
    --data-urlencode "interval.endTime=${end}" \
    --data-urlencode "aggregation.alignmentPeriod=${WINDOW_SECONDS}s" \
    --data-urlencode "aggregation.perSeriesAligner=ALIGN_SUM" \
    --data-urlencode "aggregation.crossSeriesReducer=REDUCE_SUM" \
    --data-urlencode "aggregation.groupByFields=metric.labels.response_code_class"
}

RESPONSE=$(fetch)

# Suma por clase de respuesta. Los puntos de una serie DELTA llegan como
# int64Value en texto.
read -r TOTAL ERRORS < <(jq -r '
  [(.timeSeries // [])[] | {
      class: (.metric.labels.response_code_class // ""),
      n: ([.points[]?.value.int64Value // 0 | tonumber] | add // 0)
  }] as $s
  | "\([$s[].n] | add // 0) \([$s[] | select(.class == "5xx") | .n] | add // 0)"
' <<<"$RESPONSE")

echo "Revisión ${REVISION:-?}: ${ERRORS} respuestas 5xx de ${TOTAL} en ${WINDOW_SECONDS}s (umbral ${MAX_5XX_RATIO})."

if (( TOTAL < MIN_REQUESTS )); then
  if (( ERRORS > 0 )); then
    echo "::error::Con poco tráfico cualquier 5xx descalifica la revisión."
    exit 1
  fi
  echo "Tráfico insuficiente para una proporción; sin 5xx, se acepta."
  exit 0
fi

if awk -v e="$ERRORS" -v t="$TOTAL" -v m="$MAX_5XX_RATIO" 'BEGIN { exit !(e / t > m) }'; then
  echo "::error::Tasa de 5xx por encima del umbral."
  exit 1
fi
echo "Tasa de 5xx dentro del umbral."
