/**
 * WPS 笔记 MCP HTTP 客户端。
 * 通过 JSON-RPC 2.0 与 https://ainote.kdocs.cn/mcp-svc/mcp 通信。
 */

export interface McpToolResult {
  // WPS 笔记 MCP 的工具直接返回业务 JSON，不统一包装 ok/code
  [key: string]: unknown;
}

export interface McpJsonRpcEvent {
  id?: number;
  result?: unknown;
  error?: { code: number | string; message: string };
}

export interface McpEnvelope<T = unknown> {
  ok?: boolean;
  code?: number | string;
  message?: string;
  data?: T;
}

/**
 * 结构化 MCP 错误，包含可机器识别的错误码与是否可重试标记。
 */
export class McpError extends Error {
  public code: number | string;
  public isRetryable: boolean;

  constructor(options: {
    code: number | string;
    message: string;
    isRetryable?: boolean;
  }) {
    super(options.message);
    this.name = "McpError";
    this.code = options.code;
    this.isRetryable = options.isRetryable ?? false;
  }
}

export interface NoteBlock {
  id: string;
  type?: string;
  content?: string;
  children?: NoteBlock[];
}

export interface NoteOutline {
  blocks?: NoteBlock[];
}

export type McpInterfaceType = "cloud" | "local";

export interface McpClientOptions {
  interfaceType?: McpInterfaceType;
  endpoint: string;
  apiKey: string;
  timeout?: number;
  retries?: number;
}

function parseMcpSseResponse(
  text: string,
  expectedId?: number | null,
): McpJsonRpcEvent | undefined {
  // 简单 SSE 解析：按 event/message 块拆分，取 data: 行
  const events: McpJsonRpcEvent[] = [];
  const lines = text.split(/\r?\n/);
  let currentData = "";

  for (const line of lines) {
    if (line.startsWith("data:")) {
      currentData += (currentData ? "\n" : "") + line.slice(5).trimStart();
    } else if (line.trim() === "" && currentData) {
      try {
        events.push(JSON.parse(currentData));
      } catch {
        ztoolkit.log("Failed to parse SSE data", currentData.slice(0, 200));
      }
      currentData = "";
    }
  }
  if (currentData) {
    try {
      events.push(JSON.parse(currentData));
    } catch {
      ztoolkit.log(
        "Failed to parse trailing SSE data",
        currentData.slice(0, 200),
      );
    }
  }

  // 如果返回的是普通 JSON（非 SSE），也兼容
  if (events.length === 0) {
    try {
      events.push(JSON.parse(text));
    } catch {
      // ignore
    }
  }

  ztoolkit.log(
    "MCP SSE events",
    events.length,
    events.map((e) => e.id),
  );

  if (expectedId === undefined || expectedId === null) {
    // notification 不需要 id，返回最后一个事件
    return events[events.length - 1] || {};
  }

  const match = events.find((e) => e.id === expectedId);
  if (match) return match;

  // 兜底：返回第一个含 result/error 的事件
  return (
    events.find((e) => e.result !== undefined || e.error !== undefined) ||
    events[0] ||
    {}
  );
}

export class WpsMcpClient {
  private endpoint: string;
  private apiKey: string;
  private interfaceType: McpInterfaceType;
  private timeout: number;
  private requestId = 0;
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;
  private tools: string[] = [];
  private retries: number;
  private sessionId?: string;

