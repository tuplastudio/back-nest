-- ---------------------------------------------------------------------------
-- Least-privilege roles for the multitenant base.
--
-- Two roles, because the two database planes need different authority:
--
--   mtb_control  performs DDL. It owns tenant schemas and the tables inside
--                them, because provisioning has to run CREATE SCHEMA and the
--                per-tenant migrations. Used by ControlPlanePrismaService.
--
--   mtb_app      performs DML on tenant data. It is deliberately NOT a schema
--                owner and has no CREATE on the database, so it cannot create
--                or drop a schema, and it holds NO privileges at all on the
--                control plane. It is also subject to the row-level security
--                policies the tenant migration installs. Used by
--                TenantPrismaService.
--
--                What RLS does and does not do for this role: the policies stop
--                application mistakes -- an unwrapped query, a wrong schema
--                binding -- from reading another tenant. They do NOT stop
--                anyone holding this credential, because the tenant variable
--                the policies compare against is set by the client and this
--                role holds USAGE on every tenant schema. Treat the database
--                credential as a trusted part of the application; a credential
--                leak needs per-tenant database logins to contain, which this
--                base does not provide.
--
-- The separation matters because the tenant tables carry FORCE ROW LEVEL
-- SECURITY: a table owner bypasses RLS unless it is forced, and a superuser
-- bypasses it unconditionally. Connecting the data plane as a non-owner,
-- non-superuser role is what makes those policies enforceable at all.
--
-- Neither password below is usable anywhere but a local compose stack; supply
-- real ones through the environment for any other deployment.
-- ---------------------------------------------------------------------------

-- Passwords come from the environment. The init scripts are run by psql, so
-- \getenv is how the container's variables reach this file; the fallback keeps
-- a bare `psql -f` usable for a purely local scratch database. Neither default
-- is safe on a shared or reachable database, which is why docker-compose now
-- refuses to start without them set and publishes the port on loopback only.
\getenv mtb_control_password MTB_CONTROL_PASSWORD
\getenv mtb_app_password MTB_APP_PASSWORD
\if :{?mtb_control_password}
\else
\set mtb_control_password 'mtb_control_local_only'
\endif
\if :{?mtb_app_password}
\else
\set mtb_app_password 'mtb_app_local_only'
\endif

-- Built with format() and executed through \gexec rather than a DO block: psql
-- variable interpolation does not happen inside dollar-quoted bodies.
-- NOSUPERUSER and NOBYPASSRLS are stated explicitly rather than inherited from
-- PostgreSQL defaults: the FORCE ROW LEVEL SECURITY policies in
-- prisma/tenant-migrations/0002_tenant_rls are only enforceable for a role that
-- cannot bypass them, so the invariant this file exists to establish should not
-- depend on a default that a future dump-and-restore could change.
SELECT format('CREATE ROLE mtb_control LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'mtb_control_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mtb_control')
\gexec

SELECT format('CREATE ROLE mtb_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'mtb_app_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mtb_app')
\gexec

-- Keep the password in step on every run, so rotating it does not require
-- dropping and recreating the database volume.
SELECT format('ALTER ROLE mtb_control PASSWORD %L', :'mtb_control_password')
\gexec

SELECT format('ALTER ROLE mtb_app PASSWORD %L', :'mtb_app_password')
\gexec

-- Resolve the database by name at run time rather than assuming it is called
-- `mtb`, so the same script works against any deployment database name. These
-- use \gexec for the same reason as above: psql does not interpolate variables
-- inside dollar-quoted bodies, so a DO block cannot build these statements.
SELECT format('GRANT CONNECT ON DATABASE %I TO mtb_control, mtb_app', current_database())
\gexec

-- PostgreSQL grants CREATE on a database to PUBLIC by default. That is how an
-- application role ends up able to create schemas, so take it away first and
-- hand it back only to the role that provisions.
SELECT format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database())
\gexec

SELECT format('GRANT CREATE ON DATABASE %I TO mtb_control', current_database())
\gexec

-- The control plane schema itself: both roles need to traverse it, only the
-- control role may create objects in it.
GRANT USAGE ON SCHEMA public TO mtb_control, mtb_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- mtb_app gets NO privileges on the control plane at all.
--
-- It does not need any: the tenant data plane only ever touches tenant schemas,
-- and every control-plane read (the tenant registry, the API key rows, the audit
-- trail) goes through mtb_control. Granting DML here was a mistake — it let the
-- "restricted" credential INSERT a platform OWNER into platform_admins, which is
-- a full platform takeover from the credential that was supposed to be the least
-- privileged one in the system. If a future change ever needs the data plane to
-- read a control-plane table, grant that one column explicitly here rather than
-- re-introducing blanket DML on the schema.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mtb_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mtb_app;

-- No default privileges for the data plane on the control plane either, or the
-- next table created there would silently be writable by mtb_app again.
ALTER DEFAULT PRIVILEGES FOR ROLE mtb_control IN SCHEMA public
  REVOKE ALL ON TABLES FROM mtb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mtb_control IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM mtb_app;

-- mtb_app must not be able to escalate by creating objects, so make sure it
-- cannot create in the control-plane schema either.
REVOKE CREATE ON SCHEMA public FROM mtb_app;