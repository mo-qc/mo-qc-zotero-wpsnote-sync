/**
 * WPS 端改动轮询提醒（受控双向的"主动发现"环节）。
 * 定期比对映射中的 noteModified 基准，发现 WPS 端新改动时弹汇总窗，
 * 由用户决定是否批量拉取——不自动覆盖、不自动回流。
 */
import { getPref, getCraftConfig } from "../utils/prefs";
import { getAllMappings, removeMappedNote } from "./syncMapping";
import { beginOperation, endOperation, getClient } from "./syncEngine";
import {
  getCraftClient,
  CraftError,
  extractLastModified,
  type CraftClient,
} from "./craftClient";
import { clearCraftDocIdFromExtra } from "./craftSync";
import { runWithConcurrency } from "../utils/concurrencyHelper";
import { pullFromCraft, pullFromWps } from "./ui";

type ChangedEntry = { key: string; wpsTime: string; target: "wps" | "craft" };

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
/** pollOnce 开始时间（僵尸保护用），0 表示当前无进行中的轮询 */
let pollingSince = 0;
/** 已提醒过的改动（itemKey → WPS 端 update_time），同一批改动只提醒一次 */
const notified = new Map<string, string>();
/** notified 上限：防止长期运行无界增长（超限时淘汰最早条目，Map 保插入序） */
const NOTIFIED_MAX = 2000;

function markNotified(key: string, time: string): void {
  notified.set(key, time);
  if (notified.size > NOTIFIED_MAX) {
    const oldest = notified.keys().next().value;
    if (oldest !== undefined) notified.delete(oldest);
  }
}

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
    let wpsClient: ReturnType<typeof getClient> | undefined;
    try {
      wpsClient = getClient();
    } catch {
      wpsClient = undefined; // WPS MCP 未配置：只走 Craft 检测
    }
    const craftCfg = getCraftConfig();
    const craftClient =
      craftCfg.link && craftCfg.token
        ? getCraftClient(craftCfg.link, craftCfg.token)
        : undefined;
    if (!wpsClient && !craftClient) return []; // 两端都未配置时静默跳过
    // 检测阶段与同步/回流互斥，避免读到同步中途的基准造成误报；
    // 弹窗等待用户操作前释放锁，不阻塞用户手动同步。
    if (!beginOperation("poll")) return [];
    let changed: ChangedEntry[];
    try {
      changed = await detectChanges(wpsClient, craftClient);
    } finally {
      endOperation();
    }
    if (changed.length) {
      for (const c of changed) markNotified(c.key, c.wpsTime);
      await showChangeDialog(changed);
    }
    return changed.map((c) => c.key);
  } finally {
    polling = false;
    pollingSince = 0;
  }
}

/**
 * 一次性拉取全部 WPS 笔记的 update_time 索引。
 * 失败（未配置/网络/鉴权）返回 null，由调用方退回逐条 get_note_info。
 */
async function loadWpsUpdateTimes(
  client: ReturnType<typeof getClient>,
): Promise<Map<string, number> | null> {
  try {
    return await client.getNoteUpdateTimes();
  } catch (e) {
    ztoolkit.log("Poller: list_notes failed, fallback per-note", e);
    return null;
  }
}

/**
 * 一次性拉取全部 Craft 文档的 lastModifiedAt 索引（fetchMetadata）。
 * 失败返回 null，由调用方退回逐文档 fetchBlocks。
 */
async function loadCraftModifiedTimes(
  client: CraftClient,
): Promise<Map<string, string> | null> {
  try {
    const res = await client.listDocuments({ fetchMetadata: true });
    const map = new Map<string, string>();
    for (const doc of res.items || []) {
      const id = String(doc.id || "");
      const modified = String(
        doc.lastModifiedAt || extractLastModified(doc) || "",
      );
      if (id && modified) map.set(id, modified);
    }
    return map;
  } catch (e) {
    ztoolkit.log("Poller: listDocuments failed, fallback per-document", e);
    return null;
  }
}

