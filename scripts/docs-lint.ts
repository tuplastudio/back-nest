import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Verifica que la documentación no prometa lo que el código no tiene
 * (BN-REQ-DOC-002, BN-REQ-DOC-003).
 *
 * Dos comprobaciones sobre `docs/*.md` y `README.md`:
 *
 *  1. **Variables de entorno.** Todo identificador `UPPER_SNAKE` cuyo primer
 *     segmento pertenece a un espacio de nombres de configuración de la app
 *     (`NETPAY_`, `OUTBOUND_`, `PAYMENT(S)_`, `JWT_`…, derivados de las claves
 *     de `src/config/env.validation.ts`) tiene que ser una clave de ese esquema.
 *     Se aceptan además, porque no son configuración de la app:
 *       - las variables que leen las herramientas fuera de `src/` (`scripts/`,
 *         `prisma/`, `test/`, `*.config.ts` en la raíz), p. ej. la cadena directa
 *         de migración o las llaves del e2e contra sandbox;
 *       - las constantes declaradas en `src/` (`const NETPAY_DIGITS_PATTERN`),
 *         que la documentación cita como código, no como variable;
 *       - la lista {@link NOT_APP_CONFIG}, corta y justificada entrada a entrada.
 *  2. **Rutas.** Toda ruta `/api/v1/...` citada tiene que corresponder a una ruta
 *     declarada con `@Controller` + `@Get`/`@Post`/… en `src/**\/*.controller.ts`.
 *     `:param`, `{param}`, `<param>`, `$VAR` y `…` cuentan como comodines de un
 *     segmento.
 *
 * Sale con código 1 y un listado `fichero:línea` si algo no cuadra.
 *
 * Uso: `npm run docs:lint`
 */

const ROOT = process.cwd();
const ENV_SCHEMA = join(ROOT, 'src/config/env.validation.ts');
const API_PREFIX = '/api/v1';

/**
 * Identificadores con espacio de nombres de configuración que no son
 * variables de la app. Cada entrada dice por qué existe; si una deja de
 * aparecer en la documentación, se borra de aquí.
 */
const NOT_APP_CONFIG: ReadonlyMap<string, string> = new Map([
  // Variables y secretos de GitHub Actions (DEPLOY-GCP §5, GITHUB_ACTIONS_SETUP).
  ['GCP_CREDENTIALS', 'secreto de GitHub Actions (flujo histórico con llave JSON)'],
  ['GCP_WIF_PROVIDER', 'variable de GitHub Actions'],
  ['GCP_REGION', 'variable de GitHub Actions'],
  ['GCP_DEPLOYER_SA', 'variable de GitHub Actions'],
  ['GCP_DRIFT_SA', 'variable de GitHub Actions (environments *-readonly de drift-check.yml)'],
  // Variables locales de shell en los ejemplos de DEPLOY-GCP.
  ['DOCS_USER', 'variable local del ejemplo curl contra /docs'],
  ['DOCS_PASS', 'variable local del ejemplo curl contra /docs'],
  ['CONTROL_URL', 'variable local de shell al construir los secretos (DEPLOY-GCP §9.2)'],
  ['CONTROL_URL_UNPOOLED', 'variable local de shell al construir los secretos (DEPLOY-GCP §9.2)'],
  // Secret Manager → scripts de administración, nunca el servicio.
  ['TENANT_PLANE_DATABASE_URL_UNPOOLED', 'secreto para scripts de administración (DEPLOY-GCP §9.2)'],
  // Códigos de error de la API (docs/ERRORS.md) que comparten prefijo con la configuración.
  ['MFA_REQUIRED', 'código de error 403 (src/auth/admin-session-policy.ts)'],
  ['TENANT_REQUIRED', 'código de error 400 (src/common/errors/app.exception.ts)'],
  ['TENANT_UNAVAILABLE', 'código de error 403 (src/common/errors/app.exception.ts)'],
  ['DATABASE_ERROR', 'código de error de Prisma (src/common/filters/all-exceptions.filter.ts)'],
  ['DATABASE_UNAVAILABLE', 'código de error 503 (src/common/filters/all-exceptions.filter.ts)'],
  // INTERNAL_ es espacio de nombres de configuración desde INTERNAL_TICK_* (BN-TASK-016).
  ['INTERNAL_SERVER_ERROR', 'código de error 500 (src/common/filters/all-exceptions.filter.ts)'],
]);

/** One problem found, with where it was found. */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/**
 * Lists files under a directory, recursively.
 *
 * @param dir Directory to walk.
 * @param accept Predicate on the file path.
 * @returns Absolute paths of the accepted files.
 */
function walk(dir: string, accept: (path: string) => boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path, accept));
    } else if (accept(path)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Collects the keys of the Zod environment schema, following the
 * `./sibling` modules it spreads into the object (e.g. `paymentUrlFields`).
 *
 * @returns Variable names the application validates at boot.
 */
function schemaKeys(): Set<string> {
  const keys = new Set<string>();
  const source = readFileSync(ENV_SCHEMA, 'utf8');
  const sources = [source];
  for (const match of source.matchAll(/from '\.\/([\w-]+)'/g)) {
    sources.push(readFileSync(join(ROOT, 'src/config', `${match[1]}.ts`), 'utf8'));
  }
  for (const text of sources) {
    for (const match of text.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s/gm)) {
      keys.add(match[1]);
    }
  }
  return keys;
}

