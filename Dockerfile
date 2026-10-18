# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Multi-stage build for the NestJS multitenancy base.
#
# Stage 1 installs every dependency and compiles TypeScript, stage 2 keeps only
# the production dependency tree and the compiled output. The result contains no
# build tooling, no test files and no source maps.
#
# The Prisma clients are generated TypeScript and are compiled like the rest of
# the application, so `prisma generate` runs in the builder stage and its output
# ships inside `dist/`.
# ---------------------------------------------------------------------------

# --- Build stage ------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Openssl is required by Prisma's query engine at runtime.
RUN apk add --no-cache openssl

# Dependencies are copied first so the layer is reused whenever only source
# changes.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json tsconfig.spec.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# The client is generated before compilation so the generated sources are part of
# the TypeScript program.
RUN npx prisma generate --schema prisma/schema.prisma \
 && npx prisma generate --schema prisma/schema.tenant.prisma

COPY src ./src
RUN npm run build

# Re-resolve to production-only dependencies, reusing the installed tree.
RUN npm prune --omit=dev

# --- Runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache openssl tini \
 && addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --chown=app:app prisma.config.ts ./

# The provisioner reads the rendered tenant migrations from disk at runtime, so
# they must ship with the image.
USER app

# `tini` reaps zombies and forwards SIGTERM, which is what lets the Nest
# shutdown hooks drain in-flight requests before the container exits.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

# --- Migrate stage ----------------------------------------------------------
# Runs the control-plane migrations as the Cloud Run Job `netpay-migrate`.
# `prisma` and `tsx` are devDependencies and are pruned from the runtime image,
# so this stage installs the full tree. Build with `--target migrate`.
FROM node:22-alpine AS migrate

WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY prisma ./prisma
COPY prisma.config.ts ./
COPY scripts/migrate.ts ./scripts/migrate.ts

ENV NODE_ENV=production

CMD ["npx", "tsx", "scripts/migrate.ts"]