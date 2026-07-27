import { config } from "../../package.json";
import { decryptString, encryptString } from "./secret";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

/**
 * Clear preference value.
 * Wrapper of `Zotero.Prefs.clear`.
 * @param key
 */
export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}

/**
 * Read the WPS MCP API Key, transparently handling legacy plaintext values.
 */
export function getApiKey(): string {
  const raw = String(getPref("wpsMcpApiKey") || "");
  if (!raw) return "";
  const decrypted = decryptString(raw);
  return decrypted !== null ? decrypted : raw;
}

/**
 * Save the WPS MCP API Key using simple obfuscation.
 */
export function setApiKey(value: string): void {
  const trimmed = value.trim();
  setPref("wpsMcpApiKey", trimmed ? encryptString(trimmed) : "");
}

/**
 * Read the local WPS MCP token, transparently handling legacy plaintext values.
 */
export function getLocalMcpToken(): string {
  const raw = String(getPref("localMcpToken") || "");
  if (!raw) return "";
  const decrypted = decryptString(raw);
  return decrypted !== null ? decrypted : raw;
}

/**
 * Save the local WPS MCP token using simple obfuscation.
 */
export function setLocalMcpToken(value: string): void {
  const trimmed = value.trim();
  setPref("localMcpToken", trimmed ? encryptString(trimmed) : "");
}