/**
 * Variables read directly by tooling that runs outside the application
 * (scripts, seeds, tests, root config files).
 *
 * @returns Variable names.
 */
function toolingVariables(): Set<string> {
  const files = [
    ...walk(join(ROOT, 'scripts'), (path) => /\.(ts|mjs)$/.test(path)),
    ...walk(join(ROOT, 'prisma'), (path) => path.endsWith('.ts')),
    ...walk(join(ROOT, 'test'), (path) => path.endsWith('.ts')),
    ...readdirSync(ROOT)
      .filter((entry) => entry.endsWith('.config.ts'))
      .map((entry) => join(ROOT, entry)),
  ];
  const names = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/process\.env(?:\[['"]([A-Z][A-Z0-9_]*)['"]\]|\.([A-Z][A-Z0-9_]*))/g)) {
      names.add(match[1] ?? match[2]);
    }
  }
  return names;
}

/**
 * Upper-case constants declared in the application source.
 *
 * @returns Constant names.
 */
function sourceConstants(): Set<string> {
  const names = new Set<string>();
  for (const file of walk(join(ROOT, 'src'), (path) => path.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bconst ([A-Z][A-Z0-9_]*)\b/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

/**
 * Reduces a variable name to its namespace: the first segment, singular.
 *
 * @param name Variable name.
 * @returns Namespace, e.g. `PAYMENT` for both `PAYMENT_REDIRECT_URL` and `PAYMENTS_ENABLED`.
 */
function namespaceOf(name: string): string {
  return name.split('_')[0].replace(/S$/, '');
}

/** A route declared by a controller, as path segments. */
type Route = readonly string[];

/**
 * Splits a path into non-empty segments.
 *
 * @param path Path, with or without leading slash.
 * @returns Segments.
 */
function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Reads every `@Controller` + method decorator pair in `src/**\/*.controller.ts`.
 *
 * @returns Declared routes, relative to the global prefix.
 */
function controllerRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of walk(join(ROOT, 'src'), (path) => path.endsWith('.controller.ts'))) {
    let base: string[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const controller = /@Controller\((?:'([^']*)')?\)/.exec(line);
      if (controller) {
        base = segments(controller[1] ?? '');
        continue;
      }
      const method = /@(?:Get|Post|Put|Patch|Delete|All)\((?:'([^']*)')?\)/.exec(line);
      if (method) {
        routes.push([...base, ...segments(method[1] ?? '')]);
      }
    }
  }
  return routes;
}

/**
 * Whether a documented segment is a placeholder rather than a literal.
 *
 * @param segment Path segment as written in the docs.
 * @returns True for `:id`, `{id}`, `<id>`, `$ID`, `${ID}` and `…`.
 */
function isPlaceholder(segment: string): boolean {
  return /^(?::|\{|<|\$)/.test(segment) || segment.includes('…') || segment === '*';
}

/**
 * Whether a documented path matches a declared route.
 *
 * @param documented Documented segments, prefix removed.
 * @param route Declared segments.
 * @returns True when every segment matches literally or through a placeholder.
 */
function matches(documented: readonly string[], route: Route): boolean {
  if (documented.length !== route.length) {
    return false;
  }
  return documented.every(
    (segment, index) => isPlaceholder(segment) || route[index].startsWith(':') || segment === route[index],
  );
}

/**
 * Runs both checks over the documentation.
 *
 * @returns Every problem found.
 */
function lint(): Finding[] {
  const known = schemaKeys();
  const namespaces = new Set([...known].filter((key) => key.includes('_')).map(namespaceOf));
  const tooling = toolingVariables();
  const constants = sourceConstants();
  const routes = controllerRoutes();

  const docs = [
    ...readdirSync(join(ROOT, 'docs'))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => join(ROOT, 'docs', entry)),
    join(ROOT, 'README.md'),
  ];

  const findings: Finding[] = [];
  for (const file of docs) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      const at = { file: relative(ROOT, file), line: index + 1 };

      for (const match of text.matchAll(/(?<![\w$-])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
        const name = match[1];
        if (
          !namespaces.has(namespaceOf(name)) ||
          known.has(name) ||
          tooling.has(name) ||
          constants.has(name) ||
          NOT_APP_CONFIG.has(name)
        ) {
          continue;
        }
        findings.push({
          ...at,
          message: `variable ${name} no existe en src/config/env.validation.ts`,
        });
      }

      for (const match of text.matchAll(/\/api\/v1(\/[^\s`'"()[\],;|@?#]*)/g)) {
        const path = match[1].replace(/[.:]+$/, '');
        const documented = segments(path);
        if (documented.length === 0 || routes.some((route) => matches(documented, route))) {
          continue;
        }
        findings.push({
          ...at,
          message: `ruta ${API_PREFIX}${path} no corresponde a ningún controlador`,
        });
      }
    });
  }
  return findings;
}

const findings = lint();
for (const finding of findings) {
  console.error(`${finding.file}:${finding.line}: ${finding.message}`);
}
if (findings.length > 0) {
  console.error(`\ndocs-lint: ${findings.length} problema(s).`);
  process.exit(1);
}
console.log('docs-lint: sin variables huérfanas ni rutas inexistentes.');
