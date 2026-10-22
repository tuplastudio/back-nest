/**
 * Reads a test-only override variable.
 *
 * Lives in `src/config/` because it is the one place allowed to touch
 * `process.env` (lint rule `no-process-env`). The override is honoured only
 * when `NODE_ENV` is `test`, so no deployed process can be redirected by a
 * stray variable; callers add their own narrower conditions on top.
 *
 * @param variable Name of the override variable, e.g. `NETPAY_SANDBOX_BASE_URL`.
 * @returns The value under `NODE_ENV=test` when set and non-empty, otherwise `undefined`.
 */
export function testOnlyOverride(variable: string): string | undefined {
  if (process.env['NODE_ENV'] !== 'test') {
    return undefined;
  }
  const value = process.env[variable];
  return value ? value : undefined;
}
