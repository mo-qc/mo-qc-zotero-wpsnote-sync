import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import {
  registerMenus,
  unregisterMenus,
  closeSyncHistoryWindow,
  runSync,
  openSyncHistory,
  pullFromWps,
  pullFromCraft,
} from "./modules/ui";
import {
  syncSelectedItems,
  syncItem,
  getClient,
  beginOperation,
  endOperation,
  isSelfSave,
  type ConflictKind,
  type ConflictResolution,
} from "./modules/syncEngine";
import {
  startChangePoller,
  stopChangePoller,
  pollOnce,
} from "./modules/changePoller";
import { registerAgentTools, unregisterAgentTools } from "./modules/agentTools";
import { registerMcpServer, unregisterMcpServer } from "./modules/mcpServer";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { htmlToWpsXml } from "./utils/htmlToWps";
import { getPref } from "./utils/prefs";
import {
  getMappedEntry,
  removeMappedNote,
  updateNoteModified,
} from "./modules/syncMapping";

// Notifier observer ID，用于插件关闭时注销
let notifierObserverID: string | null = null;
// 自动同步去重集合，防止同一 item 并发触发多次同步
const syncingItems = new Set<string>();
// 自动同步防抖定时器，避免连续 modify 触发多次同步
const autoSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
// 每个主窗口注入的样式表，窗口卸载时清理
const styleSheetRegistry = new WeakMap<Window, HTMLLinkElement>();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  registerPrefs();

  // 注册 Zotero.Notifier，监听 item 修改事件（用于标签触发自动同步）
  notifierObserverID = Zotero.Notifier.registerObserver(
    { notify: onNotify },
    ["item"],
    "zotero-wpsnote-sync",
  );

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // 暴露 API 供调试/自动化调用
  (addon.api as any).runSync = runSync;
  (addon.api as any).syncSelectedItems = syncSelectedItems;
  (addon.api as any).openSyncHistory = openSyncHistory;
  (addon.api as any).pullFromWps = pullFromWps;
  (addon.api as any).pullFromCraft = pullFromCraft;
  (addon.api as any).updateNoteModified = updateNoteModified;
  (addon.api as any).readNote = (noteId: string) =>
    getClient().readNote(noteId);
  (addon.api as any).syncItem = syncItem;
  (addon.api as any).searchNotes = (query: string, limit?: number) =>
    getClient().searchNotes(query, limit);
  (addon.api as any).pollOnce = pollOnce;
  (addon.api as any).htmlToWpsXml = (html: string) => htmlToWpsXml(html);
  (addon.api as any).callTool = (name: string, args: Record<string, unknown>) =>
    (
      getClient() as unknown as {
        callTool: (n: string, a: unknown) => Promise<unknown>;
      }
    ).callTool(name, args);
  (addon.api as any).createReportNote = async (title: string, xml: string) => {
    const client = getClient();
    const created = await client.createNote(title);
    const outline = await client.getNoteOutline(created.noteId);
    const firstBlockId = outline?.blocks?.[0]?.id;
    if (!firstBlockId) throw new Error("无法获取笔记初始 block_id");
    await client.editBlock(created.noteId, "replace", {
      block_id: firstBlockId,
      content: xml,
    });
    return { noteId: created.noteId, noteUrl: created.noteUrl };
  };

  // llm-for-zotero Agent 工具注册（对话式同步）+ 本插件 MCP Server（/wpsnote/mcp）
  registerAgentTools();
  registerMcpServer();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // 避免多窗口时重复覆盖全局 ztoolkit 实例
  if (!addon.data.ztoolkit) {
    addon.data.ztoolkit = createZToolkit();
  }

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerStyleSheet(win);
  registerMenus(win);

  // 启动 WPS 改动轮询提醒（内部防多窗口重复启动）
  startChangePoller();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // 清理该窗口注入的样式表
  const link = styleSheetRegistry.get(win);
  if (link && link.parentNode) {
    link.parentNode.removeChild(link);
    styleSheetRegistry.delete(win);
  }
  unregisterMenus(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  // 注销 Notifier observer
  if (notifierObserverID !== null) {
    try {
      Zotero.Notifier.unregisterObserver(notifierObserverID);
    } catch (e) {
      ztoolkit.log("Failed to unregister notifier observer", e);
    }
    notifierObserverID = null;
  }

  // 清理未执行的自动同步定时器
  for (const timerId of autoSyncTimers.values()) {
    clearTimeout(timerId);
  }
  autoSyncTimers.clear();

  // 停止 WPS 改动轮询
  stopChangePoller();

  // 注销 llm-for-zotero 工具与本插件 MCP Server
  unregisterAgentTools();
  unregisterMcpServer();

  // 关闭同步历史窗口，避免插件更新/禁用后残留孤儿窗口
  closeSyncHistoryWindow();
  unregisterMenus();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * 根据批注或附件 item 找到其所属的常规文献条目。
 * 顺序：annotation -> attachment parent -> regular item
 */
function resolveRegularItem(item: Zotero.Item): Zotero.Item | undefined {
  if (!item) return undefined;

  if (item.isRegularItem && item.isRegularItem()) {
    return item;
  }

  if (item.isAnnotation && item.isAnnotation()) {
    const parentItem = item.parentItem;
    if (parentItem && parentItem.isRegularItem && parentItem.isRegularItem()) {
      return parentItem;
    }
    const grandParent =
      parentItem?.parentID && parentItem.parentID
        ? Zotero.Items.get(parentItem.parentID)
        : undefined;
    if (
      grandParent &&
      grandParent.isRegularItem &&
      grandParent.isRegularItem()
    ) {
      return grandParent;
    }
    return undefined;
  }

  if (item.isAttachment && item.isAttachment()) {
    const parentItem = item.parentItem;
    if (parentItem && parentItem.isRegularItem && parentItem.isRegularItem()) {
      return parentItem;
    }
    return undefined;
  }

  // 子笔记修改（AI 写入/手动编辑）→ 归属父条目；standalone 笔记无父不触发
  if (item.isNote && item.isNote()) {
    const parentItem = item.parentItem;
    if (parentItem && parentItem.isRegularItem && parentItem.isRegularItem()) {
      return parentItem;
    }
    return undefined;
  }

  return undefined;
}

function getItemTags(item: Zotero.Item): string[] {
  return item.getTags
    ? item
        .getTags()
        .map((t: any) => String(t.tag || ""))
        .filter(Boolean)
    : [];
}

/**
 * 自动同步的冲突策略：无人在场，宁可跳过不可覆盖。
 *
 * - kind = "item"（Zotero 侧变更）：这正是本次自动同步要推送的内容，直接覆盖远端；
 * - kind = "wps"/"craft"（远端被手改）：自动同步时无法弹窗征询，跳过本次并把
 *   远端改动留在原地，弹提醒由用户手动处理（手动同步/回流）。
 * 不受 promptOnConflict 偏好影响：手动同步关掉提示是用户在场时的授权，
 * 自动同步无人在场，静默覆盖的代价比多弹一条提醒高。
 */
export function autoSyncConflictPolicy(
  kind: ConflictKind | undefined,
  title: string,
): ConflictResolution {
  if (!kind || kind === "item") return "overwrite";
  notifyAutoSyncRemoteConflict(kind, title);
  return "skip";
}

function notifyAutoSyncRemoteConflict(kind: ConflictKind, title: string) {
  try {
    const target = kind === "craft" ? "Craft" : "WPS";
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeTime: 8000,
    })
      .createLine({
        text: `检测到 ${target} 端有手改，自动同步已跳过（请手动同步或回流）：${title.slice(0, 40)}`,
        type: "warning",
      })
      .show();
  } catch (e) {
    ztoolkit.log("Auto-sync conflict notify failed", e);
  }
}

