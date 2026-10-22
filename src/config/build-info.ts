/** What was built and deployed (BN-REQ-OPS-010). */
export interface BuildInfo {
  /** Release version (`BUILD_VERSION`), else the package version. */
  readonly version: string;
  /** Commit the image was built from (`BUILD_SHA`), else `unknown`. */
  readonly sha: string;
}

/** Version reported when the image was not stamped with one. */
const FALLBACK_VERSION = '1.0.0';

/**
 * Reads the build stamp.
 *
 * Kept out of the validated configuration on purpose: these describe the
 * artefact rather than how it runs, they are set at build time (an image build
 * argument copied into the environment), and a local run has none of them,
 * which must not stop it from booting.
 *
 * @param env Environment, defaults to `process.env`.
 * @returns The build version and commit SHA.
 */
export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    version: nonEmpty(env['BUILD_VERSION']) ?? FALLBACK_VERSION,
    sha: nonEmpty(env['BUILD_SHA']) ?? 'unknown',
  };
}

/**
 * @param value Raw environment value.
 * @returns The trimmed value, or `undefined` when unset or blank.
 */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
