/**
 * 注册右键菜单、工具栏按钮与同步进度 UI。
 */

import {
  syncSelectedItems,
  syncItem,
  getClient,
  beginOperation,
  endOperation,
  SyncResult,
  ConflictResolution,
  ConflictKind,
} from "./syncEngine";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import {
  getAllMappings,
  getMappedEntry,
  getMappedNote,
  removeMappedNote,
  recordPullNoteId,
  updateNoteModified,
} from "./syncMapping";
import { runWithConcurrency } from "../utils/concurrencyHelper";
import { semanticXmlToZoteroHtml } from "../utils/semanticRender";
import { getSelectedItems } from "./zoteroItem";

// Zotero 插件环境可能没有全局 AbortController，提供最小 polyfill
const AbortControllerImpl =
  (globalThis as any).AbortController ||
  class {
    signal: { aborted: boolean };
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      this.signal.aborted = true;
    }
  };

// 缓存同步历史窗口，防止重复打开
let syncHistoryWindow: Window | null = null;

function isWindowClosed(win: Window | null): boolean {
  if (!win) return true;
  try {
    return win.closed || win.document.readyState === "uninitialized";
  } catch {
    return true;
  }
}

function parseDefaultTags(): string[] {
  const raw = String(getPref("defaultTags") || "");
  return raw
    .split(/[,，;；]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function errorTypeLabel(type?: string, code?: number | string): string {
  const prefix =
    {
      network: "[网络] ",
      mcp: "[MCP] ",
      image: "[图片] ",
    }[type || ""] || "";
  const codeLabel = code !== undefined ? `(${code}) ` : "";
  return prefix + codeLabel;
}

function errorActionAdvice(type?: string, code?: number | string): string {
  if (type === "network") {
    return "建议：检查网络连接，或稍后重试。";
  }
  if (type === "mcp") {
    if (code === 401 || code === 403 || code === "UNAUTHORIZED") {
      return "建议：WPS 笔记 API Key / Token 无效或已过期，请重新生成并填入插件设置。";
    }
    if (code === 400 || code === "BAD_REQUEST") {
      return "建议：请求被 WPS MCP 拒绝，请检查 API Key 是否对应正确的云端/本地接口，或重新生成 Token。";
    }
    if (code === 429 || code === "RATE_LIMIT") {
      return "建议：请求过于频繁，请稍后再试。";
    }
    if (code === "INVALID_CONTENT") {
      return "建议：内容格式错误，请检查模板或联系开发者。";
    }
    return "建议：请检查 MCP 服务状态、接口类型与 API Key / Token 设置。";
  }
  if (type === "image") {
    return "建议：图片上传失败，请检查图片链接是否可访问。";
  }
  return "建议：请打开同步历史查看详情。";
}

let conflictBatchChoice: ConflictResolution | null = null;

async function promptConflict(
  title: string,
  kind: ConflictKind = "item",
): Promise<ConflictResolution> {
  if (conflictBatchChoice) {
    return conflictBatchChoice;
  }

  const dialogData: {
    remember?: boolean;
    _lastButtonId?: string;
    unloadLock?: { promise: Promise<void> };
  } = {
    remember: false,
  };

  const isWps = kind === "wps";
  const heading = isWps ? "WPS 笔记已修改" : "文献已变更";
  const body = isWps
    ? `文献「${escapeHtml(title.slice(0, 40))}」的 WPS 笔记在上次同步后被手工修改过，可能包含你的心得或批注。<br/>覆盖会丢失这些修改；可先跳过，稍后用右键菜单「从 WPS 拉取」取回。`
    : `文献「${escapeHtml(title.slice(0, 40))}」在 Zotero 中已变更，可能已同步过到 WPS 笔记。`;

  const dialog = new (ztoolkit as any).Dialog(2, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: {
        innerHTML: `
          <div style="font-size:16px;font-weight:600;color:#0f172a;margin:0 0 8px 0;">${heading}</div>
          <p style="font-size:13px;line-height:1.6;margin:0;color:#475569;">
            ${body}<br/>
            请选择处理方式：
          </p>
        `,
      },
    })
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      properties: {
        innerHTML: `<input type="checkbox" data-bind="remember" data-prop="checked" style="width:16px;height:16px;accent-color:#2563eb;margin-right:8px;cursor:pointer;"/>记住选择，应用到本次同步的其余冲突`,
      },
      styles: {
        fontSize: "13px",
        color: "#475569",
        display: "flex",
        alignItems: "center",
        marginTop: "8px",
      },
    })
    .addButton("跳过本次", "skip")
    .addButton("新建副本", "create-copy")
    .addButton("覆盖 WPS 笔记", "overwrite")
    .setDialogData(dialogData);

  dialog.open("Zotero → WPS 笔记同步冲突", {
    width: 440,
    height: 200,
    centerscreen: true,
    resizable: false,
    fitContent: true,
    noDialogMode: true,
  });

  await dialog.dialogData.unloadLock!.promise;

  const mapping: Record<string, ConflictResolution> = {
    overwrite: "overwrite",
    skip: "skip",
    "create-copy": "create-copy",
  };
  const resolution =
    mapping[dialog.dialogData._lastButtonId || ""] || "overwrite";
  if (dialog.dialogData.remember) {
    conflictBatchChoice = resolution;
  }
  return resolution;
}

