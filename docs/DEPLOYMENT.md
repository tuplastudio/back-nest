# Deployment Guide: Google Cloud Run + Neon.tech

> **Sustituido por [DEPLOY-GCP.md](DEPLOY-GCP.md)**, que es la guía vigente:
> define la topología real (VPC + Cloud NAT + egress fijo, canario, Ingress
> cerrado, IAM por servicio) y el pipeline `deploy.yml`. Este documento se
> conserva como referencia histórica del arranque con Cloud Build; sus scripts
> (`cloudbuild.yaml`, `scripts/deploy-cloud-run.sh`) y sus comandos de
> despliegue **ya no existen** y su región por defecto (`us-central1`) no es la
> de producción (`us-east5`). No lo sigas para desplegar.

This guide explains how to deploy the Vondi API to Google Cloud Run using Neon.tech as the PostgreSQL database provider.

## Prerequisites

Before deploying, ensure you have:

1. **Google Cloud Project** with billing enabled
2. **gcloud CLI** installed and authenticated
3. **Neon.tech account** with a PostgreSQL project
4. **Docker** installed locally (for testing)
5. **Git** installed

### Install Google Cloud CLI

```bash
# macOS
brew install google-cloud-sdk

# Initialize and authenticate
gcloud init
gcloud auth login
```

### Install Docker

```bash
# macOS
brew install --cask docker
```

## Architecture Overview

- **Compute**: Google Cloud Run (serverless containers)
- **Database**: Neon.tech (managed PostgreSQL)
- **Container Registry**: Google Artifact Registry
- **Secrets**: Google Secret Manager
- **Build**: Google Cloud Build

## Step 1: Set Up Neon.tech Database

### 1.1 Create a Neon Project

