/**
 * Secret resolution — retrieves API keys from secure stores.
 *
 * Priority:
 * 1. agentauth proxy (agents never see keys — proxy injects headers)
 * 2. macOS Keychain (via `security` CLI — for local dev without proxy)
 * 3. File-based (path in <KEY>_FILE env var)
 * 4. Environment variable (fallback with warning)
 *
 * For LLM providers, the preferred approach is agentauth proxy mode:
 * - Set GROQ_BASE_URL=http://localhost:9999/groq (agentauth routes to Groq)
 * - Set GROQ_API_KEY=proxy-managed (SDK requires non-empty, proxy replaces it)
 *
 * macOS Keychain setup (for direct mode):
 *   security add-generic-password -s agentforce -a GROQ_API_KEY -w "gsk_your_key"
 */

import { execFile } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { platform } from 'os';
import http from 'http';

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
  if (envValue && envValue !== 'proxy-managed') {
    if (allowEnvFallback) {
      if (!silent) console.warn(`[secrets] ${name}: falling back to env var (consider using agentauth proxy or macOS Keychain)`);
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
  await Promise.all(
    names.map(async (name) => {
      results[name] = await resolveSecret(name, options);
    })
  );
  return results;
}

/**
 * Check if agentauth proxy is running and has a specific backend configured.
 * Returns the proxy base URL for that backend, or null if unavailable.
 */
export async function checkAgentAuth(
  backend: string,
  proxyUrl = 'http://127.0.0.1:9999'
): Promise<string | null> {
  try {
    const health = await httpGet(`${proxyUrl}/agentauth/health`, 2000);
    const data = JSON.parse(health);
    if (data.status === 'ok' && Array.isArray(data.backends) && data.backends.includes(backend)) {
      return `${proxyUrl}/${backend}`;
    }
  } catch {
    // Proxy not running or not reachable
  }
  return null;
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
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value || null);
      }
    );
  });
}

/**
 * Simple HTTP GET (no dependencies).
 */
function httpGet(url: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
