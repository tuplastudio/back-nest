#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Provisiona la red de egress del proyecto: VPC, subred, router y Cloud NAT
# con una dirección externa reservada.
#
# Implementa §5.1 de docs/DEPLOY-GCP.md. Es idempotente: se puede volver a
# ejecutar y lo que ya existe se deja como está.
#
# POR QUÉ ESTO EXISTE
#
# La IP de salida de Cloud Run es efímera si no se fija. Neon solo puede
# permitir una IP estable si el servicio sale por una dirección que no cambie,
# y esa dirección la aporta el Cloud NAT. Sin esto, la allowlist de Neon tendría
# que aceptar el rango de IP público de Google, que no es un rango estable que
# uno pueda autorizar.
#
# POR QUÉ NO SE EJECUTA AUTOMÁTICAMENTE
#
# El orden importa y hay un paso fuera de GCP:
#
#   1. este script (crea la red y reserva la IP)
#   2. autorizar esa IP /32 en Neon            <- fuera de GCP, paso manual
#   3. gcloud run services update ... --vpc-egress=all-traffic
#
# Saltarse el paso 2 deja el servicio sin poder conectar con la base: por eso
# este script no toca ningún servicio. Al terminar imprime la IP y el comando
# exacto del paso 3.
#
# Coste: Cloud NAT (~0.044 USD/h por IP) más la dirección reservada. Se factura
# desde que se crea el router, aunque nadie lo use.
#
# Uso:
#   GCP_PROJECT_ID=vondi-0q REGION=us-east5 ./scripts/provision-network.sh
#   ./scripts/provision-network.sh --dry-run   # solo muestra lo que haría
# ---------------------------------------------------------------------------

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-}"
REGION="${REGION:-us-east5}"
NETWORK="${NETWORK:-vondi-net}"
SUBNET="${SUBNET:-vondi-subnet}"
SUBNET_RANGE="${SUBNET_RANGE:-10.60.0.0/24}"
ROUTER="${ROUTER:-vondi-router}"
NAT="${NAT:-vondi-nat}"
ADDRESS="${ADDRESS:-vondi-egress}"
RUNTIME_SA="${RUNTIME_SA:-vondi-runtime@${PROJECT_ID}.iam.gserviceaccount.com}"
MIGRATOR_SA="${MIGRATOR_SA:-vondi-migrator@${PROJECT_ID}.iam.gserviceaccount.com}"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ -z "$PROJECT_ID" ]]; then
  echo "Falta GCP_PROJECT_ID." >&2
  exit 1
fi

run() {
  if $DRY_RUN; then
    printf '  [dry-run] %s\n' "$*"
  else
    printf '  %s\n' "$*"
    "$@"
  fi
}

exists() { gcloud "$@" >/dev/null 2>&1; }

echo "Proyecto: $PROJECT_ID · región: $REGION"

echo "Red"
if exists compute networks describe "$NETWORK" --project "$PROJECT_ID"; then
  echo "  $NETWORK ya existe"
else
  run gcloud compute networks create "$NETWORK" --subnet-mode=custom --project "$PROJECT_ID"
fi

if exists compute networks subnets describe "$SUBNET" --region "$REGION" --project "$PROJECT_ID"; then
  echo "  $SUBNET ya existe"
else
  # Private Google Access es necesario: con --vpc-egress=all-traffic el acceso a
  # las APIs de Google también pasa por la VPC, y sin esto no habría ruta a
  # Secret Manager ni a los endpoints de Cloud Run.
  run gcloud compute networks subnets create "$SUBNET" \
    --network "$NETWORK" --range "$SUBNET_RANGE" --region "$REGION" \
    --enable-private-ip-google-access --project "$PROJECT_ID"
fi

echo "Router"
if exists compute routers describe "$ROUTER" --region "$REGION" --project "$PROJECT_ID"; then
  echo "  $ROUTER ya existe"
else
  run gcloud compute routers create "$ROUTER" \
    --network "$NETWORK" --region "$REGION" --project "$PROJECT_ID"
fi

echo "Dirección externa reservada"
if exists compute addresses describe "$ADDRESS" --region "$REGION" --project "$PROJECT_ID"; then
  echo "  $ADDRESS ya existe"
else
  run gcloud compute addresses create "$ADDRESS" --region "$REGION" \
    --address-tier=PREMIUM --ip-version=IPV4 --purpose=VPC --project "$PROJECT_ID"
fi

echo "Cloud NAT"
NAT_IP=$(gcloud compute addresses describe "$ADDRESS" --region "$REGION" --project "$PROJECT_ID" --format='value(address)' 2>/dev/null || echo '')
if exists compute routers nats describe "$NAT" --router "$ROUTER" --region "$REGION" --project "$PROJECT_ID"; then
  echo "  $NAT ya existe"
else
  run gcloud compute routers nats create "$NAT" \
    --router "$ROUTER" --region "$REGION" \
    --nat-ip-allocation-option=manual --nat-manual-ips="$NAT_IP" \
    --source-subnetwork-ip-ranges-to-nat=ALL_SUBNETWORKS_ALL_IP_RANGES \
    --enable-logging --project "$PROJECT_ID"
fi

echo "IAM de red para las cuentas de servicio"
for SA in "$RUNTIME_SA" "$MIGRATOR_SA"; do
  run gcloud compute networks subnets add-iam-policy-binding "$SUBNET" \
    --region "$REGION" --project "$PROJECT_ID" \
    --member="serviceAccount:$SA" --role="roles/compute.networkUser"
done

cat <<EOF

Red lista${NAT_IP:+ (IP reservada: $NAT_IP)}.

Falta el paso fuera de GCP, y es el que hace que esto sirva de algo:

  Autorizar $NAT_IP/32 en Neon (Settings → Network Restrictions / Allowed IPs)

Hasta que esa IP esté en la allowlist, NO ejecutes el paso siguiente: el
servicio dejaría de alcanzar la base. Cuando ya esté:

  gcloud run services update vondi-api --region=$REGION \\
    --network=$NETWORK --subnet=$SUBNET --vpc-egress=all-traffic --quiet

  gcloud run jobs update vondi-migrate --region=$REGION \\
    --network=$NETWORK --subnet=$SUBNET --vpc-egress=all-traffic --quiet

Y añade al workflow, en los pasos de deploy y migrate:

  --network=$NETWORK --subnet=$SUBNET --vpc-egress=all-traffic
EOF