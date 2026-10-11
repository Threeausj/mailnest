import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const derive = promisify(scrypt);
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split(':');
  if (!salt || !hash || hash.length !== 128) return false;
  const key = await derive(password, salt, 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
export class SecretBox {
  private key: Buffer;
  constructor(hex: string) { this.key = Buffer.from(hex, 'hex'); }
  encrypt(value: unknown): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
  }
  decrypt<T>(value: string): T {
    const [iv, tag, data] = value.split('.');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8')) as T;
  }
}
export function isPublicAddress(address: string): boolean {
  if (address.startsWith('::ffff:')) return isPublicAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) return /^[23]/i.test(address) && !/^2001:db8:/i.test(address) && !/^2001:(?:0:|10:|20:)/i.test(address);
  return false;
}
export async function resolveMailHost(host: string, allowPrivate = false): Promise<{address:string;family:number}> {
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) throw new ApiError(400, 'INVALID_HOST', '请输入有效的邮箱服务器域名。');
  let resolved: {address:string;family:number}[];
  try {
    if (isIP(host)) resolved=[{address:host,family:isIP(host)}];
    else {
      let timer: ReturnType<typeof setTimeout>;
      try {resolved=await Promise.race([lookup(host,{all:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),5_000);timer.unref();})]);}
      finally {clearTimeout(timer!);}
    }
  }
  catch { throw new ApiError(400, 'DNS_FAILED', '邮箱服务器域名无法解析，请检查 IMAP / SMTP 地址。'); }
  if (!resolved.length || (!allowPrivate && resolved.some(item => !isPublicAddress(item.address)))) throw new ApiError(400, 'PRIVATE_HOST', '不能连接内部或保留网络地址。自建内网邮箱需管理员配置 ALLOW_PRIVATE_MAIL_HOSTS=true。');
  return resolved.find(item => item.family === 4) || resolved[0];
}
export function safeMailError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const e = error as {code?:string;authenticationFailed?:boolean;responseCode?:string};
  if (e.authenticationFailed || ['EAUTH','AUTHENTICATIONFAILED','InvalidCredentials','EOAUTH2'].includes(e.code || '') || e.responseCode === 'AUTHENTICATIONFAILED') return '邮箱登录失败。请检查用户名、应用专用密码，或重新连接 Google 授权。';
  if (['ETIMEDOUT','ETIMEOUT','CONNECT_TIMEOUT','GREETING_TIMEOUT','SOCKET_TIMEOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EHOSTUNREACH'].includes(e.code || '')) return '邮箱服务器连接失败或超时，请检查地址、端口及防火墙。';
  if (['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','ETLS'].includes(e.code || '')) return 'TLS 证书验证失败，请检查服务器证书及加密端口。';
  return '邮箱操作失败。请检查 IMAP / SMTP 已启用、服务器 TLS 设置及邮箱权限，然后重新同步。';
}