function resetConflictBatchChoice() {
  conflictBatchChoice = null;
}

function showResults(results: SyncResult[]) {
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (!failed.length) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: 5000,
    })
      .createLine({
        text: `成功同步 ${succeeded.length} 条文献到 WPS 笔记`,
        type: "success",
      })
      .show();
    return;
  }

  const allFailed = failed.length === results.length;
  const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 6000,
  }).createLine({
    text: `同步完成：成功 ${succeeded.length} 条 · 失败 ${failed.length} 条`,
    type: allFailed ? "error" : "default",
  });
  for (const r of failed.slice(0, 2)) {
    popup.createLine({
      text: `${errorTypeLabel(r.errorType, r.errorCode)}「${r.title.slice(0, 20)}」${r.error?.slice(0, 60) || ""}`,
      type: "error",
    });
    popup.createLine({
      text: errorActionAdvice(r.errorType, r.errorCode),
      type: "default",
    });
  }
  if (failed.length > 2) {
    popup.createLine({
      text: `还有 ${failed.length - 2} 条失败，请打开同步历史查看详情`,
      type: "default",
    });
  }
  popup.show();
}

function formatSyncTime(timestamp: number): string {
  if (!timestamp) return "-";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return String(timestamp);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openUrlSafely(url: string): void {
  try {
    if (typeof (Zotero as any).launchURL === "function") {
      (Zotero as any).launchURL(url);
      return;
    }
  } catch (e: any) {
    ztoolkit.log("Zotero.launchURL failed", url, e?.message || String(e));
  }

  try {
    const internal = (Zotero as any).Utilities?.Internal;
    if (typeof internal?.openURL === "function") {
      internal.openURL(url);
      return;
    }
  } catch (e: any) {
    ztoolkit.log(
      "Zotero.Utilities.Internal.openURL failed",
      url,
      e?.message || String(e),
    );
  }

  // 兜底：使用系统默认浏览器打开
  try {
    const { nsIScriptSecurityManager } = Components.interfaces;
    const uri = Services.io.newURI(url, null, null);
    const principal = Services.scriptSecurityManager.createNullPrincipal(
      {} as any,
    );
    Cc["@mozilla.org/uriloader/external-protocol-service;1"]
      .getService(Ci.nsIExternalProtocolService)
      .loadURI(uri, { triggeringPrincipal: principal } as any);
  } catch (e: any) {
    ztoolkit.log("Failed to open URL", url, e?.message || String(e));
  }
}

function findItemByKey(key: string): Zotero.Item | undefined {
  try {
    for (const lib of Zotero.Libraries.getAll()) {
      const item = (Zotero.Items as any).getByLibraryAndKey(lib.libraryID, key);
      if (item) return item;
    }
  } catch (e) {
    ztoolkit.log("findItemByKey failed", key, e);
  }
  return undefined;
}

function refreshSyncHistory() {
  if (!isWindowClosed(syncHistoryWindow)) {
    syncHistoryWindow!.close();
  }
  syncHistoryWindow = null;
  openSyncHistory();
}

async function confirmDelete(title: string): Promise<boolean> {
  const dialogData: {
    unloadLock?: { promise: Promise<void> };
    _lastButtonId?: string;
  } = {};

  const dialog = new (ztoolkit as any).Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: {
        innerHTML: `<p style="font-size:13px;line-height:1.6;margin:0;">确定要删除「${escapeHtml(title.slice(0, 40))}」的同步映射记录吗？<br/><span style="color:#64748b;font-size:12px;">这不会删除 WPS 笔记，只是让插件忘记它们之间的关联。</span></p>`,
      },
    })
    .addButton("取消", "cancel")
    .addButton("删除", "delete")
    .setDialogData(dialogData);

  dialog.open("确认删除映射", {
    width: 360,
    height: 140,
    centerscreen: true,
    resizable: false,
    fitContent: true,
    noDialogMode: true,
  });

  await dialogData.unloadLock!.promise;
  return (dialogData._lastButtonId || "") === "delete";
}

const DEFAULT_RETRY_CONCURRENCY = 2;

