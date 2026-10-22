#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Política de limpieza del repositorio de Artifact Registry (BN-REQ-OPS-008).
#
# scripts/gcp/artifact-cleanup-policy.json: se conservan SIEMPRE las 10
# versiones (digests) más recientes de cada paquete —la imagen de runtime y la
# `-migrate`— y se borra lo que, además, tenga más de 30 días. Keep gana a
# Delete, así que un rollback a cualquiera de los 10 últimos releases sigue
# teniendo su imagen aunque sea vieja; y lo que sirve tráfico hoy es siempre
# uno de ellos, porque cada release empuja uno nuevo.
#
# Sin argumentos solo imprime el comando. `--dry-run` instala la política en
# modo simulación (Artifact Registry registra qué borraría, sin borrar);
# `--apply` la activa de verdad. Lo prudente: `--dry-run`, revisar una semana,
# después `--apply`.
#
#   GCP_PROJECT_ID=vondi-0q REGION=us-east5 AR_REPOSITORY=netpay-api \
#     scripts/gcp/apply-artifact-cleanup.sh [--dry-run|--apply]
#
# Este script NO se ejecuta desde CI.
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Define GCP_PROJECT_ID.}"
REGION="${REGION:-us-east5}"
AR_REPOSITORY="${AR_REPOSITORY:-netpay-api}"
POLICY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/artifact-cleanup-policy.json"

MODE=--dry-run
EXECUTE=false
case "${1:-}" in
  --dry-run) EXECUTE=true ;;
  --apply) EXECUTE=true; MODE=--no-dry-run ;;
  "") ;;
  *) echo "Uso: $0 [--dry-run|--apply]" >&2; exit 2 ;;
esac

jq -e '.[] | select(.action.type == "Keep") | .mostRecentVersions.keepCount' "$POLICY" >/dev/null

CMD=(gcloud artifacts repositories set-cleanup-policies "$AR_REPOSITORY"
  --project="$PROJECT_ID" --location="$REGION"
  --policy="$POLICY" "$MODE")

printf '%s\n' "${CMD[*]}"
if ! $EXECUTE; then
  echo "(solo impreso; --dry-run o --apply para ejecutarlo)"
  exit 0
fi
"${CMD[@]}"

echo "Política aplicada ($MODE). Revisar en unos días qué marcó para borrar:"
echo "  gcloud logging read 'protoPayload.methodName=\"google.devtools.artifactregistry.v1.ArtifactRegistry.BatchDeleteVersions\"' --project=$PROJECT_ID --limit=20"
