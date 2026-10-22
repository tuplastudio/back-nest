#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Utilidades compartidas por scripts/gcp/monitoring/*.sh.
#
# Todos los scripts son de SOLO IMPRESIÓN por defecto: muestran los comandos de
# gcloud que ejecutarían. `--apply` los ejecuta. Así se pueden revisar en un PR
# y correr a mano por quien tiene permisos sobre el proyecto, nunca desde CI.
# ---------------------------------------------------------------------------
set -euo pipefail

APPLY=false
ARGS=()
for A in "$@"; do
  case "$A" in
    --apply) APPLY=true ;;
    *) ARGS+=("$A") ;;
  esac
done

: "${PROJECT_ID:?Define PROJECT_ID (p. ej. vondi-0q o vondi-0q-staging).}"
SERVICE="${SERVICE:-netpay-api}"
REGION="${REGION:-us-east5}"

# run <cmd...>: imprime; con --apply, además ejecuta.
run() {
  if $APPLY; then
    printf '+ %s\n' "$*" >&2
    "$@"
  else
    printf '[dry-run] %s\n' "$*" >&2
  fi
}

# Archivo temporal para definiciones JSON/YAML; se borra al salir.
TMPDIR_MON="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_MON"' EXIT
