/**
 * Craft Space API REST 官方客户端（Bearer 认证，直连 connect.craft.do）。
 * 限流：空间级 100 请求 / 60s；429 指数退避重试（≤3 次），
 * 并在 X-RateLimit-Remaining 低于 20 时主动 pacing。
 */

export class CraftError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CraftError";
  }
}

export interface CraftClientOptions {
  /** API link 基址，如 https://connect.craft.do/links/{linkId}/api/v1 */
  link: string;
  /** Bearer token */
  token: string;
  timeoutMs?: number;
}

export interface CraftBlock {
  id: string;
  type?: string;
  textStyle?: string;
  markdown?: string;
  content?: CraftBlock[];
  /** fetchMetadata=true 时根块携带的文档元数据（真实 API 放在 metadata 子对象） */
  metadata?: {
    lastModifiedAt?: string;
    createdAt?: string;
    clickableLink?: string;
  };
  /** 兼容早期认知的顶层字段（真实 API 不返回，保留以防旧缓存） */
  lastModifiedAt?: string;
}

/** 提取根块 lastModifiedAt：真实 API 在 metadata 子对象，顶层字段作兼容回退 */
export function extractLastModified(block: CraftBlock): string | undefined {
  return block.metadata?.lastModifiedAt ?? block.lastModifiedAt;
}

/** POST /blocks 单请求体上限保护：超过会 413 PAYLOAD_TOO_LARGE（真机实测 95KB 级笔记触发） */
const INSERT_CHUNK_BYTES = 48 * 1024;

/**
 * 把长 Markdown 按安全边界切成 ≤limit 字节的多段：
 * 只在围栏（```）外的空行处切，避免切断代码块/表格内部；
 * 无安全切点的超长段整段保留（宁可单块偏大也不破坏内容）。
 */
