import { SetMetadata, type CustomDecorator } from '@nestjs/common';

/**
 * Metadata key holding the API key scopes a route requires.
 */
export const SCOPES_KEY = 'auth:scopes';

/**
 * Requires one or more API key scopes on a route.
 *
 * ```ts
 * @RequireScopes('projects:read')
 * @Get()
 * findAll() {}
 * ```
 *
 * Enforced by {@link ApiKeyScopesGuard}. Only applies to API key principals;
 * human sessions are authorised by their tenant role at the service layer.
 *
 * @param scopes Scopes the caller must hold. All listed scopes are required.
 * @returns A decorator that stores the scope list as metadata.
 */
export const RequireScopes = (...scopes: string[]): CustomDecorator<string> =>
  SetMetadata(SCOPES_KEY, scopes);
