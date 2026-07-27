/**
 * 维护 Zotero itemKey ↔ WPS noteId 的映射表。
 * 存储在 Zotero 偏好中，JSON 格式。
 */

import { getPref, setPref } from "../utils/prefs";

const PREF_KEY = "syncMapping";

export interface SyncMappingEntry {
  noteId?: string;
  noteUrl?: string;
  title?: string;
  lastSync: number;
  lastSuccess?: boolean;
  lastError?: string;
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

export function getMappedNote(
  itemKey: string,
): { noteId: string; noteUrl: string } | undefined {
  const mapping = loadMapping();
  const entry = mapping[itemKey];
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
    error?: string;
  },
): void {
  const mapping = loadMapping();
  const entry: SyncMappingEntry = {
    ...mapping[itemKey],
    lastSync: Date.now(),
    lastSuccess: result.success,
    lastError: result.error,
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
  mapping[itemKey] = entry;
  saveMapping(mapping);
}

export function removeMappedNote(itemKey: string): void {
  const mapping = loadMapping();
  delete mapping[itemKey];
  saveMapping(mapping);
}

export function getAllMappings(): SyncMapping {
  return loadMapping();
}