async function retryFailedItems(itemKeys: string[]) {
  const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeTime: -1,
    closeOnClick: false,
  })
    .createLine({
      text: `正在重试 ${itemKeys.length} 条失败记录...`,
      type: "default",
    })
    .show();

  if (!beginOperation("retry")) {
    popup.changeLine({
      text: "另一同步/回流操作正在进行，请稍后再试",
      type: "fail",
    });
    popup.startCloseTimer(3000);
    return;
  }
  try {
    // 先解析 item，保留索引以维持结果顺序
    const entries: { key: string; item?: Zotero.Item }[] = itemKeys.map(
      (key) => ({
        key,
        item: findItemByKey(key),
      }),
    );

    const results = await runWithConcurrency<
      { key: string; item?: Zotero.Item },
      SyncResult
    >(
      entries,
      async ({ key, item }) => {
        if (!item) {
          return {
            success: false,
            itemKey: key,
            title: "-",
            error: "未找到对应文献",
          };
        }
        try {
          return await syncItem(item, {
            addTags: parseDefaultTags(),
            updateExisting: true,
          });
        } catch (e: any) {
          ztoolkit.log("Batch retry failed", key, e?.message || String(e));
          return {
            success: false,
            itemKey: key,
            title: String(item.getField("title") || ""),
            error: e?.message || String(e),
          };
        }
      },
      {
        concurrency: DEFAULT_RETRY_CONCURRENCY,
        onProgress: (completed, total, _result, _index, { item }) => {
          const title = item
            ? String(item.getField("title") || "").slice(0, 30)
            : "";
          popup.changeLine({
            text: title
              ? `重试中 ${completed}/${total}：${title}`
              : `重试中 ${completed}/${total}`,
          });
        },
      },
    );

    const succeeded = results.filter((r) => r.success).length;
    popup.changeLine({
      text: `重试完成：成功 ${succeeded}/${results.length}`,
      type: succeeded === results.length ? "success" : "default",
    });
    popup.startCloseTimer(2000);
    showResults(results);
    refreshSyncHistory();
  } finally {
    endOperation();
  }
}

function bindHistoryActions(iframe: HTMLIFrameElement): () => void {
  // Zotero 10 的 XUL 文档用 innerHTML 解析时会丢弃 input/button 等表单控件，
  // 因此历史窗口内容写在 HTML iframe 文档里，事件也绑定在 iframe 上
  const win = iframe.contentWindow!;
  const doc = iframe.contentDocument!;
  type ListenerEntry = {
    target: EventTarget;
    type: string;
    listener: EventListener;
  };
  const listeners: ListenerEntry[] = [];

  const addListener = (
    target: EventTarget,
    type: string,
    listener: EventListener,
  ) => {
    target.addEventListener(type, listener);
    listeners.push({ target, type, listener });
  };

  // 操作按钮（打开/重试/删除）
  doc.querySelectorAll("[data-history-action]").forEach((el: Element) => {
    addListener(el, "click", (ev: Event) => {
      const target = ev.currentTarget as HTMLElement;
      const action = target.dataset.historyAction;
      const itemKey = target.dataset.itemKey;
      if (!itemKey) return;

      if (action === "open-note") {
        const noteUrl = target.dataset.noteUrl;
        if (noteUrl) {
          openUrlSafely(noteUrl);
        }
      } else if (action === "retry") {
        (async () => {
          const item = findItemByKey(itemKey);
          if (!item) {
            new ztoolkit.ProgressWindow(addon.data.config.addonName, {
              closeTime: 3000,
            })
              .createLine({ text: "未找到对应文献", type: "error" })
              .show();
            return;
          }
          const popup = new ztoolkit.ProgressWindow(
            addon.data.config.addonName,
            { closeTime: -1, closeOnClick: false },
          )
            .createLine({ text: "重试同步中...", type: "default" })
            .show();
          if (!beginOperation("retry")) {
            popup.changeLine({
              text: "另一同步/回流操作正在进行，请稍后再试",
              type: "fail",
            });
            popup.startCloseTimer(3000);
            return;
          }
          try {
            const result = await syncItem(item, {
              addTags: parseDefaultTags(),
              updateExisting: true,
            });
            popup.close();
            showResults([result]);
            refreshSyncHistory();
          } catch (e: any) {
            popup.close();
            ztoolkit.log("Retry failed", itemKey, e?.message || String(e));
            new ztoolkit.ProgressWindow(addon.data.config.addonName, {
              closeTime: 4000,
            })
              .createLine({
                text: `重试失败：${e?.message || String(e)}`.slice(0, 120),
                type: "error",
              })
              .show();
          } finally {
            endOperation();
          }
        })();
      } else if (action === "clear-mapping") {
        (async () => {
          try {
            const entry = getAllMappings()[itemKey];
            const confirmed = await confirmDelete(entry?.title || itemKey);
            if (!confirmed) return;
            removeMappedNote(itemKey);
            refreshSyncHistory();
          } catch (e: any) {
            ztoolkit.log(
              "Clear mapping failed",
              itemKey,
              e?.message || String(e),
            );
          }
        })();
      }
    });
  });

  // 刷新按钮
  const refreshBtn = doc.getElementById("zws-history-refresh");
  if (refreshBtn) {
    addListener(refreshBtn, "click", () => {
      refreshSyncHistory();
    });
  }

  // 批量重试失败
  const retryFailedBtn = doc.getElementById("zws-history-retry-failed");
  if (retryFailedBtn) {
    addListener(retryFailedBtn, "click", () => {
      const failedKeys: string[] = [];
      doc
        .querySelectorAll<HTMLElement>("[data-history-row]")
        .forEach((row: HTMLElement) => {
          if (row.dataset.status === "failed") {
            const key = row.dataset.itemKey;
            if (key) failedKeys.push(key);
          }
        });
      if (!failedKeys.length) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName, {
          closeTime: 2500,
        })
          .createLine({ text: "没有失败记录需要重试", type: "default" })
          .show();
        return;
      }
      retryFailedItems(failedKeys);
    });
  }

  // 搜索框
  const searchInput = doc.getElementById(
    "zws-history-search",
  ) as HTMLInputElement | null;
  if (searchInput) {
    addListener(searchInput, "input", () => {
      applyHistoryFilter(win, searchInput.value.trim());
    });
  }

  // 状态筛选按钮
  doc.querySelectorAll("[data-history-filter]").forEach((el: Element) => {
    addListener(el, "click", (ev: Event) => {
      const target = ev.currentTarget as HTMLElement;
      const filter = target.dataset.historyFilter || "all";
      doc.querySelectorAll("[data-history-filter]").forEach((btn: Element) => {
        btn.classList.toggle("active", btn === target);
      });
      (win as any).__zwsHistoryFilter = filter;
      applyHistoryFilter(
        win,
        (
          doc.getElementById("zws-history-search") as HTMLInputElement
        )?.value?.trim() || "",
      );
    });
  });

  const cleanup = () => {
    for (const { target, type, listener } of listeners) {
      target.removeEventListener(type, listener);
    }
    listeners.length = 0;
  };

  // 窗口卸载时自动清理，同时把缓存引用置空
  addListener(win, "unload", () => {
    syncHistoryWindow = null;
    cleanup();
  });

  return cleanup;
}

