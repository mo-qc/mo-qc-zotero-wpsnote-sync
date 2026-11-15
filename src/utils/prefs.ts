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

/**
 * 自动同步的文献库白名单。
 * 返回 null 表示未配置（默认行为：排除订阅 feed 库、其余全同步）；
 * 返回数组表示用户显式选择（空数组 = 全部不同步）。
 */
export function getAutoSyncLibraryIds(): number[] | null {
  try {
    const raw = String(getPref("autoSyncLibraries") || "").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return null;
  }
}

/**
 * 某条目的所属库是否参与自动同步。
 * - 已配置白名单：严格按名单（空名单 = 全不同步）。
 * - 未配置：排除订阅(feed)库，其余同步——订阅文献更新不触发同步。
 * 库信息取不到时保守不同步，避免误推订阅内容。
 */
export function isAutoSyncLibrary(libraryID: number): boolean {
  const list = getAutoSyncLibraryIds();
  if (list !== null) return list.includes(libraryID);
  try {
    const lib = Zotero.Libraries.get(libraryID);
    // Zotero 10：库类型字段是 libraryType（"user"/"group"/"feed"），不是 type
    return !!lib && (lib as any).libraryType !== "feed";
  } catch {
    return false;
  }
}

/** 同步目标：wps（默认）或 craft */
export function getSyncTarget(): "wps" | "craft" {
  const v = String(getPref("syncTarget") || "wps");
  return v === "craft" ? "craft" : "wps";
}

export function setSyncTarget(target: "wps" | "craft"): void {
  setPref("syncTarget", target);
}

/** Craft API Bearer token（混淆存储，兼容明文旧值） */
export function getCraftApiToken(): string {
  const raw = String(getPref("craftApiToken") || "");
  if (!raw) return "";
  const decrypted = decryptString(raw);
  return decrypted !== null ? decrypted : raw;
}

export function setCraftApiToken(value: string): void {
  const trimmed = value.trim();
  setPref("craftApiToken", trimmed ? encryptString(trimmed) : "");
}

export interface CraftConfig {
  link: string;
  token: string;
  folderId: string;
}

export function getCraftConfig(): CraftConfig {
  return {
    link: String(getPref("craftApiLink") || "").trim(),
    token: getCraftApiToken(),
    folderId: String(getPref("craftFolderId") || "").trim(),
  };
}

/**
 * 颜色语义映射（JSON：{"#7fba00":"核心结论"}）。
 * 用于批注分组标题：用户定义了语义名就用语义名，否则回落默认色名。
 * 解析失败/非法项静默忽略，不影响同步。
 */
export function getColorSemanticMap(): Record<string, string> {
  try {
    const raw = String(getPref("colorSemanticMap") || "");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k).trim().toLowerCase();
      const val = String(v ?? "").trim();
      if (/^#[0-9a-f]{3,8}$/.test(key) && val) out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

export interface McpServerConfig {
  url: string;
  transport?: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  endpoint: string;
  apiKey: string;
  interfaceType: "cloud" | "local";
}

/**
 * 解析用户粘贴的 MCP JSON 配置。
 * 支持格式：{ "mcpServers": { "name": { "url": "...", "headers": {...} } } }
 */
export function parseMcpConfigJson(json: string): McpConfig | null {
  const trimmed = json.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    const servers = parsed?.mcpServers || parsed?.mcp_server;
    if (!servers || typeof servers !== "object") return null;

    const server: McpServerConfig | undefined = Object.values(servers).find(
      (s): s is McpServerConfig =>
        s !== null &&
        typeof s === "object" &&
        typeof (s as any).url === "string",
    );
    if (!server?.url) return null;

    const headers = server.headers || {};
    const endpoint = server.url;

    // 本地 streamable_http 通常使用 Authorization Bearer 或 API_KEY
    const bearer = headers["Authorization"] || "";
    const localToken =
      (bearer.startsWith("Bearer ")
        ? bearer.slice("Bearer ".length)
        : bearer) ||
      headers["API_KEY"] ||
      headers["api_key"] ||
      "";

    // 云端使用 X-API-Key
    const cloudKey = headers["X-API-Key"] || headers["x-api-key"] || "";

    const isLocalUrl =
      /^(http:\/\/127\.0\.0\.1|http:\/\/localhost)/i.test(endpoint) ||
      server.transport === "streamable_http";

    if (isLocalUrl && localToken) {
      return { endpoint, apiKey: localToken, interfaceType: "local" };
    }
    if (cloudKey) {
      return { endpoint, apiKey: cloudKey, interfaceType: "cloud" };
    }
    if (localToken) {
      return { endpoint, apiKey: localToken, interfaceType: "local" };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 读取 MCP 配置：优先使用 JSON 配置，否则回退到旧的分散偏好设置。
 */
export function getMcpConfig(): McpConfig {
  const interfaceType =
    (String(getPref("mcpInterfaceType") || "cloud") as "cloud" | "local") ||
    "cloud";

  const jsonConfig = parseMcpConfigJson(String(getPref("mcpConfigJson") || ""));
  if (jsonConfig) {
    return jsonConfig;
  }

  // 回退旧配置
  if (interfaceType === "local") {
    return {
      endpoint: String(getPref("localMcpUrl") || "http://127.0.0.1:18930/mcp"),
      apiKey: getLocalMcpToken(),
      interfaceType: "local",
    };
  }
  return {
    endpoint: String(
      getPref("wpsMcpEndpoint") || "https://ainote.kdocs.cn/mcp-svc/mcp",
    ),
    apiKey: getApiKey(),
    interfaceType: "cloud",
  };
}
