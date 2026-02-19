/**
 * Browser-side Ed25519 identity generation using Web Crypto API
 * Matches server-side tweetnacl format: base64-encoded raw keys
 */

export interface Identity {
  publicKey: string;  // base64-encoded raw public key
  secretKey: string;  // base64-encoded raw private key (seed)
}

/**
 * Generate a new Ed25519 keypair using Web Crypto API
 * Returns base64-encoded keys matching server's tweetnacl format
 */
export async function generateIdentity(): Promise<Identity> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'Ed25519',
    },
    true, // extractable
    ['sign', 'verify']
  );

  // Export public key as raw bytes
  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKey = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)));

  // Export private key as PKCS8, extract the 32-byte seed
  const privateKeyPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const privateKeyBytes = new Uint8Array(privateKeyPkcs8);
  
  // PKCS8 for Ed25519: last 32 bytes are the seed (what tweetnacl calls secretKey)
  const seed = privateKeyBytes.slice(-32);
  const secretKey = btoa(String.fromCharCode(...seed));

  return { publicKey, secretKey };
}

/**
 * Get or create identity from localStorage
 * Ensures persistent identity across sessions
 */
export async function getOrCreateIdentity(): Promise<Identity> {
  const stored = localStorage.getItem('dashboardIdentity');
  
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.publicKey && parsed.secretKey) {
        return parsed;
      }
    } catch {
      // Fall through to generate new identity
    }
  }

  // Generate new identity and persist immediately
  const identity = await generateIdentity();
  localStorage.setItem('dashboardIdentity', JSON.stringify(identity));
  return identity;
}
