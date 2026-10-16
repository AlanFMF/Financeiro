import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Criptografia das chaves de API dos usuários (AES-256-GCM).
 * A chave mestra vem de AI_KEY_SECRET (32 bytes em hex ou base64) ou, se não houver, é derivada do JWT_SECRET.
 */
export function createSecretBox(masterSecret: string) {
  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(masterSecret)) key = Buffer.from(masterSecret, 'hex');
  else if (Buffer.from(masterSecret, 'base64').length === 32 && /^[A-Za-z0-9+/]{43}=$/.test(masterSecret)) key = Buffer.from(masterSecret, 'base64');
  else key = scryptSync(masterSecret, 'saldo/ai-keys/v1', 32);

  return {
    encrypt(plain: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
    },
    decrypt(packed: string) {
      const [version, iv, tag, data] = packed.split(':');
      if (version !== 'v1' || !iv || !tag || !data) throw new Error('formato de chave inválido');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    }
  };
}

export type SecretBox = ReturnType<typeof createSecretBox>;
