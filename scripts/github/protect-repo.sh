#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Protección del repositorio en GitHub (BN-REQ-OPS-001), como código:
#
#   * environment `production`: aprobación de al menos un revisor y solo la
#     rama `main` puede desplegar en él;
#   * environment `staging`: sin revisores (los PR despliegan ahí a propósito);
#   * environments `staging-readonly` y `production-readonly`: los usa
#     drift-check.yml, programado, que no puede esperar aprobación; solo `main`;
#   * rama `main`: PR con 1 aprobación, revisiones obsoletas descartadas, checks
#     de CI obligatorios y al día, sin force-push ni borrado, también para admins.
#
# Por defecto SOLO IMPRIME las llamadas a la API. `--apply` las ejecuta;
# `--verify` lee la configuración actual y falla si no coincide (solo GET).
#
#   REPO=tuplastudio/back-nest REVIEWERS="user:octocat team:payments-oncall" \
#     scripts/github/protect-repo.sh [--apply|--verify]
#
# Requiere `gh` autenticado con admin del repositorio para --apply.
# Los nombres de los checks son los del job llamador en deploy.yml
# («CI / …»): si se renombra un job de ci.yml, actualizar REQUIRED_CHECKS.
# ---------------------------------------------------------------------------
set -euo pipefail

APPLY=false
VERIFY=false
case "${1:-}" in
  --apply) APPLY=true ;;
  --verify) VERIFY=true ;;
  "") ;;
  *) echo "Uso: $0 [--apply|--verify]" >&2; exit 2 ;;
esac

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"
: "${REPO:?Define REPO=owner/name.}"
REVIEWERS="${REVIEWERS:-}"
REQUIRED_CHECKS=("CI / Verificación, tests y e2e" "CI / Vulnerabilidades")

# gh_api <método> <ruta> [json]
gh_api() {
  local method="$1" path="$2" body="${3:-}"
  if ! $APPLY; then
    printf '[dry-run] gh api -X %s %s\n' "$method" "$path"
    [[ -n "$body" ]] && jq . <<<"$body" | sed 's/^/    /'
    return 0
  fi
  if [[ -n "$body" ]]; then
    gh api -X "$method" "$path" -H 'Accept: application/vnd.github+json' --input - <<<"$body" >/dev/null
  else
    gh api -X "$method" "$path" -H 'Accept: application/vnd.github+json' >/dev/null
  fi
  printf 'OK %s %s\n' "$method" "$path"
}

# "user:login team:slug" → [{"type":"User","id":…}, …]
reviewers_json() {
  local out='[]' kind name id
  for R in $REVIEWERS; do
    kind="${R%%:*}"
    name="${R#*:}"
    if [[ "$kind" == "team" ]]; then
      id=$(gh api "orgs/${REPO%%/*}/teams/$name" -q .id 2>/dev/null || echo "<id de $name>")
      out=$(jq --arg id "$id" '. + [{type: "Team", id: ($id | tonumber? // $id)}]' <<<"$out")
    else
      id=$(gh api "users/$name" -q .id 2>/dev/null || echo "<id de $name>")
      out=$(jq --arg id "$id" '. + [{type: "User", id: ($id | tonumber? // $id)}]' <<<"$out")
    fi
  done
  echo "$out"
}

# Environment restringido a `main` mediante una política de ramas propia.
main_only_environment() { # <nombre> <json-de-reviewers>
  local name="$1" reviewers="$2"
  gh_api PUT "repos/$REPO/environments/$name" "$(jq -n --argjson r "$reviewers" '{
    reviewers: $r,
    prevent_self_review: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  }')"
  gh_api POST "repos/$REPO/environments/$name/deployment-branch-policies" '{"name":"main","type":"branch"}'
}

if $VERIFY; then
  FAIL=0
  check() { if eval "$2"; then echo "ok    $1"; else echo "FALLA $1"; FAIL=1; fi; }
  PROD=$(gh api "repos/$REPO/environments/production")
  check "production exige revisor" \
    "jq -e '[.protection_rules[]? | select(.type==\"required_reviewers\") | .reviewers[]] | length > 0' <<<'$PROD' >/dev/null"
  check "production solo desde ramas con política propia" \
    "jq -e '.deployment_branch_policy.custom_branch_policies == true' <<<'$PROD' >/dev/null"
  check "la política de production es exactamente main" \
    "[[ \$(gh api repos/$REPO/environments/production/deployment-branch-policies -q '[.branch_policies[].name] | join(\",\")') == main ]]"
  PROTECTION=$(gh api "repos/$REPO/branches/main/protection")
  check "main exige 1 aprobación" \
    "jq -e '.required_pull_request_reviews.required_approving_review_count >= 1' <<<'$PROTECTION' >/dev/null"
  for C in "${REQUIRED_CHECKS[@]}"; do
    check "main exige el check «$C»" \
      "jq -e --arg c \"$C\" '.required_status_checks.contexts | index(\$c)' <<<'$PROTECTION' >/dev/null"
  done
  exit $FAIL
fi

if [[ -z "$REVIEWERS" ]]; then
  echo "REVIEWERS vacío: production quedaría sin aprobación. Define REVIEWERS=\"user:<login> team:<slug>\"." >&2
  exit 2
fi
$APPLY || echo "Modo simulación: nada se escribe. Repite con --apply." >&2

# --- Environments ------------------------------------------------------------
main_only_environment production "$(reviewers_json)"
main_only_environment production-readonly '[]'
main_only_environment staging-readonly '[]'
# Staging sin política de ramas: los PR despliegan ahí desde refs/pull/N/merge,
# que ninguna política de ramas admite.
gh_api PUT "repos/$REPO/environments/staging" '{"deployment_branch_policy": null}'

# --- Protección de main --------------------------------------------------------
gh_api PUT "repos/$REPO/branches/main/protection" "$(jq -n --args '{
  required_status_checks: { strict: true, contexts: $ARGS.positional },
  enforce_admins: true,
  required_pull_request_reviews: {
    required_approving_review_count: 1,
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false
  },
  restrictions: null,
  required_linear_history: false,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: true
}' "${REQUIRED_CHECKS[@]}")"

echo "Listo. Comprobar con: $0 --verify" >&2
