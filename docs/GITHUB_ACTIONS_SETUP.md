# GitHub Actions Setup Guide

This guide explains how to set up GitHub Actions for CI/CD and database migrations.

## Prerequisites

1. **Google Cloud Project** with appropriate permissions
2. **GitHub Repository** with the code
3. **Neon.tech Database** configured for staging and production

## Step 1: Create Google Cloud Service Account

### 1.1 Create Service Account

```bash
# Set your project
export PROJECT_ID="your-project-id"
gcloud config set project $PROJECT_ID

# Create service account
gcloud iam service-accounts create github-actions \
  --description="Service account for GitHub Actions" \
  --display-name="GitHub Actions"
```

### 1.2 Grant Permissions

```bash
# Get service account email
SA_EMAIL=$(gcloud iam service-accounts describe github-actions \
  --project=$PROJECT_ID \
  --format='value(email)')

# Grant Cloud Run deployer role
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/run.developer"

# Grant Cloud Build role
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/cloudbuild.builds.builder"

# Grant Artifact Registry role
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/artifactregistry.writer"

# Grant Secret Manager role
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

### 1.3 Create Service Account Key

```bash
# Create and download key
gcloud iam service-accounts keys create github-actions-key.json \
  --iam-account=$SA_EMAIL

# Keep this file secure! You'll need its content for GitHub.
```

**⚠️ SECURITY WARNING**: The key file contains sensitive credentials. Never commit it to git. Store it securely and delete after adding to GitHub.

## Step 2: Configure GitHub Secrets

### 2.1 Add Secrets to GitHub

1. Go to your GitHub repository
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add the following secrets:

#### Required Secrets

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `GCP_CREDENTIALS` | Service account JSON key (entire file content) | `{"type": "service_account", ...}` |
| `GCP_PROJECT_ID` | Google Cloud project ID | `my-project-123` |
| `CODECOV_TOKEN` | Upload token de Codecov (repo `tuplastudio/back-nest`) para subir la cobertura de `npm run test:cov` | `••••••••` |

#### Staging Secrets

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `STAGING_CONTROL_PLANE_DATABASE_URL` | Pooled connection string | `postgresql://postgres:pass@xxx.pooler.neon.tech/db` |
| `STAGING_CONTROL_PLANE_DATABASE_URL_UNPOOLED` | Unpooled connection string | `postgresql://postgres:pass@xxx.neon.tech/db` |
| `STAGING_TENANT_PLANE_DATABASE_URL` | Pooled tenant connection | `postgresql://mtb_app:pass@xxx.pooler.neon.tech/db` |
| `STAGING_TENANT_PLANE_DATABASE_URL_UNPOOLED` | Unpooled tenant connection | `postgresql://mtb_app:pass@xxx.neon.tech/db` |

#### Production Secrets

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `PRODUCTION_CONTROL_PLANE_DATABASE_URL` | Pooled connection string | `postgresql://postgres:pass@xxx.pooler.neon.tech/db` |
| `PRODUCTION_CONTROL_PLANE_DATABASE_URL_UNPOOLED` | Unpooled connection string | `postgresql://postgres:pass@xxx.neon.tech/db` |
| `PRODUCTION_TENANT_PLANE_DATABASE_URL` | Pooled tenant connection | `postgresql://mtb_app:pass@xxx.pooler.neon.tech/db` |
| `PRODUCTION_TENANT_PLANE_DATABASE_URL_UNPOOLED` | Unpooled tenant connection | `postgresql://mtb_app:pass@xxx.neon.tech/db` |

### 2.2 Adding GCP_CREDENTIALS

The `GCP_CREDENTIALS` secret should contain the **entire content** of the JSON key file:

```bash
# Read the key file and copy its content
cat github-actions-key.json

# Copy the entire output (including braces and quotes)
# Paste it into the GitHub secret value field
```

## Step 3: Configure GitHub Environments

### 3.1 Create Environments

1. Go to **Settings** → **Environments**
2. Click **New environment**
3. Create `staging` environment
4. Create `production` environment

### 3.2 Configure Production Environment

For the `production` environment:

1. Click on **production**
2. Scroll to **Deployment protection rules**
3. Enable **Required reviewers**
4. Add required reviewers (at least 1)
5. Optionally enable **Wait timer** (e.g., 5 minutes)

This ensures production migrations require manual approval.

