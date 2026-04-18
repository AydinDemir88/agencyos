/**
 * AES-256-GCM encryption / decryption utility
 *
 * Each encrypt() call generates a fresh random 12-byte IV.
 * The 16-byte GCM auth tag is prepended to the ciphertext before storage:
 *   stored BYTEA = [ authTag (16 bytes) | ciphertext (n bytes) ]
 *   stored IV    = [ iv (12 bytes) ]
 *
 * The master key is read from MASTER_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 * It is never logged, never passed as a function argument — always read from env.
 */

const crypto = require('crypto');

const ALGORITHM       = 'aes-256-gcm';
const IV_LENGTH       = 12;   // 96-bit IV — recommended for GCM
const AUTH_TAG_LENGTH = 16;   // 128-bit authentication tag

/** Load and validate master key from environment — throws on misconfiguration */
function getMasterKey() {
  const hex = process.env.MASTER_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'MASTER_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string.
 *
 * @param {string} plaintext
 * @returns {{ ciphertext: Buffer, iv: Buffer }}
 *   ciphertext = authTag(16) + encryptedData(n)
 *   iv         = random 12-byte nonce
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encrypt() requires a non-empty string');
  }

  const key    = getMasterKey();
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag    = cipher.getAuthTag();
  const ciphertext = Buffer.concat([authTag, encrypted]);

  return { ciphertext, iv };
}

/**
 * Decrypt a ciphertext buffer using the stored IV.
 *
 * @param {Buffer} ciphertext  - authTag(16) + encryptedData(n), as stored in DB
 * @param {Buffer} iv          - 12-byte nonce, as stored in DB
 * @returns {string}           - original plaintext
 */
function decrypt(ciphertext, iv) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length <= AUTH_TAG_LENGTH) {
    throw new Error('decrypt() requires a valid ciphertext Buffer (authTag + data)');
  }
  if (!Buffer.isBuffer(iv) || iv.length !== IV_LENGTH) {
    throw new Error('decrypt() requires a valid 12-byte IV Buffer');
  }

  const key       = getMasterKey();
  const authTag   = ciphertext.slice(0, AUTH_TAG_LENGTH);
  const encrypted = ciphertext.slice(AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    // GCM auth tag mismatch — data tampered or wrong key
    throw new Error('Decryption failed: authentication tag mismatch');
  }
}

/**
 * Encrypt a credential field if a new value is provided, otherwise return
 * the existing encrypted columns unchanged.
 *
 * @param {string|undefined} newValue    - new plaintext value (or undefined = no change)
 * @param {Buffer|null}      existingEnc - current encrypted value from DB
 * @param {Buffer|null}      existingIv  - current IV from DB
 * @returns {{ enc: Buffer|null, iv: Buffer|null }}
 */
function encryptIfProvided(newValue, existingEnc = null, existingIv = null) {
  if (newValue !== undefined && newValue !== null && newValue !== '') {
    const { ciphertext, iv } = encrypt(newValue);
    return { enc: ciphertext, iv };
  }
  return { enc: existingEnc, iv: existingIv };
}

module.exports = { encrypt, decrypt, encryptIfProvided };
