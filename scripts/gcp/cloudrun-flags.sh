#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Flags de runtime de Cloud Run declarados en .github/cloudrun/flags.json
# (BN-REQ-OPS-007). Una sola fuente para dos usos:
#
#   args  <entorno>               imprime los flags de `gcloud run deploy`, uno
#                                 por línea (el workflow los lee con mapfile).
#   check <entorno> <describe>    compara la salida de
#                                 `gcloud run services describe --format=json`
#                                 con lo declarado; sale con 1 si hay drift.
#
# No llama a gcloud: el workflow hace el describe y pasa el fichero, así el
# script se prueba con fixtures (scripts/gcp/test-cloudrun-flags.sh).
#
# Dónde mira cada flag en el describe (servicio Knative v1):
#   --min-instances    spec.template.metadata.annotations["autoscaling.knative.dev/minScale"]
#   --max-instances    spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"]
#   --cpu-throttling   spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"]
#                      (ausente = throttling activo, el valor por defecto)
#   --vpc-egress       spec.template.metadata.annotations["run.googleapis.com/vpc-access-egress"]
#   --ingress          metadata.annotations["run.googleapis.com/ingress"]
#   --concurrency      spec.template.spec.containerConcurrency
#   --timeout          spec.template.spec.timeoutSeconds
#   --cpu / --memory   spec.template.spec.containers[0].resources.limits
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLAGS_FILE="${CLOUDRUN_FLAGS_FILE:-$ROOT/.github/cloudrun/flags.json}"

usage() {
  echo "Uso: $0 args <staging|production> | check <staging|production> <describe.json>" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
MODE="$1"
ENVIRONMENT="$2"

if ! jq -e --arg e "$ENVIRONMENT" 'has($e)' "$FLAGS_FILE" >/dev/null; then
  echo "Entorno desconocido en $FLAGS_FILE: $ENVIRONMENT" >&2
  exit 2
fi

flag() { jq -r --arg e "$ENVIRONMENT" --arg k "$1" '.[$e][$k] | tostring' "$FLAGS_FILE"; }

case "$MODE" in
  args)
    echo "--min-instances=$(flag minInstances)"
    echo "--max-instances=$(flag maxInstances)"
    if [[ "$(flag cpuThrottling)" == "true" ]]; then
      echo "--cpu-throttling"
    else
      echo "--no-cpu-throttling"
    fi
    echo "--ingress=$(flag ingress)"
    echo "--vpc-egress=$(flag vpcEgress)"
    echo "--concurrency=$(flag concurrency)"
    echo "--timeout=$(flag timeoutSeconds)"
    echo "--cpu=$(flag cpu)"
    echo "--memory=$(flag memory)"
    echo "--execution-environment=$(flag executionEnvironment)"
    ;;
  check)
    [[ $# -eq 3 ]] || usage
    DESCRIBE="$3"
    # Pares «nombre|declarado|real». El real se normaliza a los mismos tipos
    # que el JSON declarado (números y booleanos como texto).
    ACTUAL=$(jq -r '
      (.spec.template.metadata.annotations // {}) as $t
      | (.metadata.annotations // {}) as $s
      | [
          "minInstances|\($t["autoscaling.knative.dev/minScale"] // "0")",
          "maxInstances|\($t["autoscaling.knative.dev/maxScale"] // "100")",
          "cpuThrottling|\(($t["run.googleapis.com/cpu-throttling"] // "true") | tostring)",
          "ingress|\($s["run.googleapis.com/ingress"] // "all")",
          "vpcEgress|\($t["run.googleapis.com/vpc-access-egress"] // "none")",
          "concurrency|\(.spec.template.spec.containerConcurrency // 80)",
          "timeoutSeconds|\(.spec.template.spec.timeoutSeconds // 300)",
          "cpu|\(.spec.template.spec.containers[0].resources.limits.cpu // "")",
          "memory|\(.spec.template.spec.containers[0].resources.limits.memory // "")",
          "executionEnvironment|\($t["run.googleapis.com/execution-environment"] // "default")"
        ][]' "$DESCRIBE")

    DRIFT=0
    while IFS='|' read -r NAME REAL; do
      WANT="$(flag "$NAME")"
      if [[ "$WANT" == "$REAL" ]]; then
        echo "ok     $NAME=$REAL"
      else
        echo "DRIFT  $NAME: declarado=$WANT real=$REAL"
        DRIFT=1
      fi
    done <<<"$ACTUAL"

    if [[ $DRIFT -ne 0 ]]; then
      echo "El servicio de $ENVIRONMENT no coincide con $FLAGS_FILE." >&2
      echo "Si el cambio es intencionado, actualiza flags.json y docs/DEPLOY-GCP.md §11.3 en un PR;" >&2
      echo "si no, el próximo despliegue lo revierte (o reaplícalo con el workflow de deploy)." >&2
      exit 1
    fi
    ;;
  *)
    usage
    ;;
esac
