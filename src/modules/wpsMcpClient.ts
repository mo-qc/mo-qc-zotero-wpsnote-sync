/**
 * WPS 笔记 MCP HTTP 客户端。
 * 通过 JSON-RPC 2.0 与 https://ainote.kdocs.cn/mcp-svc/mcp 通信。
 */

export interface McpToolResult {
  // WPS 笔记 MCP 的工具直接返回业务 JSON，不统一包装 ok/code
  [key: string]: any;
}

export interface McpClientOptions {
  endpoint: string;
  apiKey: string;
  timeout?: number;
  retries?: number;
}

function parseMcpSseResponse(text: string, expectedId?: number | null): any {
  // 简单 SSE 解析：按 event/message 块拆分，取 data: 行
  const events: any[] = [];
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
  return events.find((e) => "result" in e || "error" in e) || events[0] || {};
}

export class WpsMcpClient {
  private endpoint: string;
  private apiKey: string;
  private timeout: number;
  private requestId = 0;
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;
  private tools: string[] = [];
  private retries: number;

  constructor(options: McpClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || 60000;
    this.retries = options.retries ?? 2;
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
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
      timeout: this.timeout,
      successCodes: false, // 允许我们自行处理状态码
    });

    const text = xhr.responseText || "";
    ztoolkit.log("MCP response", xhr.status, text.slice(0, 800));

    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(`MCP HTTP ${xhr.status}: ${text.slice(0, 200)}`);
    }

    // WPS 笔记 MCP 使用 SSE 流返回，解析 data: 行
    const parsed = parseMcpSseResponse(text, id);
    if (parsed.error) {
      throw new Error(
        `MCP error ${parsed.error.code}: ${parsed.error.message}`,
      );
    }

    return parsed.result;
  }

  private async post(
    method: string,
    params?: any,
    id?: number | null,
  ): Promise<any> {
    const maxRetries = this.retries;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.doRequest(method, params, id);
      } catch (err: any) {
        lastError = err;
        const isNetworkError = !err?.message?.includes("MCP error");
        if (!isNetworkError || attempt === maxRetries) {
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
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
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
        const result = await this.post(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: true },
            },
            clientInfo: {
              name: "zotero-wpsnote-sync",
              version: addon.data.config.version || "0.1.0",
            },
          },
          this.nextId(),
        );

        ztoolkit.log("MCP initialized", result);

        // 发送 initialized 通知（无 id），notification 不应期待响应
        await this.sendNotification("notifications/initialized", undefined);

        // 拉取工具列表
        const toolsResult = await this.post(
          "tools/list",
          undefined,
          this.nextId(),
        );
        this.tools = (toolsResult?.tools || []).map(
          (t: any) => t.name as string,
        );
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

  async callTool(
    name: string,
    args: Record<string, any>,
  ): Promise<McpToolResult> {
    await this.initialize();

    const result = await this.post(
      "tools/call",
      { name, arguments: args },
      this.nextId(),
    );

    // WPS 笔记 MCP 返回的 result 中，业务数据在 content[].text 的 JSON 里，
    // 新版同时提供 structuredContent；优先取 structuredContent，再解析 text。
    if (result && typeof result === "object") {
      if (
        result.structuredContent &&
        typeof result.structuredContent === "object"
      ) {
        return result.structuredContent as McpToolResult;
      }
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === "text" && typeof item.text === "string") {
            try {
              return JSON.parse(item.text) as McpToolResult;
            } catch {
              return { text: item.text } as McpToolResult;
            }
          }
        }
      }
    }

    return (result as McpToolResult) || {};
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

  async getNoteOutline(noteId: string): Promise<any> {
    return this.callTool("get_note_outline", { note_id: noteId });
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
    outline?: any,
  ): Promise<McpToolResult> {
    if (!outline) {
      outline = await this.getNoteOutline(noteId);
    }
    const blocks = outline?.blocks || [];
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
    const blockIdsToDelete = blocks.slice(1).map((b: any) => b.id);
    if (blockIdsToDelete.length > 0) {
      operations.push({ op: "delete", block_ids: blockIdsToDelete });
    }
    operations.push({ op: "replace", block_id: blocks[0].id, content });

    return this.batchEdit(noteId, operations);
  }

  async addNoteTags(
    noteId: string,
    tagNames: string[],
  ): Promise<McpToolResult> {
    return this.callTool("add_note_tags", {
      note_id: noteId,
      tag_names: tagNames,
    });
  }

  async searchNotes(keyword: string, limit = 10): Promise<any[]> {
    const res = await this.callTool("search_notes", { keyword, limit });
    return res.items || res.data?.items || res.data || [];
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
    return {
      block_id: res.block_id || res.last_block_id,
      width: res.width,
      height: res.height,
    };
  }
}
