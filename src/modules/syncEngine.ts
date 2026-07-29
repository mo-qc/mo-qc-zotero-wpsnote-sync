/**
 * Zotero → WPS 笔记同步引擎。
 */

import { WpsMcpClient, McpInterfaceType, NoteOutline } from "./wpsMcpClient";
import {
  getSelectedItems,
  getSelectedCollectionItems,
  extractItemData,
  getAttachmentDataUrl,
  getItemModifiedTime,
  ExtractOptions,
} from "./zoteroItem";
import {
  buildNoteTitle,
  buildNoteXml,
  ZoteroNote,
  ZoteroNoteImage,
} from "../utils/xmlBuilder";
import { getPref, getMcpConfig } from "../utils/prefs";
import {
  getMappedEntry,
  recordSyncResult,
  removeMappedNote,
  SyncMappingEntry,
} from "./syncMapping";
import { runWithConcurrency } from "../utils/concurrencyHelper";

export type ConflictResolution = "overwrite" | "skip" | "create-copy";

export interface SyncOptions {
  interfaceType?: McpInterfaceType;
  endpoint?: string;
  apiKey?: string;
  addTags?: string[];
  updateExisting?: boolean;
  incrementalSync?: boolean;
  promptOnConflict?: boolean;
  titleTemplate?: string;
  bodyTemplate?: string;
  include?: ExtractOptions;
  concurrency?: number;
  onProgress?: (current: number, total: number, title: string) => void;
  onConflict?: (
    item: Zotero.Item,
    title: string,
    mapping: SyncMappingEntry,
  ) => Promise<ConflictResolution>;
  signal?: AbortSignal;
}

function getDefaultExtractOptions(): ExtractOptions {
  const read = (key: keyof ExtractOptions) => {
    // prefs.js 中存储的键带 sync 前缀
    const prefKey = `sync${key.charAt(0).toUpperCase()}${key.slice(1)}` as any;
    const val = getPref(prefKey);
    // 首次安装时偏好不存在，默认全部开启
    return val === undefined ? true : Boolean(val);
  };
  return {
    includeAbstract: read("includeAbstract"),
    includeAttachments: read("includeAttachments"),
    includeAnnotations: read("includeAnnotations"),
    includeTags: read("includeTags"),
    includeNotes: read("includeNotes"),
  };
}

export type SyncErrorType = "network" | "mcp" | "image" | "other";

export interface SyncResult {
  success: boolean;
  itemKey: string;
  title: string;
  noteId?: string;
  noteUrl?: string;
  error?: string;
  errorType?: SyncErrorType;
  errorCode?: number | string;
}

function collectSyncImages(notes: ZoteroNote[]) {
  return notes.flatMap((note) => note.images);
}

