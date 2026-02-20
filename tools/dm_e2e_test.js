// E2E Encrypted DM test
// 1) Create two Ed25519 keypairs via libsodium
// 2) Connect two dashboard websocket clients in participate mode
// 3) Client A derives shared secret and sends encrypted envelope to B
// 4) Client B receives dm_message and decrypts — assert plaintext matches

const WebSocket = require('ws');
const sodium = require('libsodium-wrappers');

const SERVER = process.env.SERVER || 'ws://localhost:3000/ws';

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function fromB64(s) { return Buffer.from(s, 'base64'); }

async function makeKeypair() {
  await sodium.ready;
  const kp = sodium.crypto_sign_keypair();
  return { publicKey: b64(kp.publicKey), secretKey: b64(kp.privateKey) };
}

async function ed25519skToX25519(skBase64) {
  await sodium.ready;
  const sk = fromB64(skBase64);
  return sodium.crypto_sign_ed25519_sk_to_curve25519(sk.slice(0, 32));
}

async function ed25519pkToX25519(pkBase64) {
  await sodium.ready;
  return sodium.crypto_sign_ed25519_pk_to_curve25519(fromB64(pkBase64));
}

async function deriveShared(ourSkB64, theirPkB64) {
  await sodium.ready;
  const ourX = await ed25519skToX25519(ourSkB64);
  const theirX = await ed25519pkToX25519(theirPkB64);
  return sodium.crypto_scalarmult(ourX, theirX);
}

async function encrypt(shared, plaintext) {
  await sodium.ready;
  const key = sodium.crypto_generichash(32, shared);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_chacha20poly1305_IETF_NPUBBYTES);
  const ct = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(Buffer.from(plaintext), null, null, nonce, key);
  return { nonce: b64(nonce), ciphertext: b64(ct) };
}

async function decrypt(shared, nonceB64, ctB64) {
  await sodium.ready;
  const key = sodium.crypto_generichash(32, shared);
  try {
    const pt = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, fromB64(ctB64), null, fromB64(nonceB64), key);
    return Buffer.from(pt).toString('utf-8');
  } catch {
    return null;
  }
}

async function run() {
  await sodium.ready;
  const idA = await makeKeypair();
  const idB = await makeKeypair();

  const wsA = new WebSocket(SERVER);
  const wsB = new WebSocket(SERVER);

  let agentA = null, agentB = null;

  wsA.on('open', () => {
    console.log('A connected');
    wsA.send(JSON.stringify({ type: 'set_mode', data: { mode: 'participate', identity: idA } }));
  });
  wsB.on('open', () => {
    console.log('B connected');
    wsB.send(JSON.stringify({ type: 'set_mode', data: { mode: 'participate', identity: idB } }));
  });

  wsA.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'session_identity') {
      agentA = msg.data.agentId;
      console.log('A session id:', agentA);
    }
  });

  wsB.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'session_identity') {
      agentB = msg.data.agentId;
      console.log('B session id:', agentB);
    }
    if (msg.type === 'dm_message') {
      const content = msg.data.content;
      try {
        const parsed = JSON.parse(content);
        if (parsed.encrypted && parsed.cipher === 'chacha20-poly1305') {
          const shared = await deriveShared(idB.secretKey, parsed.pub);
          const pt = await decrypt(shared, parsed.nonce, parsed.ciphertext);
          console.log('B decrypted:', pt);
          if (pt === 'hello encrypted') {
            console.log('TEST PASS: B successfully decrypted message from A');
            process.exit(0);
          } else {
            console.error('TEST FAIL: decrypted mismatch', pt);
            process.exit(2);
          }
        }
      } catch (e) { console.error('dm parse failed', e); }
    }
  });

  // Wait for session identities
  const start = Date.now();
  while ((!agentA || !agentB) && Date.now() - start < 10000) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (!agentA || !agentB) {
    console.error('Failed to get session identities in time');
    process.exit(3);
  }

  await new Promise(r => setTimeout(r, 500));

  // Compose encrypted envelope (A -> B)
  const sharedAB = await deriveShared(idA.secretKey, idB.publicKey);
  const enc = await encrypt(sharedAB, 'hello encrypted');
  const payload = { encrypted: true, cipher: 'chacha20-poly1305', nonce: enc.nonce, ciphertext: enc.ciphertext, pub: idA.publicKey };

  wsA.send(JSON.stringify({ type: 'send_message', data: { to: agentB, content: JSON.stringify(payload) } }));

  setTimeout(() => { console.error('Timed out waiting for decryption'); process.exit(4); }, 8000);
}

run().catch(e => { console.error(e); process.exit(1); });
