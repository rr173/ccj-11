// ---------------------------------------------------------------------------
// 离线授权包签名密钥（Ed25519）：
//   - 每台设备的每次授权使用独立密钥对；私钥以 0600 PEM 保存在服务器数据目录，
//     永远不会进入授权包或任何对外响应；
//   - 授权包只内嵌公钥（SPKI DER, base64url），设备在离线状态下用它验签；
//   - 轮换授权时生成全新密钥（keyVersion 递增）并销毁旧私钥文件，旧公钥对应的
//     旧授权包立即无法再获得服务器信任（同步按 keyVersion 拒绝）。
//
// 若设置 OFFLINE_SIGN_KEY_PEM，则不写私钥文件（适合只读容器/集中密钥注入）；
// 此时每次授权仍生成独立的内存密钥对（不落盘），轮换后旧密钥同样失效。
// ---------------------------------------------------------------------------
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function keyDir() {
  return path.dirname(config.offlineSignKeyPath);
}

function deviceKeyFile(deviceId, keyVersion) {
  // deviceId 为 base64url，只含安全字符
  return path.join(keyDir(), `offline-dev-${deviceId}-k${Number(keyVersion)}.pem`);
}

// 生成一把“该设备本次授权专用”的全新 Ed25519 密钥对，并把私钥落盘（0600）。
export function generateDeviceKeyPair(deviceId, keyVersion) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  if (!config.offlineSignKeyPem) {
    const file = deviceKeyFile(deviceId, keyVersion);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return { privateKey, publicKey };
}

// 轮换/停用时销毁旧私钥文件（旧公钥即永远验不出服务器签名，旧包作废）
export function destroyDeviceKey(deviceId, keyVersion) {
  if (config.offlineSignKeyPem) return;
  const file = deviceKeyFile(deviceId, keyVersion);
  try {
    unlinkSync(file);
  } catch {
    // 密钥文件缺失不阻塞停用/轮换流程
  }
}

// 导出公钥的规范传输形态（SPKI DER, base64url）
export function exportPublicKeySpki(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

// 用指定私钥（设备某次授权的专用密钥）对规范字节签名（Ed25519 为纯签名，无算法参数）
export function signWith(privateKey, payloadCanonicalBytes) {
  return edSign(null, payloadCanonicalBytes, privateKey);
}

export { createPrivateKey, createPublicKey, existsSync, readFileSync };