  constructor(options: McpClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.interfaceType = options.interfaceType || "cloud";
    this.timeout = options.timeout || 60000;
    this.retries = options.retries ?? 2;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.interfaceType === "local") {
      // streamable_http 需要同时接受 JSON 与 SSE 响应，否则可能返回 406
      headers["Accept"] = "application/json, text/event-stream";
      headers["Authorization"] = `Bearer ${this.apiKey}`;
      headers["API_KEY"] = this.apiKey;
      if (this.sessionId) {
        headers["Mcp-Session-Id"] = this.sessionId;
      }
    } else {
      headers["X-API-Key"] = this.apiKey;
    }
    return headers;
  }

  private getResponseHeader(xhr: any, name: string): string | null {
    if (!xhr || typeof xhr.getResponseHeader !== "function") return null;
    // HTTP 头大小写不敏感，但 getResponseHeader 某些实现区分大小写
    const variants = [name, name.toLowerCase(), name.toUpperCase()];
    const capitalized = name
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join("-");
    variants.push(capitalized);
    for (const v of variants) {
      const value = xhr.getResponseHeader(v);
      if (value) return value;
    }
    return null;
  }

  private nextId(): number {
    return ++this.requestId;
  }

  private async doRequest(
    method: string,
    params?: any,
    id?: number | null,
  ): Promise<any> {
    const body: any = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      body.params = params;
    }
    if (id !== undefined) {
      body.id = id;
    }

    ztoolkit.log("MCP request", method, params);

    const xhr = await Zotero.HTTP.request("POST", this.endpoint, {
      body: JSON.stringify(body),
      headers: this.buildHeaders(),
      timeout: this.timeout,
      successCodes: false, // 允许我们自行处理状态码
    });

    const text = xhr.responseText || "";
    ztoolkit.log("MCP response", xhr.status, text.slice(0, 800));

    if (xhr.status < 200 || xhr.status >= 300) {
      throw new McpError({
        code: xhr.status,
        message: `MCP HTTP ${xhr.status}: ${text.slice(0, 200)}`,
        isRetryable: xhr.status >= 500 || xhr.status === 429,
      });
    }

    // WPS 笔记 MCP 使用 SSE 流返回，解析 data: 行
    const parsed = parseMcpSseResponse(text, id);
    if (!parsed) {
      throw new McpError({
        code: "EMPTY_RESPONSE",
        message: "MCP response is empty",
        isRetryable: true,
      });
    }
    if (parsed.error) {
      const code = parsed.error.code;
      // JSON-RPC 标准错误码：-32768 ~ -32000 为协议/服务端错误，通常可重试
      const isProtocolError =
        typeof code === "number" && code <= -32000 && code >= -32768;
      throw new McpError({
        code,
        message: `MCP error ${code}: ${parsed.error.message}`,
        isRetryable: isProtocolError || code === -32000,
      });
    }

    return parsed.result;
  }

  private async post(
    method: string,
    params?: Record<string, unknown>,
    id?: number | null,
  ): Promise<unknown> {
    const maxRetries = this.retries;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.doRequest(method, params, id);
      } catch (err: any) {
        lastError = err;
        const isNetworkError =
          !err?.message?.includes("MCP error") &&
          !err?.message?.includes("MCP tool error");
        const retryable =
          err instanceof McpError ? err.isRetryable : isNetworkError;
        if (!retryable || attempt === maxRetries) {
          throw err;
        }
        const delay = Math.min(1000 * 2 ** attempt, 5000);
        ztoolkit.log(
          `MCP request failed, retrying in ${delay}ms`,
          method,
          err?.message || String(err),
        );
        await new Promise((resolve) => Zotero.setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  private async sendNotification(method: string, params?: any): Promise<void> {
    const body: any = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      body.params = params;
    }

    ztoolkit.log("MCP notification", method, params);

    try {
      await Zotero.HTTP.request("POST", this.endpoint, {
        body: JSON.stringify(body),
        headers: this.buildHeaders(),
        timeout: this.timeout,
        successCodes: false,
      });
    } catch (err: any) {
      ztoolkit.log(
        "MCP notification failed (non-critical)",
        method,
        err?.message || String(err),
      );
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializingPromise) return this.initializingPromise;

    this.initializingPromise = (async () => {
      try {
        const initId = this.nextId();
        const initBody = {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: true },
            },
            clientInfo: {
              name: "zotero-wpsnote-sync",
              version: addon.data.config.version || "0.1.0",
            },
          },
          id: initId,
        };

        // initialize 需要直接访问原始 XHR，以读取 streamable_http 返回的 session ID
        const xhr = await Zotero.HTTP.request("POST", this.endpoint, {
          body: JSON.stringify(initBody),
          headers: this.buildHeaders(),
          timeout: this.timeout,
          successCodes: false,
        });

        const text = xhr.responseText || "";
        ztoolkit.log("MCP initialize response", xhr.status, text.slice(0, 800));

        if (xhr.status < 200 || xhr.status >= 300) {
          throw new Error(
            `MCP initialize HTTP ${xhr.status}: ${text.slice(0, 200)}`,
          );
        }

        const sessionId = this.getResponseHeader(xhr, "Mcp-Session-Id");
        if (sessionId) {
          this.sessionId = sessionId;
          ztoolkit.log(
            "MCP session ID acquired",
            sessionId.slice(0, 8) + "...",
          );
        }

        const parsed = parseMcpSseResponse(text, initId);
        if (!parsed) {
          throw new Error("MCP initialize response is empty");
        }
        if (parsed.error) {
          throw new Error(
            `MCP initialize error: ${JSON.stringify(parsed.error)}`,
          );
        }

        ztoolkit.log("MCP initialized", parsed.result);

        // 发送 initialized 通知（无 id），notification 不应期待响应
        await this.sendNotification("notifications/initialized", undefined);

        // 拉取工具列表
        const toolsResult = (await this.post(
          "tools/list",
          undefined,
          this.nextId(),
        )) as { tools?: { name?: string }[] };
        this.tools = (toolsResult?.tools || []).map((t) => t.name as string);
        ztoolkit.log("MCP tools", this.tools);

        this.initialized = true;
      } finally {
        this.initializingPromise = null;
      }
    })();

    return this.initializingPromise;
  }

  hasTool(name: string): boolean {
    return this.tools.includes(name);
  }

  /**
   * 重置初始化状态，用于 session 过期或接口配置变更后重新握手。
   */
  reset(): void {
    this.initialized = false;
    this.initializingPromise = null;
    this.sessionId = undefined;
    this.tools = [];
  }

  private isSessionOrInitError(err: unknown): boolean {
    const msg = String((err as any)?.message || "").toLowerCase();
    const code = (err as any)?.code;
    if (
      code === "SESSION_EXPIRED" ||
      code === "INVALID_SESSION" ||
      code === "NOT_INITIALIZED" ||
      code === "SESSION_NOT_FOUND"
    ) {
      return true;
    }
    return (
      msg.includes("session") ||
      msg.includes("initialized") ||
      msg.includes("not initialized") ||
      msg.includes("initialize")
    );
  }

  private parseToolResult(result: unknown): McpToolResult {
    // WPS 笔记 MCP 返回的 result 中，业务数据在 content[].text 的 JSON 里，
    // 新版同时提供 structuredContent；优先取 structuredContent，再解析 text。
    // 本地 streamable_http 返回统一响应信封 { ok, code, data, ... }，需解包 data。
    let parsed: unknown = result;
    const resultObj =
      result && typeof result === "object"
        ? (result as {
            structuredContent?: unknown;
            content?: { type?: string; text?: string }[];
          })
        : undefined;
    if (resultObj) {
      if (
        resultObj.structuredContent &&
        typeof resultObj.structuredContent === "object"
      ) {
        parsed = resultObj.structuredContent;
      } else if (Array.isArray(resultObj.content)) {
        for (const item of resultObj.content) {
          if (item.type === "text" && typeof item.text === "string") {
            try {
              parsed = JSON.parse(item.text);
              break;
            } catch {
              return { text: item.text } as McpToolResult;
            }
          }
        }
      }
    }

    // 解包统一响应信封
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      const envelope = parsed as McpEnvelope;
      if (envelope.ok === false) {
        const isRetryable =
          envelope.code === 429 ||
          envelope.code === 500 ||
          envelope.code === 502 ||
          envelope.code === 503 ||
          envelope.code === 504;
        throw new McpError({
          code: envelope.code ?? "TOOL_ERROR",
          message:
            envelope.message ||
            `MCP tool error ${envelope.code || ""}: ${JSON.stringify(envelope)}`,
          isRetryable,
        });
      }
      if (envelope.data !== undefined) {
        parsed = envelope.data;
      }
    }

    return (parsed as McpToolResult) || {};
  }

  async callTool(
    name: string,
    args: Record<string, any>,
  ): Promise<McpToolResult> {
    await this.initialize();

    try {
      const result = await this.post(
        "tools/call",
        { name, arguments: args },
        this.nextId(),
      );
      return this.parseToolResult(result);
    } catch (err: any) {
      if (this.isSessionOrInitError(err)) {
        ztoolkit.log(
          "MCP session/init error, resetting and retrying once",
          err?.message || String(err),
        );
        this.reset();
        await this.initialize();
        const result = await this.post(
          "tools/call",
          { name, arguments: args },
          this.nextId(),
        );
        return this.parseToolResult(result);
      }
      throw err;
    }
  }

  async createNote(
    title: string,
  ): Promise<{ noteId: string; noteUrl: string }> {
    const res = await this.callTool("create_note", { title });
    const noteId = res.note_id;
    if (!noteId) {
      throw new Error(
        `create_note 失败：未返回 note_id，响应 ${JSON.stringify(res).slice(0, 200)}`,
      );
    }
    return {
      noteId: String(noteId),
      noteUrl: String(
        res.link_url || `https://ainote.kdocs.cn/wps-notes-hub/note/${noteId}`,
      ),
    };
  }

  async getNoteOutline(noteId: string): Promise<NoteOutline> {
    return this.callTool("get_note_outline", {
      note_id: noteId,
    }) as Promise<NoteOutline>;
  }

  async editBlock(
    noteId: string,
    op: "replace" | "insert" | "delete" | "update_attrs" | "move",
    params: Record<string, any>,
  ): Promise<McpToolResult> {
    return this.callTool("edit_block", {
      note_id: noteId,
      op,
      ...params,
    });
  }

  async batchEdit(noteId: string, operations: any[]): Promise<McpToolResult> {
    return this.callTool("batch_edit", {
      note_id: noteId,
      operations,
    });
  }

  /**
   * 清空笔记中旧内容，替换为新的 XML。
   * 策略：保留第一个 block 并替换其内容，删除其余所有 block。
   * batch_edit 内部执行顺序固定为 delete → replace，因此先删后换安全。
   * 注意：batch_edit 的 delete 操作需要 block_ids（数组），不是 block_id。
   */
  async replaceNoteContent(
    noteId: string,
    content: string,
    outline?: NoteOutline,
  ): Promise<McpToolResult> {
    const resolvedOutline = outline || (await this.getNoteOutline(noteId));
    const blocks = Array.isArray(resolvedOutline?.blocks)
      ? resolvedOutline.blocks
      : [];
    if (!blocks.length) {
      throw new Error("无法获取笔记 block 列表");
    }

    if (blocks.length === 1) {
      return this.editBlock(noteId, "replace", {
        block_id: blocks[0].id,
        content,
      });
    }

    const operations: any[] = [];
    const blockIdsToDelete = blocks
      .slice(1)
      .map((b: any) => b.id)
      .filter(Boolean);
    const DELETE_BATCH_SIZE = 50;
    for (let i = 0; i < blockIdsToDelete.length; i += DELETE_BATCH_SIZE) {
      operations.push({
        op: "delete",
        block_ids: blockIdsToDelete.slice(i, i + DELETE_BATCH_SIZE),
      });
    }
    operations.push({ op: "replace", block_id: blocks[0].id, content });

    return this.batchEdit(noteId, operations);
  }

  async addNoteTags(
    noteId: string,
    tagNames: string[],
  ): Promise<McpToolResult> {
    await this.initialize();
    if (this.hasTool("manage_note_tags")) {
      return this.callTool("manage_note_tags", {
        note_id: noteId,
        add: tagNames,
      });
    }
    if (this.hasTool("add_note_tags")) {
      return this.callTool("add_note_tags", {
        note_id: noteId,
        tag_names: tagNames,
      });
    }
    throw new Error(
      "MCP server 未提供标签管理工具（manage_note_tags/add_note_tags）",
    );
  }

  async searchNotes(keyword: string, limit = 10): Promise<unknown[]> {
    const isLocal = this.interfaceType === "local";
    const args = isLocal ? { keywords: [keyword], limit } : { keyword, limit };
    const res = await this.callTool("search_notes", args);
    const resObj = res as {
      notes?: unknown[];
      items?: unknown[];
      data?: {
        notes?: unknown[];
        items?: unknown[];
      };
    };
    const candidates = isLocal
      ? resObj.notes ||
        resObj.items ||
        resObj.data?.notes ||
        resObj.data?.items ||
        resObj.data ||
        []
      : resObj.items || resObj.data?.items || resObj.data || [];
    return Array.isArray(candidates) ? candidates : [];
  }

  async insertImage(
    noteId: string,
    anchorId: string,
    src: string,
    alt?: string,
    position: "before" | "after" = "after",
  ): Promise<{ block_id?: string; width?: number; height?: number }> {
    const res = await this.callTool("insert_image", {
      note_id: noteId,
      anchor_id: anchorId,
      position,
      src,
      alt,
    });
    const resObj = res as {
      dimensions?: { width?: number; height?: number };
      block_id?: string;
      last_block_id?: string;
    };
    const dims = (resObj.dimensions || resObj) as {
      width?: number;
      height?: number;
    };
    return {
      block_id: resObj.block_id || resObj.last_block_id,
      width: dims.width,
      height: dims.height,
    };
  }
}
