#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Provisiona un entorno completo de vondi: APIs, cuentas de servicio, Artifact
# Registry, WIF y red de egress. Delega la red en provision-network.sh.
#
# Implementa §6 de docs/DEPLOY-GCP.md, que hasta ahora era copy-paste. El
# motivo de que sea un script y no más texto: staging y producción son la misma
# topología con otro PROJECT_ID, y dos copias de la misma lista de comandos
# divergen. Aquí solo hay una.
#
# POR QUÉ EXISTE UN SCRIPT Y NO UN DOCUMENTO
#
# §17 separa los entornos por proyecto GCP, así que "crear staging" es
# exactamente "crear prod con otro PROJECT_ID". Lo que hay que garantizar no es
# que alguien copie bien la lista, sino que la segunda copia existe y usa el
# mismo criterio. Aquí eso es una línea más de código.
#
# IDEMPOTENTE
#
# Se puede volver a ejecutar sin efecto: lo que ya existe se comprueba antes de
# crearse. El punto de reejecución útil es un entorno a medio montar.
#
# LO QUE NO HACE
#
# - No crea los secretos (§9): sus valores son las cuatro cadenas de Neon y no
#   se pueden inventar. Van en provision-secrets.sh.
# - No toca ningún servicio de Cloud Run: crearlos con la red ya lista y la
#   Neon autorizada es lo que evita un despliegue que no arranca.
#
# Uso:
#   GCP_PROJECT_ID=vondi-0q-staging GH_REPO=tuplastudio/back-nest \
#     GIT_ENVIRONMENT=staging ./scripts/provision-environment.sh
#   ./scripts/provision-environment.sh --dry-run
# ---------------------------------------------------------------------------

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-}"
# Prefijo de todos los nombres del entorno: cuentas de servicio, registro y
# servicios. Renombrar el producto es cambiar esta variable y volver a ejecutar,
# no editar veinte cadenas en cuatro ficheros.
PREFIX="${SERVICE_PREFIX:-netpay}"
REGION="${REGION:-us-east5}"
AR_REPO="${AR_REPOSITORY:-${PREFIX}-api}"
GH_REPO="${GH_REPO:-}"
# Si se indica, el permiso de la WIF queda atado al environment de GitHub, no a
# la rama. Ver más abajo; para producción el criterio es `refs/heads/main`.
GIT_ENVIRONMENT="${GIT_ENVIRONMENT:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ -z "$PROJECT_ID" ]]; then
  echo "Falta GCP_PROJECT_ID." >&2
  exit 1
fi
if [[ -z "$GH_REPO" ]]; then
  echo "Falta GH_REPO (owner/repo del repositorio que debe poder desplegar)." >&2
  exit 1
fi

# El dominio va aparte porque estas variables ya son correos completos: los
# comandos de gcloud reciben la cuenta tal cual, y componerlas otra vez con
# "${SA}@${PROJECT_ID}..." produce un nombre inválido que la IAM API rechaza con
# un INVALID_ARGUMENT que no dice nada de un doble sufijo.
SA_DOMAIN="${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${PREFIX}-runtime@${SA_DOMAIN}"
DEPLOYER_SA="${PREFIX}-deployer@${SA_DOMAIN}"
MIGRATOR_SA="${PREFIX}-migrator@${SA_DOMAIN}"

run() {
  if $DRY_RUN; then
    printf '  [dry-run] %s\n' "$*"
  else
    printf '  %s\n' "$*"
    "$@"
  fi
}

# El IAM de una cuenta recién creada tarda unos segundos en estar disponible:
# setIamPolicy falla con INVALID_ARGUMENT "Unknown error" hasta que la cuenta se
# propaga. Es transitorio y el binding no se aplica a medias, así que reintenta
# en vez de dejar el entorno a medio montar.
run_retry() {
  local attempt=1 max=5
  while true; do
    if "$@"; then return 0; fi
    if (( attempt >= max )); then
      echo "  falló tras $max intentos: $*" >&2
      return 1
    fi
    echo "  reintento $attempt/$((max - 1)) tras un fallo transitorio de IAM" >&2
    sleep $(( attempt * 5 ))
    (( attempt++ ))
  done
}

exists() { gcloud "$@" >/dev/null 2>&1; }

echo "Entorno: $PROJECT_ID · región: $REGION · repositorio: $GH_REPO"

