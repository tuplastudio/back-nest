#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Crea (o actualiza) el servicio de Cloud Run y el Job de migraciones de un
# entorno, con la configuración completa. Es el bootstrap de §11.2 de
# docs/DEPLOY-GCP.md, parametrizado por entorno.
#
# POR QUÉ UN SCRIPT Y NO MÁS COPY-PASTE EN EL DOCUMENTO
#
# §17 define un proyecto GCP por entorno y la misma topología en todos. El
# servicio y el Job se configuran una vez y a partir de ahí solo cambia la
# imagen; el workflow nunca los crea. Eso significa que este script es el
# único sitio donde se decide cómo se configura un servicio, y si hay dos
# entornos tiene que ser uno solo con parámetros.
#
# LO QUE NO CAMBIA DESDE AQUÍ
#
# El workflow despliega solo `--image`. Variables, secretos y probes viven en el
# servicio: si el pipeline los fijara en cada despliegue, un cambio de flag
# pasaría a producción sin revisión posible.
#
# Uso:
#   GCP_PROJECT_ID=vondi-0q-staging REGION=us-east5 \
#   SERVICE=netpay-api-staging MIGRATE_JOB=netpay-migrate-staging \
#   IMAGE_DIGEST=sha256:… MIGRATE_DIGEST=sha256:… \
#   ./scripts/provision-cloudrun.sh
# ---------------------------------------------------------------------------

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-}"
# Prefijo de los nombres: cuentas de servicio, registro e imágenes. Ver
# provision-environment.sh.
PREFIX="${SERVICE_PREFIX:-netpay}"
REGION="${REGION:-us-east5}"
SERVICE="${SERVICE:-${PREFIX}-api}"
MIGRATE_JOB="${MIGRATE_JOB:-${PREFIX}-migrate}"
IMAGE_DIGEST="${IMAGE_DIGEST:-}"
MIGRATE_DIGEST="${MIGRATE_DIGEST:-}"
AR_REPOSITORY="${AR_REPOSITORY:-${PREFIX}-api}"
IMAGE_BASE="${IMAGE_BASE:-$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPOSITORY/$PREFIX-api}"

# Diferencias por entorno. Los valores por defecto son los de preproducción;
# producción está en §11.2 y se pasa explícitamente al ejecutar el script.
INGRESS="${INGRESS:-all}"
# Sin `--allow-unauthenticated` por defecto, ni en staging. La URL `run.app`
# es pública, así que permitir acceso anónimo deja la API de preproducción
# abierta a internet: sin balanceador (§13.2) no hay Cloud Armor que la filtre,
# y un endpoint de alta de tenants convierte eso en una base de datos abierta
# a quien lo encuentre. Con IAM, quien prueba en staging necesita un token.
# El acceso de CI va con un ID token contra el invoker del deployer.
ALLOW_UNAUTH="${ALLOW_UNAUTH:---no-allow-unauthenticated}"
# Cuenta que puede invocar el servicio (además de leerlo). El humo de CI usa
# esta identidad: sin ella, Cloud Run responde 403 antes de que la aplicación
# vea la petición.
INVOKER_SA="${INVOKER_SA:-${PREFIX}-deployer@${PROJECT_ID}.iam.gserviceaccount.com}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-2}"
CONCURRENCY="${CONCURRENCY:-15}"
TIMEOUT="${TIMEOUT:-300}"
DOCS_ENABLED="${DOCS_ENABLED:-true}"
# `http://localhost:3000` y no el dominio del frontend real: si el frontend de
# producción pudiera llamar a staging, un usuario en producción acabaría
# escribiendo en la base de preproducción sin darse cuenta.
CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3000}"
# Cliente → Cloud Run directo: un proxy, no dos. Con el balanceador global de
# §13.2 serían 2 (§11.4).
TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-1}"
# Staging no dispara webhooks: una versión sin validar no llama a sistemas de
# terceros, ni de prueba.
OUTBOUND_WEBHOOK_ENABLED="${OUTBOUND_WEBHOOK_ENABLED:-false}"

RUNTIME_SA="${RUNTIME_SA:-${PREFIX}-runtime@${PROJECT_ID}.iam.gserviceaccount.com}"
MIGRATOR_SA="${MIGRATOR_SA:-${PREFIX}-migrator@${PROJECT_ID}.iam.gserviceaccount.com}"
NETWORK="${NETWORK:-vondi-net}"
SUBNET="${SUBNET:-vondi-subnet}"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

for V in PROJECT_ID SERVICE IMAGE_DIGEST MIGRATE_DIGEST; do
  if [[ -z "${!V}" ]]; then
    echo "Falta \$$V." >&2
    exit 1
  fi
done

run() {
  if $DRY_RUN; then
    printf '  [dry-run] %s\n' "$*"
  else
    printf '  %s\n' "$*"
    "$@"
  fi
}

echo "Entorno: $PROJECT_ID · servicio: $SERVICE · job: $MIGRATE_JOB"

# -----------------------------------------------------------------------------
# Job de migraciones (§11.1)
# -----------------------------------------------------------------------------
echo "Job de migraciones"
# Las migraciones no corren en el arranque: Cloud Run levanta N instancias a la
# vez y `prisma migrate deploy` no es idempotente bajo concurrencia. Además este
# Job es el primer sitio donde se ve que una migración es válida, y corre
# contra la base de este entorno, no contra producción.
#
# Los secretos no rotables van fijados a versión 1: una versión nueva accidental
# no debe poder llegar al Job por el `:latest`.
RUN_JOB=(
  gcloud run jobs deploy "$MIGRATE_JOB"
  --project="$PROJECT_ID" --region="$REGION"
  --image="$IMAGE_BASE-migrate@$MIGRATE_DIGEST"
  --service-account="$MIGRATOR_SA"
  --network="$NETWORK" --subnet="$SUBNET" --vpc-egress=all-traffic
  --cpu=1 --memory=512Mi --task-timeout=900s
  --max-retries=0 --tasks=1 --parallelism=1
  --set-env-vars="NODE_ENV=production,LOG_LEVEL=log,PII_LOG_REDACTION=true"
  --set-secrets="CONTROL_PLANE_DATABASE_URL_UNPOOLED=control-plane-db-url-unpooled:latest"
)
run "${RUN_JOB[@]}"

