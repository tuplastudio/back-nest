#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Crea los secretos de un entorno en Secret Manager: las cuatro cadenas de
# conexión y las claves de cifrado y firma.
#
# Implementa §9 de docs/DEPLOY-GCP.md para un entorno cualquiera. Es
# idempotente en los secretos que ya existen: no los sobrescribe, porque
# sobrescribir `pii-encryption` deja indescifrable el PII ya escrito.
#
# POR QUÉ LAS CLAVES SE GENERAN AQUÍ Y NO SE PASAN POR VARIABLE
#
# `PII_ENCRYPTION_KEY` y `PII_HMAC_KEY` no se rotan: cambiarlas deja
# indescifrable lo ya cifrado y rompe el blind index (RB-04). Este script
# devuelve las claves que crea, y quien las necesita para custodia las copia
# fuera de GCP en el mismo momento.
#
# LAS CUATRO CADENAS VIENEN DE VARIABLES, NO DE UN ARCHIVO
#
#   export CONTROL_URL="postgresql://mtb_control:…@ep-…-pooler…/neondb?…"
#   export APP_URL=…
#   export CONTROL_URL_UNPOOLED=…
#   export APP_URL_UNPOOLED=…
#   ./scripts/provision-secrets.sh
#
# La alternativa obvia, un .env, es un fichero con las cuatro credenciales de
# la base de producción en el disco del portátil. Las variables de entorno de
# esta sesión también se pueden ver en /proc; la diferencia es que desaparecen
# al cerrar la terminal y no sobreviven a un `git status` descuidado.
#
# Uso:
#   GCP_PROJECT_ID=vondi-0q-staging ./scripts/provision-secrets.sh
#   GCP_PROJECT_ID=… KEYS_FROM_PROJECT=vondi-0q ./scripts/provision-secrets.sh
# ---------------------------------------------------------------------------

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-}"
PREFIX="${SERVICE_PREFIX:-netpay}"
# Copia `pii-*` y `netpay-encryption` de otro proyecto en lugar de generarlas.
# Necesario cuando la base de este entorno hereda filas cifradas con las claves
# del otro: sin esto, esas filas no se pueden descifrar. Son la excepción, no
# el patrón, porque significa que staging guarda las claves de producción.
KEYS_FROM_PROJECT="${KEYS_FROM_PROJECT:-}"

RUNTIME_SA="${PREFIX}-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
MIGRATOR_SA="${PREFIX}-migrator@${PROJECT_ID}.iam.gserviceaccount.com"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ -z "$PROJECT_ID" ]]; then
  echo "Falta GCP_PROJECT_ID." >&2
  exit 1
fi

for V in CONTROL_URL APP_URL CONTROL_URL_UNPOOLED APP_URL_UNPOOLED; do
  if [[ -z "${!V:-}" ]]; then
    echo "Falta \$$V (ver la cabecera del script)." >&2
    exit 1
  fi
done

# scripts/migrate.ts aborta si la URL de migración apunta al pooler. Es el mismo
# criterio que aplica el runtime, comprobado aquí para que el fallo salga al
# provisionar y no en el primer despliegue.
if [[ "$CONTROL_URL_UNPOOLED" == *"-pooler."* ]]; then
  echo "CONTROL_URL_UNPOOLED apunta al pooler (-pooler.); las migraciones" >&2
  echo "deben usar el host directo." >&2
  exit 1
fi

exists() { gcloud "$@" >/dev/null 2>&1; }

# Crea el secreto si falta. No añade versiones nuevas a los que ya existen:
# un `add-rotation` accidental cambiaría la clave de algo que ya está cifrado.
mk() {
  local name="$1" value="$2"
  if exists secrets describe "$name" --project "$PROJECT_ID"; then
    echo "  $name ya existe; no se toca"
    return 0
  fi
  if $DRY_RUN; then
    echo "  [dry-run] secrets create $name"
    return 0
  fi
  printf '%s' "$value" | gcloud secrets create "$name" \
    --project "$PROJECT_ID" --replication-policy=automatic --data-file=- >/dev/null
  echo "  $name creado"
}