1. Go to [Neon Console](https://console.neon.tech)
2. Create a new project
3. Note the **Project ID** (format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

### 1.2 Create Database Roles

The application requires two PostgreSQL roles:

- `postgres`: Control plane role (platform administrators, tenant registry)
- `mtb_app`: Tenant plane role (tenant data with row-level security)

You can create these roles using the Neon SQL Editor:

```sql
-- Create mtb_app role for tenant data plane
CREATE ROLE mtb_app WITH LOGIN PASSWORD 'your-secure-password';

-- Grant necessary permissions
GRANT CONNECT ON DATABASE neondb TO mtb_app;
GRANT USAGE ON SCHEMA public TO mtb_app;
GRANT CREATE ON SCHEMA public TO mtb_app;
```

**Important**: In production, use strong passwords and store them securely.

### 1.3 Get Connection Strings

Neon provides two types of connection strings:

- **Pooled**: For application runtime (uses PgBouncer)
- **Unpooled**: For migrations and direct operations

Example formats:
```
# Pooled (application)
postgresql://user:password@project-id.pooler.neon.tech/database?sslmode=require

# Unpooled (migrations)
postgresql://user:password@project-id.neon.tech/database?sslmode=require
```

## Step 2: Configure Google Cloud Project

### 2.1 Set Project Variables

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"  # Choose a region near you
export NEON_PROJECT_ID="your-neon-project-id"

gcloud config set project $PROJECT_ID
```

### 2.2 Enable Required APIs

```bash
gcloud services enable \
    cloudbuild.googleapis.com \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    sqladmin.googleapis.com
```

### 2.3 Create Artifact Registry Repository

```bash
gcloud artifacts repositories create cloud-run-source-deploy \
    --repository-format=docker \
    --location=$REGION \
    --description="Docker repository for Cloud Run deployments"
```

## Step 3: Deploy Using the Automated Script

The easiest way to deploy is using the provided script:

```bash
# From the project root
PROJECT_ID=my-project \
NEON_PROJECT_ID=your-neon-project-id \
./scripts/deploy-cloud-run.sh
```

### What the Script Does

1. **Authenticates** with Google Cloud
2. **Enables** required APIs
3. **Creates** Artifact Registry repository (if needed)
4. **Generates** Neon connection strings
5. **Creates/updates** secrets in Secret Manager:
   - `control-plane-db-url`
   - `tenant-plane-db-url`
   - `jwt-access-secret` (auto-generated if missing)
   - `jwt-refresh-secret` (auto-generated if missing)
   - `pii-hmac-key` (auto-generated if missing)
   - `pii-encryption-key` (auto-generated if missing)
   - `netpay-encryption-key` (auto-generated if missing)
6. **Grants** Cloud Run service account access to secrets
7. **Builds** the Docker image using Cloud Build
8. **Deploys** to Cloud Run

### Customizing Deployment

You can override default configuration:

```bash
PROJECT_ID=my-project \
NEON_PROJECT_ID=xxx \
REGION=europe-west1 \
SERVICE_NAME=netpay-api \
MEMORY=1Gi \
CPU=2 \
MAX_INSTANCES=50 \
MIN_INSTANCES=1 \
./scripts/deploy-cloud-run.sh
```

## Step 4: Run Database Migrations

After deployment, run the Prisma migrations on Neon:

```bash
NEON_PROJECT_ID=your-neon-project-id ./scripts/run-migrations-neon.sh
```

This will:
1. Generate Prisma client
2. Apply control plane migrations
3. Prepare tenant migration templates

**Note**: Tenant-specific migrations are applied dynamically by the application's provisioner when new tenants are created.

## Step 5: Verify Deployment

### 5.1 Check Service Status

```bash
gcloud run services describe netpay-api --region=$REGION
```

### 5.2 Test Health Endpoint

```bash
SERVICE_URL=$(gcloud run services describe netpay-api --region=$REGION --format='value(status.url)')
curl $SERVICE_URL/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 5.3 View Logs

```bash
gcloud logs tail /run.googleapis.com/netpay-api --region=$REGION
```

## Manual Deployment (Alternative)

If you prefer manual deployment instead of the script:

### 1. Build and Push Docker Image

```bash
# Build image
docker build -t $REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/netpay-api:latest .

# Push to Artifact Registry
docker push $REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/netpay-api:latest
```

### 2. Create Secrets Manually

```bash
# Database URLs
echo -n "postgresql://postgres:password@xxx.pooler.neon.tech/neondb?sslmode=require" | \
  gcloud secrets create control-plane-db-url --data-file=-

echo -n "postgresql://mtb_app:password@xxx.pooler.neon.tech/neondb?sslmode=require" | \
  gcloud secrets create tenant-plane-db-url --data-file=-

# Generate other secrets
openssl rand -base64 48 | gcloud secrets create jwt-access-secret --data-file=-
openssl rand -base64 48 | gcloud secrets create jwt-refresh-secret --data-file=-
openssl rand -base64 48 | gcloud secrets create pii-hmac-key --data-file=-
openssl rand -base64 32 | gcloud secrets create pii-encryption-key --data-file=-
openssl rand -base64 32 | gcloud secrets create netpay-encryption-key --data-file=-
```

### 3. Grant Secret Access

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for secret in control-plane-db-url tenant-plane-db-url jwt-access-secret jwt-refresh-secret pii-hmac-key pii-encryption-key netpay-encryption-key; do
  gcloud secrets add-iam-policy-binding $secret \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

### 4. Deploy to Cloud Run

```bash
gcloud run deploy netpay-api \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/netpay-api:latest \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --port=3000 \
  --memory=512Mi \
  --cpu=1 \
  --max-instances=100 \
  --min-instances=0 \
  --timeout=300s \
  --concurrency=80 \
  --set-env-vars=NODE_ENV=production \
  --set-secrets=CONTROL_PLANE_DATABASE_URL=control-plane-db-url:latest,TENANT_PLANE_DATABASE_URL=tenant-plane-db-url:latest,JWT_ACCESS_SECRET=jwt-access-secret:latest,JWT_REFRESH_SECRET=jwt-refresh-secret:latest,PII_HMAC_KEY=pii-hmac-key:latest,PII_ENCRYPTION_KEY=pii-encryption-key:latest,NETPAY_ENCRYPTION_KEY=netpay-encryption-key:latest
```

## Configuration Reference

### Cloud Run Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MEMORY` | 512Mi | Memory per instance |
| `CPU` | 1 | vCPUs per instance |
| `MAX_INSTANCES` | 100 | Maximum concurrent instances |
| `MIN_INSTANCES` | 0 | Minimum instances (0 = scale to zero) |
| `TIMEOUT` | 300s | Request timeout |
| `CONCURRENCY` | 80 | Concurrent requests per instance |

### Environment Variables

See `.env.neon.example` for the complete list of environment variables.

Key variables for Neon:
- `CONTROL_PLANE_DATABASE_URL`: Pooled connection string for control plane
- `TENANT_PLANE_DATABASE_URL`: Pooled connection string for tenant plane
- `DATABASE_POOL_MAX`: Connection pool size (default: 3)

## CI/CD Integration

### Using Cloud Build with GitHub

Create `cloudbuild.yaml` (already included) and set up triggers:

```bash
# Create a build trigger
gcloud builds triggers create github \
  --name="netpay-api-deploy" \
  --repo-owner=your-org \
  --repo-name=netpay-api \
  --branch-pattern="^main$" \
  --build-config="cloudbuild.yaml" \
  --substitutions="_REGION=$REGION,_SERVICE_NAME=netpay-api"
```

### Using GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloud Run

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_CREDENTIALS }}

      - name: Deploy
        run: |
          PROJECT_ID=my-project NEON_PROJECT_ID=${{ secrets.NEON_PROJECT_ID }} \
          ./scripts/deploy-cloud-run.sh
