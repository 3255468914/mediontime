/*!
 * push.mjs — 零依赖 Web Push 发送端
 *
 * 只用 node:crypto 实现两条标准，不引入 web-push 之类的库：
 *   · RFC 8291 —— 载荷加密（ECDH P-256 + HKDF-SHA256 + AES-128-GCM，aes128gcm 编码）
 *   · RFC 8292 —— VAPID（ES256 签名 JWT，放进 Authorization 头）
 *
 * 为什么值得自己写：加密一旦写错，现象是"服务端返回 201、家属却什么也收不到"，
 * 属于本项目最防的那类"界面在说谎"。所以测试里不用本文件的任何函数，
 * 而是**另写一个本地模拟推送服务**，从 RFC 独立实现解密，
 * 把载荷还原回原文——只有还原成功才算数（见 tests/relay.test.mjs）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** 记录大小：单条记录能装下的密文上限。提醒事件很小，4096 足够。 */
const RECORD_SIZE = 4096;

/* ---------- VAPID 密钥 ---------- */

function rawPublicFromKeyObject(keyObj) {
  const jwk = keyObj.export({ format: 'jwk' });
  const x = unb64u(jwk.x);
  const y = unb64u(jwk.y);
  return Buffer.concat([Buffer.from([0x04]), x, y]);   // 未压缩点格式
}

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    /** 浏览器 pushManager.subscribe 需要的就是这个（base64url 的未压缩点） */
    publicKey: b64u(rawPublicFromKeyObject(publicKey))
  };
}

export function loadOrCreateVapidKeys(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.privateKeyPem && j.publicKey) return j;
  } catch (e) { /* 首次运行 */ }
  const keys = generateVapidKeys();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  } catch (e) {
    console.warn('[push] VAPID 密钥落盘失败（本次仍可使用）：', e.message);
  }
  return keys;
}

/* ---------- RFC 8292 VAPID ---------- */

export function buildVapidHeader(endpoint, keys, subject = 'mailto:caregiver@example.com', nowMs = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({
    aud,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: subject
  })));
  const signingInput = header + '.' + payload;
  // ES256 要求签名是裸的 r||s（JOSE 格式），Node 默认给的是 DER —— 不加这个选项会得到一坨没人认得的签名
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: keys.privateKeyPem,
    dsaEncoding: 'ieee-p1363'
  });
  return 'vapid t=' + signingInput + '.' + b64u(sig) + ', k=' + keys.publicKey;
}

/* ---------- RFC 8291 载荷加密 ---------- */

/**
 * @param {{p256dh:String, auth:String}} keys 浏览器订阅返回的 keys（base64url）
 * @param {Buffer} plaintext
 * @returns {Buffer} aes128gcm 请求体
 */
export function encryptPayload(keys, plaintext, recordSize = RECORD_SIZE) {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);

  const asEcdh = crypto.createECDH('prime256v1');
  asEcdh.generateKeys();
  const asPublic = asEcdh.getPublicKey();               // 65 字节未压缩点
  const shared = asEcdh.computeSecret(uaPublic);        // 32 字节

  const salt = crypto.randomBytes(16);

  // IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = "WebPush: info\0" || ua_public || as_public)
  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info'), Buffer.from([0]),
    uaPublic, asPublic
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, authInfo, 32));

  // 再由 ikm + salt 派生出内容加密所需的两把"钥匙"
  const cek = Buffer.from(crypto.hkdfSync(
    'sha256', ikm, salt, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0])]), 16));
  const nonce = Buffer.from(crypto.hkdfSync(
    'sha256', ikm, salt, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0])]), 12));

  // 明文末尾必须有一个分隔符：0x02 表示"这是最后一条记录"
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(recordSize, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, enc]);
}

/* ---------- 发送 ---------- */

export function createPushSender({ vapidKeys, subject, fetchImpl, ttl = 3600 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!vapidKeys) throw new Error('缺少 VAPID 密钥');
  if (!doFetch) throw new Error('当前环境没有 fetch，无法发送 Web Push');

  return {
    vapidPublicKey: vapidKeys.publicKey,
    /**
     * 投递一条推送。**失败一律抛出**，绝不吞掉——
     * 上层要靠这个异常如实告诉用户"没送到"，而不是显示"已通知"。
     */
    async send(subscription, payloadObj) {
      if (!subscription || !subscription.endpoint) throw new Error('订阅缺少 endpoint');
      const body = encryptPayload(subscription.keys, Buffer.from(JSON.stringify(payloadObj)));
      const res = await doFetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'TTL': String(ttl),
          'Authorization': buildVapidHeader(subscription.endpoint, vapidKeys, subject)
        },
        body
      });
      if (!res || !res.ok) {
        const err = new Error('推送端点返回 ' + (res ? res.status : '无响应'));
        err.statusCode = res ? res.status : 0;
        throw err;
      }
      return { status: res.status };
    }
  };
}
