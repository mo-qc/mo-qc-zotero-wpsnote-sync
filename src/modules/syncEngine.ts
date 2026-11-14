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
import { getPref, getMcpConfig, getSyncTarget } from "../utils/prefs";
import { syncItemCraft } from "./craftSync";
import {
  getMappedEntry,
  getAllMappings,
  recordSyncResult,
  removeMappedNote,
  SyncMappingEntry,
} from "./syncMapping";
import { runWithConcurrency } from "../utils/concurrencyHelper";

export type ConflictResolution = "overwrite" | "skip" | "create-copy";

/** 冲突来源：item = Zotero 侧文献变更；wps = WPS 端笔记被手工修改；craft = Craft 端文档被手工修改 */
export type ConflictKind = "item" | "wps" | "craft";

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
    kind?: ConflictKind,
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
  noteModified?: string;
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

// 操作互斥锁：同步 / 回流 / 轮询检测共用一个槽位，
// 防止并发写同一篇笔记或轮询读到同步中途的基准造成误报。
let operationLock: string | null = null;

export function beginOperation(kind: string): boolean {
  if (operationLock) return false;
  operationLock = kind;
  return true;
}

export function endOperation(): void {
  operationLock = null;
}

export function currentOperation(): string | null {
  return operationLock;
}

export function getClient(options?: SyncOptions): WpsMcpClient {
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

export function isMappingInvalidError(err: any): boolean {
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

export interface WpsSearchCandidate {
  note_id?: string;
  title?: string;
}

/**
 * WPS 标题搜索兑底的候选选择器（纯函数，可单测）。
 *
 * 匹配优先级：
 *   1. 精确等于模板渲染后的完整标题（默认含「[Zotero] 」前缀）；
 *   2. 标题内含唯一 item key（模板变量 {{itemKey}}，全局唯一）；
 *   3. 宽松包含文献标题（旧笔记/自改标题场景，最易误报，放最后）。
 * 每一级都先过滤 isOwnedByOther：同名文献场景下，搜索兑底命中
 * 已映射给其他条目的笔记并接管，会让两篇共写一篇互相覆盖
 * （Craft 侧同型逻辑已早有此校验，见 craftSync 搜索兑底注释）。
 */
export function pickWpsSearchMatch(
  candidates: WpsSearchCandidate[],
  ref: { templateTitle: string; itemTitle: string; itemKey: string },
  isOwnedByOther: (noteId?: string) => boolean,
): WpsSearchCandidate | undefined {
  const norm = (s?: string) =>
    String(s || "")
      .trim()
      .toLowerCase();
  const tpl = norm(ref.templateTitle);
  const dataTitle = norm(ref.itemTitle);
  if (!tpl && !dataTitle) return undefined;

  const available = candidates.filter(
    (c) => c.note_id && !isOwnedByOther(c.note_id),
  );
  return (
    (tpl && available.find((c) => norm(c.title) === tpl)) ||
    available.find((c) => norm(c.title).includes(norm(ref.itemKey))) ||
    (dataTitle && available.find((c) => norm(c.title).includes(dataTitle))) ||
    undefined
  );
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("同步已取消");
  }
}

export function classifyError(err: any): SyncErrorType {
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
  // 同步目标二选一：Craft 走独立执行路径（模板/锁/触发机制共用）
  if (getSyncTarget() === "craft") {
    return syncItemCraft(item, options);
  }
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

    // 映射未命中时从条目 extra 字段恢复 noteId（冗余备份）。
    // 只恢复 mapped 不恢复 mappedEntry：无基准则增量/冲突/改动检测全部
    // 走完整同步，同步成功后由 recordSyncResult 重建基准。
    if (!mapped && updateExisting) {
      const extraNoteId = readNoteIdFromExtra(item);
      if (extraNoteId) {
        ztoolkit.log("Restore noteId from item extra", item.key, extraNoteId);
        mapped = { noteId: extraNoteId, noteUrl: "" };
      }
    }

    // 校验映射笔记在 WPS 端仍可见（排除回收站）：笔记被删除后
    // get_note_outline 仍可读到回收站内容，但 search_notes/list_notes
    // 不返回回收站——判定已删则清映射与 extra 冗余，走新建。
    // 可见集合走 30s 缓存，批量同步期间只拉一次列表。
    if (mapped && updateExisting) {
      const mappedNoteId = mapped.noteId;
      let visible = false;
      try {
        const visibleIds = await getVisibleNoteIds(client);
        visible = visibleIds.has(mappedNoteId);
        if (!visible) {
          // 列表可能分页不全，用标题搜索按 note_id 复核后再判定
          const candidates = await client.searchNotes(data.title, 10);
          visible = candidates.some(
            (n) =>
              String((n as { note_id?: string }).note_id || "") ===
              mappedNoteId,
          );
        }
      } catch (e) {
        // 校验失败保守沿用映射，避免误建重复笔记
        ztoolkit.log("Mapping visibility check failed (non-fatal)", e);
        visible = true;
      }
      if (!visible) {
        ztoolkit.log(
          "Mapped note trashed in WPS, clearing mapping",
          item.key,
          mappedNoteId,
        );
        removeMappedNote(item.key);
        await clearNoteIdFromExtra(item);
        mapped = undefined;
        mappedEntry = undefined;
      }
    }

    // 增量同步：文献未变更且上次同步成功，则直接跳过。
    // 要求 noteModified 基准存在（与 Craft 侧对称）：老映射基准缺失时跳过会让
    // 轮询永远无法检测该条（轮询 filter 要求基准），走一次完整同步补上基准后恢复
    const incrementalSync =
      options?.incrementalSync ?? Boolean(getPref("incrementalSync"));
    if (
      incrementalSync &&
      mappedEntry?.lastSuccess &&
      mappedEntry.itemModified &&
      mappedEntry.noteModified &&
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
      // 补写 extra 冗余（老条目可能缺失）
      await writeNoteIdToExtra(item, mappedEntry.noteId!);
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
          "item",
        );
        if (resolution === "skip") {
          result.success = true;
          result.noteId = mappedEntry.noteId;
          result.noteUrl = mappedEntry.noteUrl;
          // skip 后对齐 itemModified（已知晓条目变更并选择跳过），
          // 否则条目时间恒晚于基准，每次同步重复弹同一处冲突
          recordSyncResult(item.key, {
            success: true,
            title: data.title,
            noteId: mappedEntry.noteId,
            noteUrl: mappedEntry.noteUrl,
            itemModified,
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

    // WPS 端改动检测：上次同步后 WPS 笔记被手工修改（update_time 晚于记录的基准）
    if (mapped && mappedEntry?.lastSuccess && mappedEntry.noteModified) {
      try {
        const info = await client.getNoteInfo(mapped.noteId);
        const wpsModified = String(info.updateTime || "");
        if (
          wpsModified &&
          Number(wpsModified) > Number(mappedEntry.noteModified)
        ) {
          ztoolkit.log(
            "WPS-side modification detected",
            item.key,
            mappedEntry.noteModified,
            "->",
            wpsModified,
          );
          if (promptOnConflict && options?.onConflict) {
            const resolution = await options.onConflict(
              item,
              data.title,
              mappedEntry,
              "wps",
            );
            if (resolution === "skip") {
              result.success = true;
              result.noteId = mappedEntry.noteId;
              result.noteUrl = mappedEntry.noteUrl;
              // skip 后对齐 noteModified 到 WPS 端现状：不更新会让
              // update_time 恒晚于基准，每次同步重复弹同一处冲突
              recordSyncResult(item.key, {
                success: true,
                title: data.title,
                noteId: mappedEntry.noteId,
                noteUrl: mappedEntry.noteUrl,
                itemModified,
                noteModified: wpsModified,
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
          // overwrite（或未开启冲突提示）→ 覆盖 WPS 端继续
        }
      } catch (e) {
        // 检测失败不阻断同步
        ztoolkit.log("WPS-side modification check failed (non-fatal)", e);
      }
    }

    if (mapped) {
      noteId = mapped.noteId;
      noteUrl = mapped.noteUrl;
    }

    // 2. 映射未命中时，按标题关键词搜索（用文献标题本身做锚点，
    //    与标题模板前缀无关，避免用户改模板后兜底失效重复建笔记）
    if (!noteId && updateExisting) {
      const existing = (await client.searchNotes(
        data.title,
        10,
      )) as WpsSearchCandidate[];
      const mappings = getAllMappings();
      const isOwnedByOther = (id?: string) =>
        !id
          ? false
          : Object.entries(mappings).some(
              ([k, e]) => k !== item.key && e.noteId === id,
            );
      const match = pickWpsSearchMatch(
        existing,
        {
          templateTitle: title,
          itemTitle: data.title,
          itemKey: item.key,
        },
        isOwnedByOther,
      );
      if (match) {
        ztoolkit.log("WPS search fallback hit", item.key, match.note_id);
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
      // 标签失败不阻断：正文已写入，降级为警告，保证映射正常保存
      try {
        await client.addNoteTags(noteId, tagsToAdd);
      } catch (e) {
        ztoolkit.log("Add note tags failed (non-fatal)", e);
      }
    }

    // 保存/更新映射
    const finalUrl =
      noteUrl || `https://ainote.kdocs.cn/wps-notes-hub/note/${noteId}`;
    result.success = true;
    result.noteId = noteId;
    result.noteUrl = finalUrl;

    // 记录写入后的 WPS 端 update_time 作为下次改动检测基准（失败不阻断）
    try {
      const info = await client.getNoteInfo(noteId);
      if (info.updateTime) {
        result.noteModified = String(info.updateTime);
      }
    } catch (e) {
      ztoolkit.log("Record noteModified failed (non-fatal)", e);
    }

    // 冗余写入 noteId 到条目 extra（幂等，失败不阻断）
    await writeNoteIdToExtra(item, noteId);
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
    noteModified: result.noteModified,
    error: result.error,
    errorType: result.errorType,
    errorCode: result.errorCode,
  });

  return result;
}

const EXTRA_NOTE_ID_KEY = "ZWS-Note-Id";

/**
 * 插件自身保存条目（写 extra 冗余）的时间戳记录。
 * saveTx 会触发 Notifier modify → 自动同步再排一轮全量同步，
 * 内容没变但白写一遍远端（双倍请求/限流压力）。hooks.onNotify
 * 在排程前用 isSelfSave 过滤掉这类自我触发；窗口期后自然失效，
 * 真实用户编辑不受影响（后续 modify 或手动同步仍会推送）。
 */
const SELF_SAVE_WINDOW_MS = 10_000;
const recentSelfSaves = new Map<string, number>();

export function markSelfSave(itemKey: string): void {
  recentSelfSaves.set(itemKey, Date.now());
  // 防无界增长：超限时淘汰最早条目（Map 保插入序）。
  // 用迭代器 done 判断空表——键可能是 undefined（调用方传入无 key 的
  // mock 条目时），按 value!==undefined 判断会把"最旧键是 undefined"
  // 误判为空表，导致淘汰永久卡死、集合无界增长
  if (recentSelfSaves.size > 1000) {
    const oldest = recentSelfSaves.keys().next();
    if (!oldest.done) recentSelfSaves.delete(oldest.value);
  }
}

export function isSelfSave(itemKey: string): boolean {
  const ts = recentSelfSaves.get(itemKey);
  if (ts === undefined) return false;
  if (Date.now() - ts > SELF_SAVE_WINDOW_MS) {
    recentSelfSaves.delete(itemKey);
    return false;
  }
  return true;
}

/** 从条目 extra 字段读取冗余备份的 WPS noteId */
export function readNoteIdFromExtra(item: Zotero.Item): string | undefined {
  const extra = (item.getField("extra") as string) || "";
  for (const line of extra.split(/\r?\n/)) {
    const m = line.match(/^\s*ZWS-Note-Id\s*:\s*(\S+)\s*$/i);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * 把 noteId 冗余写入条目 extra 字段（映射丢失时可从条目自身恢复）。
 * 幂等：值未变化不保存，避免触发条目修改→自动同步循环；失败不阻断。
 */
export async function writeNoteIdToExtra(
  item: Zotero.Item,
  noteId: string,
): Promise<void> {
  try {
    const base = ((item.getField("extra") as string) || "").replace(/\s+$/, "");
    const lines = base
      ? base.split(/\r?\n/).filter((l) => !/^\s*ZWS-Note-Id\s*:/i.test(l))
      : [];
    const next = [...lines, `${EXTRA_NOTE_ID_KEY}: ${noteId}`].join("\n");
    if (next === base) return;
    item.setField("extra", next);
    // saveTx 触发的 modify 属于自我修改：标记后由 hooks.onNotify 过滤，
    // 避免自动同步再排一轮全量同步
    markSelfSave(item.key);
    await item.saveTx();
    ztoolkit.log("Wrote noteId to item extra", item.key, noteId);
  } catch (e) {
    ztoolkit.log("Write noteId to extra failed (non-fatal)", e);
  }
}

// 正常笔记可见集合缓存（回收站校验用）：批量同步期间共享，
// 避免每篇同步都拉一次 list_notes。
let visibleNotesCache: { ids: Set<string>; ts: number } | null = null;
const VISIBLE_CACHE_TTL = 30_000;

export async function getVisibleNoteIds(
  client: ReturnType<typeof getClient>,
): Promise<Set<string>> {
  if (
    visibleNotesCache &&
    Date.now() - visibleNotesCache.ts < VISIBLE_CACHE_TTL
  ) {
    return visibleNotesCache.ids;
  }
  const all = await client.listNotes(1000);
  const ids = new Set(all.map((n) => String(n.note_id || "")).filter(Boolean));
  visibleNotesCache = { ids, ts: Date.now() };
  return ids;
}

/**
 * 清除条目 extra 中的 noteId 冗余行（映射笔记在 WPS 端被删除时调用，
 * 避免下次同步从 extra 恢复到已进回收站的 noteId）。失败不阻断。
 */
export async function clearNoteIdFromExtra(item: Zotero.Item): Promise<void> {
  try {
    const base = ((item.getField("extra") as string) || "").replace(/\s+$/, "");
    const lines = base
      ? base.split(/\r?\n/).filter((l) => !/^\s*ZWS-Note-Id\s*:/i.test(l))
      : [];
    const next = lines.join("\n");
    if (next === base) return;
    item.setField("extra", next);
    markSelfSave(item.key);
    await item.saveTx();
    ztoolkit.log("Cleared noteId from item extra", item.key);
  } catch (e) {
    ztoolkit.log("Clear noteId from extra failed (non-fatal)", e);
  }
}

const DEFAULT_SYNC_CONCURRENCY = 2;

export async function syncSelectedItems(
  options?: SyncOptions,
): Promise<SyncResult[]> {
  if (!beginOperation("sync")) {
    throw new Error("另一同步/回流操作正在进行，请稍后再试。");
  }
  try {
    return await syncSelectedItemsLocked(options);
  } finally {
    endOperation();
  }
}

async function syncSelectedItemsLocked(
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