function applyHistoryFilter(win: Window, keyword: string) {
  const filter = (win as any).__zwsHistoryFilter || "all";
  const lower = keyword.toLowerCase();
  win.document
    .querySelectorAll<HTMLElement>("[data-history-row]")
    .forEach((row: HTMLElement) => {
      const status = row.dataset.status || "";
      const text = (row.dataset.searchText || "").toLowerCase();
      const statusMatch =
        filter === "all" ||
        (filter === "success" && status === "success") ||
        (filter === "failed" && status === "failed") ||
        (filter === "pending" && status === "pending");
      const keywordMatch = !lower || text.includes(lower);
      row.style.display = statusMatch && keywordMatch ? "" : "none";
    });
}

export function closeSyncHistoryWindow() {
  if (!isWindowClosed(syncHistoryWindow)) {
    try {
      syncHistoryWindow!.close();
    } catch (e) {
      ztoolkit.log("Failed to close sync history window", e);
    }
  }
  syncHistoryWindow = null;
}

export function openSyncHistory() {
  // 如果窗口已存在且未关闭，则聚焦并返回
  if (!isWindowClosed(syncHistoryWindow)) {
    syncHistoryWindow!.focus();
    return;
  }

  const mapping = getAllMappings();
  const entries = Object.entries(mapping).sort(
    (a, b) => (b[1].lastSync || 0) - (a[1].lastSync || 0),
  );

  const statusValue = (entry: any) =>
    entry.lastSuccess === true
      ? "success"
      : entry.lastSuccess === false
        ? "failed"
        : "pending";

  const rows = entries
    .map(([itemKey, entry]) => {
      const isSuccess = entry.lastSuccess === true;
      const isFailed = entry.lastSuccess === false;
      const status = statusValue(entry);
      const statusClass =
        status === "success"
          ? "zws-status-success"
          : status === "failed"
            ? "zws-status-error"
            : "zws-status-pending";
      const statusDot =
        status === "success"
          ? "#10b981"
          : status === "failed"
            ? "#ef4444"
            : "#f59e0b";
      const statusText = isSuccess ? "成功" : isFailed ? "失败" : "未同步";
      const title = entry.title || "-";
      const noteId = entry.noteId || "-";
      const error = entry.lastError || "";
      const errorType = entry.lastErrorType || "";
      const errorCode = entry.lastErrorCode;
      const noteUrl = entry.noteUrl || "";
      const searchText = `${title} ${itemKey} ${noteId} ${statusText} ${error}`;
      const openBtn = noteUrl
        ? `<button data-history-action="open-note" data-item-key="${escapeHtml(itemKey)}" data-note-url="${escapeHtml(noteUrl)}" class="zws-history-btn">打开笔记</button>`
        : `<button class="zws-history-btn" disabled>打开笔记</button>`;
      return `<tr data-history-row data-status="${status}" data-item-key="${escapeHtml(itemKey)}" data-search-text="${escapeHtml(searchText)}">
<td class="zws-history-cell zws-history-title">${escapeHtml(title)}</td>
<td class="zws-history-cell zws-history-mono">${escapeHtml(itemKey)}</td>
<td class="zws-history-cell zws-history-mono">${formatSyncTime(entry.lastSync)}</td>
<td class="zws-history-cell"><span class="zws-history-status ${statusClass}"><span style="color:${statusDot};">●</span> ${statusText}</span></td>
<td class="zws-history-cell zws-history-mono">${escapeHtml(noteId)}</td>
<td class="zws-history-cell zws-history-error" title="${escapeHtml(error)}">${errorTypeLabel(errorType, errorCode)}${escapeHtml(error.slice(0, 80))}</td>
<td class="zws-history-cell zws-history-actions">
${openBtn}<button data-history-action="retry" data-item-key="${escapeHtml(itemKey)}" class="zws-history-btn zws-history-btn-primary">重试</button><button data-history-action="clear-mapping" data-item-key="${escapeHtml(itemKey)}" class="zws-history-btn zws-history-btn-danger">清除映射</button>
</td>
</tr>`;
    })
    .join("");

  const failedCount = entries.filter(
    ([, entry]) => entry.lastSuccess === false,
  ).length;

  const historyDocHtml = `
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html,
  body {
    height: 100%;
    margin: 0;
    background: #ffffff;
  }
  body {
    overflow: auto;
  }
  .zws-history-window {
    /* Brand */
    --zws-primary: #2563eb;
    --zws-primary-hover: #1d4ed8;
    --zws-primary-subtle: #eff6ff;
    --zws-primary-ring: rgba(37, 99, 235, 0.25);
    /* Neutral */
    --zws-bg: #ffffff;
    --zws-surface: #f8fafc;
    --zws-surface-hover: #f1f5f9;
    --zws-border: #e2e8f0;
    --zws-border-strong: #cbd5e1;
    /* Text */
    --zws-text: #0f172a;
    --zws-text-secondary: #475569;
    --zws-text-muted: #64748b;
    --zws-text-placeholder: #94a3b8;
    /* Status */
    --zws-success: #10b981;
    --zws-success-subtle: #ecfdf5;
    --zws-success-text: #047857;
    --zws-error: #ef4444;
    --zws-error-subtle: #fef2f2;
    --zws-error-text: #b91c1c;
    --zws-warning: #f59e0b;
    --zws-warning-subtle: #fffbeb;
    --zws-warning-text: #b45309;
    /* Radius */
    --zws-radius-sm: 6px;
    --zws-radius-md: 10px;
    /* Shadows */
    --zws-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
    /* Typography */
    --zws-font:
      -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
      Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    --zws-font-mono:
      "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas,
      "PingFang SC", monospace;

    font-family: var(--zws-font);
    color: var(--zws-text);
  }
  .zws-history-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--zws-surface);
    border-bottom: 1px solid var(--zws-border);
    border-radius: var(--zws-radius-md) var(--zws-radius-md) 0 0;
    flex-wrap: wrap;
  }
  .zws-history-search {
    flex: 1;
    min-width: 140px;
    max-width: 260px;
    font-family: var(--zws-font);
    font-size: 13px;
    padding: 8px 12px;
    color: var(--zws-text);
    background: var(--zws-bg);
    border: 1px solid var(--zws-border-strong);
    border-radius: var(--zws-radius-md);
    outline: none;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .zws-history-search:focus {
    border-color: var(--zws-primary);
    box-shadow: 0 0 0 3px var(--zws-primary-ring);
  }
  .zws-history-filter-group {
    display: flex;
    gap: 4px;
  }
  .zws-history-filter {
    font-family: var(--zws-font);
    font-size: 12px;
    font-weight: 500;
    padding: 4px 10px;
    border: 1px solid var(--zws-border);
    border-radius: var(--zws-radius-sm);
    background: var(--zws-bg);
    color: var(--zws-text-secondary);
    cursor: pointer;
    transition: background 0.15s;
  }
  .zws-history-filter:hover {
    background: var(--zws-surface-hover);
  }
  .zws-history-filter.active {
    background: var(--zws-primary-subtle);
    border-color: #bfdbfe;
    color: var(--zws-primary-hover);
  }
  .zws-history-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 13px;
  }
  .zws-history-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--zws-surface);
    color: var(--zws-text-secondary);
    font-weight: 600;
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--zws-border);
  }
  /* 错误列无内容时会被压到逐字竖排，nowrap+定宽保证表头横排 */
  .zws-history-table th:nth-child(6) {
    width: 76px;
    white-space: nowrap;
  }
  .zws-history-table th:first-child {
    border-top-left-radius: var(--zws-radius-md);
  }
  .zws-history-table th:last-child {
    border-top-right-radius: var(--zws-radius-md);
  }
  .zws-history-table tbody tr:hover {
    background: var(--zws-surface-hover);
  }
  .zws-history-cell {
    padding: 10px 12px;
    border-bottom: 1px solid var(--zws-border);
    vertical-align: middle;
  }
  .zws-history-title {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .zws-history-mono {
    font-family: var(--zws-font-mono);
    color: var(--zws-text-muted);
    white-space: nowrap;
  }
  .zws-history-error {
    color: var(--zws-error);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .zws-history-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--zws-surface-hover);
    color: var(--zws-text-secondary);
  }
  .zws-history-status.zws-status-success {
    background: var(--zws-success-subtle);
    color: var(--zws-success-text);
  }
  .zws-history-status.zws-status-error {
    background: var(--zws-error-subtle);
    color: var(--zws-error-text);
  }
  .zws-history-status.zws-status-pending {
    background: var(--zws-warning-subtle);
    color: var(--zws-warning-text);
  }
  .zws-history-actions {
    white-space: nowrap;
    display: flex;
    gap: 6px;
  }
  .zws-history-btn {
    font-family: var(--zws-font);
    font-size: 12px;
    font-weight: 500;
    padding: 4px 10px;
    border: 1px solid var(--zws-border);
    border-radius: var(--zws-radius-sm);
    background: var(--zws-surface);
    color: var(--zws-text-secondary);
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s;
  }
  .zws-history-btn:hover:not(:disabled) {
    background: var(--zws-surface-hover);
    border-color: var(--zws-border-strong);
  }
  .zws-history-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .zws-history-btn-primary {
    background: var(--zws-primary);
    border-color: var(--zws-primary);
    color: #ffffff;
  }
  .zws-history-btn-primary:hover:not(:disabled) {
    background: var(--zws-primary-hover);
    border-color: var(--zws-primary-hover);
  }
  .zws-history-btn-danger {
    background: var(--zws-error-subtle);
    border-color: #fecaca;
    color: var(--zws-error);
  }
  .zws-history-btn-danger:hover:not(:disabled) {
    background: #fee2e2;
  }
  .zws-history-empty {
    padding: 32px;
    text-align: center;
    color: var(--zws-text-placeholder);
    font-size: 13px;
  }
</style>
</head>
<body>
<div class="zws-history-window">
  <div class="zws-history-toolbar">
    <input id="zws-history-search" class="zws-history-search" type="text" placeholder="搜索标题、Key、Note ID、错误..."/>
    <div class="zws-history-filter-group">
      <button class="zws-history-filter active" data-history-filter="all">全部</button>
      <button class="zws-history-filter" data-history-filter="success">成功</button>
      <button class="zws-history-filter" data-history-filter="failed">失败</button>
      <button class="zws-history-filter" data-history-filter="pending">未同步</button>
    </div>
    <button id="zws-history-retry-failed" class="zws-history-btn zws-history-btn-primary">批量重试失败 (${failedCount})</button>
    <button id="zws-history-refresh" class="zws-history-btn">刷新</button>
  </div>
  <table class="zws-history-table">
    <thead>
      <tr>
        <th>标题</th>
        <th>Zotero Key</th>
        <th>上次同步时间</th>
        <th>状态</th>
        <th>WPS Note ID</th>
        <th>错误信息</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7" class="zws-history-empty">暂无同步记录</td></tr>'}
    </tbody>
  </table>
</div>
</body>
</html>`;

  const dialog = new (ztoolkit as any).Dialog(1, 1);
  const win = dialog
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: { id: "zws-history-host" },
      styles: {
        width: "100%",
        height: "480px",
        padding: "0",
        overflow: "hidden",
      },
    })
    .open(getString("sync-history-title"), {
      // 表格各列 min-content 合计约 967px，窗口需容纳否则操作列被裁
      width: 1000,
      height: 540,
      centerscreen: true,
      resizable: true,
    });

  syncHistoryWindow = win;

  // Dialog.open 返回时窗口 document 可能尚未就绪（win.document 为 undefined），
  // 轮询等待 host 渲染完成后再挂载 iframe
  let mountTries = 0;
  const findHistoryDoc = (): Document | undefined => {
    try {
      if (
        win &&
        win.document &&
        win.document.getElementById("zws-history-host")
      ) {
        return win.document;
      }
    } catch (e) {
      // win.document 尚未就绪，走枚举兜底
    }
    try {
      const wins = Services.wm.getEnumerator(null);
      while (wins.hasMoreElements()) {
        const w = wins.getNext();
        try {
          const d = w.document;
          // 只认空 host：插件热重载残留的孤儿窗口也带同名 host，
          // 挂到孤儿上会让新窗口永远空白
          const host = d && d.getElementById("zws-history-host");
          if (host && !host.querySelector("iframe")) return d;
        } catch (e) {
          // 个别窗口 document 暂不可访问
        }
      }
    } catch (e) {
      // 枚举失败时继续重试
    }
    return undefined;
  };
  const mountHistoryIframe = () => {
    try {
      const doc = findHistoryDoc();
      if (!doc) return false;
      const host = doc.getElementById("zws-history-host");
      if (!host) return false;
      let iframe = host.querySelector("iframe") as HTMLIFrameElement | null;
      if (!iframe) {
        iframe = doc.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:0;margin:0;";
        // bootstrap sandbox 对 about:blank 文档执行 document.write 会抛
        // SecurityError("The operation is insecure")，改用 srcdoc 由引擎注入；
        // srcdoc 文档继承宿主 chrome principal，load 后可正常读 contentDocument。
        // iframe 首次 load 可能是初始 about:blank（body 为空），此时轮询等待
        // srcdoc 文档就绪后再绑定，避免错过唯一一次 load
        let bound = false;
        const tryBind = () => {
          if (bound) return;
          try {
            const idoc = iframe!.contentDocument;
            if (idoc && idoc.body && idoc.body.childElementCount > 0) {
              bindHistoryActions(iframe!);
              bound = true;
              return;
            }
          } catch (e) {
            ztoolkit.log("bind history actions failed", e);
            bound = true;
            return;
          }
          setTimeout(tryBind, 50);
        };
        iframe.addEventListener("load", tryBind);
        iframe.srcdoc = historyDocHtml;
        host.appendChild(iframe);
        // load 未触发的兜底（srcdoc 就绪早于监听等极端时序）
        setTimeout(tryBind, 100);
      }
      return true;
    } catch (e) {
      ztoolkit.log("mount history iframe failed", e);
      return false;
    }
  };
  const tryMount = () => {
    if (mountHistoryIframe()) return;
    if (++mountTries < 100) {
      setTimeout(tryMount, 50);
    }
  };
  tryMount();
}

