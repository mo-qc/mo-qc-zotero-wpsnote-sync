/**
 * 对敏感偏好值进行简单的混淆存储。
 * 这不是强加密，只是避免在 Zotero 偏好中直接明文保存 API Key。
 */

import { config } from "../../package.json";

function xorWithKey(text: string, key: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(
      text.charCodeAt(i) ^ key.charCodeAt(i % key.length),
    );
  }
  return result;
}

export function encryptString(text: string): string {
  return btoa(xorWithKey(text, config.addonID));
}

export function decryptString(text: string): string | null {
  try {
    return xorWithKey(atob(text), config.addonID);
  } catch {
    return null;
  }
}
