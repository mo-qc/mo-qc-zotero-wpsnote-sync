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
        innerHTML: `<p style="font-size:14px;line-height:1.5;margin:0 0 12px 0;">文献「${escapeHtml(title.slice(0, 40))}」在 Zotero 中已变更，可能已同步过到 WPS 笔记。<br/>请选择处理方式：</p>`,
      },
    })
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      properties: {
        innerHTML: `<input type="checkbox" data-bind="remember" data-prop="checked" style="margin-right:6px;"/>记住选择，应用到本次同步的其余冲突`,
      },
      styles: {
        fontSize: "13px",
        display: "flex",
        alignItems: "center",
      },
    })
    .addButton("覆盖 WPS 笔记", "overwrite")
    .addButton("跳过本次", "skip")
    .addButton("新建副本", "create-copy")
    .setDialogData(dialogData);

  dialog.open("Zotero → WPS 笔记同步冲突", {
    width: 420,
    height: 180,
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
  const resolution = mapping[dialog.dialogData._lastButtonId || ""] || "overwrite";
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

  const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 6000,
  }).createLine({
    text: `成功 ${succeeded.length} 条，失败 ${failed.length} 条`,
    type: failed.length === results.length ? "error" : "default",
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
      const item = (Zotero.Items as any).getByLibraryAndKey(
        lib.libraryID,
        key,
      );
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
  win.document.querySelectorAll("[data-history-action]").forEach((el: Element) => {
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
      const status =
        entry.lastSuccess === true
          ? "成功"
          : entry.lastSuccess === false
            ? "失败"
            : "未同步";
      const title = entry.title || "-";
      const noteId = entry.noteId || "-";
      const error = entry.lastError || "";
      const errorType = entry.lastErrorType || "";
      const noteUrl = entry.noteUrl || "";
      const openBtn = noteUrl
        ? `<button data-history-action="open-note" data-item-key="${escapeHtml(itemKey)}" data-note-url="${escapeHtml(noteUrl)}" style="margin-right:4px;padding:2px 6px;font-size:12px;">打开笔记</button>`
        : "";
      return `<tr>
<td style="padding:4px;border-bottom:1px solid #eee;">${escapeHtml(title)}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">${escapeHtml(itemKey)}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">${formatSyncTime(entry.lastSync)}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">${status}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">${escapeHtml(noteId)}</td>
<td style="padding:4px;border-bottom:1px solid #eee;color:red;max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(error)}">${errorTypeLabel(errorType)}${escapeHtml(error.slice(0, 80))}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">
${openBtn}<button data-history-action="retry" data-item-key="${escapeHtml(itemKey)}" style="margin-right:4px;padding:2px 6px;font-size:12px;">重试</button><button data-history-action="clear-mapping" data-item-key="${escapeHtml(itemKey)}" style="padding:2px 6px;font-size:12px;">清除映射</button>
</td>
</tr>`;
    })
    .join("");

  const tableHtml = `<table style="border-collapse:collapse;width:100%;font-size:13px;">
<thead>
<tr>
<th style="text-align:left;border-bottom:2px solid #ccc;padding:4px;">标题</th>
<th style="text-align:left;border-bottom:2px solid #ccc;padding:4px;">Zotero Key</th>
<th style="text-align:left;border-bottom:2px solid #ccc;padding:4px;">上次同步时间</th>
<th style="text-align:left;border-bottom:2px solid #ccc;padding:4px;">状态</th>
<th style="text-align:left;border-bottom:2px solid #ccc;padding:4px;">WPS Note ID</th>
<th style="text-align:left;border-bottom:2px solid #ccc;padding:4px;">错误信息</th>
<th style="text-align:left;border-bottom:2px solid #ccc;padding:4px;">操作</th>
</tr>
</thead>
<tbody>
${rows || '<tr><td colspan="7" style="padding:12px;color:#999;text-align:center;">暂无同步记录</td></tr>'}
</tbody>
</table>`;

  const dialog = new (ztoolkit as any).Dialog(1, 1);
  const win = dialog
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: { innerHTML: tableHtml },
      styles: {
        overflow: "auto",
        maxHeight: "420px",
        width: "100%",
        padding: "8px",
      },
    })
    .open(getString("sync-history-title"), {
      width: 900,
      height: 520,
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
