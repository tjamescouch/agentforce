/**
 * API authentication middleware.
 *
 * Checks for a Bearer token in the Authorization header.
 * Token is resolved from macOS Keychain, file, or env var.
 *
 * If no token is configured, all requests are allowed (development mode).
 */

import { Request, Response, NextFunction } from 'express';
import { resolveSecret } from './secrets.js';

let cachedToken: string | null | undefined = undefined; // undefined = not yet resolved

/**
 * Resolve the API token (async, cached after first call).
 */
async function getToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;

  const value = await resolveSecret('API_TOKEN', {
    keychainService: 'agentforce',
    keychainAccount: 'API_TOKEN',
  });

  cachedToken = value;
  return cachedToken;
}

/**
 * Express middleware that checks Bearer token auth.
 * If no token is configured (dev mode), allows all requests.
 */
export async function apiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = await getToken();

    // No token configured = dev mode, allow everything
    if (!token) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization required', hint: 'Set Authorization: Bearer <token>' });
      return;
    }

    const provided = authHeader.slice(7);
    if (provided !== token) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  } catch (err) {
    console.error('[api-auth] Token resolution failed:', err);
    res.status(500).json({ error: 'Auth system error' });
  }
}
