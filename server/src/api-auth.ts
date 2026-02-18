/**
 * API authentication middleware.
 *
 * Checks for a Bearer token in the Authorization header.
 * Token is resolved from macOS Keychain, file, or env var.
 *
 * If no token is configured, all requests are allowed (development mode).
 */

import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
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

  if (!cachedToken) {
    console.warn('[api-auth] WARNING: No API_TOKEN configured — API endpoints are unauthenticated');
    console.warn('[api-auth] Set token in macOS Keychain: security add-generic-password -s agentforce -a API_TOKEN -w "your-token"');
  }

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
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  } catch (err) {
    console.error('[api-auth] Token resolution failed:', err);
    res.status(500).json({ error: 'Auth system error' });
  }
}
