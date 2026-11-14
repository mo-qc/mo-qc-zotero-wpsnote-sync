/**
 * llm-for-zotero Agent 工具注册 + 本插件 MCP Server 共享的工具定义。
 *
 * 两个入口复用同一份 TOOL_DEFS：
 * - llm-for-zotero 的 `Zotero.LLMForZotero.api.agent.registerTool`（对话式同步）
 * - 本插件暴露的 `/wpsnote/mcp` JSON-RPC 端点（外部 MCP 客户端）
 *
 * executionClass 全部为 "read"：llm4zotero 的 external_effect 要求
 * effectOperations 必须命中其宿主 OPERATION_CATALOG（仅 Zotero 内部操作），
 * WPS 外部写无法合法申报；写工具改用 shouldRequireConfirmation 请求 HITL
 * 确认卡作为补偿（read 工具官方允许弹确认）。
 */

import { syncItem, beginOperation, endOperation } from "./syncEngine";
import { getAllMappings } from "./syncMapping";
import { pollOnce } from "./changePoller";
import { pullFromWps } from "./ui";
import { getPref } from "../utils/prefs";

export interface ToolDef {
  spec: {
    name: string;
    description: string;
    inputSchema: object;
    executionClass: "read" | "control" | "external_effect";
    workCategory:
      | "retrieval"
      | "planning"
      | "generation"
      | "zotero_action"
      | "external_system";
    exposure?: "model" | "internal";
  };
  validate: (
    args: unknown,
  ) => { ok: true; value: unknown } | { ok: false; error: string };
  execute: (input: any) => Promise<unknown>;
  needsConfirmation?: boolean;
}

function ok<T>(value: T) {
  return { ok: true as const, value };
}
function fail(error: string) {
  return { ok: false as const, error };
}

function resolveItemsByKey(keys: string[]): {
  items: Zotero.Item[];
  missing: string[];
} {
  const items: Zotero.Item[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const item = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      String(key || "").trim(),
    );
    if (item) items.push(item);
    else missing.push(String(key));
  }
  return { items, missing };
}

const statusTool: ToolDef = {
  spec: {
    name: "wps_sync_status",
    description:
      "查询 Zotero → WPS 笔记同步状态：映射条数、轮询开关与间隔、MCP 接口类型。只读。",
    inputSchema: { type: "object", properties: {} },
    executionClass: "read",
    workCategory: "external_system",
  },
  validate: (args) => {
    if (args !== undefined && args !== null && typeof args !== "object")
      return fail("arguments must be an object");
    return ok({});
  },
  execute: async () => {
    const mappings = getAllMappings();
    const keys = Object.keys(mappings);
    return {
      mappedNotes: keys.length,
      changePollEnabled: Boolean(getPref("changePollEnabled")),
      changePollIntervalMinutes: Number(getPref("changePollInterval") || 30),
      mcpInterfaceType: String(getPref("mcpInterfaceType") || "cloud"),
      sample: keys.slice(0, 5),
    };
  },
};

const pollTool: ToolDef = {
  spec: {
    name: "wps_poll_changes",
    description:
      "立即检查所有已同步的 WPS 笔记是否在 WPS 端被修改过（对比 update_time 基准），返回改动清单。只读，不写入任何一端。",
    inputSchema: { type: "object", properties: {} },
    executionClass: "read",
    workCategory: "external_system",
  },
  validate: (args) => {
    if (args !== undefined && args !== null && typeof args !== "object")
      return fail("arguments must be an object");
    return ok({});
  },
  execute: async () => {
    const changed = await pollOnce();
    return { changedCount: changed.length, changed };
  },
};

const syncTool: ToolDef = {
  spec: {
    name: "wps_sync_item",
    description:
      "把指定 Zotero 条目同步到 WPS 笔记（按条目 key 定位）。会创建或更新 WPS 笔记，属于外部写操作，执行前应请求用户确认。",
    inputSchema: {
      type: "object",
      required: ["itemKeys"],
      properties: {
        itemKeys: {
          type: "array",
          items: { type: "string" },
          description: "Zotero 条目 key 列表（条目信息栏可见的 8 位 key）",
        },
      },
    },
    executionClass: "read",
    workCategory: "external_system",
  },
  needsConfirmation: true,
  validate: (args) => {
    const rec = (args || {}) as Record<string, unknown>;
    const raw = rec.itemKeys;
    if (!Array.isArray(raw) || raw.length === 0)
      return fail("itemKeys must be a non-empty array of item keys");
    const keys = raw.map((k) => String(k || "").trim()).filter(Boolean);
    if (!keys.length) return fail("itemKeys contains no valid keys");
    if (keys.length > 50) return fail("itemKeys limited to 50 per call");
    return ok({ itemKeys: keys });
  },
  execute: async (input: { itemKeys: string[] }) => {
    const { items, missing } = resolveItemsByKey(input.itemKeys);
    if (!items.length) return { synced: 0, missing, errors: [] };
    if (!beginOperation("sync"))
      throw new Error("Another sync/pull operation is in progress");
    const results = [];
    try {
      for (const item of items) {
        results.push(await syncItem(item, { updateExisting: true }));
      }
    } finally {
      endOperation();
    }
    return {
      synced: results.filter((r) => r.success).length,
      failed: results
        .filter((r) => !r.success)
        .map((r) => ({ itemKey: r.itemKey, error: r.error })),
      missing,
      noteUrls: results
        .filter((r) => r.success && r.noteUrl)
        .map((r) => r.noteUrl),
    };
  },
};

