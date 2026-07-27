/**
 * Zotero → WPS 笔记同步引擎。
 */

import { WpsMcpClient } from "./wpsMcpClient";
import {
  getSelectedItems,
  extractItemData,
  ExtractOptions,
} from "./zoteroItem";
import { buildNoteTitle, buildNoteXml, ZoteroNote } from "../utils/xmlBuilder";
import { getPref, getApiKey } from "../utils/prefs";
import { getMappedNote, recordSyncResult } from "./syncMapping";

export interface SyncOptions {
  endpoint?: string;
  apiKey?: string;
  addTags?: string[];
  updateExisting?: boolean;
  titleTemplate?: string;
  bodyTemplate?: string;
  include?: ExtractOptions;
  onProgress?: (current: number, total: number, title: string) => void;
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

export interface SyncResult {
  success: boolean;
  itemKey: string;
  title: string;
  noteId?: string;
  noteUrl?: string;
  error?: string;
}

function collectExternalImages(notes: ZoteroNote[]) {
  return notes.flatMap((note) =>
    note.images.filter((img) => img.src && /^https?:\/\//i.test(img.src)),
  );
}

async function syncNoteImages(
  client: WpsMcpClient,
  noteId: string,
  anchorId: string,
  notes: ZoteroNote[],
) {
  const externalImages = collectExternalImages(notes);
  if (!externalImages.length) return;

  try {
    // 先插入一个标题块，作为图片分组的锚点
    const headingRes = await client.editBlock(noteId, "insert", {
      anchor_id: anchorId,
      position: "after",
      content: "<h2>External Images</h2>",
    });
    const imageAnchorId =
      (headingRes as any).last_block_id ||
      (headingRes as any).block_id ||
      anchorId;

    // 并行插入图片，提高同步速度。顺序由 WPS 服务端决定，基本保持原序。
    await Promise.all(
      externalImages.map(async (img) => {
        try {
          await client.insertImage(
            noteId,
            imageAnchorId,
            img.src!,
            img.alt || "Image",
          );
        } catch (e: any) {
          ztoolkit.log(
            "Sync single image failed",
            img.src,
            e?.message || String(e),
          );
        }
      }),
    );
  } catch (e: any) {
    ztoolkit.log("Sync note images failed", e?.message || String(e));
  }
}

function getClient(options?: SyncOptions): WpsMcpClient {
  const endpoint =
    options?.endpoint ||
    String(getPref("wpsMcpEndpoint") || "https://ainote.kdocs.cn/mcp-svc/mcp");
  const apiKey = options?.apiKey || getApiKey();

  if (!apiKey) {
    throw new Error("未配置 WPS 笔记 MCP API Key，请在插件首选项中设置。");
  }

  return new WpsMcpClient({ endpoint, apiKey });
}

export async function syncItem(
  item: Zotero.Item,
  options?: SyncOptions,
): Promise<SyncResult> {
  const titleTemplate =
    options?.titleTemplate || String(getPref("titleTemplate") || "");
  const bodyTemplate =
    options?.bodyTemplate || String(getPref("bodyTemplate") || "");

  const include = options?.include ?? getDefaultExtractOptions();
  const data = extractItemData(item, include);
  const title = buildNoteTitle(data, titleTemplate);
  const xml = buildNoteXml(data, bodyTemplate);

  const result: SyncResult = {
    success: false,
    itemKey: item.key,
    title: data.title,
  };

  try {
    const client = getClient(options);
    let noteId: string | undefined;
    let noteUrl: string | undefined;
    let wasCreated = false;

    // 1. 优先使用本地映射表
    const updateExisting =
      options?.updateExisting ?? Boolean(getPref("updateExisting"));
    const mapped = updateExisting ? getMappedNote(item.key) : undefined;
    if (mapped) {
      noteId = mapped.noteId;
      noteUrl = mapped.noteUrl;
    }

    // 2. 映射未命中时，按标题关键词搜索
    if (!noteId && updateExisting) {
      const existing = await client.searchNotes(`[Zotero] ${data.title}`, 5);
      const match = existing.find(
        (n: any) =>
          String(n.title || "").includes(data.title) ||
          String(n.title || "").includes(item.key),
      );
      if (match) {
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

    // 获取笔记大纲
    const outline = await client.getNoteOutline(noteId);
    const firstBlockId = outline?.blocks?.[0]?.id;
    if (!firstBlockId) {
      throw new Error("无法获取笔记初始 block_id");
    }

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

    // 同步 Zotero 笔记中的外网图片（本地/内嵌图片暂无法直接上传到 WPS）
    await syncNoteImages(client, noteId, firstBlockId, data.notes);

    // 同步标签
    const tagsToAdd = [...data.tags];
    if (options?.addTags?.length) {
      tagsToAdd.push(...options.addTags);
    }
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
    ztoolkit.log("Sync failed", item.key, result.error);
  }

  recordSyncResult(item.key, {
    success: result.success,
    title: data.title,
    noteId: result.noteId,
    noteUrl: result.noteUrl,
    error: result.error,
  });

  return result;
}

export async function syncSelectedItems(
  options?: SyncOptions,
): Promise<SyncResult[]> {
  const items = getSelectedItems().filter(
    (item) => item.isRegularItem && item.isRegularItem(),
  );
  if (!items.length) {
    throw new Error("请先在 Zotero 中选择至少一条文献条目。");
  }

  const results: SyncResult[] = [];
  const total = items.length;
  for (let i = 0; i < total; i++) {
    const item = items[i];
    options?.onProgress?.(i + 1, total, String(item.getField("title") || ""));
    const res = await syncItem(item, options);
    results.push(res);
  }

  return results;
}
