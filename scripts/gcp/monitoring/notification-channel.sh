#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Crea (si no existe) el canal de notificación on-call por email y lo añade a
# TODAS las políticas de alerta del proyecto que no lo tengan (BN-REQ-OPS-003:
# una alerta sin canal no avisa a nadie).
#
#   PROJECT_ID=vondi-0q scripts/gcp/monitoring/notification-channel.sh oncall@tupla.dev [--apply]
#
# Imprime el nombre del canal (projects/…/notificationChannels/…) en stdout,
# para pasarlo como CHANNEL a uptime-check.sh y slo.sh.
# ---------------------------------------------------------------------------
# shellcheck source-path=SCRIPTDIR source=_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

EMAIL="${ARGS[0]:-${ONCALL_EMAIL:-}}"
[[ "$EMAIL" == *@* ]] || { echo "Uso: $0 <email-on-call> [--apply]" >&2; exit 2; }
DISPLAY_NAME="${CHANNEL_NAME:-netpay on-call ($EMAIL)}"

CHANNEL=$(gcloud beta monitoring channels list --project="$PROJECT_ID" \
  --filter="type=\"email\" AND labels.email_address=\"$EMAIL\"" --format='value(name)' 2>/dev/null | head -n1 || true)

if [[ -z "$CHANNEL" ]]; then
  run gcloud beta monitoring channels create --project="$PROJECT_ID" \
    --display-name="$DISPLAY_NAME" --type=email \
    --channel-labels="email_address=$EMAIL" --format='value(name)'
  if $APPLY; then
    CHANNEL=$(gcloud beta monitoring channels list --project="$PROJECT_ID" \
      --filter="type=\"email\" AND labels.email_address=\"$EMAIL\"" --format='value(name)' | head -n1)
  else
    CHANNEL="projects/$PROJECT_ID/notificationChannels/<nuevo>"
  fi
fi
echo "Canal: $CHANNEL" >&2

# Políticas existentes sin este canal.
POLICIES=$(gcloud alpha monitoring policies list --project="$PROJECT_ID" --format=json 2>/dev/null |
  jq -r --arg c "$CHANNEL" '.[] | select((.notificationChannels // []) | index($c) | not) | .name' || true)
if [[ -z "$POLICIES" ]]; then
  echo "Todas las políticas ya notifican a $CHANNEL (o no se pudieron listar)." >&2
fi
while read -r POLICY; do
  [[ -n "$POLICY" ]] || continue
  run gcloud alpha monitoring policies update "$POLICY" --project="$PROJECT_ID" \
    --add-notification-channels="$CHANNEL"
done <<<"$POLICIES"

echo "$CHANNEL"