const pullTool: ToolDef = {
  spec: {
    name: "wps_pull_note",
    description:
      "把指定条目在 WPS 端的笔记改动拉取回 Zotero 子笔记（回流）。会写入 Zotero 笔记，属于本地写操作，执行前应请求用户确认。",
    inputSchema: {
      type: "object",
      required: ["itemKeys"],
      properties: {
        itemKeys: {
          type: "array",
          items: { type: "string" },
          description: "Zotero 条目 key 列表",
        },
      },
    },
    executionClass: "read",
    workCategory: "external_system",
  },
  needsConfirmation: true,
  validate: (args) => {
    const rec = (args || {}) as Record<string, unknown>;
    const raw = rec.itemKeys;
    if (!Array.isArray(raw) || raw.length === 0)
      return fail("itemKeys must be a non-empty array of item keys");
    const keys = raw.map((k) => String(k || "").trim()).filter(Boolean);
    if (!keys.length) return fail("itemKeys contains no valid keys");
    if (keys.length > 50) return fail("itemKeys limited to 50 per call");
    return ok({ itemKeys: keys });
  },
  execute: async (input: { itemKeys: string[] }) => {
    const { items, missing } = resolveItemsByKey(input.itemKeys);
    if (!items.length) return { pulled: 0, missing };
    // 透传真实统计：锁被占用/条目失败时不能虚报 pulled=items.length
    const stat = await pullFromWps(items);
    if (stat && stat.started === false) {
      throw new Error("Another sync/pull operation is in progress");
    }
    return {
      pulled: stat?.ok ?? 0,
      skipped: stat?.skipped ?? 0,
      failed: stat?.failed ?? 0,
      missing,
    };
  },
};

export const TOOL_DEFS: ToolDef[] = [statusTool, pollTool, syncTool, pullTool];

/** 统一执行入口：MCP tools/call 与 agent 工具共用。 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: [{ type: "text"; text: string }]; isError?: boolean }> {
  const def = TOOL_DEFS.find((t) => t.spec.name === name);
  if (!def) throw new Error(`Unknown tool: ${name}`);
  const validated = def.validate(args);
  if (!validated.ok) {
    return {
      content: [
        { type: "text", text: `Invalid arguments: ${validated.error}` },
      ],
      isError: true,
    };
  }
  try {
    const result = await def.execute(validated.value);
    return {
      content: [{ type: "text", text: JSON.stringify(result ?? null) }],
    };
  } catch (e: any) {
    return {
      content: [
        {
          type: "text",
          text: `Tool failed: ${e?.message || String(e)}`,
        },
      ],
      isError: true,
    };
  }
}

// ── llm-for-zotero 注册 ────────────────────────────────────────────────────────

const REGISTERED_NAMES: string[] = [];
let waitTimer: ReturnType<typeof setInterval> | null = null;

function getAgentApi(): any | null {
  const inst = (Zotero as any).LLMForZotero;
  const api = inst?.api?.agent;
  return api && typeof api.registerTool === "function" ? api : null;
}

function registerAll(api: any): void {
  for (const def of TOOL_DEFS) {
    if (REGISTERED_NAMES.includes(def.spec.name)) continue;
    try {
      api.registerTool({
        spec: def.spec,
        validate: def.validate,
        shouldRequireConfirmation: def.needsConfirmation
          ? () => true
          : undefined,
        execute: async (input: any) => def.execute(input),
      });
      REGISTERED_NAMES.push(def.spec.name);
      ztoolkit.log("Agent tool registered", def.spec.name);
    } catch (e: any) {
      // external_effect 类被拒或 schema 变更时记录，不阻断其余工具
      ztoolkit.log(
        "Agent tool registration failed",
        def.spec.name,
        e?.message || String(e),
      );
    }
  }
}

/** 等待 llm-for-zotero 就绪后注册（对方可能晚于本插件启动）。 */
export function registerAgentTools(): void {
  if (waitTimer) return;
  let attempts = 0;
  const tryRegister = () => {
    const api = getAgentApi();
    if (api) {
      stopWait();
      registerAll(api);
      return;
    }
    if (++attempts > 30) stopWait(); // 60s 后放弃，对方未安装/未启用
  };
  waitTimer = setInterval(tryRegister, 2000);
  tryRegister();
}

function stopWait(): void {
  if (waitTimer) {
    clearInterval(waitTimer);
    waitTimer = null;
  }
}

export function unregisterAgentTools(): void {
  stopWait();
  const api = getAgentApi();
  if (api && typeof api.unregisterTool === "function") {
    for (const name of REGISTERED_NAMES) {
      try {
        api.unregisterTool(name);
      } catch (e) {
        ztoolkit.log("Agent tool unregister failed", name, e);
      }
    }
  }
  REGISTERED_NAMES.length = 0;
}
