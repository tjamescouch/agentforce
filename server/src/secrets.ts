/**
 * Secret resolution — retrieves API keys from secure stores.
 *
 * Priority:
 * 1. macOS Keychain (via `security` CLI)
 * 2. File-based (path in <KEY>_FILE env var)
 * 3. Environment variable (fallback, with warning)
 *
 * Usage:
 *   const key = await resolveSecret('GROQ_API_KEY', { keychainService: 'agentforce' });
 *
 * macOS Keychain setup:
 *   security add-generic-password -s agentforce -a GROQ_API_KEY -w "gsk_your_key"
 */

import { execFile } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { platform } from 'os';

interface ResolveOptions {
  /** Keychain service name (default: 'agentforce') */
  keychainService?: string;
  /** Keychain account name override (default: same as key name) */
  keychainAccount?: string;
  /** Whether to allow env var fallback (default: true, with warning) */
  allowEnvFallback?: boolean;
  /** Suppress warnings (for testing) */
  silent?: boolean;
}

/**
 * Resolve a secret from the best available source.
 * Returns null if not found anywhere.
 */
export async function resolveSecret(
  name: string,
  options: ResolveOptions = {}
): Promise<string | null> {
  const {
    keychainService = 'agentforce',
    keychainAccount = name,
    allowEnvFallback = true,
    silent = false,
  } = options;

  // 1. macOS Keychain
  if (platform() === 'darwin') {
    const value = await readKeychain(keychainService, keychainAccount);
    if (value) {
      if (!silent) console.log(`[secrets] ${name}: resolved from macOS Keychain (service: ${keychainService})`);
      return value;
    }
  }

  // 2. File-based (<NAME>_FILE env var points to a file containing the secret)
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try {
      if (existsSync(filePath)) {
        const value = readFileSync(filePath, 'utf-8').trim();
        if (value) {
          if (!silent) console.log(`[secrets] ${name}: resolved from file (${filePath})`);
          return value;
        }
      }
    } catch (err) {
      if (!silent) console.warn(`[secrets] ${name}: failed to read file ${filePath}:`, err);
    }
  }

  // 3. Environment variable (fallback)
  const envValue = process.env[name];
  if (envValue) {
    if (allowEnvFallback) {
      if (!silent) console.warn(`[secrets] ${name}: falling back to env var (consider using macOS Keychain or file-based storage)`);
      return envValue;
    } else {
      if (!silent) console.warn(`[secrets] ${name}: found in env var but env fallback disabled`);
      return null;
    }
  }

  return null;
}

/**
 * Resolve multiple secrets at once.
 * Returns a map of name → value (null if not found).
 */
export async function resolveSecrets(
  names: string[],
  options: ResolveOptions = {}
): Promise<Record<string, string | null>> {
  const results: Record<string, string | null> = {};
  // Resolve in parallel
  await Promise.all(
    names.map(async (name) => {
      results[name] = await resolveSecret(name, options);
    })
  );
  return results;
}

/**
 * Read a value from macOS Keychain using the `security` CLI.
 */
function readKeychain(service: string, account: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: 5000 },
      (error, stdout, _stderr) => {
        if (error) {
          // Not found or not on macOS — fail silently
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value || null);
      }
    );
  });
}