/**
 * 从 WPS 拉取笔记内容，写入为该文献的新子笔记（回流）。
 * 不覆盖已有子笔记，避免丢失 Zotero 侧内容。
 * @param itemsArg 指定要拉取的条目；缺省时使用当前选中条目。
 */
export async function pullFromWps(itemsArg?: Zotero.Item[]) {
  const items = itemsArg?.length ? itemsArg : getSelectedItems();
  if (!items.length) {
    ztoolkit.log("pullFromWps: no items selected");
    return;
  }

  const popup = new ztoolkit.ProgressWindow("Zotero → WPS 笔记同步");
  if (!beginOperation("pull")) {
    popup.createLine({
      text: "另一同步/回流操作正在进行，请稍后再试",
      type: "fail",
    });
    popup.show();
    popup.startCloseTimer(3000);
    return;
  }
  popup.createLine({
    text: `正在从 WPS 拉取 ${items.length} 篇笔记…`,
    progress: 0,
  });
  popup.show();

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = String(item.getField("title") || item.key);
      const percent = Math.round(((i + 1) / items.length) * 100);
      const mapped = getMappedNote(item.key);
      if (!mapped) {
        skipped++;
        popup.changeLine({
          progress: percent,
          text: `跳过（未同步过）：${title.slice(0, 30)}`,
          type: "warning",
        });
        continue;
      }
      try {
        const client = getClient();
        // 分页读全（长笔记可能跨多页）
        let xml = "";
        let noteTitle = "";
        let offset = 0;
        for (let page = 0; page < 50; page++) {
          const r = await client.readNote(mapped.noteId, offset, 50);
          if (page === 0) noteTitle = r.title;
          xml += r.content;
          if (!r.hasMore) break;
          offset += 50;
        }
        const html = semanticXmlToZoteroHtml(xml);
        if (!html.trim()) throw new Error("笔记内容解析为空");

        // 复用上次回流写入的子笔记（存在且仍是本条目的子笔记时更新，
        // 否则新建），防止重复拉取导致子笔记无限堆积
        let child: Zotero.Item | undefined;
        const prevPullId = getMappedEntry(item.key)?.pullNoteId;
        if (prevPullId) {
          try {
            const prev = await Zotero.Items.getAsync(Number(prevPullId));
            if (
              prev &&
              !prev.deleted &&
              prev.isNote() &&
              prev.parentID === item.id
            ) {
              child = prev;
            }
          } catch (e) {
            ztoolkit.log("Load previous pull note failed, will recreate", e);
          }
        }
        if (!child) {
          child = new Zotero.Item("note");
          child.parentID = item.id;
        }
        child.setNote(html);
        await child.saveTx();
        recordPullNoteId(item.key, String(child.id));

        // 本地已拿到最新内容，更新改动检测基准，避免下次同步误报
        try {
          const info = await client.getNoteInfo(mapped.noteId);
          if (info.updateTime) {
            updateNoteModified(item.key, String(info.updateTime));
          }
        } catch (e) {
          ztoolkit.log("updateNoteModified failed (non-fatal)", e);
        }

        ok++;
        popup.changeLine({
          progress: percent,
          text: `已拉取：${(noteTitle || title).slice(0, 30)}`,
          type: "success",
        });
      } catch (e: any) {
        failed++;
        ztoolkit.log("pullFromWps failed", item.key, e?.message || String(e));
        popup.changeLine({
          progress: percent,
          text: `失败：${title.slice(0, 25)}`,
          type: "fail",
        });
      }
    }
  } finally {
    endOperation();
  }

  popup.startCloseTimer(4000);
  ztoolkit.log(
    `pullFromWps done: ok=${ok} skipped=${skipped} failed=${failed}`,
  );
}