# -----------------------------------------------------------------------------
# APIs (§6.1)
# -----------------------------------------------------------------------------
echo "APIs"
if exists projects describe "$PROJECT_ID"; then
  echo "  proyecto existe"
else
  run gcloud projects create "$PROJECT_ID" --name="vondi ${PROJECT_ID#vondi-0q-}" --quiet
fi

run gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  compute.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  containerscanning.googleapis.com \
  --project "$PROJECT_ID"

# -----------------------------------------------------------------------------
# Cuentas de servicio (§6.2)
# -----------------------------------------------------------------------------
echo "Cuentas de servicio"
for SA in "${PREFIX}-runtime" "${PREFIX}-deployer" "${PREFIX}-migrator"; do
  if exists iam service-accounts describe "$SA@${SA_DOMAIN}" --project "$PROJECT_ID"; then
    echo "  $SA existe"
  else
    run gcloud iam service-accounts create "$SA" \
      --display-name="$SA" --project "$PROJECT_ID"
  fi
done

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" \
  --format='value(projectNumber)' --quiet 2>/dev/null || echo '')"
[[ -n "$PROJECT_NUMBER" ]] || PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "Permisos de proyecto"
# El servicio y el Job escriben sus propios logs y métricas; sin esto fallan al
# arrancar y el síntoma es un 503 con "Permission denied" en la entrada.
for SA in "$RUNTIME_SA" "$MIGRATOR_SA"; do
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" --project "$PROJECT_ID" \
    --member="serviceAccount:$SA" --role="roles/logging.logWriter"
done
run gcloud projects add-iam-policy-binding "$PROJECT_ID" --project "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role="roles/monitoring.metricWriter"
run gcloud projects add-iam-policy-binding "$PROJECT_ID" --project "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOYER_SA" --role="roles/run.developer"

echo "El deployer actúa como las cuentas de ejecución"
# Sin serviceAccountUser, `gcloud run deploy` con --service-account es rechazado
# aunque la SA exista y el deployer pueda desplegar.
for SA in "$RUNTIME_SA" "$MIGRATOR_SA"; do
  run_retry gcloud iam service-accounts add-iam-policy-binding \
    "$SA" --project "$PROJECT_ID" \
    --member="serviceAccount:$DEPLOYER_SA" --role="roles/iam.serviceAccountUser" --quiet
done

# -----------------------------------------------------------------------------
# Artifact Registry (§6.3)
# -----------------------------------------------------------------------------
echo "Artifact Registry"
if exists artifacts repositories describe "$AR_REPO" \
  --project "$PROJECT_ID" --location "$REGION"; then
  echo "  $AR_REPO existe"
else
  run gcloud artifacts repositories create "$AR_REPO" \
    --project "$PROJECT_ID" --repository-format=docker --location="$REGION" \
    --description="Imágenes de ${PREFIX}-api"
fi

run gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" \
  --project="$PROJECT_ID" --location "$REGION" \
  --member="serviceAccount:$DEPLOYER_SA" --role="roles/artifactregistry.writer"

# Escaneo de vulnerabilidades nativo, dentro del proyecto. Se activa aquí y no
# desde el pipeline a propósito: un escáner de terceros que se descarga por
# internet no puede decidir si un despliegue pasa —el run 39169632356 lo
# demostró, con Trivy muriendo al descargarse y parando producción sin haber
# escaneado nada—. Este lo hace Google, sin dependencias externas, y su
# resultado vive en el proyecto.
run gcloud artifacts repositories update "$AR_REPO" \
  --project="$PROJECT_ID" --location "$REGION" --allow-vulnerability-scanning
for SA in "$RUNTIME_SA" "$MIGRATOR_SA"; do
  run gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" \
    --project "$PROJECT_ID" --location "$REGION" \
    --member="serviceAccount:$SA" --role="roles/artifactregistry.reader"
done

# -----------------------------------------------------------------------------
# Workload Identity Federation (§6.4)
# -----------------------------------------------------------------------------
echo "Workload Identity Federation"
if exists iam workload-identity-pools describe github \
  --project "$PROJECT_ID" --location=global; then
  echo "  pool github existe"
else
  run gcloud iam workload-identity-pools create github --location=global \
    --project "$PROJECT_ID" --display-name="GitHub Actions"
fi

