#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Cloud Scheduler → POST /internal/tick, SOLO STAGING (BN-TASK-016).
#
# Staging y producción escalan a cero con CPU throttling (decisión del dueño,
# 2026-10-21): la conciliación de pagos y el despacho de webhooks salientes solo
# corren mientras hay tráfico. En staging, un job de Cloud Scheduler llama cada
# 15 min a `POST /internal/tick`, que ejecuta una pasada de conciliación y un
# ciclo de despacho aunque nadie use la API. Producción NO tiene scheduler, por
# decisión del dueño (consecuencia: docs/RUNBOOK-PAYMENTS.md §1.2).
#
# Qué crea:
#   1. La cuenta de servicio dedicada `netpay-tick@vondi-0q-staging.iam.gserviceaccount.com`.
#   2. `roles/run.invoker` para ella sobre el servicio `netpay-api-staging`.
#   3. Las variables del servicio que el guard exige: INTERNAL_TICK_SA_EMAIL,
#      INTERNAL_TICK_AUDIENCE (= URL del servicio) y PUBLIC_BASE_URL (la misma
#      URL; la usa también el chequeo de drift del webhook). Esto crea una
#      revisión nueva con la misma imagen.
#   4. El job `netpay-internal-tick` (`*/15 * * * *`, UTC) con un token OIDC de esa
#      cuenta y audiencia = URL del servicio. El guard de la API rechaza cualquier
#      otro token (401) o identidad (403).
#
# Sin argumentos SOLO IMPRIME los comandos y no llama a gcloud (ni para leer).
# `--apply` los ejecuta; lo corre a mano quien tenga permisos sobre el proyecto,
# nunca CI:
#
#   scripts/gcp/scheduler-internal-tick.sh            # imprime
#   scripts/gcp/scheduler-internal-tick.sh --apply    # ejecuta
#
# El proyecto, la región y el servicio están fijos a staging a propósito: el
# script se niega a apuntar a otro proyecto.
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT_ID="vondi-0q-staging"
REGION="us-east5"
SERVICE="netpay-api-staging"
# Cloud Scheduler vive en una región propia; por defecto la del servicio.
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-$REGION}"
SA_NAME="netpay-tick"
SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
JOB="netpay-internal-tick"
SCHEDULE="*/15 * * * *"

if [[ -n "${GCP_PROJECT_ID:-}" && "${GCP_PROJECT_ID}" != "$PROJECT_ID" ]]; then
  echo "Este script es solo para staging ($PROJECT_ID); GCP_PROJECT_ID=$GCP_PROJECT_ID no se admite." >&2
  echo "Producción no lleva scheduler por decisión del dueño (docs/RUNBOOK-PAYMENTS.md §1.2)." >&2
  exit 2
fi

APPLY=false
case "${1:-}" in
  --apply) APPLY=true ;;
  "") ;;
  *) echo "Uso: $0 [--apply]" >&2; exit 2 ;;
esac

# run <cmd...>: imprime; con --apply, además ejecuta.
run() {
  if $APPLY; then
    printf '+ %s\n' "$*"
    "$@"
  else
    printf '[dry-run] %s\n' "$*"
  fi
}

# La URL del servicio es la audiencia del token y la base del webhook. En modo
# impresión no se consulta: se usa SERVICE_URL si viene, si no un marcador.
if $APPLY; then
  SERVICE_URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --format='value(status.url)')"
else
  SERVICE_URL="${SERVICE_URL:-https://<url-de-netpay-api-staging>.run.app}"
fi
case "$SERVICE_URL" in
  https://*) ;;
  *) echo "URL de servicio inesperada: $SERVICE_URL" >&2; exit 1 ;;
esac

echo "# Proyecto $PROJECT_ID · servicio $SERVICE ($REGION) · scheduler en $SCHEDULER_LOCATION"
echo "# Audiencia/URL: $SERVICE_URL"

# 0. API de Cloud Scheduler.
run gcloud services enable cloudscheduler.googleapis.com --project="$PROJECT_ID"

# 1. Cuenta de servicio dedicada (sin llaves: solo la usa Cloud Scheduler para firmar tokens).
if $APPLY && gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "# La cuenta $SA_EMAIL ya existe."
else
  run gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT_ID" \
    --display-name="netpay /internal/tick (Cloud Scheduler)"
fi

# 2. Puede invocar el servicio (y nada más).
run gcloud run services add-iam-policy-binding "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --member="serviceAccount:$SA_EMAIL" --role="roles/run.invoker"

# 3. Lo que el guard de /internal/tick comprueba. --update-env-vars conserva el resto.
run gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --update-env-vars="INTERNAL_TICK_SA_EMAIL=$SA_EMAIL,INTERNAL_TICK_AUDIENCE=$SERVICE_URL,PUBLIC_BASE_URL=$SERVICE_URL"

# 4. El job: crear, o actualizar si ya existe.
JOB_ARGS=(
  --project="$PROJECT_ID" --location="$SCHEDULER_LOCATION"
  --schedule="$SCHEDULE" --time-zone="Etc/UTC"
  --uri="$SERVICE_URL/internal/tick" --http-method=POST
  --oidc-service-account-email="$SA_EMAIL" --oidc-token-audience="$SERVICE_URL"
  --attempt-deadline=300s
)
if $APPLY && gcloud scheduler jobs describe "$JOB" --project="$PROJECT_ID" --location="$SCHEDULER_LOCATION" >/dev/null 2>&1; then
  run gcloud scheduler jobs update http "$JOB" "${JOB_ARGS[@]}"
else
  run gcloud scheduler jobs create http "$JOB" "${JOB_ARGS[@]}" \
    --description="Conciliación de pagos + despacho de webhooks (BN-TASK-016)"
fi

echo
echo "# Verificar (a mano):"
echo "#   gcloud scheduler jobs run $JOB --project=$PROJECT_ID --location=$SCHEDULER_LOCATION"
echo "#   gcloud logging read 'resource.labels.service_name=\"$SERVICE\" AND jsonPayload.event=\"reconcile_checked\"' --project=$PROJECT_ID --limit=5"
if ! $APPLY; then
  echo "(solo impreso; --apply para ejecutarlo)"
fi
