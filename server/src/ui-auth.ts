/**
 * UI Authentication — backend-enforced lock screen for the agentforce dashboard.
 *
 * On launch the frontend is served a minimal "locked" shell. Before the main
 * app can connect (WebSocket upgrade) or call any /api/* route, the browser
 * must exchange a valid PIN / passphrase for a short-lived session token.
 *
 * Flow:
 *   1. Browser loads /  → receives the SPA shell (no data yet)
 *   2. Browser calls POST /api/ui-auth/unlock { pin } → 200 { token } or 401
 *   3. Browser stores token in sessionStorage (never localStorage — clears on tab close)
 *   4. All subsequent API calls and the WS upgrade include  X-UI-Token: <token>
 *   5. Server validates token on every request; expired tokens → 401 → frontend re-locks
 *
 * The PIN is resolved from the same secret store as API_TOKEN:
 *   - macOS Keychain: security add-generic-password -s agentforce -a UI_PIN -w "yourpin"
 *   - File: UI_PIN_FILE=/path/to/file
 *   - Env: UI_PIN=yourpin  (dev only, logged as warning)
 *
 * If NO PIN is configured the system operates in dev/open mode: all requests
 * are allowed and the frontend skips the lock screen.
 */

import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, randomBytes } from 'crypto';
import { resolveSecret } from './secrets.js';

/** Session token TTL — 8 hours. Refreshed on activity. */
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

interface Session {
  token: string;
  expiresAt: number;
}

/** In-memory session store. Fine for single-process; extend with Redis if needed. */
const sessions = new Map<string, Session>();

/** Resolve and cache the configured PIN. */
let cachedPin: string | null | undefined = undefined;

/** Sync check — valid once getPin() has resolved (happens on first /api/ui-auth/* call). */
export function isPinConfigured(): boolean {
  return typeof cachedPin === 'string' && cachedPin.length > 0;
}

/** Warm the PIN cache at startup so WS auth can work synchronously. */
export async function warmPinCache(): Promise<void> {
  await getPin();
}

async function getPin(): Promise<string | null> {
  if (cachedPin !== undefined) return cachedPin;

  const value = await resolveSecret('UI_PIN', {
    keychainService: 'agentforce',
    keychainAccount: 'UI_PIN',
    allowEnvFallback: true, // allow env for dev convenience
  });

  cachedPin = value;

  if (!cachedPin) {
    console.warn('[ui-auth] No UI_PIN configured — dashboard is open (dev mode)');
    console.warn('[ui-auth] To protect the dashboard:');
    console.warn('[ui-auth]   macOS: security add-generic-password -s agentforce -a UI_PIN -w "yourpin"');
    console.warn('[ui-auth]   Env:   UI_PIN=yourpin  (dev only)');
  } else {
    console.log('[ui-auth] UI_PIN configured — dashboard lock screen is active');
  }

  return cachedPin;
}

/** Generate a cryptographically random session token. */
function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Purge expired sessions (called on each unlock attempt). */
function purgeExpired(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(key);
  }
}

/** Validate a token and optionally refresh its TTL. */
export function validateUiToken(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  // Sliding window — refresh TTL on activity
  session.expiresAt = Date.now() + TOKEN_TTL_MS;
  return true;
}

/**
 * Express middleware: gate all /api/* routes (except /api/ui-auth/*)
 * behind UI session token when a PIN is configured.
 */
export async function uiAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const pin = await getPin();

  // Dev mode — no PIN configured, pass everything through
  if (!pin) return next();

  // Auth routes themselves are always open
  if (req.path.startsWith('/api/ui-auth')) return next();

  // Health is always open (monitoring / load-balancer probes)
  if (req.path === '/api/health') return next();

  // Check token from header or cookie
  const token =
    (req.headers['x-ui-token'] as string | undefined) ||
    req.cookies?.['ui_token'];

  if (token && validateUiToken(token)) return next();

  res.status(401).json({ error: 'UI authentication required', locked: true });
}

/**
 * POST /api/ui-auth/unlock
 * Body: { pin: string }
 * Returns: { token: string, expiresIn: number } or 401
 */
export async function handleUnlock(req: Request, res: Response): Promise<void> {
  const pin = await getPin();

  // No PIN configured — return a no-op token so the frontend can proceed
  if (!pin) {
    res.json({ token: 'open', expiresIn: TOKEN_TTL_MS, mode: 'open' });
    return;
  }

  const { pin: provided } = req.body as { pin?: string };
  if (typeof provided !== 'string' || !provided) {
    res.status(400).json({ error: 'pin required' });
    return;
  }

  // Enforce 8-digit numeric PIN
  if (!/^\d{8}$/.test(provided)) {
    res.status(400).json({ error: 'PIN must be exactly 8 digits' });
    return;
  }

  purgeExpired();

  const a = Buffer.from(provided);
  const b = Buffer.from(pin);
  const match = a.length === b.length && timingSafeEqual(a, b);

  if (!match) {
    // Short delay to slow brute-force attempts
    await new Promise(r => setTimeout(r, 400));
    res.status(401).json({ error: 'Invalid PIN' });
    return;
  }

  const token = newToken();
  sessions.set(token, { token, expiresAt: Date.now() + TOKEN_TTL_MS });

  // Also set a cookie (httpOnly, sameSite=strict) as belt-and-suspenders
  res.cookie('ui_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: TOKEN_TTL_MS,
    secure: process.env.NODE_ENV === 'production',
  });

  res.json({ token, expiresIn: TOKEN_TTL_MS });
}

/**
 * POST /api/ui-auth/lock
 * Invalidate the current session token (explicit lock).
 */
export function handleLock(req: Request, res: Response): void {
  const token =
    (req.headers['x-ui-token'] as string | undefined) ||
    req.cookies?.['ui_token'];

  if (token) sessions.delete(token);
  res.clearCookie('ui_token');
  res.json({ locked: true });
}

/**
 * GET /api/ui-auth/status
 * Returns whether UI auth is enabled and whether the current session is valid.
 * Safe to call without a token — used by the frontend on startup.
 */
export async function handleStatus(req: Request, res: Response): Promise<void> {
  const pin = await getPin();
  const pinRequired = !!pin;

  if (!pinRequired) {
    res.json({ pinRequired: false, authenticated: true });
    return;
  }

  const token =
    (req.headers['x-ui-token'] as string | undefined) ||
    req.cookies?.['ui_token'];

  const authenticated = !!(token && validateUiToken(token));
  res.json({ pinRequired: true, authenticated });
}
