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

/** list_notes / get_note_info 返回的笔记摘要 */
export interface NoteSummary {
  note_id?: string;
  title?: string;
  /** WPS 端修改时间（数字时间戳） */
  update_time?: number;
  create_time?: number;
  delete_time?: number;
  trash_status?: number;
  linkUrl?: string;
  link_id?: string;
  tags?: string[];
  starred?: boolean;
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
    idempotent = true,
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
        // 非幂等工具（create/edit 等写操作）只在 429 时重试——429 表示请求
        // 被限流拒绝、未执行；5xx/网络错误可能已执行，重试会重复写入
        const retryable =
          err instanceof McpError
            ? idempotent
              ? err.isRetryable
              : err.code === 429
            : idempotent && isNetworkError;
        if (!retryable || attempt === maxRetries) {
          throw err;
        }
        const delay = Math.min(1000 * 2 ** attempt, 5000);
        ztoolkit.log(
          `MCP request failed, retrying in ${delay}ms`,
          method,
          err?.message || String(err),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
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
          throw new McpError({
            code: xhr.status,
            message: `MCP initialize HTTP ${xhr.status}: ${text.slice(0, 200)}`,
            isRetryable: xhr.status >= 500 || xhr.status === 429,
          });
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
          throw new McpError({
            code: "EMPTY_RESPONSE",
            message: "MCP initialize response is empty",
            isRetryable: true,
          });
        }
        if (parsed.error) {
          throw new McpError({
            code: parsed.error.code,
            message: `MCP initialize error: ${parsed.error.message}`,
            isRetryable: false,
          });
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

    // 保留原始 content 数组：图片类工具（read_image）把数据放在 MCP 原生
    // image content 项（{type:"image", mimeType, data}）里，不走 JSON text，
    // 只认 text 会把图片丢掉（回流图片全灭的直接原因）
    if (resultObj && Array.isArray(resultObj.content)) {
      parsed = {
        ...(parsed && typeof parsed === "object" ? parsed : {}),
        __mcpContent: resultObj.content,
      };
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
    // 读类工具幂等可安全重试；其余（create/edit/delete 等写操作）按非幂等处理
    const idempotent = /^(get_|list_|search_|read_|query_)/.test(name);

    try {
      const result = await this.post(
        "tools/call",
        { name, arguments: args },
        this.nextId(),
        idempotent,
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
          idempotent,
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

  /** 分页读全整篇笔记 XML（长笔记跨多页；偏移以服务端 next_offset 为准，避免重复拼接） */
  async readNoteFull(noteId: string): Promise<string> {
    let xml = "";
    let offset = 0;
    for (let page = 0; page < 500; page++) {
      const r = await this.readNote(noteId, offset, 100);
      xml += r.content;
      if (!r.hasMore || r.nextOffset <= offset) break;
      offset = r.nextOffset;
    }
    return xml;
  }

  /**
   * 分区替换：只重写 marker 之前的 Zotero 区，marker 及其后的用户笔记区零触碰。
   * - readNote 拿带块 id 的整篇 XML → 定位 marker 顶层块
   * - 块级操作：delete marker 前所有顶层块 → insert(anchor=marker, before, 新内容)
   * - marker 不存在（旧映射从未分区/用户删了 marker）→ 回退全量替换并重建分区，
   *   与 Craft no-marker 行为对等；回退会覆盖远端手写，仅发生在未分区的旧笔记上
   * 返回 marker 块 id 与图片同步锚点（图片属 Zotero 区，锚在 marker 前）。
   */
  async replaceZoteroRegion(
    noteId: string,
    newContentXml: string,
    markerPhrase: string,
    markerXml: string,
    outline?: NoteOutline,
  ): Promise<{
    markerBlockId: string;
    imageAnchorId: string;
    imageAnchorPosition: "before" | "after";
  }> {
    const resolvedOutline = outline || (await this.getNoteOutline(noteId));
    const blocks = Array.isArray(resolvedOutline?.blocks)
      ? resolvedOutline.blocks
      : [];
    if (!blocks.length) {
      throw new Error("无法获取笔记 block 列表");
    }

    const xml = await this.readNoteFull(noteId);
    const markerId = findMarkerBlockId(
      xml,
      markerPhrase,
      new Set(blocks.map((b) => b.id)),
    );

    if (markerId) {
      const idx = blocks.findIndex((b) => b.id === markerId);
      // marker 之前的 Zotero 区整段删除（50/批攒进一次 batchEdit）；marker 及用户区不动
      const toDelete = blocks
        .slice(0, idx)
        .map((b) => b.id)
        .filter(Boolean);
      if (toDelete.length) {
        const operations: any[] = [];
        const DELETE_BATCH_SIZE = 50;
        for (let i = 0; i < toDelete.length; i += DELETE_BATCH_SIZE) {
          operations.push({
            op: "delete",
            block_ids: toDelete.slice(i, i + DELETE_BATCH_SIZE),
          });
        }
        await this.batchEdit(noteId, operations);
      }
      if (newContentXml.trim()) {
        await this.editBlock(noteId, "insert", {
          anchor_id: markerId,
          position: "before",
          content: newContentXml,
        });
      }
      return {
        markerBlockId: markerId,
        imageAnchorId: markerId,
        imageAnchorPosition: "before",
      };
    }

    // 回退：无 marker → 全量替换后独立 insert marker。
    // 尾部拼接（content 追加）的 marker 会被 WPS 解析丢弃（真机复现：
    // 写入时回读可见、随后消失），必须走 edit_block insert 独立块。
    await this.replaceNoteContent(noteId, newContentXml, resolvedOutline);
    const markerId2 = await this.appendMarkerBlock(
      noteId,
      markerXml,
      markerPhrase,
    );
    if (!markerId2) {
      throw new Error("分区重建后无法写入 marker 块");
    }
    return {
      markerBlockId: markerId2,
      imageAnchorId: markerId2,
      imageAnchorPosition: "before",
    };
  }

  /**
   * 末尾独立 insert marker 块并提取其顶层块 id。
   * insert 返回值不含新块 id，用 readNote+outline 定位；失败返回 undefined。
   */
  async appendMarkerBlock(
    noteId: string,
    markerXml: string,
    markerPhrase: string,
  ): Promise<string | undefined> {
    const outline = await this.getNoteOutline(noteId);
    const blocks = Array.isArray(outline?.blocks) ? outline.blocks : [];
    const lastId = blocks.length ? blocks[blocks.length - 1].id : undefined;
    if (!lastId) return undefined;
    await this.editBlock(noteId, "insert", {
      anchor_id: lastId,
      position: "after",
      content: markerXml,
    });
    return await this.extractMarkerBlockId(noteId, markerPhrase);
  }

  /**
   * 创建/重建后提取 marker 顶层块 id（readNote 全文 + outline 顶层集合验证）。
   * 提取失败返回 undefined——调用方降级为不记录，下次同步走回退重建。
   */
  async extractMarkerBlockId(
    noteId: string,
    markerPhrase: string,
  ): Promise<string | undefined> {
    const [xml, outline] = await Promise.all([
      this.readNoteFull(noteId),
      this.getNoteOutline(noteId),
    ]);
    const ids = new Set((outline.blocks || []).map((b) => b.id));
    return findMarkerBlockId(xml, markerPhrase, ids);
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

  /** 读取笔记元信息（标题、WPS 端 update_time），用于改动检测 */
  async getNoteInfo(
    noteId: string,
  ): Promise<{ title: string; updateTime: number }> {
    const res = await this.callTool("get_note_info", { note_id: noteId });
    const notes = (res as { notes?: Array<Record<string, any>> }).notes;
    const note = Array.isArray(notes)
      ? notes.find((n) => String(n.note_id) === String(noteId)) || notes[0]
      : undefined;
    if (!note) {
      throw new Error(
        `get_note_info 未返回该笔记：${JSON.stringify(res).slice(0, 200)}`,
      );
    }
    return {
      title: String(note.title || ""),
      updateTime: Number(note.update_time || 0),
    };
  }

  /**
   * 读回笔记内容（语义 XML），支持分页；用于 WPS → Zotero 回流。
   *
   * 分页语义以服务端 pagination 为准：`offset` 是 block 下标（0-based），
   * 单页上限由 `block_limit` 决定，服务端会返回实际 limit 与 returned_blocks。
   * 续读必须用 `next_offset`（缺失时回退 offset + returned_blocks），
   * 不能按请求的 block_limit 自增——服务端可能放大单页（实测 50 → 119），
   * 自增会重复读取已返回的块，回流内容成倍膨胀。
   */
  async readNote(
    noteId: string,
    offset = 0,
    blockLimit = 50,
  ): Promise<{
    title: string;
    content: string;
    truncated: boolean;
    hasMore: boolean;
    nextOffset: number;
  }> {
    const res = await this.callTool("read_note", {
      note_id: noteId,
      offset,
      block_limit: blockLimit,
    });
    const data = res as {
      title?: string;
      content?: string;
      truncated?: boolean;
      pagination?: {
        offset?: number;
        limit?: number;
        returned_blocks?: number;
        has_more?: boolean;
        next_offset?: number;
      };
    };
    if (typeof data.content !== "string" || !data.content) {
      throw new Error(
        `read_note 未返回内容：${JSON.stringify(res).slice(0, 200)}`,
      );
    }
    const page = data.pagination || {};
    const start = Number.isFinite(page.offset) ? Number(page.offset) : offset;
    const returned = Number.isFinite(page.returned_blocks)
      ? Number(page.returned_blocks)
      : 0;
    const hasMore = Boolean(page.has_more);
    const nextOffset = Number.isFinite(page.next_offset)
      ? Number(page.next_offset)
      : start + Math.max(returned, 1);
    return {
      title: String(data.title || ""),
      content: data.content,
      truncated: Boolean(data.truncated),
      hasMore,
      nextOffset,
    };
  }

  /** 单页笔记列表（含 meta.has_more / next_token） */
  async listNotesPage(opts: {
    page?: number;
    pageSize?: number;
    limit?: number;
  }): Promise<{ notes: NoteSummary[]; hasMore: boolean; nextToken?: string }> {
    const args: Record<string, unknown> = {};
    if (opts.page !== undefined) args.page = opts.page;
    if (opts.pageSize !== undefined) args.page_size = opts.pageSize;
    if (opts.limit !== undefined) args.limit = opts.limit;
    const res = (await this.callTool("list_notes", args)) as {
      notes?: unknown[];
      items?: unknown[];
      meta?: { has_more?: boolean; next_token?: string };
    };
    const list = res.notes || res.items || [];
    return {
      notes: Array.isArray(list) ? (list as NoteSummary[]) : [],
      hasMore: Boolean(res.meta?.has_more),
      nextToken: res.meta?.next_token,
    };
  }

  /**
   * 列出全部正常状态的笔记（不含回收站），自动翻页。
   * 单次 limit 可能被服务端截断（meta.has_more/truncated），
   * 只拉一页会把未返回的笔记误判为「已删」→ 清映射后重复建笔记。
   */
  async listNotes(limit = 1000): Promise<NoteSummary[]> {
    const pageSize = Math.min(Math.max(limit, 20), 200);
    const out: NoteSummary[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 200; page++) {
      const r = await this.listNotesPage({ page, pageSize });
      let added = 0;
      for (const n of r.notes) {
        const id = String(n.note_id || "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        out.push(n);
        added++;
      }
      // 服务端不再返回新条目（分页参数被忽略）或已到末页
      if (!r.hasMore || added === 0) break;
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 全量笔记 update_time 索引（noteId → update_time），一次列表请求取得。
   * 轮询检测用：避免逐篇 get_note_info 的 N 次请求。
   */
  async getNoteUpdateTimes(): Promise<Map<string, number>> {
    const notes = await this.listNotes(1000);
    const map = new Map<string, number>();
    for (const n of notes) {
      const id = String(n.note_id || "");
      const t = Number(n.update_time);
      if (id && Number.isFinite(t)) map.set(id, t);
    }
    return map;
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

  /**
   * 读取图片块的实际图片内容（base64 data URI）。
   * 回流时用于把 WPS 笔记本体图片搬回 Zotero（<img> 是只读标签，
   * read_note 只给 fileID，拿不到可直接写入的 src）。
   */
  async readImage(
    noteId: string,
    blockId: string,
  ): Promise<{ dataUrl?: string; mimeType?: string }> {
    const res = (await this.callTool("read_image", {
      note_id: noteId,
      block_id: blockId,
    })) as {
      data?: string;
      base64?: string;
      mime_type?: string;
      mimeType?: string;
      __mcpContent?: { type?: string; mimeType?: string; data?: string }[];
    };

    // 优先取 MCP 原生 image content 项（实测该工具的 base64 在这里）
    const imageItem = Array.isArray(res.__mcpContent)
      ? res.__mcpContent.find(
          (c) => c?.type === "image" && typeof c.data === "string" && c.data,
        )
      : undefined;
    const mime =
      imageItem?.mimeType || res.mime_type || res.mimeType || "image/png";
    const raw = imageItem?.data || res.data || res.base64;
    if (!raw) return {};
    return {
      dataUrl: raw.startsWith("data:") ? raw : `data:${mime};base64,${raw}`,
      mimeType: mime,
    };
  }

  /** 触发笔记与云端同步（写入后确保本地编辑已落盘到远端） */
  async syncNote(noteId: string): Promise<void> {
    await this.callTool("sync_note", { note_id: noteId });
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

/**
 * 从 readNote 返回的带 id XML 中定位 marker 所在的顶层块 id。
 * 短语往前收集所有开标签 id，倒序取第一个出现在顶层块集合中的
 * （短语若被内联标签包裹，内联 id 不在顶层集合会被跳过）。
 * 找不到返回 undefined。
 */
export function findMarkerBlockId(
  xml: string,
  phrase: string,
  topLevelIds: Set<string>,
): string | undefined {
  const idx = xml.indexOf(phrase);
  if (idx < 0) return undefined;
  const before = xml.slice(0, idx);
  const ids = Array.from(
    before.matchAll(/<([a-zA-Z][\w]*)\b[^>]*\bid="([^"]+)"/g),
    (m) => m[2],
  );
  for (let i = ids.length - 1; i >= 0; i--) {
    if (topLevelIds.has(ids[i])) return ids[i];
  }
  return undefined;
}