export async function runSync(force = false) {
  const controller = new AbortControllerImpl();
  let cancelled = false;

  const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: false,
    closeTime: -1,
  })
    .createLine({
      text: getString("sync-begin"),
      type: "default",
      progress: 0,
    })
    .show();

  // 关闭进度窗口视为取消同步
  const onPopupUnload = () => {
    cancelled = true;
    controller.abort();
  };
  (popup.win as any).addEventListener?.("unload", onPopupUnload);

  try {
    resetConflictBatchChoice();
    const results = await syncSelectedItems({
      addTags: parseDefaultTags(),
      updateExisting: Boolean(getPref("updateExisting")),
      incrementalSync: force ? false : Boolean(getPref("incrementalSync")),
      promptOnConflict: Boolean(getPref("promptOnConflict")),
      signal: controller.signal as AbortSignal,
      onProgress: (current, total, title) => {
        if (cancelled) return;
        const percent = Math.round((current / total) * 100);
        popup.changeLine({
          progress: percent,
          text: `同步中 ${current}/${total}：${title.slice(0, 30)}`,
        });
      },
      onConflict: async (_item, title, _mapping, kind) => {
        return promptConflict(title, kind);
      },
    });

    if (cancelled) return;

    const succeeded = results.filter((r) => r.success).length;
    popup.changeLine({
      progress: 100,
      text: `完成：${succeeded}/${results.length}`,
    });
    popup.startCloseTimer(1500);
    showResults(results);
  } catch (err: any) {
    if (cancelled) return;
    popup.changeLine({
      progress: 100,
      text: err?.message || String(err),
    });
    popup.startCloseTimer(5000);
  } finally {
    resetConflictBatchChoice();
    (popup.win as any).removeEventListener?.("unload", onPopupUnload);
  }
}

