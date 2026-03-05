import { encrypt, decrypt } from '../crypto';

// Set test key (32 bytes = 64 hex chars)
process.env.DB_ENCRYPTION_KEY = 'a'.repeat(64);

describe('AES-256-GCM Encryption', () => {
  it('encrypts and decrypts a value correctly', () => {
    const plaintext = 'test-access-token-value';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const plaintext = 'same-input';
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
  });

  it('throws on tampered ciphertext', () => {
    const ciphertext = encrypt('original');
    const tampered = ciphertext.slice(0, -4) + 'XXXX';
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws if DB_ENCRYPTION_KEY is missing', () => {
    const originalKey = process.env.DB_ENCRYPTION_KEY;
    delete process.env.DB_ENCRYPTION_KEY;
    expect(() => encrypt('test')).toThrow('DB_ENCRYPTION_KEY');
    process.env.DB_ENCRYPTION_KEY = originalKey!;
  });
});
