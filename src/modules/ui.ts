/**
 * 注册右键菜单、工具栏按钮与同步进度 UI。
 */

import { syncSelectedItems, SyncResult } from "./syncEngine";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { getAllMappings } from "./syncMapping";

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

function showResults(results: SyncResult[]) {
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (succeeded.length && !failed.length) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: 5000,
    })
      .createLine({
        text: `成功同步 ${succeeded.length} 条文献到 WPS 笔记`,
        type: "success",
      })
      .show();
  } else if (failed.length) {
    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: -1,
    }).createLine({
      text: `成功 ${succeeded.length} 条，失败 ${failed.length} 条`,
      type: failed.length === results.length ? "error" : "default",
    });
    for (const r of failed.slice(0, 3)) {
      popup.createLine({
        text: `「${r.title.slice(0, 20)}」${r.error?.slice(0, 60) || ""}`,
        type: "error",
      });
    }
    popup.show();
  }
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
      return `<tr>
<td style="padding:4px;border-bottom:1px solid #eee;">${escapeHtml(title)}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">${escapeHtml(itemKey)}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">${formatSyncTime(entry.lastSync)}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">${status}</td>
<td style="padding:4px;border-bottom:1px solid #eee;white-space:nowrap;">${escapeHtml(noteId)}</td>
<td style="padding:4px;border-bottom:1px solid #eee;color:red;max-width:220px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(error)}</td>
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
</tr>
</thead>
<tbody>
${rows || '<tr><td colspan="6" style="padding:12px;color:#999;text-align:center;">暂无同步记录</td></tr>'}
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
      width: 800,
      height: 500,
      centerscreen: true,
      resizable: true,
    });

  syncHistoryWindow = win;
  win.addEventListener("unload", () => {
    syncHistoryWindow = null;
  });
}

export async function runSync() {
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

  try {
    const results = await syncSelectedItems({
      addTags: parseDefaultTags(),
      updateExisting: Boolean(getPref("updateExisting")),
      onProgress: (current, total, title) => {
        const percent = Math.round((current / total) * 100);
        popup.changeLine({
          progress: percent,
          text: `同步中 ${current}/${total}：${title.slice(0, 30)}`,
        });
      },
    });

    const succeeded = results.filter((r) => r.success).length;
    popup.changeLine({
      progress: 100,
      text: `完成：${succeeded}/${results.length}`,
    });
    popup.startCloseTimer(1500);
    showResults(results);
  } catch (err: any) {
    popup.changeLine({
      progress: 100,
      text: err?.message || String(err),
    });
    popup.startCloseTimer(5000);
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

  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: `zotero-wpsnote-sync-history-menuitem`,
    label: getString("menu-sync-history"),
    commandListener: (ev) => {
      openSyncHistory();
    },
  });
}