async function detectChanges(
  wpsClient: ReturnType<typeof getClient> | undefined,
  craftClient: CraftClient | undefined,
): Promise<ChangedEntry[]> {
  const mapping = getAllMappings();
  const entries = Object.entries(mapping).filter(
    ([, entry]) =>
      entry.lastSuccess &&
      entry.noteModified &&
      (entry.noteId || entry.craftDocId),
  );
  if (!entries.length) return [];

  // 批量预取远端时间索引：list_notes / GET /documents 各一次请求拿到全量
  // update_time / lastModifiedAt，把「映射条数 × 1 次请求」降为固定 2 次。
  // 取不到（网络/鉴权失败）时索引为 null，退回逐条查询，不阻断轮询。
  const wpsTimes = wpsClient ? await loadWpsUpdateTimes(wpsClient) : null;
  const craftTimes = craftClient
    ? await loadCraftModifiedTimes(craftClient)
    : null;

  const results = await runWithConcurrency<
    [string, (typeof entries)[number][1]],
    ChangedEntry | null
  >(
    entries,
    async ([key, entry]) => {
      // 孤儿映射清理：条目已从 Zotero 删除时移除映射，避免每轮空查
      let item: Zotero.Item | undefined;
      try {
        const found = await Zotero.Items.getByLibraryAndKey(
          Zotero.Libraries.userLibraryID,
          key,
        );
        if (!found || found.deleted) {
          removeMappedNote(key);
          ztoolkit.log("Poller: orphan mapping cleared", key);
          return null;
        }
        item = found;
      } catch (e) {
        ztoolkit.log("Poller: item lookup failed", key, e);
        return null;
      }
      const base = String(entry.noteModified || "");
      // 基准格式分流：ISO 时间来自 Craft 同步，纯数字来自 WPS 同步
      if (/\d{4}-\d{2}-\d{2}T/.test(base)) {
        if (!craftClient || !entry.craftDocId) return null;
        const prev = Date.parse(base);
        if (!Number.isFinite(prev)) return null;

        // 批量索引命中：无需额外请求
        const cached = craftTimes?.get(entry.craftDocId);
        if (cached !== undefined) {
          const curr = Date.parse(cached);
          if (
            Number.isFinite(curr) &&
            curr > prev &&
            notified.get(key) !== cached
          ) {
            return { key, wpsTime: cached, target: "craft" as const };
          }
          return null;
        }

        // 索引未命中（文档不在列表中/拉取失败）→ 逐条校验
        try {
          const root = await craftClient.fetchBlocks(entry.craftDocId, {
            maxDepth: 0,
            fetchMetadata: true,
          });
          const remote = String(extractLastModified(root) || "");
          const curr = Date.parse(remote);
          if (
            remote &&
            Number.isFinite(curr) &&
            curr > prev &&
            notified.get(key) !== remote
          ) {
            return { key, wpsTime: remote, target: "craft" as const };
          }
          return null;
        } catch (e) {
          if (
            e instanceof CraftError &&
            (e.status === 404 || e.status === 400)
          ) {
            // 文档已删（回收站）：清映射与 extra 冗余，下次同步走新建。
            // 增量跳过先行后，同步路径不再做存在性校验，轮询成为唯一的悬空映射发现点
            removeMappedNote(key);
            if (item) await clearCraftDocIdFromExtra(item);
            ztoolkit.log("Poller: craft doc missing, mapping cleared", key);
          } else {
            ztoolkit.log("fetchBlocks failed during poll", key, e);
          }
          return null;
        }
      }
      if (!wpsClient || !entry.noteId) return null;
      const baseNum = Number(base);
      if (!Number.isFinite(baseNum)) return null;

      const cachedWps = wpsTimes?.get(entry.noteId);
      if (cachedWps !== undefined) {
        return cachedWps > baseNum && notified.get(key) !== String(cachedWps)
          ? { key, wpsTime: String(cachedWps), target: "wps" as const }
          : null;
      }

      try {
        const info = await wpsClient.getNoteInfo(entry.noteId);
        const wps = String(info.updateTime || "");
        if (!wps || !Number.isFinite(Number(wps))) {
          return null;
        }
        if (Number(wps) > baseNum && notified.get(key) !== wps) {
          return { key, wpsTime: wps, target: "wps" as const };
        }
        return null;
      } catch (e) {
        ztoolkit.log("getNoteInfo failed during poll", key, e); // 单条失败跳过
        return null;
      }
    },
    { concurrency: 3 },
  );
  return results.filter((r): r is ChangedEntry => r !== null);
}

async function showChangeDialog(changed: ChangedEntry[]): Promise<void> {
  const items: Zotero.Item[] = [];
  const titles: string[] = [];
  const targetOf = new Map<string, "wps" | "craft">();
  for (const c of changed) {
    try {
      const item = await Zotero.Items.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        c.key,
      );
      if (item && !item.deleted) {
        items.push(item);
        titles.push(String(item.getField("title") || c.key));
        targetOf.set(item.key, c.target);
      }
    } catch (e) {
      ztoolkit.log("resolve item failed", c.key, e);
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

  const hasWps = changed.some((c) => c.target === "wps");
  const hasCraft = changed.some((c) => c.target === "craft");
  const headline =
    hasWps && hasCraft
      ? "同步目标有新改动"
      : hasCraft
        ? "Craft 文档有新改动"
        : "WPS 笔记有新改动";
  const desc =
    hasWps && hasCraft
      ? "检测到以下条目在 WPS/Craft 端被修改过。拉取会把最新内容更新到回流子笔记（重复拉取不会产生重复笔记）；也可稍后在条目右键菜单「从 WPS 拉取 / 从 Craft 拉取」处理。"
      : hasCraft
        ? "检测到以下文档在 Craft 端被修改过。拉取会把 Craft 最新内容更新到回流子笔记（重复拉取不会产生重复笔记）；也可稍后在条目右键菜单「从 Craft 拉取」处理。"
        : "检测到以下笔记在 WPS 端被修改过。拉取会把 WPS 最新内容更新到回流子笔记（重复拉取不会产生重复笔记）；也可稍后在条目右键菜单「从 WPS 拉取」处理。";

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
          <div style="font-size:16px;font-weight:600;color:#0f172a;margin:0 0 8px 0;">${headline}</div>
          <p style="font-size:13px;line-height:1.6;margin:0 0 8px 0;color:#475569;">
            ${desc}
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
    const wpsItems: Zotero.Item[] = [];
    const craftItems: Zotero.Item[] = [];
    for (const it of items) {
      if (targetOf.get(it.key) === "craft") craftItems.push(it);
      else wpsItems.push(it);
    }
    if (wpsItems.length) await pullFromWps(wpsItems);
    if (craftItems.length) await pullFromCraft(craftItems);
  }
}