# -----------------------------------------------------------------------------
# Servicio (§11.2)
# -----------------------------------------------------------------------------
echo "Servicio"
# `^@^` como delimitador: `CORS_ORIGINS` con varias URLs trae comas, y el
# delimitador por defecto las interpretaría como separadores.
COMMON=(
  --project="$PROJECT_ID" --region="$REGION"
  --image="$IMAGE_BASE@$IMAGE_DIGEST"
  --service-account="$RUNTIME_SA"
  --network="$NETWORK" --subnet="$SUBNET" --vpc-egress=all-traffic
  --execution-environment=gen2
  --concurrency="$CONCURRENCY" --cpu=1 --memory=512Mi --timeout="$TIMEOUT"
  --min-instances="$MIN_INSTANCES" --max-instances="$MAX_INSTANCES"
  --ingress="$INGRESS"
  --startup-probe="httpGet.path=/health/live,initialDelaySeconds=0,periodSeconds=2,timeoutSeconds=2,failureThreshold=30"
  --liveness-probe="httpGet.path=/health/live,periodSeconds=30,timeoutSeconds=3,failureThreshold=3"
)
# Comparación de cadena, no `$VAR && algo`: eso intentaría ejecutar el valor de
# la variable como comando, que es como `--allow-unauthenticated: command not
# found` acaba dejando el servicio a medias.
if [[ "$ALLOW_UNAUTH" == "--allow-unauthenticated" ]]; then
  COMMON+=(--allow-unauthenticated)
else
  COMMON+=(--no-allow-unauthenticated)
fi

# `/health/live` y no `/health/ready` en los probes: ready devuelve 503 si
# Postgres no responde, y un probe que falla reinicia el contenedor. Con el
# compute de Neon despertándose, eso es un bucle de reinicios (§11.3).
RUN_SERVICE=(
  gcloud run deploy "$SERVICE" "${COMMON[@]}"
  --set-env-vars="^@^NODE_ENV=production@API_PREFIX=api/v1@TRUST_PROXY_HOPS=$TRUST_PROXY_HOPS@DOCS_ENABLED=$DOCS_ENABLED@PII_LOG_REDACTION=true@LOG_LEVEL=log@DATABASE_POOL_MAX=10@DATABASE_CONNECTION_TIMEOUT_MS=15000@DATABASE_STATEMENT_TIMEOUT_MS=15000@CORS_ORIGINS=$CORS_ORIGINS@OUTBOUND_WEBHOOK_ENABLED=$OUTBOUND_WEBHOOK_ENABLED"
  --set-secrets="CONTROL_PLANE_DATABASE_URL=control-plane-db-url:latest,TENANT_PLANE_DATABASE_URL=tenant-plane-db-url:latest,JWT_ACCESS_SECRET=jwt-access-secret:latest,JWT_REFRESH_SECRET=jwt-refresh-secret:latest,PII_HMAC_KEY=pii-hmac-key:1,PII_ENCRYPTION_KEY=pii-encryption-key:1,NETPAY_ENCRYPTION_KEY=netpay-encryption-key:1,DOCS_BASIC_AUTH_PASSWORD=docs-basic-auth-password:latest"
)
run "${RUN_SERVICE[@]}"

if $DRY_RUN; then
  exit 0
fi

# El `run.invoker` va en el servicio, no en el proyecto: es una excepción
# puntual a un rol que proyecto entero no necesita para desplegar.
echo "run.invoker para el humo de CI"
if $DRY_RUN; then
  echo "  [dry-run] add-iam-policy-binding $SERVICE -> $INVOKER_SA (run.invoker)"
else
  gcloud run services add-iam-policy-binding "$SERVICE" \
    --project="$PROJECT_ID" --region="$REGION" \
    --member="serviceAccount:$INVOKER_SA" --role="roles/run.invoker" \
    --condition=None --quiet >/dev/null
  echo "  $INVOKER_SA"
fi

# -----------------------------------------------------------------------------
# API_BASE_DOMAIN, que depende de la URL que acabamos de crear
# -----------------------------------------------------------------------------
# Es el único valor que no se puede fijar antes de desplegar: la URL del
# servicio se conoce cuando ya existe. Sirve para la URL del servidor que
# publica la referencia de la API, así que dejarlo apuntando al dominio de
# producción hace que la documentación de staging describa producción.
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --format='value(status.url)')"
DOMAIN="${URL#https://}"
echo "API_BASE_DOMAIN del servicio: $DOMAIN"
gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --update-env-vars="API_BASE_DOMAIN=$DOMAIN" --quiet >/dev/null

cat <<EOF

Listo.

  Servicio  $SERVICE    $URL
  Job       $MIGRATE_JOB

Comprueba que arrancó contra la base (ambos planos hacen SELECT 1 al inicio):

  curl -s -o /dev/null -w '%{http_code}\\n' $URL/health/live
  curl -s -o /dev/null -w '%{http_code}\\n' $URL/health/ready

Un 503 en /health/ready con un 200 en /health/live significa que la aplicación
arrancó y la base no responde: casi siempre es la IP allowlist de Neon (§7).
EOF