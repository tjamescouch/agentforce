/**
 * Persistent Ed25519 identity for AgentChat dashboards.
 * Uses the browser's built-in Web Crypto API — zero dependencies.
 * (Inlined from @agentchat/identity to avoid external file: dependency in Docker builds)
 */

const STORAGE_KEY = 'dashboardIdentity';

export interface DashboardIdentity {
  publicKey: string; // base64, 32 bytes
  secretKey: string; // base64, 64 bytes (nacl format: seed || publicKey)
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function generateIdentity(): Promise<DashboardIdentity> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' } as EcKeyGenParams,
    true,
    ['sign', 'verify']
  );

  const publicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey)
  );

  const privateKeyPkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  );
  const seed = privateKeyPkcs8.slice(16, 48);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKeyRaw, 32);

  return {
    publicKey: base64Encode(publicKeyRaw),
    secretKey: base64Encode(secretKey),
  };
}

export async function getOrCreateIdentity(): Promise<DashboardIdentity | null> {
  if (typeof window === 'undefined' || !window.localStorage) return null;

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as DashboardIdentity;
      if (parsed.publicKey && parsed.secretKey) return parsed;
    } catch {
      // Corrupted — regenerate
    }
  }

  const identity = await generateIdentity();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

export function getStoredIdentity(): DashboardIdentity | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as DashboardIdentity;
    return parsed.publicKey && parsed.secretKey ? parsed : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: DashboardIdentity): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export function clearIdentity(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  localStorage.removeItem(STORAGE_KEY);
}
