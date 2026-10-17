#!/bin/bash
set -e

# ==============================================================================
# Script to run Prisma migrations on Neon.tech database
# ==============================================================================

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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

# Configuration
NEON_PROJECT_ID="${NEON_PROJECT_ID:-}"
NEON_DATABASE_NAME="${NEON_DATABASE_NAME:-neondb}"

# Check required variables
if [ -z "$NEON_PROJECT_ID" ]; then
    log_error "NEON_PROJECT_ID is required"
    echo "Usage: NEON_PROJECT_ID=xxx ./scripts/run-migrations-neon.sh"
    exit 1
fi

# Set up database URLs for Prisma
export CONTROL_PLANE_DATABASE_URL="postgresql://postgres:postgres@${NEON_PROJECT_ID}.neon.tech/${NEON_DATABASE_NAME}?sslmode=require"
export CONTROL_PLANE_DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@${NEON_PROJECT_ID}.neon.tech/${NEON_DATABASE_NAME}?sslmode=require"
export TENANT_PLANE_DATABASE_URL="postgresql://mtb_app:mtb_app@${NEON_PROJECT_ID}.neon.tech/${NEON_DATABASE_NAME}?sslmode=require"
export TENANT_PLANE_DATABASE_URL_UNPOOLED="postgresql://mtb_app:mtb_app@${NEON_PROJECT_ID}.neon.tech/${NEON_DATABASE_NAME}?sslmode=require"

log_info "Running Prisma migrations on Neon..."

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    log_info "Installing dependencies..."
    npm ci
fi

# Generate Prisma client
log_info "Generating Prisma client..."
npm run prisma:generate

# Run control plane migrations
log_info "Running control plane migrations..."
npx prisma migrate deploy --schema prisma/schema.prisma

log_success "Migrations completed successfully!"
log_info "Note: Tenant migrations are applied dynamically by the provisioner when new tenants are created."