```

## Monitoring and Debugging

### View Logs

```bash
# Tail logs in real-time
gcloud logs tail /run.googleapis.com/netpay-api --region=$REGION

# View recent logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=netpay-api" \
  --limit=50 --format=json
```

### Monitor Performance

```bash
# View instance metrics
gcloud run services describe netpay-api --region=$REGION --format=yaml
```

### Debug Common Issues

**Connection refused to database:**
- Verify Neon connection strings are correct
- Check if Neon project is active
- Ensure SSL is enabled (`sslmode=require`)

**Secrets not accessible:**
- Verify service account has `roles/secretmanager.secretAccessor`
- Check secret names match exactly

**Build failures:**
- Check Cloud Build logs: `gcloud builds list`
- Verify Dockerfile syntax
- Ensure all dependencies are in package.json

## Security Best Practices

1. **Never commit secrets** to git
2. **Use Secret Manager** for all sensitive values
3. **Enable HTTPS** - Cloud Run does this by default
4. **Set appropriate IAM roles** - principle of least privilege
5. **Regularly rotate secrets** - especially JWT keys
6. **Enable Cloud Armor** for DDoS protection if needed
7. **Use VPC connectors** if you need private database access

## Cost Optimization

- Set `MIN_INSTANCES=0` to scale to zero when idle
- Use appropriate memory/CPU for your workload
- Monitor Cloud Run costs with the Cost Calculator
- Consider Neon's serverless pricing model

## Troubleshooting

### Application not starting

```bash
# Check instance logs
gcloud logs tail /run.googleapis.com/netpay-api --region=$REGION

# Verify database connectivity
# Run a local test with your Neon connection string
psql "postgresql://user:password@project-id.neon.tech/database"
```

### Migration failures

```bash
# Run migrations manually to see detailed errors
NEON_PROJECT_ID=xxx ./scripts/run-migrations-neon.sh

# Or the same entrypoint the migrate Job runs (direct, non-pooler URL)
CONTROL_PLANE_DATABASE_URL_UNPOOLED="postgresql://..." npm run db:migrate:deploy
```

### CORS errors

Update `CORS_ORIGINS` in your Cloud Run deployment:

```bash
gcloud run services update netpay-api \
  --region=$REGION \
  --set-env-vars=CORS_ORIGINS=https://your-frontend-domain.com
```

## Rolling Back

To deploy a previous version:

```bash
# List revisions
gcloud run revisions list --service=netpay-api --region=$REGION

# Revert to a specific revision
gcloud run services update-traffic netpay-api \
  --region=$REGION \
  --to-revisions=REVISION_NAME=100
```

## Additional Resources

- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Neon Documentation](https://neon.tech/docs)
- [Prisma Cloud Run Guide](https://www.prisma.io/docs/guides/deployment/deploy-to-cloud-run)
- [Google Secret Manager](https://cloud.google.com/secret-manager/docs)

## Support

For issues related to:
- **Deployment**: Check Cloud Build logs
- **Database**: Check Neon console
- **Application**: Check Cloud Run logs
- **Script errors**: Review `scripts/deploy-cloud-run.sh`