function scheduleAutoSync(item: Zotero.Item, delay = 2000): void {
  const itemKey = item.key;
  const existing = autoSyncTimers.get(itemKey);
  if (existing) {
    clearTimeout(existing);
  }

  // Zotero 10 已移除 Zotero.setTimeout，使用标准全局定时器
  const timerId = setTimeout(async () => {
    autoSyncTimers.delete(itemKey);
    if (syncingItems.has(itemKey)) return;
    // 与批量同步/回流互斥：撞锁时跳过本次（下次修改或手动同步会覆盖）
    if (!beginOperation("autosync")) {
      ztoolkit.log("Auto-sync skipped: another operation in progress", itemKey);
      return;
    }
    syncingItems.add(itemKey);
    try {
      await syncItem(item, {
        addTags: ["Zotero"],
        updateExisting: true,
        // 修改事件即变更信号：子笔记/批注修改不 bump 父条目 dateModified，
        // 走增量会被误判"未变更"而跳过，导致 AI/手动改的内容推不到 WPS
        incrementalSync: false,
        // 无人在场：条目自身变更是推送意图（覆盖），远端手改一律跳过并提醒
        promptOnConflict: true,
        onConflict: (_item, title, _mapping, kind) =>
          Promise.resolve(autoSyncConflictPolicy(kind, title)),
      });
    } catch (e: any) {
      ztoolkit.log("Auto-sync failed", item.key, e?.message || String(e));
    } finally {
      syncingItems.delete(itemKey);
      endOperation();
    }
  }, delay);

  autoSyncTimers.set(itemKey, timerId);
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // 自动同步：监听 item 的 add/modify 事件
  if (type !== "item" || (event !== "modify" && event !== "add")) return;

  if (!getPref("autoSyncEnabled")) return;

  const autoSyncTag = String(getPref("autoSyncTag") || "").trim();
  const autoSyncOnModify = Boolean(getPref("autoSyncOnModify"));
  if (!autoSyncTag && !autoSyncOnModify) return;

  for (const itemId of ids) {
    const rawItem = Zotero.Items.get(itemId);
    if (!rawItem) continue;

    // 批注/附件修改时，需要找到其归属的常规条目
    const item = resolveRegularItem(rawItem);
    if (!item) continue;

    const itemKey = item.key;
    if (syncingItems.has(itemKey)) continue;

    // 插件自己写 extra 冗余触发的 modify：跳过，避免每次同步后再
    // 白白多跑一轮全量同步（内容未变，纯双倍请求）
    if (isSelfSave(itemKey)) continue;

    const tags = getItemTags(item);
    const shouldSyncByTag = autoSyncTag && tags.includes(autoSyncTag);
    const shouldSyncByModify = autoSyncOnModify && event === "modify";
    if (!shouldSyncByTag && !shouldSyncByModify) continue;

    scheduleAutoSync(item);
  }
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function registerPrefs() {
  const rootURI = `chrome://${addon.data.config.addonRef}/`;
  // reload 会重复注册，先移除同插件旧 pane，避免设置侧栏出现重复入口
  try {
    const existing =
      (
        Zotero.PreferencePanes as unknown as {
          pluginPanes?: Array<{ id: string; pluginID: string }>;
        }
      ).pluginPanes || [];
    for (const p of existing) {
      if (p.pluginID === addon.data.config.addonID) {
        Zotero.PreferencePanes.unregister(p.id);
      }
    }
  } catch {
    // 去重失败不影响注册
  }
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: rootURI + "content/icons/favicon.png",
  });
}

function registerStyleSheet(win: Window) {
  const doc = win.document;
  const root = doc.documentElement;
  if (!root) return;
  // 避免重复注入
  if (styleSheetRegistry.has(win)) return;
  const styles = doc.createElement("link");
  styles.rel = "stylesheet";
  styles.href = `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`;
  styles.type = "text/css";
  root.appendChild(styles);
  styleSheetRegistry.set(win, styles);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