async function resolveImageSrc(
  img: ZoteroNoteImage,
): Promise<string | undefined> {
  if (img.dataUrl) return img.dataUrl;
  const src = img.src;
  if (!src && !img.attachmentKey) return undefined;
  if (src && (/^https?:\/\//i.test(src) || src.startsWith("data:"))) {
    return src;
  }
  if (img.attachmentKey) {
    const dataUrl = getAttachmentDataUrl(img.attachmentKey);
    if (dataUrl) return dataUrl;
  }
  return undefined;
}

function isValidWpsTag(tag: string): boolean {
  if (!tag || !tag.trim()) return false;
  // WPS 标签不能包含这些字符或 emoji
  if (/[\\:*?"<>|]/g.test(tag)) return false;
  // 简单 emoji 范围过滤（常见 BMP + 补充面 emoji）
  if (/[\u{1F300}-\u{1F9FF}]/u.test(tag)) return false;
  return true;
}

function sanitizeWpsTag(tag: string): string {
  // 保留有效层级，每级截断至 20 字符，整体最多 10 级
  return tag
    .split("/")
    .map((level) => level.trim().slice(0, 20))
    .filter(Boolean)
    .slice(0, 10)
    .join("/");
}

async function syncNoteImages(
  client: WpsMcpClient,
  noteId: string,
  anchorId: string,
  notes: ZoteroNote[],
) {
  const noteImages = collectSyncImages(notes);
  if (!noteImages.length) return;

  const resolvedImages = (
    await Promise.all(
      noteImages.map(async (img) => {
        const src = await resolveImageSrc(img);
        return src ? { src, alt: img.alt || "Image" } : null;
      }),
    )
  ).filter(Boolean) as { src: string; alt: string }[];

  if (!resolvedImages.length) return;

  try {
    // 先插入一个标题块，作为图片分组的锚点
    const headingRes = await client.editBlock(noteId, "insert", {
      anchor_id: anchorId,
      position: "after",
      content: "<h2>图片</h2>",
    });
    const imageAnchorId =
      (headingRes as any).last_block_id ||
      (headingRes as any).block_id ||
      anchorId;

    // 受控并发插入图片，避免一次性请求过多导致 WPS 服务端限流。
    await runWithConcurrency(
      resolvedImages,
      async (img) => {
        try {
          await client.insertImage(noteId, imageAnchorId, img.src, img.alt);
        } catch (e: any) {
          ztoolkit.log(
            "Sync single image failed",
            img.src.slice(0, 120),
            e?.message || String(e),
          );
        }
      },
      { concurrency: 3 },
    );
  } catch (e: any) {
    ztoolkit.log("Sync note images failed", e?.message || String(e));
  }
}

function getClient(options?: SyncOptions): WpsMcpClient {
  const config = getMcpConfig();

  const interfaceType = options?.interfaceType || config.interfaceType;
  const endpoint = options?.endpoint || config.endpoint;
  const apiKey = options?.apiKey || config.apiKey;

  if (!apiKey) {
    const label = interfaceType === "local" ? "本地 MCP Token" : "云端 API Key";
    throw new Error(`未配置 WPS 笔记 ${label}，请在插件首选项中设置。`);
  }

  return new WpsMcpClient({ interfaceType, endpoint, apiKey });
}

function isMappingInvalidError(err: any): boolean {
  const msg = String(err?.message || "").toLowerCase();
  const patterns = [
    "note not found",
    "笔记不存在",
    "note 不存在",
    "invalid note_id",
    "note_id 无效",
    "已删除",
    "deleted",
  ];
  return patterns.some((p) => msg.includes(p));
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("同步已取消");
  }
}

function classifyError(err: any): SyncErrorType {
  const code = (err as any)?.code;
  const msg = String(err?.message || "").toLowerCase();

  // 优先根据结构化错误码判断
  if (code !== undefined) {
    if (
      code === 401 ||
      code === 403 ||
      code === "UNAUTHORIZED" ||
      code === "AUTH_ERROR" ||
      code === "INVALID_API_KEY"
    ) {
      return "mcp";
    }
    if (
      code === 429 ||
      code === 500 ||
      code === 502 ||
      code === 503 ||
      code === 504 ||
      code === "RATE_LIMIT" ||
      code === "TIMEOUT" ||
      code === "EMPTY_RESPONSE"
    ) {
      return "network";
    }
    if (
      code === "NOTE_NOT_FOUND" ||
      code === "INVALID_NOTE_ID" ||
      code === "BLOCK_NOT_FOUND" ||
      code === "INVALID_CONTENT" ||
      code === "TOOL_ERROR"
    ) {
      return "mcp";
    }
    if (code === "IMAGE_ERROR" || code === "INSERT_IMAGE_FAILED") {
      return "image";
    }
  }

  if (
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("abort") ||
    msg.includes("offline") ||
    msg.includes("connection") ||
    msg.includes("enet") ||
    msg.includes("econnrefused") ||
    msg.includes("无法连接") ||
    msg.includes("连接超时")
  ) {
    return "network";
  }
  if (
    msg.includes("mcp error") ||
    msg.includes("mcp tool error") ||
    msg.includes("mcp initialize") ||
    msg.includes("initialize http") ||
    msg.includes("未配置") ||
    msg.includes("未提供") ||
    msg.includes("未返回") ||
    msg.includes("api key") ||
    msg.includes("token") ||
    msg.includes("认证") ||
    msg.includes("鉴权") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid") ||
    msg.includes("expired") ||
    msg.includes("bad request")
  ) {
    return "mcp";
  }
  if (
    msg.includes("image") ||
    msg.includes("图片") ||
    msg.includes("insert_image")
  ) {
    return "image";
  }
  return "other";
}

export async function syncItem(
  item: Zotero.Item,
  options?: SyncOptions,
): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    itemKey: item.key,
    title: String(item.getField("title") || ""),
  };
  const itemModified = getItemModifiedTime(item);

  try {
    const titleTemplate =
      options?.titleTemplate || String(getPref("titleTemplate") || "");
    const bodyTemplate =
      options?.bodyTemplate || String(getPref("bodyTemplate") || "");

    const include = options?.include ?? getDefaultExtractOptions();
    const data = extractItemData(item, include);
    const title = buildNoteTitle(data, titleTemplate);
    const xml = buildNoteXml(data, bodyTemplate);

    result.title = data.title;

    checkCancelled(options?.signal);
    const client = getClient(options);
    let noteId: string | undefined;
    let noteUrl: string | undefined;
    let wasCreated = false;

    // 1. 优先使用本地映射表
    const updateExisting =
      options?.updateExisting ?? Boolean(getPref("updateExisting"));
    let mappedEntry = updateExisting ? getMappedEntry(item.key) : undefined;
    let mapped = mappedEntry
      ? { noteId: mappedEntry.noteId!, noteUrl: mappedEntry.noteUrl || "" }
      : undefined;

    // 增量同步：文献未变更且上次同步成功，则直接跳过
    const incrementalSync =
      options?.incrementalSync ?? Boolean(getPref("incrementalSync"));
    if (
      incrementalSync &&
      mappedEntry?.lastSuccess &&
      mappedEntry.itemModified &&
      mappedEntry.itemModified === itemModified
    ) {
      ztoolkit.log("Incremental sync: skip unchanged item", item.key);
      result.success = true;
      result.noteId = mappedEntry.noteId;
      result.noteUrl = mappedEntry.noteUrl;
      recordSyncResult(item.key, {
        success: true,
        title: data.title,
        noteId: mappedEntry.noteId,
        noteUrl: mappedEntry.noteUrl,
        itemModified,
      });
      return result;
    }

    // 冲突检测：映射存在且 Zotero 侧文献已修改
    const promptOnConflict =
      options?.promptOnConflict ?? Boolean(getPref("promptOnConflict"));
    if (
      mappedEntry?.lastSuccess &&
      mappedEntry.itemModified &&
      mappedEntry.itemModified !== itemModified
    ) {
      if (promptOnConflict && options?.onConflict) {
        const resolution = await options.onConflict(
          item,
          data.title,
          mappedEntry,
        );
        if (resolution === "skip") {
          result.success = true;
          result.noteId = mappedEntry.noteId;
          result.noteUrl = mappedEntry.noteUrl;
          recordSyncResult(item.key, {
            success: true,
            title: data.title,
            noteId: mappedEntry.noteId,
            noteUrl: mappedEntry.noteUrl,
            itemModified: mappedEntry.itemModified,
          });
          return result;
        }
        if (resolution === "create-copy") {
          noteId = undefined;
          noteUrl = undefined;
          mapped = undefined;
          mappedEntry = undefined;
        }
      }
    }

    if (mapped) {
      noteId = mapped.noteId;
      noteUrl = mapped.noteUrl;
    }

    // 2. 映射未命中时，按标题关键词搜索
    if (!noteId && updateExisting) {
      const existing = await client.searchNotes(`[Zotero] ${data.title}`, 5);
      const match = existing.find(
        (n) =>
          String((n as { title?: string }).title || "").includes(data.title) ||
          String((n as { title?: string }).title || "").includes(item.key),
      ) as { note_id?: string; title?: string } | undefined;
      if (match?.note_id) {
        noteId = match.note_id;
      }
    }

    // 3. 仍无匹配则新建笔记
    if (!noteId) {
      const created = await client.createNote(title);
      noteId = created.noteId;
      noteUrl = created.noteUrl;
      wasCreated = true;
    }

    // 获取笔记大纲；若本地映射失效（笔记被删除/不存在），自动重建
    let outline: NoteOutline;
    try {
      outline = await client.getNoteOutline(noteId);
    } catch (err: any) {
      if (mapped && isMappingInvalidError(err)) {
        ztoolkit.log("Mapped note invalid, recreating", item.key, noteId);
        removeMappedNote(item.key);
        const created = await client.createNote(title);
        noteId = created.noteId;
        noteUrl = created.noteUrl;
        wasCreated = true;
        outline = await client.getNoteOutline(noteId);
      } else {
        throw err;
      }
    }

    const firstBlockId = outline?.blocks?.[0]?.id;
    if (!firstBlockId) {
      throw new Error("无法获取笔记初始 block_id");
    }

    checkCancelled(options?.signal);

    // 写入/覆盖内容：
    // - 如果是新建笔记（只有 1 个初始 block），直接替换首段；
    // - 如果是更新已有笔记，先删除其余 block，再替换首段，避免内容叠加。
    if (wasCreated) {
      await client.editBlock(noteId, "replace", {
        block_id: firstBlockId,
        content: xml,
      });
    } else {
      await client.replaceNoteContent(noteId, xml, outline);
    }

    // 同步 Zotero 笔记中的图片（外网 URL、内嵌 data URL、本地附件转 base64）
    await syncNoteImages(client, noteId, firstBlockId, data.notes);

    // 同步标签（清理非法字符、emoji、超长层级）
    const tagsToAdd = [...data.tags, ...(options?.addTags || [])]
      .filter(isValidWpsTag)
      .map(sanitizeWpsTag)
      .filter(Boolean);
    if (tagsToAdd.length) {
      await client.addNoteTags(noteId, tagsToAdd);
    }

    // 保存/更新映射
    const finalUrl =
      noteUrl || `https://ainote.kdocs.cn/wps-notes-hub/note/${noteId}`;
    result.success = true;
    result.noteId = noteId;
    result.noteUrl = finalUrl;
  } catch (err: any) {
    result.error = err?.message || String(err);
    result.errorType = classifyError(err);
    result.errorCode = (err as any)?.code;
    ztoolkit.log(
      "Sync failed",
      item.key,
      result.errorType,
      result.errorCode,
      result.error,
    );
  }

  recordSyncResult(item.key, {
    success: result.success,
    title: result.title,
    noteId: result.noteId,
    noteUrl: result.noteUrl,
    itemModified,
    error: result.error,
    errorType: result.errorType,
    errorCode: result.errorCode,
  });

  return result;
}

