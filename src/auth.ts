import type { MiddlewareHandler } from "hono";

/**
 * Authentication and authorization hooks.
 *
 * Version 1 runs with no auth: every request is anonymous and allowed. To add auth
 * (SSO/JWT), replace `authenticate` with a middleware that verifies the token and calls
 * `c.set("user", { id, ... })`, returning 401 when it is missing or invalid; then make
 * `canViewPath` check the user's folder permissions. Sessions already record their
 * owner and `canUseSession` already compares it, so session and segment URLs become
 * tied to the user who created them as soon as `user` is set.
 */
export interface AuthUser {
  id: string;
  name?: string;
}

export type AppEnv = { Variables: { user: AuthUser | null } };

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  await next();
};

/** May this user view this file (path relative to the media root)? */
export function canViewPath(_user: AuthUser | null, _relPath: string): boolean {
  return true;
}

/** May this user read or stop this session? */
export function canUseSession(user: AuthUser | null, ownerId: string | null): boolean {
  return ownerId === null || ownerId === (user?.id ?? null);
}