copy() {
  local name="$1" value
  if exists secrets describe "$name" --project "$PROJECT_ID"; then
    echo "  $name ya existe; no se toca"
    return 0
  fi
  if $DRY_RUN; then
    echo "  [dry-run] copy $name desde $KEYS_FROM_PROJECT"
    return 0
  fi
  value="$(gcloud secrets versions access latest \
    --secret="$name" --project="$KEYS_FROM_PROJECT" 2>/dev/null)"
  if [[ -z "$value" ]]; then
    echo "No se pudo leer $name de $KEYS_FROM_PROJECT." >&2
    exit 1
  fi
  printf '%s' "$value" | gcloud secrets create "$name" \
    --project "$PROJECT_ID" --replication-policy=automatic --data-file=- >/dev/null
  echo "  $name copiado de $KEYS_FROM_PROJECT"
}

JWT_ACCESS="$(openssl rand -base64 48)"
JWT_REFRESH="$(openssl rand -base64 48)"
PII_HMAC="$(openssl rand -base64 48)"
PII_ENCRYPTION="$(openssl rand -base64 32)"
NETPAY_ENCRYPTION="$(openssl rand -base64 32)"
DOCS_PASSWORD="$(openssl rand -base64 24)"

echo "Secretos de $PROJECT_ID"
mk jwt-access-secret "$JWT_ACCESS"
mk jwt-refresh-secret "$JWT_REFRESH"
if [[ -n "$KEYS_FROM_PROJECT" ]]; then
  echo "Claves de cifrado copiadas de $KEYS_FROM_PROJECT"
  copy pii-hmac-key
  copy pii-encryption-key
  copy netpay-encryption-key
else
  mk pii-hmac-key "$PII_HMAC"
  mk pii-encryption-key "$PII_ENCRYPTION"
  mk netpay-encryption-key "$NETPAY_ENCRYPTION"
fi
mk docs-basic-auth-password "$DOCS_PASSWORD"
mk control-plane-db-url "$CONTROL_URL"
mk tenant-plane-db-url "$APP_URL"
mk control-plane-db-url-unpooled "$CONTROL_URL_UNPOOLED"
mk tenant-plane-db-url-unpooled "$APP_URL_UNPOOLED"

echo "Acceso por secreto y por cuenta"
# Nunca a nivel de proyecto: `roles/secretmanager.secretAccessor` sobre todo el
# proyecto deja que cualquier SA del entorno lea los secretos de los demás.
grant() {
  local secret="$1" sa="$2"
  if $DRY_RUN; then
    echo "  [dry-run] grant $secret -> $sa"
    return 0
  fi
  gcloud secrets add-iam-policy-binding "$secret" --project "$PROJECT_ID" \
    --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor" \
    --condition=None --quiet >/dev/null
}

# El runtime NO accede a las URLs directas: la conexión sin pooler existe
# para migraciones y administration, y dársela a la ruta de peticiones ampliaría
# el radio de acción de una inyección.
for S in jwt-access-secret jwt-refresh-secret pii-hmac-key pii-encryption-key \
  netpay-encryption-key docs-basic-auth-password control-plane-db-url tenant-plane-db-url; do
  grant "$S" "$RUNTIME_SA"
done
grant control-plane-db-url-unpooled "$MIGRATOR_SA"
grant tenant-plane-db-url-unpooled "$MIGRATOR_SA"

if $DRY_RUN; then
  exit 0
fi

cat <<EOF

Secretos listos.

Claves que este entorno acaba de crear y que NO son rotables. Cópialas a un
lugar fuera de GCP ahora: si se pierden, el PII escrito con ellas queda
indescifrable y la única salida es el proyecto de recifrado por lotes (RB-04).

  PII_HMAC_KEY         $PII_HMAC
  PII_ENCRYPTION_KEY   $PII_ENCRYPTION
  NETPAY_ENCRYPTION_KEY $NETPAY_ENCRYPTION

Para restaurarlas tal cual:

  printf '%s' '<valor>' | gcloud secrets versions add pii-encryption-key \\
    --project=$PROJECT_ID --data-file=-

Contraseña de la documentación (la usan el usuario 'docs' y, en Cloud Run, el
valor de DOCS_BASIC_AUTH_PASSWORD):

  DOCS_BASIC_AUTH_PASSWORD  $DOCS_PASSWORD

Referencia ':latest' en los rotables (los *-secret). Para los no rotables,
fijar la versión numérica en el --set-secrets del servicio y del Job
(pii-encryption-key:1, pii-hmac-key:1, netpay-encryption-key:1): así una versión
nueva accidental no llega a producción sin un despliegue.
EOF