# El criterio de atributos es el control de seguridad del pipeline, y es lo
# único que impide que otro repositorio use esta identidad. Hay dos criterios
# distintos según para qué sirva el entorno:
#
#   * producción: `ref == refs/heads/main`. Nada que no sea la rama de
#     producción despliega a producción, ni siquiera otro workflow del repo.
#   * staging (GIT_ENVIRONMENT): `environment == staging`. Aquí el despliegue
#     viene de un pull_request, así que atar a `ref` no sirve (la ref de un PR
#     es `refs/pull/N/merge`). Sin esta condición, cualquier rama del
#     repositorio —incluida la de un colaborador— podría desplegar a staging.
#
# POR QUÉ EL CLAIM `environment` Y NO EL `sub`
#
# Lo natural sería `sub == 'repo:OWNER/REPO:environment:staging'`, y en un
# repositorio anterior a julio de 2026 funciona. Este se creó después, así que
# usa el formato inmutable: `repo:tuplastudio@119982788/back-nest@1423773262:…`,
# con los IDs dentro. Una condición escrita con el formato anterior no falla al
# desplegar —falla la autenticación, con "The given credential is rejected by
# the attribute condition", que no dice nada del formato— y por eso atar la
# identidad a `sub` es una trampa cada vez que GitHub cambia el formato.
#
# El claim `environment` dice lo mismo ("el job declaró este environment") y no
# cambia con el formato ni con un renombrado del repositorio.
if [[ -n "$GIT_ENVIRONMENT" ]]; then
  CONDITION="assertion.repository == '$GH_REPO' && assertion.environment == '$GIT_ENVIRONMENT'"
else
  CONDITION="assertion.repository == '$GH_REPO' && assertion.ref == 'refs/heads/main'"
fi

MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref"

# `update-oidc` y no siempre `create-oidc`: cambiar el criterio de atributos es
# una corrección de seguridad, y tener que borrar el provider para poderla
# aplicar es una forma de que la corrección no se aplique nunca.
if exists iam workload-identity-pools providers describe github \
  --project "$PROJECT_ID" --location=global --workload-identity-pool=github; then
  run gcloud iam workload-identity-pools providers update-oidc github \
    --project "$PROJECT_ID" --location=global --workload-identity-pool=github \
    --attribute-mapping="$MAPPING" \
    --attribute-condition="$CONDITION"
else
  run gcloud iam workload-identity-pools providers create-oidc github \
    --project "$PROJECT_ID" --location=global --workload-identity-pool=github \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" \
    --attribute-condition="$CONDITION"
fi

# principalSet con el NÚMERO de proyecto, no el ID: con el ID la binding se
# crea sin error y no concede nada.
run_retry gcloud iam service-accounts add-iam-policy-binding \
  "$DEPLOYER_SA" --project "$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" --quiet \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$GH_REPO"

# -----------------------------------------------------------------------------
# Red (§7)
# -----------------------------------------------------------------------------
echo "Red de egress"
NET_ARGS=()
# `if` y no `&&`: con `set -e`, un `$DRY_RUN && algo` que no se cumple devuelve
# 1 y mata el script justo antes de provisionar la red.
if $DRY_RUN; then
  NET_ARGS+=(--dry-run)
fi
GCP_PROJECT_ID="$PROJECT_ID" REGION="$REGION" "$SCRIPT_DIR/provision-network.sh" "${NET_ARGS[@]}"

cat <<EOF

Entorno provisionado: $PROJECT_ID ($PROJECT_NUMBER) en $REGION.

Criterio de la WIF:
  $CONDITION

Valores para el environment de GitHub:

  GCP_PROJECT_ID    $PROJECT_ID
  GCP_REGION        $REGION
  GCP_WIF_PROVIDER  projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github
  GCP_DEPLOYER_SA   $DEPLOYER_SA
  AR_REPOSITORY     $AR_REPO

Lo que falta, y en este orden (el orden es el aislamiento, no el capricho):

  1. provision-secrets.sh con las cuatro cadenas de la rama de Neon.
  2. Autorizar la IP /32 del NAT de este proyecto en Neon. Sin esto, ni el Job
     de migraciones ni el servicio pueden conectar, y el síntoma es un error de
     conexión que parece de credenciales.
  3. Cloud Run: servicio y Job de migraciones.
EOF