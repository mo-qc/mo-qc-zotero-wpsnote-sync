/**
 * 维护 Zotero itemKey ↔ WPS noteId 的映射表。
 * 存储在 Zotero 偏好中，JSON 格式。
 */

import { getPref, setPref } from "../utils/prefs";

const PREF_KEY = "syncMapping";

export interface SyncMappingEntry {
  noteId?: string;
  noteUrl?: string;
  /** Craft 目标：documentId（与 WPS noteId 并存，二选一目标切换时互不覆盖） */
  craftDocId?: string;
  title?: string;
  lastSync: number;
  itemModified?: string;
  noteModified?: string;
  lastSuccess?: boolean;
  lastError?: string;
  lastErrorType?: string;
  lastErrorCode?: number | string;
  /** 上次回流拉取写入的 Zotero 子笔记 id（重复拉取时更新该子笔记而非新建） */
  pullNoteId?: string;
  /** Zotero 区渲染内容指纹（不含同步脚注）：相同则零请求跳过写入 */
  contentHash?: string;
  /** Craft 分区标记块 id：标记之前为 Zotero 区（同步器独占），之后为用户笔记区（永不覆盖） */
  markerBlockId?: string;
}

export interface SyncMapping {
  [itemKey: string]: SyncMappingEntry;
}

// 内存缓存，避免每次读写都序列化/反序列化 JSON
let mappingCache: SyncMapping | null = null;

function loadMapping(): SyncMapping {
  if (mappingCache) return mappingCache;
  try {
    const raw = String(getPref(PREF_KEY) || "{}");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      mappingCache = parsed as SyncMapping;
      return mappingCache;
    }
  } catch (e) {
    ztoolkit.log("Failed to parse sync mapping", e);
  }
  mappingCache = {};
  return mappingCache;
}

function saveMapping(mapping: SyncMapping): void {
  try {
    setPref(PREF_KEY, JSON.stringify(mapping));
    mappingCache = mapping;
  } catch (e) {
    ztoolkit.log("Failed to save sync mapping", e);
  }
}

export function getMappedEntry(itemKey: string): SyncMappingEntry | undefined {
  const mapping = loadMapping();
  const entry = mapping[itemKey];
  if (entry?.noteId) {
    return entry;
  }
  return undefined;
}

/**
 * Craft 目标专用读取：守卫 craftDocId 而非 noteId。
 * 不放宽 getMappedEntry 本体——WPS 主流程依赖 noteId 守卫，
 * craft-only 条目若被它放行会导致 WPS 可见性校验误判、误删映射。
 */
export function getCraftMappedEntry(
  itemKey: string,
): SyncMappingEntry | undefined {
  const mapping = loadMapping();
  const entry = mapping[itemKey];
  if (entry?.craftDocId) {
    return entry;
  }
  return undefined;
}

export function getMappedNote(
  itemKey: string,
): { noteId: string; noteUrl: string } | undefined {
  const entry = getMappedEntry(itemKey);
  if (entry?.noteId) {
    return { noteId: entry.noteId, noteUrl: entry.noteUrl || "" };
  }
  return undefined;
}

export function recordSyncResult(
  itemKey: string,
  result: {
    success: boolean;
    title?: string;
    noteId?: string;
    noteUrl?: string;
    craftDocId?: string;
    itemModified?: string;
    noteModified?: string;
    error?: string;
    errorType?: string;
    errorCode?: number | string;
    contentHash?: string;
    markerBlockId?: string;
  },
): void {
  const mapping = loadMapping();
  const entry: SyncMappingEntry = {
    ...mapping[itemKey],
    lastSync: Date.now(),
    lastSuccess: result.success,
    lastError: result.error,
    lastErrorType: result.errorType,
    lastErrorCode: result.errorCode,
  };
  if (result.title) {
    entry.title = result.title;
  }
  if (result.noteId) {
    entry.noteId = result.noteId;
  }
  if (result.noteUrl) {
    entry.noteUrl = result.noteUrl;
  }
  if (result.craftDocId) {
    entry.craftDocId = result.craftDocId;
  }
  if (result.itemModified !== undefined) {
    entry.itemModified = result.itemModified;
  }
  if (result.noteModified !== undefined) {
    entry.noteModified = result.noteModified;
  }
  if (result.contentHash !== undefined) {
    entry.contentHash = result.contentHash;
  }
  if (result.markerBlockId !== undefined) {
    entry.markerBlockId = result.markerBlockId;
  }
  mapping[itemKey] = entry;
  saveMapping(mapping);
}

export function removeMappedNote(itemKey: string): void {
  const mapping = loadMapping();
  delete mapping[itemKey];
  saveMapping(mapping);
}

/** 只更新端修改时间基准，不动同步状态（回流拉取后调用；WPS/Craft 共用 noteModified 字段） */
export function updateNoteModified(itemKey: string, noteModified: string) {
  const mapping = loadMapping();
  const entry = mapping[itemKey];
  if (!entry?.noteId && !entry?.craftDocId) return;
  entry.noteModified = noteModified;
  mapping[itemKey] = entry;
  saveMapping(mapping);
}

/** 记录回流写入的子笔记 id，重复拉取时复用（防止子笔记无限堆积） */
export function recordPullNoteId(itemKey: string, pullNoteId: string): void {
  const mapping = loadMapping();
  const entry = mapping[itemKey];
  if (!entry?.noteId && !entry?.craftDocId) return;
  entry.pullNoteId = pullNoteId;
  mapping[itemKey] = entry;
  saveMapping(mapping);
}

/**
 * 回流子笔记的 HTML 标记（写在笔记开头的注释里）。
 * 渲染同步时据此排除——比 pullNoteId 映射字段更可靠（映射字段存在
 * 竞态覆盖/守卫漏读的历史问题，会导致回流快照被拼回正文造成套娃放大）。
 */
export const PULL_NOTE_MARK = "<!--zotero-wps-sync-pull-note-->";

export function getAllMappings(): SyncMapping {
  return loadMapping();
}
