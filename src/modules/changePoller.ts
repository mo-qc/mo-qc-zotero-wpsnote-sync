/**
 * WPS 端改动轮询提醒（受控双向的"主动发现"环节）。
 * 定期比对映射中的 noteModified 基准，发现 WPS 端新改动时弹汇总窗，
 * 由用户决定是否批量拉取——不自动覆盖、不自动回流。
 */
import { getPref } from "../utils/prefs";
import { getAllMappings, removeMappedNote } from "./syncMapping";
import { beginOperation, endOperation, getClient } from "./syncEngine";
import { runWithConcurrency } from "../utils/concurrencyHelper";
import { pullFromWps } from "./ui";

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
/** pollOnce 开始时间（僵尸保护用），0 表示当前无进行中的轮询 */
let pollingSince = 0;
/** 已提醒过的改动（itemKey → WPS 端 update_time），同一批改动只提醒一次 */
const notified = new Map<string, string>();

export function startChangePoller(): void {
  if (pollTimer !== null) return; // 防多窗口重复启动
  scheduleNext();
}

export function stopChangePoller(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** 设置变更后立即重启轮询（关→开即时生效，间隔变更下轮生效） */
export function restartChangePoller(): void {
  stopChangePoller();
  startChangePoller();
}

function scheduleNext(): void {
  // 每轮排程前读开关：关闭时不再排程，自然停止
  if (getPref("changePollEnabled") === false) {
    pollTimer = null;
    return;
  }
  const minutes = Math.max(5, Number(getPref("changePollInterval")) || 30);
  // Zotero 10 已移除 Zotero.setTimeout，使用标准全局定时器
  pollTimer = setTimeout(
    () => {
      pollTimer = null;
      void pollOnce().catch((e) => ztoolkit.log("change poll failed", e));
      scheduleNext();
    },
    minutes * 60 * 1000,
  );
}

/**
 * 执行一轮检测：并发比对映射中各笔记的 WPS 端 update_time 与同步基准。
 * 返回新检出的 {key, wpsTime} 列表（已提醒过的同一批改动不重复返回）。
 */
export async function pollOnce(): Promise<string[]> {
  if (polling) {
    // 僵尸保护：上一轮超过 5 分钟未结束（如宿主中断导致 finally 未执行）
    // 时强制重置，避免轮询永久空转
    if (pollingSince && Date.now() - pollingSince > 5 * 60_000) {
      ztoolkit.log("pollOnce: stale polling flag reset");
      polling = false;
    } else {
      return [];
    }
  }
  polling = true;
  pollingSince = Date.now();
  try {
    let client;
    try {
      client = getClient();
    } catch {
      return []; // 未配置 MCP 时静默跳过
    }
    // 检测阶段与同步/回流互斥，避免读到同步中途的基准造成误报；
    // 弹窗等待用户操作前释放锁，不阻塞用户手动同步。
    if (!beginOperation("poll")) return [];
    let changed: { key: string; wpsTime: string }[];
    try {
      changed = await detectChanges(client);
    } finally {
      endOperation();
    }
    if (changed.length) {
      for (const c of changed) notified.set(c.key, c.wpsTime);
      await showChangeDialog(changed.map((c) => c.key));
    }
    return changed.map((c) => c.key);
  } finally {
    polling = false;
    pollingSince = 0;
  }
}

async function detectChanges(
  client: ReturnType<typeof getClient>,
): Promise<{ key: string; wpsTime: string }[]> {
  const mapping = getAllMappings();
  const entries = Object.entries(mapping).filter(
    ([, entry]) => entry.noteId && entry.lastSuccess && entry.noteModified,
  );
  if (!entries.length) return [];

  const results = await runWithConcurrency<
    [string, (typeof entries)[number][1]],
    { key: string; wpsTime: string } | null
  >(
    entries,
    async ([key, entry]) => {
      // 孤儿映射清理：条目已从 Zotero 删除时移除映射，避免每轮空查
      try {
        const item = await Zotero.Items.getByLibraryAndKey(
          Zotero.Libraries.userLibraryID,
          key,
        );
        if (!item || item.deleted) {
          removeMappedNote(key);
          ztoolkit.log("Poller: orphan mapping cleared", key);
          return null;
        }
      } catch (e) {
        ztoolkit.log("Poller: item lookup failed", key, e);
        return null;
      }
      try {
        const info = await client.getNoteInfo(entry.noteId!);
        const wps = String(info.updateTime || "");
        const base = Number(entry.noteModified);
        if (!wps || !Number.isFinite(Number(wps)) || !Number.isFinite(base)) {
          return null;
        }
        if (Number(wps) > base && notified.get(key) !== wps) {
          return { key, wpsTime: wps };
        }
        return null;
      } catch (e) {
        ztoolkit.log("getNoteInfo failed during poll", key, e); // 单条失败跳过
        return null;
      }
    },
    { concurrency: 3 },
  );
  return results.filter(
    (r): r is { key: string; wpsTime: string } => r !== null,
  );
}

async function showChangeDialog(keys: string[]): Promise<void> {
  const items: Zotero.Item[] = [];
  const titles: string[] = [];
  for (const key of keys) {
    try {
      const item = await Zotero.Items.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        key,
      );
      if (item && !item.deleted) {
        items.push(item);
        titles.push(String(item.getField("title") || key));
      }
    } catch (e) {
      ztoolkit.log("resolve item failed", key, e);
    }
  }
  if (!items.length) return;

  const esc = (s: string) => Zotero.Utilities.htmlSpecialChars(s);
  const shown = titles
    .slice(0, 8)
    .map(
      (t) =>
        `<li style="margin:4px 0;color:#334155;font-size:13px;">${esc(t.slice(0, 50))}</li>`,
    )
    .join("");
  const more =
    titles.length > 8
      ? `<li style="margin:4px 0;color:#64748b;font-size:13px;">…共 ${titles.length} 篇</li>`
      : "";

  const dialogData: {
    _lastButtonId?: string;
    unloadLock?: { promise: Promise<void> };
  } = {};

  const dialog = new (ztoolkit as any).Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: {
        innerHTML: `
          <div style="font-size:16px;font-weight:600;color:#0f172a;margin:0 0 8px 0;">WPS 笔记有新改动</div>
          <p style="font-size:13px;line-height:1.6;margin:0 0 8px 0;color:#475569;">
            检测到以下笔记在 WPS 端被修改过。拉取会把 WPS 最新内容更新到回流子笔记（重复拉取不会产生重复笔记）；也可稍后在条目右键菜单「从 WPS 拉取」处理。
          </p>
          <ul style="margin:0;padding:0 0 0 18px;max-height:180px;overflow-y:auto;">${shown}${more}</ul>
        `,
      },
    })
    .addButton("全部拉取", "pull")
    .addButton("稍后处理", "later")
    .setDialogData(dialogData);

  dialog.open("Zotero → WPS 笔记同步", {
    width: 480,
    height: 340,
    centerscreen: true,
    resizable: false,
    fitContent: true,
    noDialogMode: true,
  });

  await dialog.dialogData.unloadLock!.promise;

  if (dialog.dialogData._lastButtonId === "pull") {
    await pullFromWps(items);
  }
}