## Step 4: Get Neon Connection Strings

### 4.1 Get Project ID

1. Go to [Neon Console](https://console.neon.tech)
2. Select your project
3. Copy the **Project ID** from the dashboard

### 4.2 Generate Connection Strings

For each environment (staging/production), you need 4 connection strings:

```bash
# Control plane (pooled - for application)
postgresql://postgres:password@project-id.pooler.neon.tech/database?sslmode=require

# Control plane (unpooled - for migrations)
postgresql://postgres:password@project-id.neon.tech/database?sslmode=require

# Tenant plane (pooled - for application)
postgresql://mtb_app:password@project-id.pooler.neon.tech/database?sslmode=require

# Tenant plane (unpooled - for migrations)
postgresql://mtb_app:password@project-id.neon.tech/database?sslmode=require
```

**Note**: For production, use separate Neon projects for staging and production, or use Neon's branching feature.

## Step 5: Verify Setup

### 5.1 Test Workflow

1. Make a small change to the code
2. Push to `develop` branch
3. Go to **Actions** tab in GitHub
4. Verify the CI/CD workflow runs successfully

### 5.2 Test Migration Workflow

1. Create a new migration
2. Push to `develop` branch
3. Verify:
   - CI validates the migration
   - Migration is applied to staging
   - Tests pass

### 5.3 Test Production Deployment

1. Merge `develop` to `main`
2. Verify:
   - CI validates again
   - Docker image built
   - Migration workflow triggered
   - Requires manual approval
   - After approval, applied to production

## Step 6: Configure Branch Protection (Optional)

To enforce the workflow:

1. Go to **Settings** → **Branches**
2. Add rule for `main` branch:
   - Require pull request before merging
   - Require status checks to pass before merging
   - Require branches to be up to date before merging
   - Select required checks:
     - `Test & Quality Checks`
     - `Build Docker Image`

## Troubleshooting

### Workflow Fails with "Authentication Failed"

**Cause**: Invalid or missing GCP credentials

**Solution**:
```bash
# Verify service account exists
gcloud iam service-accounts describe github-actions

# Verify key is valid
gcloud iam service-accounts keys list --iam-account=github-actions@PROJECT_ID.iam.gserviceaccount.com

# Re-create key if needed
gcloud iam service-accounts keys create new-key.json \
  --iam-account=github-actions@PROJECT_ID.iam.gserviceaccount.com
```

### Migration Fails with "Connection Timeout"

**Cause**: Using pooled connection string for migrations

**Solution**: Ensure you're using `*_UNPOOLED` secrets for migrations

### "Environment not found" Error

**Cause**: GitHub environment not created

**Solution**: Create the environment in Settings → Environments

### Permission Denied on Artifact Registry

**Cause**: Service account missing Artifact Registry role

**Solution**:
```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:github-actions@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

## Security Best Practices

1. **Rotate Keys Regularly**: Every 90 days, rotate the service account key
2. **Limit Permissions**: Grant only necessary roles (principle of least privilege)
3. **Use Environments**: Require approval for production changes
4. **Monitor Logs**: Regularly review GitHub Actions logs for suspicious activity
5. **Separate Projects**: Use separate GCP projects for staging and production if possible

## Maintenance

### Rotating Service Account Key

```bash
# List existing keys
gcloud iam service-accounts keys list \
  --iam-account=github-actions@PROJECT_ID.iam.gserviceaccount.com

# Delete old key
gcloud iam service-accounts keys delete KEY_ID \
  --iam-account=github-actions@PROJECT_ID.iam.gserviceaccount.com

# Create new key
gcloud iam service-accounts keys create new-key.json \
  --iam-account=github-actions@PROJECT_ID.iam.gserviceaccount.com

# Update GitHub secret with new key content
```

### Updating Database Credentials

When rotating database passwords:

1. Update password in Neon
2. Update corresponding GitHub secrets
3. Test workflow with new credentials
4. Monitor for connection errors

## Summary

After completing this setup, you'll have:

- ✅ Automated CI/CD pipeline
- ✅ Automated migration validation
- ✅ Automatic deployment to staging
- ✅ Manual approval for production
- ✅ Database migration automation
- ✅ Rollback capabilities

The workflows will:
- Run tests on every push
- Validate migrations before deployment
- Build and deploy Docker images
- Apply migrations to staging automatically
- Require approval for production migrations
- Notify on success/failure
