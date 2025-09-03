// utils/kms.js
// AES-256-GCM envelope for tenant secrets.
// Accepts KMS_MASTER_KEY as: base64(32B)  | hex(64 chars) | passphrase (scrypt → 32B)

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const RAW = process.env.KMS_MASTER_KEY || '';

function deriveKey(raw) {
  if (!raw) return null;

  // 64-char hex → 32 bytes
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

  // base64 → must decode to 32 bytes
  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
  } catch { /* ignore */ }

  // fallback: passphrase → scrypt(…, 32B)
  return crypto.scryptSync(raw, 'tenant-secrets-v1', 32);
}

const KEY = deriveKey(RAW);

function hasKey() { return !!KEY; }
function isEncrypted(v) { return typeof v === 'string' && v.startsWith(PREFIX); }

function encrypt(plaintext) {
  if (plaintext == null) return plaintext;

  if (!hasKey()) {
    // Fail-closed in prod so we never persist plaintext by mistake
    if (process.env.NODE_ENV === 'production') {
      throw new Error('KMS_MASTER_KEY missing in production');
    }
    // Dev convenience: store as plaintext
    return plaintext;
  }

  const iv = crypto.randomBytes(12); // GCM nonce
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  const payload = Buffer.concat([ct, tag]).toString('base64');

  return `${PREFIX}${iv.toString('base64')}:${payload}`;
}

function decrypt(value) {
  if (!isEncrypted(value)) return value;
  if (!hasKey()) throw new Error('KMS_MASTER_KEY required to decrypt a value');

  const parts = String(value).split(':'); // ["enc","v1","<ivB64>","<ct+tag B64>"]
  if (parts.length !== 4 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Bad ciphertext format');
  }

  const iv = Buffer.from(parts[2], 'base64');
  const buf = Buffer.from(parts[3], 'base64');
  if (iv.length !== 12) throw new Error('Bad IV length');
  if (buf.length < 17) throw new Error('Bad ciphertext length');

  const ct = buf.slice(0, -16);
  const tag = buf.slice(-16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

function mask(val) {
  if (val == null) return '';
  const s = String(val);
  if (isEncrypted(s)) return 'enc:***';
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

module.exports = {
  PREFIX,
  hasKey,
  isEncrypted,
  encrypt,
  decrypt,
  mask,
};