export function splitMarkdownForInsert(md: string, limit: number): string[] {
  const size = (s: string) => new Blob([s]).size;
  if (size(md) <= limit) return [md];
  const cuts: number[] = [];
  let inFence = false;
  let idx = 0;
  for (const line of md.split("\n")) {
    const end = idx + line.length + 1;
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence && line.trim() === "") cuts.push(end);
    idx = end;
  }
  const chunks: string[] = [];
  let start = 0;
  let ci = 0;
  while (start < md.length) {
    let cut = -1;
    while (ci < cuts.length && cuts[ci] <= start) ci++;
    for (let j = ci; j < cuts.length; j++) {
      if (size(md.slice(start, cuts[j])) <= limit) {
        cut = cuts[j];
        ci = j + 1;
      } else break;
    }
    if (cut < 0) cut = md.length;
    chunks.push(md.slice(start, cut));
    start = cut;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

export interface CraftDocument {
  id: string;
  title?: string;
  rootBlockId?: string;
  clickableLink?: string;
  lastModifiedAt?: string;
}

export interface CraftSpaceInfo {
  id: string;
  name?: string;
}

export interface CraftFolder {
  id: string;
  name?: string;
  documentCount?: number;
  folders?: CraftFolder[];
}

export class CraftClient {
  private readonly base: string;
  private spaceId: string | undefined;
  private inflight: Map<string, Promise<unknown>> = new Map();

  constructor(private readonly opts: CraftClientOptions) {
    this.base = String(opts.link || "")
      .trim()
      .replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    if (!this.base) {
      throw new CraftError("Craft API link 未配置", 0, "NO_LINK");
    }
    if (!this.opts.token) {
      throw new CraftError("Craft token 未配置", 0, "NO_TOKEN");
    }
    let url = `${this.base}${path}`;
    if (query) {
      const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
        )
        .join("&");
      if (qs) url += `?${qs}`;
    }
    // Zotero 插件沙箱没有全局 AbortController（WPS 路径走 Zotero.HTTP 故未暴露），
    // 用 Promise.race 实现超时，不依赖 signal
    const timeoutMs = this.opts.timeoutMs ?? 20000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CraftError(`Craft 请求超时 (${timeoutMs}ms)`, 0, "TIMEOUT"),
          ),
        timeoutMs,
      );
    });
    let res: Response;
    try {
      res = await Promise.race([
        fetch(url, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        timeout,
      ]);
    } catch (e) {
      // 网络失败/超时：幂等方法（GET/PUT/DELETE）重试一次；
      // POST 不重试——insert 重试会重复插入、create 重试会重复建文档
      const isTimeout = e instanceof CraftError && e.code === "TIMEOUT";
      const transient = isTimeout || !(e instanceof CraftError);
      if (transient && method !== "POST" && attempt < 1) {
        ztoolkit.log(
          `Craft network error, retrying ${method} ${path} (attempt ${attempt + 1})`,
          e,
        );
        await new Promise((r) => setTimeout(r, 800));
        return this.request<T>(method, path, query, body, attempt + 1);
      }
      if (e instanceof CraftError) throw e;
      throw new CraftError(
        `Craft 网络请求失败: ${e instanceof Error ? e.message : String(e)}`,
        0,
        "NETWORK",
      );
    } finally {
      clearTimeout(timer);
    }

    // 429：尊重 Retry-After，否则指数退避 + 抖动（Craft 文档建议），最多重试 3 次
    if (res.status === 429 && attempt < 3) {
      const retryAfterSec = Number(res.headers.get("Retry-After") || "");
      const backoffMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec, 30) * 1000
          : Math.min(1000 * 2 ** attempt, 10000) +
            Math.floor(Math.random() * 500);
      ztoolkit.log(
        `Craft rate limited, backing off ${backoffMs}ms (attempt ${attempt + 1}/3)`,
        method,
        path,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      return this.request<T>(method, path, query, body, attempt + 1);
    }
    // 主动 pacing：空间级预算（100 req/60s，所有客户端共享）接近打满时暂缓，
    // 读 X-RateLimit-Remaining/Reset，避免撞墙后才被动退避。
    // 实测 X-RateLimit-Reset 是「距重置的秒数」（如 60），不是 epoch 时间戳；
    // 两者都兼容（>1e9 视为 epoch）。
    const remaining = Number(res.headers.get("X-RateLimit-Remaining"));
    if (Number.isFinite(remaining) && remaining >= 0 && remaining < 20) {
      const reset = Number(res.headers.get("X-RateLimit-Reset"));
      let waitMs = 5000;
      if (Number.isFinite(reset) && reset > 0) {
        waitMs = reset > 1e9 ? reset - Date.now() + 200 : reset * 1000 + 50;
      }
      waitMs = Math.max(0, Math.min(waitMs, 60000));
      if (waitMs > 0) {
        ztoolkit.log(
          `Craft rate limit low (${remaining} left), pacing ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    // 块预算 pacing：空间级 20000 blocks/60s（含读写），大文档批量同步时
    // 接近上限先暂缓，避免被 429 打断整批。头缺失（新窗口首次读）时跳过。
    const blockRemaining = Number(res.headers.get("X-BlockBudget-Remaining"));
    if (
      Number.isFinite(blockRemaining) &&
      blockRemaining >= 0 &&
      blockRemaining < 500
    ) {
      const blockReset = Number(res.headers.get("X-BlockBudget-Reset"));
      const waitMs =
        Number.isFinite(blockReset) && blockReset > 0
          ? Math.max(0, Math.min(blockReset * 1000 + 50, 60000))
          : 3000;
      ztoolkit.log(
        `Craft block budget low (${blockRemaining} left), pacing ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!res.ok) {
      let detail = "";
      try {
        const text = await res.text();
        try {
          const j = JSON.parse(text) as { error?: string; code?: string };
          detail = j.code || j.error || text.slice(0, 200);
        } catch {
          detail = text.slice(0, 200);
        }
      } catch {
        /* ignore */
      }
      throw new CraftError(
        `Craft API ${method} ${path} 失败 (${res.status}): ${detail}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** 同 URL 并发去重（批量同步时避免重复请求） */
  private dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async connection(): Promise<{ space: CraftSpaceInfo }> {
    const data = await this.dedupe("GET /connection", () =>
      this.request<{ space: CraftSpaceInfo }>("GET", "/connection"),
    );
    if (data?.space?.id) this.spaceId = data.space.id;
    return data;
  }

  async getSpaceId(): Promise<string> {
    if (this.spaceId) return this.spaceId;
    const data = await this.connection();
    return data.space.id;
  }

  async listDocuments(opts?: {
    location?: string;
    folderId?: string;
    fetchMetadata?: boolean;
    createdDateGte?: string;
    createdDateLte?: string;
    lastModifiedDateGte?: string;
    lastModifiedDateLte?: string;
    dailyNoteDateGte?: string;
    dailyNoteDateLte?: string;
  }): Promise<{ items: CraftDocument[] }> {
    return this.request("GET", "/documents", {
      location: opts?.location,
      folderId: opts?.folderId,
      fetchMetadata: opts?.fetchMetadata ? "true" : undefined,
      createdDateGte: opts?.createdDateGte,
      createdDateLte: opts?.createdDateLte,
      lastModifiedDateGte: opts?.lastModifiedDateGte,
      lastModifiedDateLte: opts?.lastModifiedDateLte,
      dailyNoteDateGte: opts?.dailyNoteDateGte,
      dailyNoteDateLte: opts?.dailyNoteDateLte,
    });
  }

  /**
   * 移动文档到文件夹/未整理（也可用于从回收站还原）。
   * 文档要求 destination 为对象：`{folderId}` 或 `{destination: "unsorted"|"templates"}`，
   * 直接传 folderId 字符串会 400。
   */
  async moveDocuments(
    documentIds: string[],
    destination: { folderId?: string; destination?: string },
  ): Promise<{ items: { id: string }[] }> {
    if (!documentIds.length) return { items: [] };
    return this.request("PUT", "/documents/move", undefined, {
      documentIds,
      destination,
    });
  }

  async createDocuments(
    titles: string[],
    folderId?: string,
  ): Promise<{ items: CraftDocument[] }> {
    const body: Record<string, unknown> = {
      documents: titles.map((t) => ({ title: t })),
    };
    if (folderId) body.destination = { folderId };
    return this.request("POST", "/documents", undefined, body);
  }

  /** 全空间文件夹树（含内嵌子文件夹） */
  async listFolders(): Promise<{ items: CraftFolder[] }> {
    return this.request("GET", "/folders");
  }

  /** 批量创建文件夹（根级或嵌套于 parentFolderId） */
  async createFolders(
    specs: { name: string; parentFolderId?: string }[],
  ): Promise<{ items: { id: string; name?: string }[] }> {
    return this.request("POST", "/folders", undefined, { folders: specs });
  }

  async fetchBlocks(
    docId: string,
    opts?: { maxDepth?: number; fetchMetadata?: boolean },
  ): Promise<CraftBlock> {
    return this.request("GET", "/blocks", {
      id: docId,
      maxDepth: opts?.maxDepth,
      fetchMetadata: opts?.fetchMetadata ? "true" : undefined,
    });
  }

  async insertBlocks(
    pageId: string,
    markdown: string,
  ): Promise<{ items: CraftBlock[] }> {
    // 大文档单请求会 413：按安全边界分块、顺序 append（单块时行为与原先一致）
    const chunks = splitMarkdownForInsert(markdown, INSERT_CHUNK_BYTES);
    const items: CraftBlock[] = [];
    for (const chunk of chunks) {
      const r: { items: CraftBlock[] } = await this.request(
        "POST",
        "/blocks",
        undefined,
        {
          blocks: [{ type: "text", markdown: chunk }],
          position: { position: "end", pageId },
        },
      );
      if (r.items) items.push(...r.items);
    }
    return { items };
  }

  async deleteBlocks(ids: string[]): Promise<{ items: string[] }> {
    if (!ids.length) return { items: [] };
    // Craft API 字段名为 blockIds（传 ids 会 400 VALIDATION_ERROR）
    return this.request("DELETE", "/blocks", undefined, { blockIds: ids });
  }

  async updateBlocks(
    blocks: Array<{ id: string; markdown: string }>,
  ): Promise<{ items: CraftBlock[] }> {
    return this.request("PUT", "/blocks", undefined, { blocks });
  }

  async searchDocuments(
    include: string,
    opts?: {
      fetchBlocks?: boolean;
      documentIds?: string[];
      lastModifiedDateGte?: string;
    },
  ): Promise<{ items: CraftDocument[] }> {
    return this.request("GET", "/documents/search", {
      include,
      fetchBlocks: opts?.fetchBlocks ? "true" : undefined,
      documentIds: opts?.documentIds?.length
        ? opts.documentIds.join(",")
        : undefined,
      lastModifiedDateGte: opts?.lastModifiedDateGte,
    });
  }

  /** 文档内搜索（RE2 正则），返回匹配块及前后上下文 */
  async searchInDocument(
    blockId: string,
    pattern: string,
    opts?: {
      caseSensitive?: boolean;
      beforeBlockCount?: number;
      afterBlockCount?: number;
      fetchBlocks?: boolean;
    },
  ): Promise<{
    items: {
      blockId: string;
      markdown?: string;
      beforeBlocks?: { blockId: string; markdown?: string }[];
      afterBlocks?: { blockId: string; markdown?: string }[];
    }[];
  }> {
    return this.request("GET", "/blocks/search", {
      blockId,
      pattern,
      caseSensitive: opts?.caseSensitive ? "true" : undefined,
      beforeBlockCount: opts?.beforeBlockCount,
      afterBlockCount: opts?.afterBlockCount,
      fetchBlocks: opts?.fetchBlocks ? "true" : undefined,
    });
  }

  /** 构造 web 编辑器链接（回链用） */
  async webUrl(docId: string): Promise<string> {
    const spaceId = await this.getSpaceId();
    return `https://docs.craft.do/editor/d/${spaceId}/${docId}`;
  }
}

let sharedClient: CraftClient | null = null;
let sharedKey = "";

/** 按当前 prefs 构造共享客户端（配置变化时自动重建） */
export function getCraftClient(link: string, token: string): CraftClient {
  const key = `${link}\n${token}`;
  if (!sharedClient || sharedKey !== key) {
    sharedClient = new CraftClient({ link, token });
    sharedKey = key;
  }
  return sharedClient;
}