// toolkit 6.0 移除了 Menu 工具，改为直接向 Zotero 原生菜单 popup 注入 menuitem
type MenuRegistration = { win: Window; id: string };
const menuRegistrations: MenuRegistration[] = [];

function appendMenuItem(
  win: Window,
  popupId: string,
  id: string,
  label: string,
  icon: string,
  onCommand: () => void,
) {
  const doc = win.document;
  const popup = doc.getElementById(popupId);
  if (!popup) {
    ztoolkit.log("Menu popup not found", popupId);
    return;
  }
  doc.getElementById(id)?.remove();
  const item = doc.createXULElement("menuitem");
  item.setAttribute("id", id);
  item.setAttribute("label", label);
  if (icon) item.setAttribute("image", icon);
  item.addEventListener("command", onCommand);
  popup.appendChild(item);
  menuRegistrations.push({ win, id });
}

export function registerMenus(win: Window) {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;

  appendMenuItem(
    win,
    "zotero-itemmenu",
    "zotero-wpsnote-sync-menuitem",
    getString("menu-sync-to-wpsnote"),
    menuIcon,
    () => {
      runSync();
    },
  );
  appendMenuItem(
    win,
    "zotero-itemmenu",
    "zotero-wpsnote-sync-force-menuitem",
    getString("menu-force-sync-to-wpsnote"),
    menuIcon,
    () => {
      runSync(true);
    },
  );
  appendMenuItem(
    win,
    "zotero-itemmenu",
    "zotero-wpsnote-sync-pull-menuitem",
    getString("menu-pull-from-wpsnote"),
    menuIcon,
    () => {
      pullFromWps();
    },
  );
  appendMenuItem(
    win,
    "zotero-collectionmenu",
    "zotero-wpsnote-sync-collection-menuitem",
    getString("menu-sync-collection-to-wpsnote"),
    menuIcon,
    () => {
      runSync();
    },
  );
  appendMenuItem(
    win,
    "zotero-collectionmenu",
    "zotero-wpsnote-sync-force-collection-menuitem",
    getString("menu-force-sync-collection-to-wpsnote"),
    menuIcon,
    () => {
      runSync(true);
    },
  );
  appendMenuItem(
    win,
    "menu_ToolsPopup",
    "zotero-wpsnote-sync-history-menuitem",
    getString("menu-sync-history"),
    menuIcon,
    () => {
      openSyncHistory();
    },
  );
}

export function unregisterMenus(win?: Window) {
  for (let i = menuRegistrations.length - 1; i >= 0; i--) {
    const reg = menuRegistrations[i];
    if (win && reg.win !== win) continue;
    try {
      reg.win.document.getElementById(reg.id)?.remove();
    } catch (e) {
      ztoolkit.log("Failed to remove menuitem", reg.id, e);
    }
    menuRegistrations.splice(i, 1);
  }
}
