import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { registerMenus, runSync, openSyncHistory } from "./modules/ui";
import { syncSelectedItems, syncItem } from "./modules/syncEngine";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { getPref } from "./utils/prefs";

// Notifier observer ID，用于插件关闭时注销
let notifierObserverID: string | null = null;
// 自动同步去重集合，防止同一 item 并发触发多次同步
const syncingItems = new Set<string>();
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
  registerMenus();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // 清理该窗口注入的样式表
  const link = styleSheetRegistry.get(win);
  if (link && link.parentNode) {
    link.parentNode.removeChild(link);
    styleSheetRegistry.delete(win);
  }
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

  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // 自动同步：当启用且条目标签包含 autoSyncTag 时触发同步
  if (type !== "item" || event !== "modify") return;

  if (!getPref("autoSyncEnabled")) return;

  const autoSyncTag = String(getPref("autoSyncTag") || "").trim();
  if (!autoSyncTag) return;

  for (const itemId of ids) {
    const item = Zotero.Items.get(itemId);
    if (!item || !item.isRegularItem || !item.isRegularItem()) continue;

    const tags = item.getTags
      ? item
          .getTags()
          .map((t: any) => String(t.tag || ""))
          .filter(Boolean)
      : [];
    if (!tags.includes(autoSyncTag)) continue;

    const itemKey = item.key;
    if (syncingItems.has(itemKey)) continue;
    syncingItems.add(itemKey);

    try {
      await syncItem(item, {
        addTags: ["Zotero"],
        updateExisting: true,
      });
    } catch (e: any) {
      ztoolkit.log("Auto-sync failed", item.key, e?.message || String(e));
    } finally {
      syncingItems.delete(itemKey);
    }
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
