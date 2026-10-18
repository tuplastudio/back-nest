# Guía de despliegue a Google Cloud Platform + Neon

**Servicio:** `vondi-api` (API REST NestJS 12 + Prisma 7, multitenant por schema + RLS)
**Runtime:** Google Cloud Run
**Base de datos:** Neon (PostgreSQL serverless, AWS)
**Documento:** procedimiento reproducible, paso a paso
**Última revisión:** 2026-10-16

> **Convención.** Los comandos asumen `bash` con las variables de la [§5](#5-variables-y-convenciones). Los puntos marcados **[VERIFICAR]** dependen de comportamiento que la documentación del proveedor no confirma y deben comprobarse una vez en staging antes de producción.

---

## Índice

1. [Resumen](#1-resumen)
2. [Decisiones de arquitectura](#2-decisiones-de-arquitectura)
3. [Estado del repositorio](#3-estado-del-repositorio)
4. [Topología](#4-topología)
5. [Variables y convenciones](#5-variables-y-convenciones)
6. [Fase 1 — GCP: APIs, IAM y Artifact Registry](#6-fase-1--gcp-apis-iam-y-artifact-registry)
7. [Fase 2 — Red y salida con IP estática](#7-fase-2--red-y-salida-con-ip-estática)
8. [Fase 3 — Neon](#8-fase-3--neon)
9. [Fase 4 — Secret Manager](#9-fase-4--secret-manager)
10. [Fase 5 — Imagen Docker](#10-fase-5--imagen-docker)
11. [Fase 6 — Servicio, Job de migraciones y primer despliegue](#11-fase-6--servicio-job-de-migraciones-y-primer-despliegue)
12. [Fase 7 — GitHub Actions](#12-fase-7--github-actions)
13. [Fase 8 — Balanceador, Cloud Armor y dominio](#13-fase-8--balanceador-cloud-armor-y-dominio)
14. [Fase 9 — Observabilidad](#14-fase-9--observabilidad)
15. [Capacidad y conexiones](#15-capacidad-y-conexiones)
16. [Continuidad y recuperación](#16-continuidad-y-recuperación)
17. [Entornos y costes](#17-entornos-y-costes)
18. [Runbooks](#18-runbooks)
19. [Riesgos conocidos](#19-riesgos-conocidos)
20. [Checklist previo a producción](#20-checklist-previo-a-producción)
21. [Apéndices](#21-apéndices)

---

## 1. Resumen

La API corre en **Cloud Run** y usa **Neon** como PostgreSQL. Neon se alcanza **por Internet con TLS**, restringido por **IP Allow** a la IP estática de salida de **Cloud NAT**.

| Capa            | Servicio                                                                   | Nota                                |
| --------------- | -------------------------------------------------------------------------- | ----------------------------------- |
| Runtime         | Cloud Run                                                                  | Stateless, rollout por revisión     |
| Base de datos   | Neon (PostgreSQL 17), región `aws-us-east-2`                               | PITR por historial, branching       |
| Red hacia la BD | Direct VPC egress → Cloud NAT con IP reservada → Internet + TLS + IP Allow | Neon Private Networking es solo AWS |
| Secretos        | Secret Manager                                                             | Versionados                         |
| Imágenes        | Artifact Registry                                                          | Despliegue por digest               |
| CI/CD           | GitHub Actions + Workload Identity Federation                              | Sin claves JSON                     |

**Objetivos propuestos** (a validar con pruebas de carga): disponibilidad 99.9 %; p95 lectura < 400 ms; p95 escritura < 800 ms; RPO y RTO definidos por la ventana de historial de Neon y el procedimiento de [§16](#16-continuidad-y-recuperación).

---

## 2. Decisiones de arquitectura

### ADR-001 — Cloud Run

Contenedor Node.js 22 stateless con `tini` como PID 1, `enableShutdownHooks()`, escucha en `0.0.0.0:$PORT` y probes `/health/live` (sin BD) y `/health/ready` (con BD). Cloud Run da rollout por revisión y rollback en segundos.

Consecuencias:

- Hay que facturar CPU siempre asignada (`--no-cpu-throttling`) porque el dispatcher de webhooks usa `setInterval` ([§11.3](#113-flags-del-servicio)).
- El dispatcher corre por réplica; el claim atómico evita duplicados ([§19.1](#191-el-dispatcher-de-webhooks-es-un-setinterval-en-proceso)).
- No hay `exec` interactivo: las tareas de administración van en Cloud Run Jobs.

### ADR-002 — Neon por Internet, con IP Allow

**Neon Private Networking existe solo para AWS** (PrivateLink). En GCP la única restricción de red disponible es **IP Allow** (plan **Scale** o superior).

Para tener una IP de origen fija, Cloud Run sale por **Direct VPC egress con `--vpc-egress=all-traffic`** hacia un **Cloud NAT con una dirección externa reservada**. Esa IP `/32` es la que se registra en Neon.

> **`--vpc-egress=all-traffic` es obligatorio.** Con `private-ranges-only` el tráfico a Neon (IP pública) **no** pasa por el NAT: sale por la IP dinámica de Google y Neon lo rechaza.

Consecuencias aceptadas:

- Los metadatos (IPs, tiempos) viajan por red pública; el contenido va cifrado con TLS.
- **Si la IP del NAT cambia, la aplicación pierde la base de datos.** La dirección debe ser _reservada_ ([RB-05](#rb-05--la-ip-de-salida-cambió)).
- IP Allow puede limitarse a **ramas protegidas** (Settings → Networking → _Protected branches only_). Se usa para que las ramas de CI/dev no dependan de IPs fijas ([§8.1](#81-proyecto-ramas-y-protección)). **[VERIFICAR]** que la restricción aplica también al endpoint _pooled_ (conectar desde una IP no permitida a ambos hosts).

### ADR-003 — `@prisma/adapter-pg` sobre TCP

Neon recomienda `@prisma/adapter-neon` (WebSocket) para entornos serverless/edge. Este servicio es de larga vida (`min-instances=1`, pool de `pg` persistente), así que se mantiene `@prisma/adapter-pg` con el host **pooled** de Neon. Evita migrar los dos servicios Prisma (`ControlPlanePrismaService` y `TenantPrismaService`).

El `Pool` se configura **en código** (`DATABASE_POOL_MAX`, `DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`). Los parámetros de URL propios del motor de Prisma (`connection_limit`, `pool_timeout`, `pgbouncer`, `schema`) **no los lee `pg`** y no tienen efecto en el runtime; no se usan en las URLs de producción.

### ADR-004 — Pooler de Neon en modo transacción

El host `-pooler` de Neon usa PgBouncer en `pool_mode=transaction`.

- **No soportado:** `SET`/`RESET` de sesión, `LISTEN/NOTIFY`, `PREPARE` SQL, tablas temporales con `PRESERVE`, advisory locks de sesión.
- **Soportado:** prepared statements a nivel de protocolo (PgBouncer ≥ 1.22).

Por eso: app en host **pooled**; migraciones, seeds, `pg_dump` y admin en host **directo**.

### ADR-005 — `SET LOCAL` mantiene el aislamiento bajo el pooler

El aislamiento entre tenants depende de `app.current_tenant`. Se fija así (`src/prisma/tenant-prisma.service.ts`):

```ts
return interactive.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = ${quoteStringLiteral(schemaName)}`);
  return callback(tx);
});
```

`SET LOCAL` dentro de una transacción interactiva es compatible: la transacción fija una conexión de backend y el valor se descarta al terminar.

**Regla de revisión:** prohibido `SET`/`RESET` de sesión en cualquier ruta que toque datos de tenant. Un `SET` sin `LOCAL` no da error: deja `app.current_tenant` en `NULL` (cero filas) o apunta el `search_path` al schema equivocado. Prueba obligatoria: [§8.5](#85-pruebas-de-aislamiento-gate-de-lanzamiento).

---

## 3. Estado del repositorio

### 3.1 Ya resuelto (cambios en el working tree, pendientes de commit)

| Requisito                                       | Dónde                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Migraciones con URL directa                     | `prisma.config.ts` lee `CONTROL_PLANE_DATABASE_URL_UNPOOLED` (sin fallback al pooler) |
| Comando de migración independiente del arranque | `scripts/migrate.ts` (`npm run db:migrate:deploy`); rechaza URLs `-pooler.`           |
| Variables `*_UNPOOLED` documentadas             | `.env.example`                                                                        |
| `SET LOCAL` en rutas de tenant                  | `tenant-prisma.service.ts`, provisioner, seeds                                        |
| Un solo `Pool` compartido por todos los tenants | `TenantPrismaService.sharedPool`                                                      |
| Validación estricta de configuración (Zod)      | `src/config/env.validation.ts`                                                        |
| Redacción de PII en logs, escaneo de secretos   | `PII_LOG_REDACTION`, `scripts/scan-secrets.sh`                                        |

### 3.2 Pendiente

| #   | Brecha                                                                                                      | Sev.  | Acción                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| G1  | **La imagen no puede migrar**: `prisma` y `tsx` son `devDependencies` (se podan) y `scripts/` no se compila | Alta  | Target `migrate` en el Dockerfile ([§10](#10-fase-5--imagen-docker))          |
| G2  | `EXPOSE 3000` contradice el puerto de Cloud Run                                                             | Baja  | Eliminar ([§10](#10-fase-5--imagen-docker))                                   |
| G3  | `TRUST_PROXY_HOPS=0` por defecto: `request.ip` sería el proxy y el rate limit por IP no sirve               | Alta  | Fijar el valor correcto ([§11.4](#114-trust_proxy_hops))                      |
| G4  | `DOCS_ENABLED=true` por defecto                                                                             | Alta  | `false` en producción                                                         |
| G5  | `DATABASE_POOL_MAX=3` es muy bajo para `--concurrency=15`                                                   | Media | 10 ([§15](#15-capacidad-y-conexiones))                                        |
| G6  | `DATABASE_CONNECTION_TIMEOUT_MS=10000` por defecto; el compute puede estar despertando                      | Media | 15000                                                                         |
| G7  | No existe `.github/workflows/`                                                                              | Alta  | [§12](#12-fase-7--github-actions)                                             |
| G8  | CI sin roles `mtb_control`/`mtb_app`                                                                        | Media | Reusar `docker/postgres/init/01-roles.sql` ([§12.2](#122-ci-de-verificación)) |
| G9  | Sin SBOM, escaneo de imagen ni smoke tests                                                                  | Media | [§12](#12-fase-7--github-actions)                                             |

---

## 4. Topología

```
Proyecto GCP: vondi-0q                       (un proyecto por entorno)
├── VPC vondi-net
│   └── Subred vondi-subnet                  (10.10.0.0/24)
│       ├── Cloud Router vondi-router
│       └── Cloud NAT vondi-nat              (IP RESERVADA: vondi-egress)
├── Artifact Registry vondi-api              (docker / us-east5)
├── Secret Manager                           (secretos de la §9)
├── Cloud Run
│   ├── Service vondi-api                    (producción; ingress: LB)
│   ├── Service vondi-api-canary             (candidata; requiere IAM)
│   └── Job     vondi-migrate                (migraciones)
├── Cloud Load Balancing vondi-lb            (global, IP estática, Cloud Armor)
├── Cloud Monitoring / Cloud Logging
└── Service Accounts
    ├── vondi-runtime    servicios Cloud Run
    ├── vondi-deployer   GitHub Actions (WIF)
    └── vondi-migrator   Job de migraciones

Neon: proyecto "vondi"        (región aws-us-east-2, plan Scale)
├── main     producción  (protegida, 1 CU, sin autosuspend)
├── staging  preproducción (protegida mientras contenga datos reales)
└── ci-<n>   efímera por PR (desde staging anonimizada, se borra al cerrar)

Hosts por rama:
  pooled  ep-XXXX-pooler.us-east-2.aws.neon.tech   → aplicación
  direct  ep-XXXX.us-east-2.aws.neon.tech          → migraciones, seeds, pg_dump
Network: IP Allow = [EGRESS_IP/32]  (+ ramas no protegidas sin restricción)
```

---

## 5. Variables y convenciones

```bash
export PROJECT_ID="vondi-0q"
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export REGION="us-east5"                  # Columbus, Ohio — ver §5.1
export SERVICE="vondi-api"
export CANARY_SERVICE="vondi-api-canary"
export MIGRATE_JOB="vondi-migrate"
export AR_REPO="vondi-api"
export GH_REPO="tupla-studio/vondi-api"   # DEBE coincidir con el repositorio real
export DB_NAME="neondb"
export IMAGE_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/vondi-api"
```

### 5.1 Región

**`us-east2` no existe en GCP.** Neon `aws-us-east-2` es Ohio; su equivalente en GCP es **`us-east5` (Columbus, Ohio)**. Cloud Run, Cloud NAT y Artifact Registry usan `us-east5`.

| Neon (AWS)           | Región GCP cercana           |
| -------------------- | ---------------------------- |
| `aws-us-east-2`      | `us-east5` (Columbus)        |
| `aws-us-east-1`      | `us-east4` (N. Virginia)     |
| `aws-us-west-2`      | `us-west1` (Oregón)          |
| `aws-eu-central-1`   | `europe-west3` (Fráncfort)   |
| `aws-ap-southeast-1` | `asia-southeast1` (Singapur) |

La latencia real entre AWS y GCP en la misma metrópoli suele ser de pocos ms pero **debe medirse** ([§8.7](#87-medir-la-latencia)). **Elegir primero la región de Neon**: cambiarla implica migrar datos y rehacer IP Allow. Cloud Run en una región lejana (p. ej. `us-central1`) añade decenas de ms por consulta.

---

## 6. Fase 1 — GCP: APIs, IAM y Artifact Registry

### 6.1 APIs

```bash
gcloud config set project "$PROJECT_ID"

gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  compute.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  billingbudgets.googleapis.com
```

### 6.2 Cuentas de servicio

No usar la cuenta de Compute por defecto.

```bash
for SA in vondi-runtime vondi-deployer vondi-migrator; do
  gcloud iam service-accounts create "$SA" --display-name="$SA"
done

RUNTIME_SA="vondi-runtime@$PROJECT_ID.iam.gserviceaccount.com"
DEPLOYER_SA="vondi-deployer@$PROJECT_ID.iam.gserviceaccount.com"
MIGRATOR_SA="vondi-migrator@$PROJECT_ID.iam.gserviceaccount.com"

# Logs y métricas desde los servicios y el Job
for SA in "$RUNTIME_SA" "$MIGRATOR_SA"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA" --role="roles/logging.logWriter"
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role="roles/monitoring.metricWriter"

# El deployer despliega Cloud Run y actúa como las SA de ejecución
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOYER_SA" --role="roles/run.developer"
for SA in "$RUNTIME_SA" "$MIGRATOR_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$SA" \
    --member="serviceAccount:$DEPLOYER_SA" --role="roles/iam.serviceAccountUser"
done
```

### 6.3 Artifact Registry

```bash
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker --location="$REGION" \
  --description="Imágenes de vondi-api"

gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" \
  --member="serviceAccount:$DEPLOYER_SA" --role="roles/artifactregistry.writer"

# Cloud Run (agentes de servicio) y las SA de ejecución leen las imágenes
for SA in "$RUNTIME_SA" "$MIGRATOR_SA"; do
  gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" \
    --member="serviceAccount:$SA" --role="roles/artifactregistry.reader"
done
```

### 6.4 Workload Identity Federation (sin claves JSON)

```bash
gcloud iam workload-identity-pools create github --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '$GH_REPO' && assertion.ref == 'refs/heads/main'"

# OJO: el principalSet usa el NÚMERO de proyecto, no el ID
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$GH_REPO"
```

> **La condición de atributo es el control de seguridad del pipeline.** Aquí limita a un repositorio y a la rama `main`. Si el workflow usa `environment: production`, el claim `ref` sigue siendo la rama; para exigir además el environment se puede condicionar `assertion.sub == 'repo:$GH_REPO:environment:production'`.

Variables en GitHub (_Settings → Environments → `production`_):

| Nombre              | Valor                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `GCP_PROJECT_ID`    | `vondi-0q`                                                                                 |
| `GCP_REGION`        | `us-east5`                                                                                 |
| `GCP_WIF_PROVIDER`  | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOYER_SA`   | `vondi-deployer@vondi-0q.iam.gserviceaccount.com`                                          |
| `CLOUD_RUN_SERVICE` | `vondi-api`                                                                                |
| `CLOUD_RUN_CANARY`  | `vondi-api-canary`                                                                         |
| `MIGRATE_JOB`       | `vondi-migrate`                                                                            |
| `AR_REPOSITORY`     | `vondi-api`                                                                                |

No guardar claves JSON en GitHub Secrets.

### 6.5 Auditoría de Secret Manager

Los _Data Access logs_ de Secret Manager no están activos por defecto. Activarlos (IAM → _Audit Logs_ → Secret Manager → Data Read) y, si se requiere retención larga, exportarlos:

```bash
gcloud storage buckets create "gs://$PROJECT_ID-audit-logs" --location="$REGION" \
  --uniform-bucket-level-access --retention-period=400d
gcloud storage buckets update "gs://$PROJECT_ID-audit-logs" --versioning

gcloud logging sinks create vondi-audit-sink \
  "storage.googleapis.com/$PROJECT_ID-audit-logs" \
  --log-filter='protoPayload.serviceName="secretmanager.googleapis.com"'
# Conceder al writerIdentity que imprime el comando anterior roles/storage.objectCreator
# sobre el bucket.
```

Los registros de consultas SQL de Neon no están en GCP ([§14.4](#144-auditoría)).

---

## 7. Fase 2 — Red y salida con IP estática

```bash
gcloud compute networks create vondi-net --subnet-mode=custom

gcloud compute networks subnets create vondi-subnet \
  --network=vondi-net --region="$REGION" \
  --range=10.10.0.0/24 \
  --enable-private-ip-google-access \
  --enable-flow-logs

gcloud compute routers create vondi-router --network=vondi-net --region="$REGION"

# IP RESERVADA (no autoasignada): es la que se registra en Neon.
gcloud compute addresses create vondi-egress --region="$REGION" --network-tier=PREMIUM

gcloud compute routers nats create vondi-nat \
  --router=vondi-router --region="$REGION" \
  --nat-custom-subnet-ip-ranges=vondi-subnet \
  --nat-external-ip-pool=vondi-egress \
  --enable-logging

export EGRESS_IP="$(gcloud compute addresses describe vondi-egress \
  --region="$REGION" --format='value(address)')"
echo "IP de salida: $EGRESS_IP"
```

> **Ejecutado por [scripts/provision-network.sh](../scripts/provision-network.sh)**, que
> es idempotente y además concede `roles/compute.networkUser` a `vondi-runtime` y
> `vondi-migrator` sobre la subred (sin eso, un servicio en la VPC no puede
> tomar la subred). No lo ejecutes sin leer su cabecera: la red solo sirve cuando
> la IP reservada está autorizada después en Neon, y ese paso es fuera de GCP.

Notas:

- `--enable-private-ip-google-access` es necesario: con `all-traffic` el acceso a APIs de Google también pasa por la VPC.
- Si alguien cambia el NAT a `--auto-allocate-nat-external-ips`, la IP cambia y la BD deja de ser alcanzable sin ningún error en GCP que lo explique. Restringir `compute.addresses.*` y `compute.routers.update` y alertar ([§14.3](#143-alertas)).
- **Direct VPC egress** consume IPs de la subred por instancia. `/24` es suficiente a esta escala (4 instancias + canario + Jobs).
- Cloud NAT tiene coste por hora y por GB procesado.

---

## 8. Fase 3 — Neon

### 8.1 Proyecto, ramas y protección

Neon genera el ID del proyecto (p. ej. `cool-leaf-12345678`); el nombre es libre. Crear el proyecto en la consola o con la CLI y apuntar el ID:

```bash
npm i -g neonctl          # binario: neonctl (alias: neon)
export NEON_API_KEY="…"   # API key personal o de organización

neonctl projects create --name vondi --region-id aws-us-east-2
export NEON_PROJECT_ID="<id devuelto>"

neonctl branches create --project-id "$NEON_PROJECT_ID" --name staging --parent main
```

> Los flags exactos pueden variar entre versiones: comprobar con `neonctl projects create --help`.

En la consola (_Branches_):

1. La rama por defecto debe llamarse `main`; marcarla **protegida**.
2. _Settings → Networking → IP Allow_: añadir `$EGRESS_IP/32` y activar **Protected branches only**.

```bash
neonctl ip-allow add "$EGRESS_IP/32" --project-id "$NEON_PROJECT_ID"
neonctl ip-allow list --project-id "$NEON_PROJECT_ID"
```

**Ojo con las ramas hijas.** Una rama creada desde `main` hereda **datos, roles y contraseñas**. `staging` y las ramas de PR no son "más seguras" por existir:

- Si `staging` contiene datos reales, márcala protegida (queda dentro de IP Allow) **y** rota las contraseñas de sus roles.
- Las ramas de CI se crean desde una rama `staging` **anonimizada**, nunca desde `main` ([§8.6](#86-ramas-de-ci)).

### 8.2 Compute: tamaño y autosuspend

| Parámetro         | staging | main (producción) |
| ----------------- | ------- | ----------------- |
| Compute           | 0.5 CU  | **1 CU**          |
| `max_connections` | 209     | **419**           |
| Autosuspend       | 5 min   | **desactivado**   |

Con 1 CU el pooler ofrece `default_pool_size = 0.9 × 419 = 377` por usuario/base de datos (siete conexiones quedan reservadas al superusuario de Neon).

**Autosuspend desactivado en producción**: un compute dormido tarda segundos en despertar y esa espera caería sobre la primera petición. En la consola: _Branch → Compute → Edit → Scale to zero: off_; o vía API (`suspend_timeout_seconds`, `-1` = nunca). **[VERIFICAR]** el valor mostrado en la consola tras aplicarlo.

### 8.3 Roles y permisos

Conectar a la rama `main` por el **host directo** como `neondb_owner` (rol que Neon crea por defecto) desde el editor SQL de la consola o `psql`.

> `neondb_owner` pertenece a `neon_superuser`, que tiene `BYPASSRLS`. **Nunca** se usa en la aplicación.

Generar contraseñas (alfanuméricas, evita problemas de URL):

```bash
export PWD_CONTROL="$(openssl rand -hex 24)"
export PWD_APP="$(openssl rand -hex 24)"
```

```sql
-- Rol de DDL: dueño de los schemas de tenant; ejecuta migraciones y CREATE SCHEMA.
CREATE ROLE mtb_control LOGIN
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD '<PWD_CONTROL>';

-- Rol de DML: no es dueño de nada, no tiene CREATE. Eso hace exigible FORCE RLS.
CREATE ROLE mtb_app LOGIN
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD '<PWD_APP>';

REVOKE CREATE ON DATABASE neondb FROM PUBLIC;
GRANT CONNECT ON DATABASE neondb TO mtb_control, mtb_app;
GRANT CREATE  ON DATABASE neondb TO mtb_control;        -- CREATE SCHEMA por tenant

-- Control plane (schema public)
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO mtb_control;    -- CREATE: prisma migrate crea tablas aquí
GRANT USAGE          ON SCHEMA public TO mtb_app;

-- mtb_app NO recibe privilegios sobre el control plane: DML ahí permitiría
-- insertar un OWNER de plataforma desde la credencial de menor privilegio.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM mtb_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mtb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mtb_control IN SCHEMA public REVOKE ALL ON TABLES    FROM mtb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mtb_control IN SCHEMA public REVOKE ALL ON SEQUENCES FROM mtb_app;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Las migraciones de producción se ejecutan con `mtb_control`: los objetos quedan a su nombre, que es lo que necesita el provisioner para `ALTER`/`DROP`. Si se ejecutaran con `neondb_owner`, los schemas pertenecerían a un rol que la aplicación no controla.

> Los grants de `mtb_app` sobre los schemas de tenant los aplica el provisioner / las migraciones de tenant (`prisma/tenant-migrations`), no este script.

### 8.4 Verificación de roles

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
FROM pg_roles WHERE rolname IN ('mtb_control', 'mtb_app');
```

Criterio: ambos con `rolsuper = f` y `rolbypassrls = f`.

### 8.5 Pruebas de aislamiento (gate de lanzamiento)

Conectado como `mtb_app` **al host pooled**, que es lo que usa la aplicación:

```sql
-- 1. No lee el control plane
SELECT * FROM public.tenant;
-- ERROR: permission denied for table tenant

-- 2. No crea schemas
CREATE SCHEMA illicit;
-- ERROR: permission denied for database neondb
```

3 y 4 se hacen contra un schema de tenant ya aprovisionado (sustituir `tenant_a`/`orders` por nombres reales):

```sql
-- 3. Sin ligadura de tenant, RLS no devuelve filas (sin error)
BEGIN;
SELECT count(*) FROM tenant_a.orders;     -- 0
COMMIT;

-- 4. Valida ADR-005: la ligadura vive solo dentro de la transacción
BEGIN;
SET LOCAL app.current_tenant = 'tenant_a';
SELECT count(*) FROM tenant_a.orders;     -- > 0
COMMIT;

BEGIN;
SELECT count(*) FROM tenant_a.orders;     -- 0: no persistió
COMMIT;
```

Repetir la prueba 4 unas 20 veces: el pooler reparte conexiones y un `SET` de sesión escapado solo se manifestaría de forma intermitente. Cualquier fila fuera de la transacción **bloquea el despliegue**.

### 8.6 Ramas de CI

```bash
neonctl branches create --project-id "$NEON_PROJECT_ID" --name "ci-$PR_NUMBER" --parent staging
neonctl branches delete "ci-$PR_NUMBER" --project-id "$NEON_PROJECT_ID"
```

Nunca apuntar CI a `main`. Una migración de prueba sobre la rama de producción es un incidente.

### 8.7 Medir la latencia

Desde un Job o una instancia temporal en `us-east5`:

```bash
psql "$APP_URL" -c '\timing on' -c 'SELECT 1' -c 'SELECT 1' -c 'SELECT 1'
```

Esperado: unos pocos ms por consulta con el compute activo. Si supera ~20 ms, revisar la región.

---

## 9. Fase 4 — Secret Manager

### 9.1 Matriz

| Secreto                    | Variable                              | Generación / origen                   | Rotable |
| -------------------------- | ------------------------------------- | ------------------------------------- | ------- |
| `jwt-access`               | `JWT_ACCESS_SECRET`                   | `openssl rand -base64 48`             | Sí      |
| `jwt-refresh`              | `JWT_REFRESH_SECRET`                  | `openssl rand -base64 48` (distinto)  | Sí      |
| `netpay-encryption`        | `NETPAY_ENCRYPTION_KEY`               | `openssl rand -base64 32`             | **No**¹ |
| `pii-encryption`           | `PII_ENCRYPTION_KEY`                  | `openssl rand -base64 32`             | **No**  |
| `pii-hmac`                 | `PII_HMAC_KEY`                        | `openssl rand -base64 48`             | **No**  |
> **Los nombres de este documento son una propuesta, no los que existen.** En el
> proyecto `vondi-0q` los secretos se llaman `control-plane-db-url`,
> `tenant-plane-db-url`, `control-plane-db-url-unpooled`,
> `tenant-plane-db-url-unpooled`, `jwt-access-secret`, `jwt-refresh-secret`,
> `pii-hmac-key`, `pii-encryption-key`, `netpay-encryption-key` y
> `docs-basic-auth-password`. Los comandos de §11.1 y §11.2 ya usan esos nombres
> reales; el resto del documento conserva los antiguos por brevedad. **Usa los
> reales**: un `--set-secrets` con un nombre inexistente hace fallar el deploy.

| `db-control-url`           | `CONTROL_PLANE_DATABASE_URL` (pooled) | §9.2                                  | Sí      |
| `db-app-url`               | `TENANT_PLANE_DATABASE_URL` (pooled)  | §9.2                                  | Sí      |
| `db-control-url-unpooled`  | `CONTROL_PLANE_DATABASE_URL_UNPOOLED` | §9.2 (solo Job de migraciones)        | Sí      |
| `db-app-url-unpooled`      | `TENANT_PLANE_DATABASE_URL_UNPOOLED`  | §9.2 (solo scripts de administración) | Sí      |
| `docs-basic-auth-password` | `DOCS_BASIC_AUTH_PASSWORD`            | Solo si `DOCS_ENABLED=true`           | Sí      |

¹ `NETPAY_ENCRYPTION_KEY` cifra los secretos de integración guardados; cambiarla los deja ilegibles. Tratarla como clave de datos.

**`pii-encryption` y `pii-hmac` no se rotan**: cambiarlas deja indescifrable el PII persistido y rompe el blind index. Requieren un proyecto de recifrado por lotes ([RB-04](#rb-04--rotación-de-pii_encryption_key)). Guardar una copia en custodia segura **fuera de GCP** antes del primer despliegue.

Variables **no secretas** (van en `--set-env-vars`): ver [§21.1](#211-variables-de-entorno-de-producción).

### 9.2 Las cuatro cadenas de conexión

Las URLs se construyen con los hosts de la rama `main` (consola → _Connect_):

```bash
NEON_HOST_POOL="ep-XXXX-pooler.us-east-2.aws.neon.tech"
NEON_HOST_DIRECT="ep-XXXX.us-east-2.aws.neon.tech"
PARAMS="sslmode=require&channel_binding=require"

CONTROL_URL="postgresql://mtb_control:${PWD_CONTROL}@${NEON_HOST_POOL}/${DB_NAME}?${PARAMS}"
APP_URL="postgresql://mtb_app:${PWD_APP}@${NEON_HOST_POOL}/${DB_NAME}?${PARAMS}"
CONTROL_URL_UNPOOLED="postgresql://mtb_control:${PWD_CONTROL}@${NEON_HOST_DIRECT}/${DB_NAME}?${PARAMS}"
APP_URL_UNPOOLED="postgresql://mtb_app:${PWD_APP}@${NEON_HOST_DIRECT}/${DB_NAME}?${PARAMS}"
```

Reglas:

1. **Pooled = host con `-pooler`** (aplicación). **Directa = host sin `-pooler`** (migraciones, seeds, admin). `scripts/migrate.ts` aborta si la URL de migración contiene `-pooler.`.
2. `sslmode=require` y `channel_binding=require` son los valores por defecto de las cadenas de Neon. Las contraseñas generadas con `openssl rand -hex` no necesitan escape; si se usan otros caracteres, aplicar _percent-encoding_ (`@ / : #`).
3. **No** añadir `pgbouncer=true`, `connection_limit`, `pool_timeout`, `connect_timeout` ni `schema=`: `pg` no los lee. El tamaño del pool y los timeouts son las variables `DATABASE_*` ([§15](#15-capacidad-y-conexiones)).
4. **[VERIFICAR]** una vez en staging: que la aplicación arranca con estas URLs (el `onModuleInit` de ambos servicios hace `SELECT 1`) y que `npm run db:migrate:deploy` funciona con la URL directa.

### 9.3 Creación

```bash
mk() { gcloud secrets create "$1" --replication-policy=automatic --data-file=-; }

printf '%s' "$(openssl rand -base64 48)" | mk jwt-access
printf '%s' "$(openssl rand -base64 48)" | mk jwt-refresh
printf '%s' "$(openssl rand -base64 48)" | mk pii-hmac
printf '%s' "$(openssl rand -base64 32)" | mk pii-encryption
printf '%s' "$(openssl rand -base64 32)" | mk netpay-encryption
printf '%s' "$CONTROL_URL"          | mk db-control-url
printf '%s' "$APP_URL"              | mk db-app-url
printf '%s' "$CONTROL_URL_UNPOOLED" | mk db-control-url-unpooled
printf '%s' "$APP_URL_UNPOOLED"     | mk db-app-url-unpooled
```

Conceder acceso **por secreto y por cuenta** (nunca a nivel de proyecto):

```bash
grant() { # grant <secreto> <sa>
  gcloud secrets add-iam-policy-binding "$1" \
    --member="serviceAccount:$2" --role="roles/secretmanager.secretAccessor"
}

for S in jwt-access jwt-refresh pii-hmac pii-encryption netpay-encryption db-control-url db-app-url; do
  grant "$S" "$RUNTIME_SA"
done
grant db-control-url-unpooled "$MIGRATOR_SA"
```

`vondi-runtime` **no** accede a las URLs directas. El deployer no lee valores; si `gcloud run deploy --set-secrets` pide permiso de metadatos, concederle `roles/secretmanager.viewer` sobre esos secretos.

> Referencias `:latest` en secretos rotables. Para los **no rotables**, fijar la versión numérica (`pii-encryption:1`), de modo que una versión nueva accidental nunca llegue a producción sin un despliegue.

### 9.4 Prueba de arranque con valores de ejemplo

La validación Zod debe **rechazar** (el proceso muere al arrancar): `PII_ENCRYPTION_KEY` de ejemplo (`AAAA…`), `PII_HMAC_KEY=change-me-blind-index-key`, `NETPAY_ENCRYPTION_KEY` de ejemplo, `CORS_ORIGINS=*` fuera de desarrollo, `DOCS_BASIC_AUTH_PASSWORD` de ejemplo con `DOCS_ENABLED=true`, y la ausencia de `TENANT_PLANE_DATABASE_URL` en producción. Que fallen demuestra que el gate funciona.

---

## 10. Fase 5 — Imagen Docker

El `Dockerfile` actual es multi-stage, no root, con `tini`. Dos cambios:

1. Eliminar `EXPOSE 3000` (Cloud Run inyecta `PORT`).
2. Añadir un **target `migrate`** para el Job. La imagen de runtime poda `devDependencies`, y `prisma` (CLI) y `tsx` están ahí; además `scripts/` no se compila a `dist/`.

Insertar **antes** de `RUN npm prune --omit=dev` la copia de scripts, y añadir al final del Dockerfile:

```dockerfile
# En el stage builder, antes de `npm prune`:
COPY scripts ./scripts

# ... stage runtime existente (sin EXPOSE) ...

# --- Migrate target ---------------------------------------------------------
# Incluye node_modules completo (prisma CLI + tsx). No se despliega como servicio.
FROM node:22-alpine AS migrate
WORKDIR /app
RUN apk add --no-cache openssl tini && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
COPY --chown=app:app package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app prisma.config.ts tsconfig.json ./
COPY --chown=app:app scripts ./scripts
USER app
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "scripts/migrate.ts"]
```

> Como el stage `migrate` va al final, un `docker build .` sin `--target` produciría la imagen de migración. Para evitarlo, definir el stage `runtime` como último y poner `migrate` **antes** de él, o construir siempre con `--target` explícito (lo hace el workflow de la §12).

Construcción (CI lo hace con `buildx`):

```bash
docker buildx build --platform=linux/amd64 --target runtime \
  --provenance=true --sbom=true -t "$IMAGE_BASE:$GIT_SHA" --push .
docker buildx build --platform=linux/amd64 --target migrate \
  -t "$IMAGE_BASE-migrate:$GIT_SHA" --push .
```

Despliegue siempre por **digest** (`…@sha256:…`), no por tag: un tag es mutable.

---

## 11. Fase 6 — Servicio, Job de migraciones y primer despliegue

### 11.1 Job de migraciones

Las migraciones **no** corren en el arranque: Cloud Run arranca N instancias a la vez y `prisma migrate deploy` no es idempotente bajo concurrencia. Corren en un Job con la conexión **directa**.

```bash
gcloud run jobs deploy "$MIGRATE_JOB" \
  --region="$REGION" \
  --image="$IMAGE_BASE-migrate:$GIT_SHA" \
  --service-account="$MIGRATOR_SA" \
  --network=vondi-net --subnet=vondi-subnet --vpc-egress=all-traffic \
  --cpu=1 --memory=512Mi --task-timeout=900 \
  --max-retries=0 --tasks=1 --parallelism=1 \
  --set-secrets="CONTROL_PLANE_DATABASE_URL_UNPOOLED=control-plane-db-url-unpooled:latest"

gcloud run jobs execute "$MIGRATE_JOB" --region="$REGION" --wait
```

- `--max-retries=0 --tasks=1 --parallelism=1`: una migración se ejecuta una vez; si falla es un fallo visible con intervención humana.
- `--vpc-egress=all-traffic`: **el Job también debe salir por la IP del NAT**, o Neon lo rechaza.
- El Job se redeploya con la imagen del release en cada ejecución (lo hace el workflow).

### 11.2 Primer despliegue (bootstrap)

El primer servicio necesita una imagen existente. Construir y subir la primera imagen manualmente o ejecutando el workflow una vez con `skip_deploy`; después:

```bash
COMMON=(
  --region="$REGION"
  --image="$IMAGE_BASE@sha256:<digest>"
  --service-account="$RUNTIME_SA"
  --network=vondi-net --subnet=vondi-subnet --vpc-egress=all-traffic
  --execution-environment=gen2
  --concurrency=15 --cpu=1 --memory=512Mi --timeout=60 --no-cpu-throttling
  --startup-probe="httpGet.path=/health/live,initialDelaySeconds=0,periodSeconds=2,timeoutSeconds=2,failureThreshold=30"
  --liveness-probe="httpGet.path=/health/live,periodSeconds=30,timeoutSeconds=3,failureThreshold=3"
  --set-env-vars="^@^NODE_ENV=production@API_PREFIX=api/v1@API_BASE_DOMAIN=api.vondi.tupla.studio@CORS_ORIGINS=https://app.vondi.tupla.studio@TRUST_PROXY_HOPS=2@DOCS_ENABLED=false@PII_LOG_REDACTION=true@LOG_LEVEL=log@DATABASE_POOL_MAX=10@DATABASE_CONNECTION_TIMEOUT_MS=15000@DATABASE_STATEMENT_TIMEOUT_MS=15000@PAYMENT_REDIRECT_URL=https://api.vondi.tupla.studio/api/v1/payments/return@PAYMENT_CANCEL_URL=https://app.vondi.tupla.studio/payments/cancelled"
  --set-secrets="CONTROL_PLANE_DATABASE_URL=control-plane-db-url:latest,TENANT_PLANE_DATABASE_URL=tenant-plane-db-url:latest,JWT_ACCESS_SECRET=jwt-access-secret:latest,JWT_REFRESH_SECRET=jwt-refresh-secret:latest,PII_HMAC_KEY=pii-hmac-key:latest,PII_ENCRYPTION_KEY=pii-encryption-key:latest,NETPAY_ENCRYPTION_KEY=netpay-encryption-key:latest"
)

# Producción: detrás del balanceador, sin tráfico público directo
gcloud run deploy "$SERVICE" "${COMMON[@]}" \
  --ingress=internal-and-cloud-load-balancing --allow-unauthenticated \
  --min-instances=1 --max-instances=4 \
  --update-env-vars="OUTBOUND_WEBHOOK_ENABLED=true"

# Canario: privado (requiere token de identidad), webhooks desactivados
gcloud run deploy "$CANARY_SERVICE" "${COMMON[@]}" \
  --ingress=all --no-allow-unauthenticated \
  --min-instances=0 --max-instances=1 \
  --update-env-vars="OUTBOUND_WEBHOOK_ENABLED=false"
```

> `--set-env-vars` reemplaza el conjunto; el delimitador `^@^` evita problemas con comas (p. ej. `CORS_ORIGINS` con varias URLs). En la práctica, unificar todas las variables de [§21.1](#211-variables-de-entorno-de-producción) en `COMMON` y usar `--update-env-vars` para las diferencias por servicio, tal como hace el workflow.

### 11.3 Flags del servicio

| Flag                      | Valor                               | Motivo                                                                                      |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `--vpc-egress`            | `all-traffic`                       | **Obligatorio** para que Neon vea la IP del NAT (ADR-002).                                  |
| `--no-cpu-throttling`     | activo                              | El dispatcher de webhooks (`setInterval` de 5 s) y Argon2id necesitan CPU entre peticiones. |
| `--min-instances`         | `1` (prod)                          | Evita pagar arranque de Nest + TLS + conexión en la primera petición.                       |
| `--max-instances`         | `4`                                 | Ver [§15](#15-capacidad-y-conexiones).                                                      |
| `--concurrency`           | `15`                                | Argon2id es CPU puro; con 1 vCPU no conviene más.                                           |
| `--timeout`               | `60`                                | Techo por petición.                                                                         |
| `--ingress`               | `internal-and-cloud-load-balancing` | La URL `run.app` deja de ser pública; todo pasa por el LB con Cloud Armor.                  |
| `--allow-unauthenticated` | solo en producción                  | La autenticación es de la aplicación (JWT/API key); sin esto el LB recibe 403 de IAM.       |

**Probes.** Ambos sobre `/health/live`. **No** usar `/health/ready` como startup/liveness: devuelve 503 si Postgres no responde y un probe que falla reinicia el contenedor; con Neon un despertar lento del compute provocaría reinicios en bucle. `/health/ready` es para monitorización y uptime checks. Nota: `onModuleInit` de ambos servicios Prisma hace `SELECT 1` al arrancar, por lo que el startup probe (hasta 60 s) ya exige BD alcanzable.

### 11.4 `TRUST_PROXY_HOPS`

Con valor `0` (por defecto) `request.ip` es la IP del proxy de Google: el rate limit por IP y la auditoría quedan inservibles. El valor correcto depende de la cadena de proxies:

| Cadena                                        | Valor probable |
| --------------------------------------------- | -------------- |
| Cliente → Cloud Run directo                   | `1`            |
| Cliente → LB global → Cloud Run (este diseño) | `2`            |

**[VERIFICAR] antes de producción:** hacer una petición desde una IP conocida contra el canario/staging detrás del LB y comprobar que la IP registrada (log/auditoría) es la del cliente y no la del LB ni un frontend de Google. Ajustar el valor hasta que coincida. No asumirlo.

### 11.5 Verificación

```bash
gcloud run services describe "$SERVICE" --region="$REGION" \
  --format='value(status.url, spec.template.spec.containers[0].image)'
gcloud run services logs read "$SERVICE" --region="$REGION" --limit=50
```

Esperado en los logs: `Listening on http://0.0.0.0:8080 (production)` y `API base path: /api/v1`; ausencia de la línea de documentación (confirma `DOCS_ENABLED=false`).

#### 11.5 Consultar `/docs` en un servicio privado

`DOCS_ENABLED=true` exige `DOCS_BASIC_AUTH_USER` y `DOCS_BASIC_AUTH_PASSWORD`: sin ellas el proceso muere al arrancar (`env.validation.ts`). La referencia se monta en `/docs` y el documento en `/docs/openapi.json`, **fuera** del prefijo `api/v1`.

En el canario y en producción la URL `run.app` es privada, así que hacen falta las dos credenciales a la vez, en cabeceras distintas:

```bash
URL=https://vondi-api-259853160457.us-east5.run.app
ID=$(gcloud auth print-identity-token)
# Basic -> Authorization (lo consume el guard de la app)
# ID token -> X-Serverless-Authorization (lo consume la IAM de Cloud Run, con precedencia)
curl -u "$DOCS_USER:$DOCS_PASS" \
     -H "X-Serverless-Authorization: Bearer $ID" \
     "$URL/docs/openapi.json"
```

El guard de docs solo lee `authorization` (`scalar-docs.service.ts`), igual que el guard de la API; por eso el token de identidad tiene que ir en `X-Serverless-Authorization`. Un navegador no puede enviar un ID token de Google, así que para ver la UI hay que tunelizar: `gcloud run services proxy "$SERVICE" --region="$REGION"`.

Guardar `DOCS_BASIC_AUTH_PASSWORD` como env var en claro es aceptable en el canario; en producción, moverlo a Secret Manager (`docs-basic-auth-password`, ver la matriz de §9.1) igual que `JWT_ACCESS_SECRET`.

---

### 11.6 Estado verificado en `vondi-0q`

Comprobado con `gcloud`, no deducido del repositorio. La tabla separa lo
desplegado de lo que este documento diseña:

| Aspecto                                 | Diseño                    | Real                              |
| --------------------------------------- | ------------------------- | --------------------------------- |
| Red                                     | `vondi-net` + NAT         | existe (creada 2026-10-17)       |
| Egress del servicio y del Job           | `all-traffic` por NAT     | aplicado y verificado            |
| IP de salida                            | reservada                 | `34.162.112.204`                  |
| Probes                                  | startup + liveness        | solo en el canario                |
| `--timeout`                             | `60s`                     | `300s`                            |
| `--min-instances`                       | `1`                       | `0`                               |
| `--no-cpu-throttling`                   | activo                    | inactivo                          |
| `--ingress`                             | cerrado + LB              | `all` (no hay LB desplegado)     |
| `DOCS_ENABLED`                          | `false`                   | `true`                            |
| Canario                                 | `vondi-api-canary`        | existe, privado, webhooks off     |
| SA del Job de migraciones               | `vondi-migrator`          | asignada                          |
| IAM del deployer (canario + token)      | `run.invoker` + `TokenCreator` | concedido                     |

Qué se verificó al poner el egress, y por qué en ese orden:

1. Se creó la red con [scripts/provision-network.sh](../scripts/provision-network.sh).
2. **Primero el Job de migraciones, no el servicio.** El Job corre
   `prisma migrate deploy` contra la base: si Neon no acepta la IP del NAT, el
   Job falla por conexión y no se toca nada que esté sirviendo tráfico. Ejecutado
   en verde, la base responde desde esa IP. Resultado: **Neon no tiene una
   allowlist que lo bloquee** en este proyecto (por eso no hizo falta tocar Neon).
3. Después el servicio. `/health/ready` responde con ambos planos de base `up`.

Lo que sigue pendiente, y por qué no se hizo aquí:

- `--ingress=internal-and-cloud-loadbalancing` **no** se aplicó: sin el balanceador
  global desplegado, la URL `run.app` quedaría inalcanzable y sería una caída de
  producción. Es un proyecto con su propia CDN y reglas de firewall.
- `min-instances=1` y `--no-cpu-throttling` cuestan dinero de forma continua
  (CPU siempre asignada con `min-instances>0`), así que son decisión de negocio.
- Probes en producción: el canario ya las tiene; copiarlas es inocuo y conviene,
  pero `/health/live` no comprueba la base, así que un probe de arranque no
  protege de un fallo de Neon. Para eso está `/health/ready` en monitorización.

Nota sobre `gcloud`: el egress directo **no** aparece en `spec.template.spec.vpcAccess`
sino en anotaciones (`run.googleapis.com/network-interfaces` y
`run.googleapis.com/vpc-access-egress`). Un `describe --format='value(...vpcAccess)'`
sale vacío y hace pensar que el flag no se aplicó. Con jobs, además, hay que
mirar `spec.template.metadata.annotations` (un export en YAML lo deja claro).

---

## 12. Fase 7 — GitHub Actions

### 12.1 Flujo

```
verify ─► build ─► migrate ─► deploy (canario + revisión sin tráfico) ─► smoke ─► promote
                                                                          │         │
                                                       falla: nada llega  ┘         └ falla: rollback
```

- Cada release usa un **nombre de revisión determinista** `r<sha7>-<intento>`; el nombre completo es `<servicio>-r<sha7>-<intento>`.
- El canario es un servicio **separado** porque producción tiene ingress cerrado y su URL no es alcanzable desde CI.
- El canario apunta a la **misma BD de producción** (solo lectura en el smoke) y con `OUTBOUND_WEBHOOK_ENABLED=false` para no despachar webhooks desde una versión no validada.

### 12.2 CI de verificación

El Postgres de CI necesita los roles `mtb_control` y `mtb_app`. Un `services: postgres` no ejecuta `docker/postgres/init/01-roles.sql`; ejecutarlo con `psql` tras levantar el servicio (el script lee las contraseñas de `MTB_CONTROL_PASSWORD`/`MTB_APP_PASSWORD`, igual que `docker-compose.yml`; si no admite variables fuera de initdb, adaptar con `psql -v`).

### 12.3 `.github/workflows/deploy.yml`

Implementado en [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml),
que es la fuente de verdad. Este resumen explica las decisiones; el YAML no se
duplica aquí para que no derive.

```
verify ─► build ─► migrate ─► deploy (canario + revisión sin tráfico) ─► smoke ─► promote
                                                                          │         │
                                                       falla: nada llega  ┘         └ falla: rollback
```

| Job          | Qué hace                                                                                                   | Falla si…                        |
| ------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `verify`     | gitleaks (set commiteable + histórico), format, lint, typecheck, migrations:validate, `test:cov` + subida a Codecov, roles de la BD, `prisma:seed`, `test:e2e` | algo del gate falla              |
| `build`      | runtime y migrate por digest, con SBOM y provenance, y Trivy `HIGH,CRITICAL` con `exit-code: 1`            | la imagen tiene una vulnerabilidad |
| `migrate`    | `gcloud run jobs execute --wait` con `--tasks=1 --parallelism=1 --max-retries=0`                            | la migración falla               |
| `deploy`     | canario y revisión de producción con `--no-traffic`, nombre `r<sha>-<intento>`                              | el servicio no acepta la imagen  |
| `smoke`      | `/health/live`, `/health/ready` y una ruta protegida (401/403) contra el canario                            | la revisión no sirve tráfico     |
| `promote`    | `update-traffic` al 100% y verificación; si la revisión no queda `Ready=True`, vuelve el tráfico a la anterior | —                               |

Cuatro puntos donde la implementación difiere del diseño original de este
documento, todos por una razón concreta:

1. **El token de identidad del smoke lo emite la action de auth, no
   `gcloud auth print-identity-token`.** Ese comando rechaza credenciales WIF
   (`external_account`); el smoke se quedaba sin token y el paso fallaba siempre.
   Se usa `token_format: id_token` con `id_token_audience` = URL del canario.
2. **`npm run secrets:staged` no sirve en CI.** Escanea el índice de git, que en
   un checkout de Actions está vacío: escanearía cero ficheros. El gate usa
   `npm run secrets` (set commiteable) y `npm run secrets:history`.
3. **La ruta protegida del smoke es real**, no un marcador: `GET /api/v1/api-keys`
   exige JWT (`API_PREFIX=api/v1`, ver `.env.example`).
4. **Las migraciones se aplican antes del seed.** `prisma:seed` escribe en el
   esquema, así que una base recién creada fallaría. Se usa
   `npm run db:migrate:deploy`, que es el mismo entrypoint que ejecuta el Job de
   producción (`scripts/migrate.ts`), y no un `prisma migrate deploy` suelto: el
   CI ejercita la misma ruta que producción, incluido el guard que rechaza el
   pooler.

Detalles de `verify` que no son obvios:

- El plano de control migra como el superusuario del Postgres de servicio y el
  plano de datos conecta como `mtb_app`. Es lo mismo que `.env.test.example`: si
  el plano de datos conectara como dueño de tabla, las políticas RLS no serían
  exigibles porque un dueño las ignora.
- `prisma.config.ts` lee `CONTROL_PLANE_DATABASE_URL_UNPOOLED` y **no** acepta
  fallback a la URL normal, así que el paso de e2e tiene que exportar esa
  variable o `prisma migrate deploy` falla.
- `prisma/seed.ts` es quien crea el catálogo RBAC. Sin él, `seedAdmin` no
  encuentra el rol `platform-owner` y toda ruta protegida responde 403.
- Las claves (PII, JWT, docs, seed) se generan efímeras por ejecución y se
  comparten entre seed y e2e: `env.validation.ts` rechaza los placeholders de
  `.env.example`, y si el seed y el servidor que arranca `beforeAll` usaran claves
  distintas, las filas PII que el seed cifra no se podrían descifrar.
- `01-roles.sql` usa `\getenv`, que necesita **psql 11 o superior**. En los
  runners de GitHub hay psql 16; en un macOS con el psql de `/usr/bin` (13 o
  anterior, o 9.x) el script aborta.

Notas del workflow:

- `environment: production` aplica reglas de protección (aprobadores) si se
  configuran.
- El deployer necesita `roles/run.invoker` sobre el canario para el smoke:
  ```bash
  gcloud run services add-iam-policy-binding "$CANARY" --region="$REGION" \
    --member="serviceAccount:$DEPLOYER_SA" --role="roles/run.invoker"
  gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" \
    --member="serviceAccount:$DEPLOYER_SA" --role="roles/iam.serviceAccountTokenCreator"
  ```
- Primero desplegar con `--no-traffic` y promover **por nombre de revisión**: el
  nombre determinista (`<servicio>-r<sha>-<intento>`) evita depender de "la última
  revisión".
- `skip_migrations` es solo para hotfix: deja el esquema por detrás del código.
- Rama `main` protegida: PR obligatorio, una revisión, checks obligatorios, sin
  force-push.
- Variables de GitHub (Environment `production`): `GCP_PROJECT_ID`, `GCP_REGION`,
  `CLOUD_RUN_SERVICE`, `CLOUD_RUN_CANARY`, `MIGRATE_JOB`, `AR_REPOSITORY`,
  `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`.

### 12.4 Compatibilidad de migraciones

Cloud Run mantiene la revisión anterior hasta la promoción, por lo que las migraciones deben ser compatibles hacia atrás.

| Permitido en un release       | Requiere dos releases |
| ----------------------------- | --------------------- |
| `CREATE TABLE`                | `DROP TABLE`          |
| `ADD COLUMN` nullable/default | `DROP COLUMN`         |
| `CREATE INDEX CONCURRENTLY`   | `ALTER COLUMN TYPE`   |
| Tabla de relación nueva       | `RENAME` de columna   |

### 12.5 Migraciones por tenant

`prisma/tenant-migrations/` se aplican en runtime por `TenantProvisionerService` **al aprovisionar** (la imagen las incluye). Un tenant ya provisionado **no** recibe migraciones nuevas: cualquier cambio de esquema que lo afecte requiere un script de backfill, fuera de este pipeline.

El provisioner ejecuta `CREATE SCHEMA` y DDL por el cliente del plano de control (host **pooled**), dentro de transacciones interactivas; es compatible con el modo transacción y no hay advisory locks de sesión. Si el volumen de provisiones crece, moverlo a un Job con conexión directa.

---

## 13. Fase 8 — Balanceador, Cloud Armor y dominio

La URL `run.app` no admite Cloud Armor ni dominio propio con certificado gestionado; para una API pública se usa un balanceador global.

```
Internet ─► Global HTTPS LB (IP estática) ─► Cloud Armor ─► Serverless NEG ─► Cloud Run (vondi-api)
```

### 13.1 Política de Cloud Armor

Se crea **antes** del backend. Las reglas se evalúan por prioridad ascendente:

```bash
gcloud compute security-policies create vondi-armor --description="WAF vondi-api"

# 1000: WAF — inyección SQL
gcloud compute security-policies rules create 1000 --security-policy=vondi-armor \
  --expression="evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})" \
  --action=deny-403

# 2000: rate limiting por IP (la aplicación limita por instancia, ver §15.3)
gcloud compute security-policies rules create 2000 --security-policy=vondi-armor \
  --src-ip-ranges="*" \
  --action=throttle \
  --rate-limit-threshold-count=600 --rate-limit-threshold-interval-sec=60 \
  --conform-action=allow --exceed-action=deny-429 --enforce-on-key=IP

# Regla por defecto (2147483647): allow — es una API pública
```

Las reglas de WAF preconfiguradas pueden dar falsos positivos con JSON de negocio. Desplegarlas primero en modo _preview_ (`--preview`), revisar los logs y solo entonces activarlas.

> Cloud Armor es una capa adicional. La defensa real contra inyección es el acceso parametrizado de Prisma y `SafeSqlService`.

### 13.2 Balanceador

```bash
gcloud compute addresses create vondi-lb-ip --global --ip-version=IPV4

gcloud compute network-endpoint-groups create vondi-neg \
  --region="$REGION" --network-endpoint-type=serverless \
  --cloud-run-service="$SERVICE"

gcloud compute backend-services create vondi-be \
  --global --load-balancing-scheme=EXTERNAL_MANAGED

gcloud compute backend-services add-backend vondi-be --global \
  --network-endpoint-group=vondi-neg --network-endpoint-group-region="$REGION"

gcloud compute backend-services update vondi-be --global \
  --security-policy=vondi-armor

gcloud compute url-maps create vondi-lb --default-service=vondi-be

gcloud compute ssl-certificates create vondi-cert \
  --domains="api.vondi.tupla.studio" --global

gcloud compute target-https-proxies create vondi-proxy \
  --ssl-certificates=vondi-cert --url-map=vondi-lb

gcloud compute forwarding-rules create vondi-fr \
  --global --load-balancing-scheme=EXTERNAL_MANAGED --network-tier=PREMIUM \
  --target-https-proxy=vondi-proxy --address=vondi-lb-ip --ports=443
```

### 13.3 DNS

Crear un registro `A` para `api.vondi.tupla.studio` hacia `vondi-lb-ip` **antes** de esperar el certificado gestionado (queda en `PROVISIONING` hasta que el DNS resuelve; puede tardar hasta decenas de minutos).

Los tenants usan subdominios derivados de `API_BASE_DOMAIN` (`acme.api.vondi.tupla.studio`). Un certificado por dominio exacto **no** los cubre: se necesita un registro DNS comodín (`*.api.vondi.tupla.studio`) y un certificado que lo incluya (certificado autogestionado, o certificado gestionado con autorización DNS en Certificate Manager). Definirlo antes del lanzamiento si la resolución de tenant es por subdominio.

---

## 14. Fase 9 — Observabilidad

### 14.1 Logs

Excluir el ruido de las sondas del almacenamiento de logs (con `min-instances=1` y probes cada pocos segundos, el volumen se dispara):

```bash
gcloud logging sinks update _Default \
  --add-exclusion='name=exclude-health,filter=resource.type="cloud_run_revision" AND httpRequest.requestUrl:"/health/"'

gcloud logging buckets update _Default --location=global --retention-days=30
```

Los logs de aplicación llevan `requestId` para correlación. OpenTelemetry/Cloud Trace requiere añadir el SDK; hoy no está.

### 14.2 Métricas de Neon

Las métricas del pooler (conexiones cliente/servidor, esperas) están en _Neon → Monitoring_ y se exportan por OpenTelemetry. **Son la fuente primaria para diagnosticar saturación de conexiones**; GCP solo ve el lado cliente.

### 14.3 Alertas

| Alerta                      | Condición                                                                                  | Sev. |
| --------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| Disponibilidad              | uptime check < 99 % en 5 min                                                               | P1   |
| Errores 5xx                 | ratio > 2 % en 5 min                                                                       | P1   |
| Instancias al máximo        | `instance_count` = 4 durante 10 min                                                        | P2   |
| **IP de salida modificada** | audit log `compute.addresses.*` o `compute.routers.patch` sobre `vondi-egress`/`vondi-nat` | P1   |
| Reinicios de contenedor     | `container/startup_latencies` o reinicios crecientes                                       | P1   |
| Migración fallida           | ejecución del Job `vondi-migrate` en estado Failed                                         | P1   |
| Espera en el pooler (Neon)  | clientes en _waiting_ > 0 sostenido                                                        | P1   |
| Conexiones cerca del tope   | conexiones de servidor > 80 % de `max_connections`                                         | P2   |
| Presupuesto                 | umbrales de §17                                                                            | P3   |

Si la IP de salida cambia, Neon rechaza la conexión y los logs muestran un error de IP no permitida o de autenticación; el síntoma no apunta a la causa ([RB-05](#rb-05--la-ip-de-salida-cambió)).

Uptime check externo contra el dominio público:

```bash
gcloud monitoring uptime create vondi-api-ready \
  --resource-type=uptime-url \
  --resource-labels=host=api.vondi.tupla.studio,project_id="$PROJECT_ID" \
  --path=/health/ready --protocol=https --period=1 --timeout=10
```

(Los flags de `gcloud monitoring uptime` cambian entre versiones: confirmar con `--help`.)

### 14.4 Auditoría

```bash
gcloud logging read 'protoPayload.serviceName="secretmanager.googleapis.com"
  AND protoPayload.methodName:"AccessSecretVersion"' \
  --project="$PROJECT_ID" --limit=50 \
  --format='table(timestamp, protoPayload.authenticationInfo.principalEmail, protoPayload.resourceName)'
```

Requiere los Data Access logs activados ([§6.5](#65-auditoría-de-secret-manager)). Las consultas SQL no se auditan en GCP; si la política lo exige, usar el registro de Neon y exportarlo (tarea pendiente, no cubierta aquí).

---

## 15. Capacidad y conexiones

### 15.1 Cadena de límites

```
Cloud Run                 Pooler Neon (PgBouncer, transaction)      Postgres
instancias × pool    →    max_client_conn = 10 000             →   max_connections = 419 (1 CU)
                          default_pool_size = 0.9 × 419 = 377      (7 reservadas)
                          por usuario y base de datos
```

Cada instancia tiene **dos pools de `pg`**: plano de control (`ControlPlanePrismaService`) y plano de datos (`TenantPrismaService.sharedPool`, uno solo para todos los tenants). Cada pool usa `DATABASE_POOL_MAX`.

| Parámetro           | Valor | Efecto                                            |
| ------------------- | ----- | ------------------------------------------------- |
| `--max-instances`   | 4     |                                                   |
| `--concurrency`     | 15    | hasta 60 peticiones concurrentes                  |
| `DATABASE_POOL_MAX` | 10    | hasta 40 conexiones cliente por rol (80 en total) |
| Compute Neon        | 1 CU  | pool del pooler de 377 por rol                    |

### 15.2 Por qué `DATABASE_POOL_MAX=10` y no 3

Con el pooler en modo transacción, una conexión cliente inactiva **no** ocupa una conexión de Postgres: solo la ocupa durante una transacción. Un pool cliente de 3 con `--concurrency=15` obliga a encolar peticiones (hasta `DATABASE_CONNECTION_TIMEOUT_MS`) sin ningún beneficio para Postgres. Con 10, el máximo es 40 conexiones por rol, muy por debajo de 377.

Neon aconseja no apilar pools grandes sobre el pooler; la cifra es una cota razonable, no un objetivo. Ajustar con las métricas de espera del pooler ([§14.2](#142-métricas-de-neon)). Aplica a ambos servicios Prisma (misma variable).

**El cuello real es la duración de las transacciones**, no el número de conexiones: una transacción larga mantiene fijada una conexión de Postgres durante todo ese tiempo. `DATABASE_STATEMENT_TIMEOUT_MS=15000` acota el peor caso.

### 15.3 El rate limiting de la aplicación es por instancia

`THROTTLE_LIMIT` y `AUTH_THROTTLE_LIMIT` son contadores en memoria. Con 4 instancias el límite efectivo es hasta 4× el configurado. El límite fiable para fuerza bruta está en Cloud Armor ([§13.1](#131-política-de-cloud-armor)); el de la aplicación es una segunda capa.

### 15.4 Webhooks y carga por tenant

`OUTBOUND_WEBHOOK_MAX_TENANTS_PER_TICK=200` con `POLL_INTERVAL_MS=5000`: cada tick recorre tenants **secuencialmente**, una transacción por tenant, con latencia de red a Neon por consulta. Si el número de tenants activos se acerca a 200, mover el drenaje a un Cloud Run Job con Cloud Scheduler (o servicio dedicado con `max-instances=1`) en lugar de subir el límite.

---

## 16. Continuidad y recuperación

Neon sustituye backups y PITR clásicos con **historial de WAL** (ventana según plan: **verificar la ventana configurada en el proyecto**) y **branching**. El RPO/RTO reales dependen de esa ventana y se confirman con un ensayo (§20).

### 16.1 Copia de seguridad previa a un cambio de riesgo

Una rama es una copia instantánea y barata:

```bash
neonctl branches create --project-id "$NEON_PROJECT_ID" \
  --name "pre-migration-$(date +%Y%m%d-%H%M)" --parent main
```

Hacerlo antes de cualquier migración destructiva o de riesgo.

### 16.2 Restaurar a un punto en el tiempo

```bash
neonctl branches restore main ^self@2026-10-15T10:30:00Z \
  --project-id "$NEON_PROJECT_ID" \
  --preserve-under-name main_old_20261015
```

- La rama conserva **el mismo endpoint y la misma cadena de conexión**: no hace falta cambiar secretos ni redesplegar. Las conexiones abiertas se interrumpen brevemente y el pool de `pg` se reconecta.
- Neon guarda el estado previo en una rama de respaldo (`main_old_<timestamp>`), que sirve para deshacer la restauración.
- Tras restaurar: ejecutar [RB-08](#rb-08--verificación-de-aislamiento-entre-tenants) y el smoke.

### 16.3 Rollback y esquema

El rollback de código (`update-traffic`) no revierte migraciones. Si una migración destructiva rompió la versión anterior, la salida es restaurar la BD (§16.2), no revertir código. Por eso [§12.4](#124-compatibilidad-de-migraciones) exige migraciones compatibles hacia atrás.

---

## 17. Entornos y costes

**Un proyecto GCP por entorno y una rama de Neon por entorno** (la rama es frontera de datos; el proyecto, de permisos).

|                 | dev                     | staging              | producción                                       |
| --------------- | ----------------------- | -------------------- | ------------------------------------------------ |
| Proyecto GCP    | `vondi-0q-dev`          | `vondi-0q-staging`   | `vondi-0q`                                       |
| Rama Neon       | `ci-<n>` efímera        | `staging`            | `main` (protegida)                               |
| Compute Neon    | 0.25 CU, suspende 5 min | 0.5 CU               | 1 CU, sin autosuspend                            |
| `min-instances` | 0                       | 0                    | 1                                                |
| Cloud Armor     | No                      | No                   | Sí                                               |
| Despliegue      | Manual                  | Automático en `main` | Automático en `main` + protección de environment |

Anonimizar `staging` antes de cualquier prueba con datos personales y rotar las contraseñas de sus roles (heredadas de `main`).

Costes: Cloud Run con CPU siempre asignada y `min-instances=1` factura de forma continua; compute Neon 1 CU sin autosuspend; Cloud NAT (hora + GB); Load Balancer; Cloud Armor; egreso. Control:

```bash
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' | sed 's|billingAccounts/||')"

gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
  --display-name="vondi mensual" --budget-amount=500USD \
  --filter-projects="projects/$PROJECT_ID" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.8 \
  --threshold-rule=percent=1.0 --threshold-rule=percent=1.5
```

Los presupuestos de GCP son periódicos (mensual/trimestral/anual): no existe un presupuesto _diario_. Para detectar fugas rápidas, usar las alertas de §14.3 y revisar _Billing → Reports_.

---

## 18. Runbooks

### RB-01 — Rollback de código

```bash
gcloud run revisions list --service="$SERVICE" --region="$REGION" \
  --format='table(name, active, creationTimestamp)'
gcloud run services update-traffic "$SERVICE" --region="$REGION" \
  --to-revisions="<revisión-anterior>=100"
```

Segundos; no toca migraciones. Válido porque las migraciones son compatibles hacia atrás.

### RB-02 — Rotación de JWT

```bash
printf '%s' "$(openssl rand -base64 48)" | gcloud secrets versions add jwt-access --data-file=-
gcloud run services update "$SERVICE" --region="$REGION" \
  --update-secrets=JWT_ACCESS_SECRET=jwt-access:latest
```

Repetir para `jwt-refresh` y para el canario. Invalida las sesiones y tokens emitidos: correcto tras una filtración, disruptivo por diseño.

### RB-03 — Rotación de contraseñas de Neon

1. En el editor SQL (host directo, como `neondb_owner`): `ALTER ROLE mtb_control PASSWORD '…'` y `ALTER ROLE mtb_app PASSWORD '…'`.
2. Nueva versión de **los cuatro** secretos de BD (`db-control-url`, `db-app-url` y sus `-unpooled`).
3. `gcloud run services update … --update-secrets=…` (servicio, canario) y redeploy del Job.

Actualizar los cuatro: si se omite el `-unpooled`, la migración del siguiente despliegue falla. Las instancias existentes con la contraseña antigua perderán conexiones nuevas hasta que se reemplacen; el update fuerza una revisión nueva.

### RB-04 — Rotación de `PII_ENCRYPTION_KEY`

No es un runbook de una página; requiere un proyecto de datos: (1) inventariar campos cifrados; (2) desplegar un binario que acepte dos claves; (3) backfill por lotes con verificación; (4) cortar a la nueva clave; (5) retirar la compatibilidad tras el periodo de retención.

### RB-05 — La IP de salida cambió

Síntoma: todas las peticiones fallan contra la BD; errores de IP no permitida / autenticación en logs.

```bash
NEW_IP=$(gcloud compute addresses describe vondi-egress --region="$REGION" --format='value(address)')
gcloud compute routers nats describe vondi-nat --router=vondi-router --region="$REGION" \
  --format='value(natIps, natIpAllocateOption)'     # esperado: MANUAL_ONLY y la IP reservada

neonctl ip-allow add "$NEW_IP/32" --project-id "$NEON_PROJECT_ID"
# Tras confirmar el servicio, retirar la IP antigua:
neonctl ip-allow remove "<ip-antigua>/32" --project-id "$NEON_PROJECT_ID"
```

Añadir la nueva **antes** de retirar la antigua. Causa habitual: alguien puso el NAT en asignación automática o recreó la dirección reservada.

### RB-06 — Pooler saturado

Síntoma: latencia alta con poco tráfico; en Neon, _client connections waiting_.

```sql
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
SELECT usename, count(*) FROM pg_stat_activity WHERE datname = 'neondb' GROUP BY usename;
```

| Causa                         | Acción                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Transacciones largas          | Localizar el endpoint; `statement_timeout` ya es de 15 s                                              |
| Picos de concurrencia         | Bajar `--concurrency` o subir instancias                                                              |
| Compute insuficiente          | Subir de 1 a 2 CU (839 conexiones). No siempre ayuda si el cuello es la duración de las transacciones |
| Pool cliente demasiado grande | Reducir `DATABASE_POOL_MAX`                                                                           |

### RB-07 — Incidente en Neon

Comprobar el estado del proveedor y del endpoint; escalar a soporte con el ID de proyecto y de rama. RB-01 descarta el código como causa.

### RB-08 — Verificación de aislamiento entre tenants

Repetible tras cualquier cambio de esquema o permisos, como `mtb_app` por el host pooled:

```sql
BEGIN; SET LOCAL app.current_tenant = 'tenant_a'; SELECT count(*) FROM tenant_a.orders; COMMIT;  -- > 0
BEGIN; SET LOCAL app.current_tenant = 'tenant_b'; SELECT count(*) FROM tenant_b.orders; COMMIT;  -- > 0 (otras filas)
BEGIN; SELECT count(*) FROM tenant_a.orders; COMMIT;                                              -- 0
```

Cualquier otro resultado es un **incidente de seguridad P0**.

### RB-09 — Migración de riesgo

1. Crear rama de respaldo ([§16.1](#161-copia-de-seguridad-previa-a-un-cambio-de-riesgo)).
2. Ejecutar el workflow.
3. Si falla a medias: no reintentar automáticamente; evaluar con la rama de respaldo y, si procede, restaurar ([§16.2](#162-restaurar-a-un-punto-en-el-tiempo)).

---

## 19. Riesgos conocidos

### 19.1 El dispatcher de webhooks es un `setInterval` en proceso

`OutboundDispatcher.onApplicationBootstrap` programa un `setInterval` por proceso: con `max-instances=4` hay hasta cuatro planificadores. El claim es un `updateMany` condicional dentro de la transacción del tenant (migración `0005_webhook_delivery_claim`): dos planificadores compitiendo por una fila producen **un** propietario. Entrega _al menos una vez_, desordenada y acotada; compatible con el pooler.

Riesgo residual: el volumen de consultas escala con las instancias ([§15.4](#154-webhooks-y-carga-por-tenant)). El canario se despliega con `OUTBOUND_WEBHOOK_ENABLED=false`.

### 19.2 Un `SET` de sesión rompería el aislamiento sin error

Ver ADR-005. Hoy las rutas de tenant usan `SET LOCAL`. Excepción conocida: `prisma/seed.ts` usa `SET search_path` de sesión; es un script de una ejecución que **debe correr con la URL directa** (`*_UNPOOLED`), nunca por el pooler. Mitigación: regla de revisión, prueba §8.5 y, opcionalmente, una regla ESLint que prohíba `SET` sin `LOCAL` en `src/`.

### 19.3 La IP de salida es un punto único de fallo

Ver ADR-002, alerta P1 y RB-05.

### 19.4 La base de datos no es privada

Cifrado en tránsito + IP Allow, pero no hay PrivateLink en GCP. Riesgo aceptado; para eliminarlo habría que mover el runtime a AWS.

### 19.5 Ramas de Neon heredan datos y contraseñas

Ver §8.1. Ramas hijas de `main` fuera de IP Allow son un camino de exfiltración si se dejan sin proteger o con credenciales heredadas.

### 19.6 Migraciones por tenant no retroactivas

Ver §12.5.

### 19.7 Migración destructiva y rollback

Ver §12.4 y §16.3. Razón de `--max-retries=0` en el Job.

### 19.8 Canario contra la BD de producción

El canario comparte la BD de producción. El smoke es de solo lectura y los webhooks están desactivados; aun así, un bug de arranque que escriba datos afectaría producción. Si el riesgo no es aceptable, apuntar el canario a una rama de Neon con copia de producción (mismas credenciales de rol, host distinto) y mantenerla fuera de este flujo.

---

## 20. Checklist previo a producción

### Neon

- [ ] Región `aws-us-east-2` y Cloud Run en `us-east5`; latencia medida ([§8.7](#87-medir-la-latencia))
- [ ] Plan Scale o superior (IP Allow)
- [ ] `main` protegida, 1 CU, sin autosuspend (verificado en consola)
- [ ] IP Allow = `$EGRESS_IP/32`, _Protected branches only_; **[VERIFICAR]** rechazo desde otra IP en host directo **y** pooled
- [ ] `mtb_control` y `mtb_app` con `rolsuper = f` y `rolbypassrls = f`
- [ ] `REVOKE CREATE ON DATABASE … FROM PUBLIC`; `mtb_app` sin privilegios en `public`
- [ ] Pruebas de §8.5 correctas; la prueba 4 repetida ~20 veces
- [ ] Ventana de historial confirmada y restauración ensayada ([§16.2](#162-restaurar-a-un-punto-en-el-tiempo))
- [ ] `staging` protegida o con contraseñas rotadas y datos anonimizados

### Red

- [x] `vondi-egress` es una dirección **reservada** (`34.162.112.204`); NAT en `MANUAL_ONLY`
- [x] Servicio, canario y Job con `--vpc-egress=all-traffic`, verificado contra la base ([§11.6](#116-estado-verificado-en-vondi-0q))
- [x] `--enable-private-ip-google-access` activo
- [ ] `roles/compute.networkUser` sobre `vondi-subnet` solo para `vondi-runtime` y `vondi-migrator`
- [ ] Permisos de escritura sobre `vondi-egress`/`vondi-nat` restringidos; alerta configurada
- [ ] DNS (`api…` y comodín de tenants si aplica) y certificado en `ACTIVE`

### Identidad

- [ ] WIF con condición sobre repositorio **y** rama; `principalSet` con número de proyecto
- [ ] Ninguna clave JSON en GitHub
- [ ] Runtime sin acceso a las URLs directas; migrator solo a `db-control-url-unpooled`
- [ ] Data Access logs de Secret Manager activos

### Secretos y configuración

- [ ] Cuatro cadenas de conexión creadas (hosts correctos, sin parámetros inertes)
- [ ] Copia de custodia de `pii-encryption`, `pii-hmac`, `netpay-encryption`
- [ ] Secretos no rotables fijados a versión numérica
- [ ] `DOCS_ENABLED=false`, `PII_LOG_REDACTION=true`, `DATABASE_POOL_MAX` y timeouts aplicados
- [ ] `TRUST_PROXY_HOPS` verificado empíricamente tras el LB ([§11.4](#114-trust_proxy_hops))
- [ ] Valores de ejemplo rechazados al arrancar ([§9.4](#94-prueba-de-arranque-con-valores-de-ejemplo))

### Pipeline

- [ ] Dockerfile con target `migrate` y sin `EXPOSE`
- [ ] Imagen con provenance + SBOM; Trivy bloquea HIGH/CRITICAL
- [ ] Migraciones en Job (`--max-retries=0`) antes de cualquier tráfico; Job sale por la IP del NAT
- [ ] Canario sin webhooks, privado; smoke con token de identidad
- [ ] Despliegue por digest, `--no-traffic`, promoción por nombre de revisión
- [ ] Rollback ensayado

### Observabilidad y operación

- [ ] Logs de sondas excluidos; retención configurada
- [ ] Alertas de disponibilidad, 5xx, IP de salida, pooler y migración
- [ ] Uptime check externo
- [ ] Presupuesto mensual
- [ ] Runbooks accesibles a guardia; rotación de secretos ensayada en staging
- [ ] Regla de revisión `SET` vs `SET LOCAL` adoptada

---

## 21. Apéndices

### 21.1 Variables de entorno de producción

**Servicio (`--set-env-vars` / `--update-env-vars`):**

```
NODE_ENV=production
API_PREFIX=api/v1
API_BASE_DOMAIN=api.vondi.tupla.studio
CORS_ORIGINS=https://app.vondi.tupla.studio
TRUST_PROXY_HOPS=2                         # verificar (§11.4)
DOCS_ENABLED=false
PII_LOG_REDACTION=true
LOG_LEVEL=log
TENANT_CLIENT_CACHE_MAX=200
DATABASE_POOL_MAX=10
DATABASE_POOL_IDLE_TIMEOUT_MS=30000
DATABASE_CONNECTION_TIMEOUT_MS=15000
DATABASE_STATEMENT_TIMEOUT_MS=15000
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
JWT_ISSUER=vondi-api
JWT_AUDIENCE=vondi-api-v1
ARGON2_MEMORY_COST=19456
ARGON2_TIME_COST=2
ARGON2_PARALLELISM=1
AUTH_MAX_FAILED_ATTEMPTS=5
AUTH_LOCKOUT_DURATION=15m
AUTH_THROTTLE_LIMIT=10
AUTH_THROTTLE_TTL=60s
THROTTLE_LIMIT=300
THROTTLE_TTL=60s
API_KEY_PREFIX=mtb
API_KEY_DEFAULT_TTL_DAYS=90
PAYMENT_REDIRECT_URL=https://api.vondi.tupla.studio/api/v1/payments/return
PAYMENT_CANCEL_URL=https://app.vondi.tupla.studio/payments/cancelled
OUTBOUND_WEBHOOK_ENABLED=true              # false en el canario
OUTBOUND_WEBHOOK_REQUIRE_HTTPS=true
OUTBOUND_WEBHOOK_ALLOWED_CIDRS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,169.254.0.0/16
```

Las variables con comas (`OUTBOUND_WEBHOOK_ALLOWED_CIDRS`, `CORS_ORIGINS` con varios orígenes) exigen un delimitador alternativo en `gcloud` (`--set-env-vars="^@^A=1,2@B=3"`) o `--env-vars-file=env.yaml`. Preferir `--env-vars-file`.

**Secretos (`--set-secrets`):**

```
CONTROL_PLANE_DATABASE_URL=db-control-url:latest
TENANT_PLANE_DATABASE_URL=db-app-url:latest
JWT_ACCESS_SECRET=jwt-access:latest
JWT_REFRESH_SECRET=jwt-refresh:latest
PII_HMAC_KEY=pii-hmac:1
PII_ENCRYPTION_KEY=pii-encryption:1
NETPAY_ENCRYPTION_KEY=netpay-encryption:1
```

**Solo en el Job de migraciones:** `CONTROL_PLANE_DATABASE_URL_UNPOOLED=db-control-url-unpooled:latest`.

### 21.2 Comandos de referencia

```bash
# Cloud Run
gcloud run services describe vondi-api --region=us-east5
gcloud run revisions list --service=vondi-api --region=us-east5
gcloud run services logs tail vondi-api --region=us-east5
gcloud run jobs executions list --job=vondi-migrate --region=us-east5

# IP de salida que Neon tiene permitida
gcloud compute addresses describe vondi-egress --region=us-east5 --format='value(address,status)'

# Neon
neonctl branches list --project-id "$NEON_PROJECT_ID"
neonctl ip-allow list --project-id "$NEON_PROJECT_ID"

# Secretos
gcloud secrets versions list jwt-access
```

### 21.3 Referencias

- Proyecto: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/NETPAY-INTEGRATION.md`
- Cloud Run — IP de salida estática: https://docs.cloud.google.com/run/docs/configuring/static-outbound-ip
- Cloud Run — regiones: https://docs.cloud.google.com/run/docs/locations
- Workload Identity Federation: https://cloud.google.com/iam/docs/workload-identity-federation
- Cloud Armor: https://cloud.google.com/armor/docs
- Neon — pooling: https://neon.com/docs/connect/connection-pooling
- Neon — Prisma: https://neon.com/docs/guides/prisma
- Neon — IP Allow: https://neon.com/docs/introduction/ip-allow
- Neon — restaurar ramas: https://neon.com/docs/guides/branch-restore
- Neon — CLI: https://neon.com/docs/reference/neon-cli
