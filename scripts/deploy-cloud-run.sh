#!/bin/bash
set -e

# ==============================================================================
# Deployment script for Google Cloud Run with Neon.tech database
# ==============================================================================

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration - Override these with environment variables or edit directly
PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-vondi-api}"
REPOSITORY="${REPOSITORY:-cloud-run-source-deploy}"
IMAGE_NAME="${IMAGE_NAME:-vondi-api}"

# Cloud Run configuration
MEMORY="${MEMORY:-512Mi}"
CPU="${CPU:-1}"
MAX_INSTANCES="${MAX_INSTANCES:-100}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
TIMEOUT="${TIMEOUT:-300s}"
CONCURRENCY="${CONCURRENCY:-80}"

# Neon database configuration
NEON_PROJECT_ID="${NEON_PROJECT_ID:-}"
NEON_DATABASE_NAME="${NEON_DATABASE_NAME:-neondb}"
NEON_BRANCH="${NEON_BRANCH:-br_main}"

# ==============================================================================
# Helper functions
# ==============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_required_vars() {
    local missing_vars=()

    if [ -z "$PROJECT_ID" ]; then
        missing_vars+=("PROJECT_ID")
    fi

    if [ -z "$NEON_PROJECT_ID" ]; then
        missing_vars+=("NEON_PROJECT_ID")
    fi

    if [ ${#missing_vars[@]} -gt 0 ]; then
        log_error "Missing required environment variables:"
        for var in "${missing_vars[@]}"; do
            echo "  - $var"
        done
        echo ""
        echo "Example usage:"
        echo "  PROJECT_ID=my-project NEON_PROJECT_ID=xxx ./scripts/deploy-cloud-run.sh"
        exit 1
    fi
}

get_neon_connection_string() {
    local role="$1"
    local is_pooled="$2"

    if [ "$is_pooled" = "true" ]; then
        # Pooled connection (for application runtime)
        echo "postgresql://${role}:${role}@${NEON_PROJECT_ID}.pooler.neon.tech/${NEON_DATABASE_NAME}?sslmode=require&connection_limit=3&pool_timeout=20"
    else
        # Unpooled connection (for migrations, prisma studio, etc.)
        echo "postgresql://${role}:${role}@${NEON_PROJECT_ID}.neon.tech/${NEON_DATABASE_NAME}?sslmode=require"
    fi
}

# ==============================================================================
# Main deployment steps
# ==============================================================================

main() {
    log_info "Starting deployment of ${SERVICE_NAME} to Cloud Run..."
    echo ""

    # Check required variables
    check_required_vars

    # Ensure gcloud is authenticated
    log_info "Checking gcloud authentication..."
    if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q "@"; then
        log_warning "Not authenticated with gcloud. Running authentication..."
        gcloud auth login
    fi
    log_success "Authenticated with gcloud"

    # Set the project
    log_info "Setting project to ${PROJECT_ID}..."
    gcloud config set project "$PROJECT_ID"

    # Enable required APIs
    log_info "Enabling required Google Cloud APIs..."
    gcloud services enable \
        cloudbuild.googleapis.com \
        run.googleapis.com \
        artifactregistry.googleapis.com \
        secretmanager.googleapis.com \
        sqladmin.googleapis.com

    # Create Artifact Registry repository if it doesn't exist
    log_info "Checking Artifact Registry repository..."
    if ! gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" &>/dev/null; then
        log_info "Creating Artifact Registry repository ${REPOSITORY}..."
        gcloud artifacts repositories create "$REPOSITORY" \
            --repository-format=docker \
            --location="$REGION" \
            --description="Docker repository for Cloud Run deployments"
    fi
    log_success "Artifact Registry repository ready"

    # ==============================================================================
    # Neon Database Setup
    # ==============================================================================
    log_info "Setting up Neon.tech database connection..."

    # Generate connection strings
    CONTROL_PLANE_POOLED=$(get_neon_connection_string "postgres" "true")
    CONTROL_PLANE_UNPOOLED=$(get_neon_connection_string "postgres" "false")
    TENANT_PLANE_POOLED=$(get_neon_connection_string "mtb_app" "true")
    TENANT_PLANE_UNPOOLED=$(get_neon_connection_string "mtb_app" "false")

    log_success "Neon connection strings generated"

    # ==============================================================================
    # Secret Manager Setup
    # ==============================================================================
    log_info "Setting up Secret Manager secrets..."

    # Function to create or update a secret
    upsert_secret() {
        local secret_name="$1"
        local secret_value="$2"

        if gcloud secrets describe "$secret_name" &>/dev/null; then
            log_info "Updating secret: $secret_name"
            echo -n "$secret_value" | gcloud secrets versions add "$secret_name" --data-file=-
        else
            log_info "Creating secret: $secret_name"
            echo -n "$secret_value" | gcloud secrets create "$secret_name" --data-file=-
        fi
    }

    # Database URLs
    upsert_secret "control-plane-db-url" "$CONTROL_PLANE_POOLED"
    upsert_secret "tenant-plane-db-url" "$TENANT_PLANE_POOLED"

    # Check if JWT secrets exist, if not generate them
    if ! gcloud secrets describe "jwt-access-secret" &>/dev/null; then
        log_warning "JWT_ACCESS_SECRET not found, generating one..."
        JWT_ACCESS_SECRET=$(openssl rand -base64 48)
        upsert_secret "jwt-access-secret" "$JWT_ACCESS_SECRET"
    fi

    if ! gcloud secrets describe "jwt-refresh-secret" &>/dev/null; then
        log_warning "JWT_REFRESH_SECRET not found, generating one..."
        JWT_REFRESH_SECRET=$(openssl rand -base64 48)
        upsert_secret "jwt-refresh-secret" "$JWT_REFRESH_SECRET"
    fi

    if ! gcloud secrets describe "pii-hmac-key" &>/dev/null; then
        log_warning "PII_HMAC_KEY not found, generating one..."
        PII_HMAC_KEY=$(openssl rand -base64 48)
        upsert_secret "pii-hmac-key" "$PII_HMAC_KEY"
    fi

    if ! gcloud secrets describe "pii-encryption-key" &>/dev/null; then
        log_warning "PII_ENCRYPTION_KEY not found, generating one..."
        PII_ENCRYPTION_KEY=$(openssl rand -base64 32)
        upsert_secret "pii-encryption-key" "$PII_ENCRYPTION_KEY"
    fi

    if ! gcloud secrets describe "netpay-encryption-key" &>/dev/null; then
        log_warning "NETPAY_ENCRYPTION_KEY not found, generating one..."
        NETPAY_ENCRYPTION_KEY=$(openssl rand -base64 32)
        upsert_secret "netpay-encryption-key" "$NETPAY_ENCRYPTION_KEY"
    fi

    log_success "Secrets configured"

    # Grant Cloud Run service account access to secrets
    PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
    COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

    log_info "Granting Cloud Run service account access to secrets..."
    for secret in \
        control-plane-db-url \
        tenant-plane-db-url \
        jwt-access-secret \
        jwt-refresh-secret \
        pii-hmac-key \
        pii-encryption-key \
        netpay-encryption-key; do
        gcloud secrets add-iam-policy-binding "$secret" \
            --member="serviceAccount:${COMPUTE_SA}" \
            --role="roles/secretmanager.secretAccessor" \
            --quiet
    done
    log_success "Secret access configured"

    # ==============================================================================
    # Build and Deploy
    # ==============================================================================
    log_info "Building and deploying with Cloud Build..."

    COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "manual")

    gcloud builds submit \
        --config cloudbuild.yaml \
        --substitutions="_REGION=${REGION},_REPOSITORY=${REPOSITORY},_IMAGE_NAME=${IMAGE_NAME},_SERVICE_NAME=${SERVICE_NAME},_MEMORY=${MEMORY},_CPU=${CPU},_MAX_INSTANCES=${MAX_INSTANCES},_MIN_INSTANCES=${MIN_INSTANCES},_TIMEOUT=${TIMEOUT},_CONCURRENCY=${CONCURRENCY},COMMIT_SHA=${COMMIT_SHA}" \
        .

    log_success "Deployment completed successfully!"
    echo ""

    # Get service URL
    SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)')
    log_success "Service URL: ${SERVICE_URL}"
    echo ""

    log_info "Next steps:"
    echo "  1. Test the deployment: curl ${SERVICE_URL}/health"
    echo "  2. Run database migrations: prisma migrate deploy --schema prisma/schema.prisma"
    echo "  3. Monitor logs: gcloud logs tail /run.googleapis.com/${SERVICE_NAME}"
}

# Run main function
main "$@"
