/**
 * 本插件的 MCP Server：在 Zotero 内置 HTTP server（默认 127.0.0.1:23119）
 * 上暴露 `POST /wpsnote/mcp`，实现 Streamable HTTP 的无状态 POST-only 子集
 * （JSON-RPC 2.0：initialize / tools/list / tools/call / ping）。
 *
 * 架构借鉴 Beaver 的 /beaver/mcp：Endpoint 挂 Zotero.Server.Endpoints，
 * GET 返回 405（规范要求不提供 SSE 流时返回 Method Not Allowed）。
 *
 * 安全：
 * - 仅绑定 Zotero 本机回环端口；
 * - pref `mcpServerToken` 非空时校验 Authorization: Bearer / X-API-Key；
 * - 写工具（sync/pull）受 pref `mcpServerWriteEnabled` 门控，默认关闭，
 *   关闭时既不在 tools/list 广告也不可调用。
 */

import { config } from "../../package.json";
import { TOOL_DEFS, executeTool } from "./agentTools";
import { getPref } from "../utils/prefs";

const ENDPOINT_PATH = "/wpsnote/mcp";
const PROTOCOL_VERSION = "2024-11-05";
const WRITE_TOOL_NAMES = new Set(["wps_sync_item", "wps_pull_note"]);

let releaseEndpoint: (() => void) | null = null;

function writeEnabled(): boolean {
  return Boolean(getPref("mcpServerWriteEnabled"));
}

function tokenConfigured(): string {
  return String(getPref("mcpServerToken") || "").trim();
}

function checkAuth(requestData: any): boolean {
  const token = tokenConfigured();
  if (!token) return true;
  const headers = requestData?.headers || {};
  const auth = String(
    headers["authorization"] || headers["Authorization"] || "",
  );
  const apiKey = String(headers["x-api-key"] || headers["X-API-Key"] || "");
  const bearer = auth.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : auth.trim();
  return bearer === token || apiKey === token;
}

function listTools(): object[] {
  return TOOL_DEFS.filter((t) => {
    if (WRITE_TOOL_NAMES.has(t.spec.name) && !writeEnabled()) return false;
    return true;
  }).map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    inputSchema: t.spec.inputSchema,
  }));
}

async function handleJsonRpc(msg: any): Promise<[number, string, string]> {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  try {
    if (method === "initialize") {
      return [
        200,
        "application/json",
        JSON.stringify(
          reply({
            protocolVersion:
              (params && params.protocolVersion) || PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: "zotero-wpsnote-sync",
              version: config.version,
            },
          }),
        ),
      ];
    }
    if (method === "notifications/initialized" || isNotification) {
      // MCP 客户端通知不期待响应
      return [202, "application/json", ""];
    }
    if (method === "ping") {
      return [200, "application/json", JSON.stringify(reply({}))];
    }
    if (method === "tools/list") {
      return [
        200,
        "application/json",
        JSON.stringify(reply({ tools: listTools() })),
      ];
    }
    if (method === "tools/call") {
      const name = String(params?.name || "");
      const args = (params?.arguments || {}) as Record<string, unknown>;
      if (WRITE_TOOL_NAMES.has(name) && !writeEnabled()) {
        return [
          200,
          "application/json",
          JSON.stringify(
            reply({
              content: [
                {
                  type: "text",
                  text: "Write tools are disabled. Enable 'MCP 写操作' in the plugin preferences to allow sync/pull calls.",
                },
              ],
              isError: true,
            }),
          ),
        ];
      }
      const result = await executeTool(name, args);
      return [200, "application/json", JSON.stringify(reply(result))];
    }
    return [
      200,
      "application/json",
      JSON.stringify(error(-32601, `Method not found: ${method}`)),
    ];
  } catch (e: any) {
    return [
      200,
      "application/json",
      JSON.stringify(error(-32603, e?.message || String(e))),
    ];
  }
}

export function registerMcpServer(): boolean {
  if (releaseEndpoint) return true;
  const endpoints = (Zotero as any).Server?.Endpoints;
  if (!endpoints) {
    ztoolkit.log("MCP server: Zotero.Server.Endpoints unavailable");
    return false;
  }

  const Endpoint = function (this: any) {} as any;
  Endpoint.prototype = {
    supportedMethods: ["POST", "GET"],
    supportedDataTypes: ["application/json"],

    init: async (requestData: any): Promise<[number, string, string]> => {
      if (requestData.method === "GET") {
        // Streamable HTTP：不提供 SSE 流时按规范返回 405
        return [405, "text/plain", "Method Not Allowed"];
      }
      if (!checkAuth(requestData)) {
        return [
          401,
          "application/json",
          JSON.stringify({ error: "unauthorized" }),
        ];
      }
      try {
        const body = requestData.data;
        if (Array.isArray(body)) {
          const results = [];
          for (const item of body)
            results.push(JSON.parse((await handleJsonRpc(item))[2] || "null"));
          return [200, "application/json", JSON.stringify(results)];
        }
        return await handleJsonRpc(body);
      } catch (e: any) {
        return [
          500,
          "application/json",
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: e?.message || String(e) },
          }),
        ];
      }
    },
  };

  endpoints[ENDPOINT_PATH] = Endpoint;
  releaseEndpoint = () => {
    if (endpoints[ENDPOINT_PATH] === Endpoint) {
      delete endpoints[ENDPOINT_PATH];
    }
  };
  ztoolkit.log(
    `MCP server registered at ${ENDPOINT_PATH} (write tools: ${writeEnabled() ? "on" : "off"})`,
  );
  return true;
}

export function unregisterMcpServer(): void {
  if (releaseEndpoint) {
    try {
      releaseEndpoint();
    } catch (e) {
      ztoolkit.log("MCP server unregister failed", e);
    }
    releaseEndpoint = null;
  }
}
