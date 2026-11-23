import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 代理密码的本地加密。
 *
 * 目标不是防住能读磁盘的攻击者，而是避免密码以明文躺在 sqlite 里被
 * 备份、日志、截图、误传项目目录时泄露。密钥文件 0600，与库文件分开。
 *
 * 商业版应换到系统钥匙串（Electron safeStorage / macOS Keychain），
 * 那一步在打包桌面端时再做。
 */
export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export function createSecretBox(keyFile: string): SecretBox {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });

  let key: Buffer;
  if (fs.existsSync(keyFile)) {
    key = Buffer.from(fs.readFileSync(keyFile, 'utf-8').trim(), 'hex');
    if (key.length !== 32) throw new Error(`密钥文件损坏（长度 ${key.length}）：${keyFile}`);
  } else {
    key = randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  }

  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`;
    },
    decrypt(sealed: string): string {
      const [version, ivB64, tagB64, bodyB64] = sealed.split(':');
      if (version !== 'v1' || !ivB64 || !tagB64 || !bodyB64) {
        throw new Error('密文格式不合法');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(bodyB64, 'base64')),
        decipher.final(),
      ]).toString('utf-8');
    },
  };
}