const DEFAULT_SYNC_CONCURRENCY = 2;

export async function syncSelectedItems(
  options?: SyncOptions,
): Promise<SyncResult[]> {
  let items = getSelectedItems().filter(
    (item) => item.isRegularItem && item.isRegularItem(),
  );
  // 未选中条目时，尝试同步当前选中的集合/文件夹
  if (!items.length) {
    items = getSelectedCollectionItems();
  }
  if (!items.length) {
    throw new Error("请先在 Zotero 中选择至少一条文献条目或一个文件夹。");
  }

  const rawConcurrency =
    options?.concurrency ??
    Number(getPref("syncConcurrency") || DEFAULT_SYNC_CONCURRENCY);
  const concurrency =
    Number.isFinite(rawConcurrency) && rawConcurrency >= 1
      ? rawConcurrency
      : DEFAULT_SYNC_CONCURRENCY;

  return runWithConcurrency<Zotero.Item, SyncResult>(
    items,
    (item) => syncItem(item, options),
    {
      concurrency,
      signal: options?.signal,
      onAborted: () => ztoolkit.log("Sync cancelled by user"),
      onProgress: (completed, total, _result, _index, item) => {
        options?.onProgress?.(
          completed,
          total,
          String(item.getField("title") || ""),
        );
      },
    },
  );
}
