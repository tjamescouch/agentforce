/**
 * Browser-side Ed25519 identity generation using Web Crypto API
 * Matches server-side tweetnacl format: base64-encoded raw keys
 *
 * E2E encryption layer uses libsodium for:
 *   Ed25519→X25519 key conversion, ECDH shared secret, ChaCha20-Poly1305
 *
 * libsodium is loaded lazily (dynamic import) to avoid Vite/Rollup ESM
 * resolution failures with libsodium-wrappers' broken ESM build.
 */

let _sodium: any = null;

async function getSodium() {
  if (!_sodium) {
    const mod = await import('libsodium-wrappers');
    _sodium = mod.default ?? mod;
    await _sodium.ready;
  }
  return _sodium;
}

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

// ============ E2E Encryption (libsodium) ============

export async function sodiumReady(): Promise<void> {
  await getSodium();
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export async function deriveSharedSecret(ourEdSkBase64: string, theirEdPkBase64: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  const ourEd = fromBase64(ourEdSkBase64);
  // secretKey is 64 bytes (seed || pub); extract 32-byte seed for conversion
  const ourX = sodium.crypto_sign_ed25519_sk_to_curve25519(ourEd.slice(0, 32));
  const theirX = sodium.crypto_sign_ed25519_pk_to_curve25519(fromBase64(theirEdPkBase64));
  return sodium.crypto_scalarmult(ourX, theirX);
}

export async function encrypt(sharedSecret: Uint8Array, plaintext: Uint8Array): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const sodium = await getSodium();
  const key = sodium.crypto_generichash(32, sharedSecret);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_chacha20poly1305_IETF_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, key);
  return { nonce, ciphertext };
}

export async function decrypt(sharedSecret: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array | null> {
  const sodium = await getSodium();
  const key = sodium.crypto_generichash(32, sharedSecret);
  try {
    return sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key);
  } catch {
    return null;
  }
}
