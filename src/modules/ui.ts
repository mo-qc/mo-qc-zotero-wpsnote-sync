/**
 * 注册右键菜单、工具栏按钮与同步进度 UI。
 */

import {
  syncSelectedItems,
  syncItem,
  SyncResult,
  ConflictResolution,
} from "./syncEngine";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { getAllMappings, removeMappedNote } from "./syncMapping";

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

function errorTypeLabel(type?: string): string {
  switch (type) {
    case "network":
      return "[网络] ";
    case "mcp":
      return "[MCP] ";
    case "image":
      return "[图片] ";
    default:
      return "";
  }
}

let conflictBatchChoice: ConflictResolution | null = null;

async function promptConflict(title: string): Promise<ConflictResolution> {
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

  const dialog = new (ztoolkit as any).Dialog(2, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: {
        innerHTML: `
          <div style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 8px 0;">文献已变更</div>
          <p style="font-size:13px;line-height:1.6;margin:0;color:#475569;">
            文献「${escapeHtml(title.slice(0, 40))}」在 Zotero 中已变更，可能已同步过到 WPS 笔记。<br/>
            请选择处理方式：
          </p>
        `,
      },
    })
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      properties: {
        innerHTML: `<input type="checkbox" data-bind="remember" data-prop="checked" style="width:14px;height:14px;accent-color:#2563eb;margin-right:8px;cursor:pointer;"/>记住选择，应用到本次同步的其余冲突`,
      },
      styles: {
        fontSize: "12px",
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
      text: `${errorTypeLabel(r.errorType)}「${r.title.slice(0, 20)}」${r.error?.slice(0, 60) || ""}`,
      type: "error",
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

function bindHistoryActions(win: Window) {
  win.document
    .querySelectorAll("[data-history-action]")
    .forEach((el: Element) => {
      el.addEventListener("click", (ev: Event) => {
        const target = ev.currentTarget as HTMLElement;
        const action = target.dataset.historyAction;
        const itemKey = target.dataset.itemKey;
        if (!itemKey) return;

        if (action === "open-note") {
          const noteUrl = target.dataset.noteUrl;
          if (noteUrl) {
            Zotero.launchURL(noteUrl);
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
            const result = await syncItem(item, {
              addTags: parseDefaultTags(),
              updateExisting: true,
            });
            popup.close();
            showResults([result]);
            refreshSyncHistory();
          })();
        } else if (action === "clear-mapping") {
          removeMappedNote(itemKey);
          refreshSyncHistory();
        }
      });
    });
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

  const rows = entries
    .map(([itemKey, entry]) => {
      const isSuccess = entry.lastSuccess === true;
      const isFailed = entry.lastSuccess === false;
      const statusClass = isSuccess
        ? "zws-status-success"
        : isFailed
          ? "zws-status-error"
          : "zws-status-pending";
      const statusDot = isSuccess
        ? "#10b981"
        : isFailed
          ? "#ef4444"
          : "#f59e0b";
      const statusText = isSuccess ? "成功" : isFailed ? "失败" : "未同步";
      const title = entry.title || "-";
      const noteId = entry.noteId || "-";
      const error = entry.lastError || "";
      const errorType = entry.lastErrorType || "";
      const noteUrl = entry.noteUrl || "";
      const openBtn = noteUrl
        ? `<button data-history-action="open-note" data-item-key="${escapeHtml(itemKey)}" data-note-url="${escapeHtml(noteUrl)}" class="zws-history-btn">打开笔记</button>`
        : `<button class="zws-history-btn" disabled>打开笔记</button>`;
      return `<tr>
<td class="zws-history-cell zws-history-title">${escapeHtml(title)}</td>
<td class="zws-history-cell zws-history-mono">${escapeHtml(itemKey)}</td>
<td class="zws-history-cell zws-history-mono">${formatSyncTime(entry.lastSync)}</td>
<td class="zws-history-cell"><span class="zws-history-status ${statusClass}"><span style="color:${statusDot};">●</span> ${statusText}</span></td>
<td class="zws-history-cell zws-history-mono">${escapeHtml(noteId)}</td>
<td class="zws-history-cell zws-history-error" title="${escapeHtml(error)}">${errorTypeLabel(errorType)}${escapeHtml(error.slice(0, 80))}</td>
<td class="zws-history-cell zws-history-actions">
${openBtn}<button data-history-action="retry" data-item-key="${escapeHtml(itemKey)}" class="zws-history-btn zws-history-btn-primary">重试</button><button data-history-action="clear-mapping" data-item-key="${escapeHtml(itemKey)}" class="zws-history-btn zws-history-btn-danger">清除映射</button>
</td>
</tr>`;
    })
    .join("");

  const tableHtml = `
<style>
  .zws-history-window {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #0f172a;
  }
  .zws-history-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12px;
  }
  .zws-history-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #f8fafc;
    color: #475569;
    font-weight: 600;
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid #e2e8f0;
  }
  .zws-history-table th:first-child { border-top-left-radius: 10px; }
  .zws-history-table th:last-child { border-top-right-radius: 10px; }
  .zws-history-table tbody tr:hover { background: #f8fafc; }
  .zws-history-cell {
    padding: 10px 12px;
    border-bottom: 1px solid #f1f5f9;
    vertical-align: middle;
  }
  .zws-history-title { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .zws-history-mono { font-family: "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, monospace; color: #64748b; white-space: nowrap; }
  .zws-history-error { color: #ef4444; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .zws-history-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 999px;
    background: #f1f5f9;
    color: #475569;
  }
  .zws-history-status.zws-status-success { background: #ecfdf5; color: #047857; }
  .zws-history-status.zws-status-error { background: #fef2f2; color: #b91c1c; }
  .zws-history-status.zws-status-pending { background: #fffbeb; color: #b45309; }
  .zws-history-actions { white-space: nowrap; display: flex; gap: 6px; }
  .zws-history-btn {
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    padding: 4px 10px;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    background: #ffffff;
    color: #475569;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .zws-history-btn:hover:not(:disabled) { background: #f8fafc; border-color: #cbd5e1; }
  .zws-history-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .zws-history-btn-primary { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
  .zws-history-btn-primary:hover:not(:disabled) { background: #dbeafe; }
  .zws-history-btn-danger { background: #fef2f2; border-color: #fecaca; color: #dc2626; }
  .zws-history-btn-danger:hover:not(:disabled) { background: #fee2e2; }
  .zws-history-empty { padding: 32px; text-align: center; color: #94a3b8; font-size: 13px; }
</style>
<div class="zws-history-window">
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
</div>`;

  const dialog = new (ztoolkit as any).Dialog(1, 1);
  const win = dialog
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: { innerHTML: tableHtml },
      styles: {
        overflow: "auto",
        maxHeight: "440px",
        width: "100%",
        padding: "4px",
      },
    })
    .open(getString("sync-history-title"), {
      width: 920,
      height: 540,
      centerscreen: true,
      resizable: true,
    });

  syncHistoryWindow = win;
  bindHistoryActions(win);
  win.addEventListener("unload", () => {
    syncHistoryWindow = null;
  });
}

export async function runSync() {
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
  (popup.win as any).addEventListener?.("unload", () => {
    cancelled = true;
    controller.abort();
  });

  try {
    resetConflictBatchChoice();
    const results = await syncSelectedItems({
      addTags: parseDefaultTags(),
      updateExisting: Boolean(getPref("updateExisting")),
      incrementalSync: Boolean(getPref("incrementalSync")),
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
      onConflict: async (_item, title) => {
        return promptConflict(title);
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
  }
}

export function registerMenus() {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;

  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `zotero-wpsnote-sync-menuitem`,
    label: getString("menu-sync-to-wpsnote"),
    icon: menuIcon,
    commandListener: (ev) => {
      runSync();
    },
  });

  ztoolkit.Menu.register("collection", {
    tag: "menuitem",
    id: `zotero-wpsnote-sync-collection-menuitem`,
    label: getString("menu-sync-collection-to-wpsnote"),
    icon: menuIcon,
    commandListener: (ev) => {
      runSync();
    },
  });

  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: `zotero-wpsnote-sync-history-menuitem`,
    label: getString("menu-sync-history"),
    commandListener: (ev) => {
      openSyncHistory();
    },
  });
}
