#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pruebas con fixtures de los scripts del pipeline que no se pueden ejecutar
# fuera de GCP: revision-error-rate.sh (promoción, BN-TASK-045) y
# cloudrun-flags.sh (drift, BN-TASK-046). Sin red ni credenciales.
#
#   bash scripts/ci/test-pipeline-scripts.sh
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILURES=0

expect() { # expect <descripción> <código esperado> <comando...>
  local name="$1" want="$2"
  shift 2
  "$@" >"$TMP/out" 2>&1
  local got=$?
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $name"
  else
    echo "FAIL  $name (exit $got, esperado $want)"
    sed 's/^/      /' "$TMP/out"
    FAILURES=$((FAILURES + 1))
  fi
}

series() { # series <2xx> <5xx>
  cat <<EOF
{"timeSeries":[
 {"metric":{"labels":{"response_code_class":"2xx"}},"points":[{"value":{"int64Value":"$1"}}]},
 {"metric":{"labels":{"response_code_class":"5xx"}},"points":[{"value":{"int64Value":"$2"}}]}
]}
EOF
}

rate() { MONITORING_RESPONSE_FILE="$1" REVISION=r1 bash "$ROOT/scripts/ci/revision-error-rate.sh"; }

series 1000 2 >"$TMP/ok.json"
series 90 10 >"$TMP/bad.json"
series 5 1 >"$TMP/low-bad.json"
echo '{}' >"$TMP/empty.json"

expect "promoción: 0.2 % de 5xx pasa" 0 rate "$TMP/ok.json"
expect "promoción: 10 % de 5xx al 10 % de tráfico revierte" 1 rate "$TMP/bad.json"
expect "promoción: un 5xx con poco tráfico revierte" 1 rate "$TMP/low-bad.json"
expect "promoción: sin tráfico aún no bloquea" 0 rate "$TMP/empty.json"

describe() { # describe <minScale> <cpu-throttling|""> <ingress>
  jq -n --arg min "$1" --arg thr "$2" --arg ing "$3" '{
    metadata: {annotations: {"run.googleapis.com/ingress": $ing}},
    spec: {template: {
      metadata: {annotations: ({
        "autoscaling.knative.dev/minScale": $min,
        "autoscaling.knative.dev/maxScale": "4",
        "run.googleapis.com/vpc-access-egress": "all-traffic",
        "run.googleapis.com/execution-environment": "gen2"
      } + (if $thr == "" then {} else {"run.googleapis.com/cpu-throttling": $thr} end))},
      spec: {containerConcurrency: 15, timeoutSeconds: 60,
             containers: [{resources: {limits: {cpu: "1", memory: "512Mi"}}}]}
    }}}'
}

describe 1 false all >"$TMP/prod-ok.json"
describe 0 "" all >"$TMP/prod-manual.json"

flags() { bash "$ROOT/scripts/gcp/cloudrun-flags.sh" "$@"; }
expect "drift: producción como se declaró" 0 flags check production "$TMP/prod-ok.json"
expect "drift: revisión manual con min-instances 0 y throttling falla" 1 flags check production "$TMP/prod-manual.json"
expect "args: producción lleva --no-cpu-throttling" 0 bash -c "bash '$ROOT/scripts/gcp/cloudrun-flags.sh' args production | grep -qx -- --no-cpu-throttling"
expect "args: entorno desconocido" 2 flags args qa

if [[ $FAILURES -ne 0 ]]; then
  echo "$FAILURES prueba(s) fallaron."
  exit 1
fi
echo "Todas las pruebas pasaron."
