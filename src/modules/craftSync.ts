/**
 * Zotero → Craft 文档同步（syncTarget=craft 时的执行路径）。
 *
 * Craft 特性驱动的同步方案：
 * - 内容以 Markdown 全量替换（fetch children → delete → insert），无 WPS 式块级增量
 * - 标题搜索兜底召回已存在文档（GET /documents/search）
 * - 429 限流由 CraftClient 统一退避；空间级预算 100 req/60s
 * - 映射 craftDocId + extra 冗余 ZWS-Craft-Id 双保险
 */

import type { SyncOptions, SyncResult, ConflictKind } from "./syncEngine";
import { markSelfSave } from "./syncEngine";
import {
  extractItemData,
  getItemModifiedTime,
  type ExtractOptions,
} from "./zoteroItem";
import { buildNoteTitle, buildNoteXml } from "../utils/xmlBuilder";
import { wpsXmlToCraftMarkdown } from "../utils/craftMarkdown";
import { splitTopLevelBlocks, buildDiffPlan } from "../utils/blockDiff";
import { getCraftConfig, getPref } from "../utils/prefs";
import {
  getCraftClient,
  CraftError,
  extractLastModified,
  type CraftClient,
} from "./craftClient";
import {
  getCraftMappedEntry,
  getAllMappings,
  recordSyncResult,
  removeMappedNote,
} from "./syncMapping";

const EXTRA_CRAFT_ID_KEY = "ZWS-Craft-Id";

/** 分区标记块内容：标记之前 = Zotero 区（同步器独占），之后 = 用户笔记区（永不覆盖） */
const PARTITION_PHRASE = "以下为我的笔记";
const PARTITION_MARKER_MARKDOWN = `---\n\n**✍️ ${PARTITION_PHRASE}**（Zotero 同步不会覆盖此区域）`;

/**
 * 内容指纹（FNV-1a 双 32 位 = 64 位 hex）：判断渲染结果是否与上次写入一致，
 * 一致则零请求跳过。只对正文（不含同步脚注——脚注含当前时间，每次渲染必变）。
 */
export function computeContentHash(text: string): string {
  const fnv = (seed: number): string => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      // h *= 16777619（FNV 素数），拆乘防 32 位溢出精度丢失
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x1b873593);
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Operation cancelled");
  }
}

function getDefaultExtractOptions(): ExtractOptions {
  const read = (key: keyof ExtractOptions) => {
    const prefKey =
      `sync${key.charAt(0).toUpperCase()}${key.slice(1)}` as never;
    const val = getPref(prefKey);
    return val === undefined ? true : Boolean(val);
  };
  return {
    includeAbstract: read("includeAbstract"),
    includeAttachments: read("includeAttachments"),
    includeAnnotations: read("includeAnnotations"),
    includeTags: read("includeTags"),
    includeNotes: read("includeNotes"),
  };
}

function findFolderByName(
  nodes: { id: string; name?: string; folders?: unknown[] }[],
  name: string,
): { id: string } | null {
  for (const n of nodes) {
    if (String(n.name || "").trim() === name) return { id: n.id };
    const sub = (n.folders || []) as typeof nodes;
    if (sub.length) {
      const hit = findFolderByName(sub, name);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 按首标签解析归档文件夹（craftArchiveByTag 开启时）：
 * 找同名 Craft 文件夹，没有就建在默认文件夹下；任何失败都回落默认文件夹，
 * 归档失败不阻塞同步本身。
 */
async function resolveArchiveFolderId(
  client: CraftClient,
  item: Zotero.Item,
  cfg: { folderId: string },
): Promise<string | undefined> {
  const fallback = cfg.folderId || undefined;
  try {
    if (!getPref("craftArchiveByTag")) return fallback;
    const tags = item
      .getTags()
      .map((t) => String(t.tag || "").trim())
      .filter(Boolean);
    if (!tags.length) return fallback;
    // 归档标签选择：优先含 / 的层级标签（语义分类），否则第一个"正常"
    // 标签（字母/数字/中文开头——跳过 /done、emoji 等标记型标签）
    const bare = (t: string) => t.replace(/^#/, "");
    const hierarchical = tags.find((t) => t.includes("/"));
    const normal = tags.find((t) => /^[\w一-鿿]/.test(bare(t)));
    const tag = hierarchical || normal || tags[0];
    // 文件夹名规范化：去 #、斜杠与空白转连字符（Craft 对含 / 的文件夹名
    // 会直接 502）、连续分隔符合并、去首尾连字符、限长
    const name = bare(tag)
      .replace(/[/\s]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    if (!name) return fallback;
    const tree = await client.listFolders();
    const hit = findFolderByName(tree.items || [], name);
    if (hit) return hit.id;
    const created = await client.createFolders([
      { name, parentFolderId: cfg.folderId || undefined },
    ]);
    const id = (created.items || [])[0]?.id;
    if (id) {
      ztoolkit.log("Craft archive folder created", name, id);
      return id;
    }
    return fallback;
  } catch (e) {
    ztoolkit.log("Craft archive folder resolve failed, fallback", e);
    return fallback;
  }
}

/** 从条目 extra 读取冗余备份的 Craft documentId */
export function readCraftDocIdFromExtra(item: Zotero.Item): string | undefined {
  const extra = (item.getField("extra") as string) || "";
  for (const line of extra.split(/\r?\n/)) {
    const m = line.match(/^\s*ZWS-Craft-Id\s*:\s*(\S+)\s*$/i);
    if (m) return m[1];
  }
  return undefined;
}

/** 把 Craft documentId 冗余写入 extra（幂等，失败不阻断） */
export async function writeCraftDocIdToExtra(
  item: Zotero.Item,
  docId: string,
): Promise<void> {
  try {
    const base = ((item.getField("extra") as string) || "").replace(/\s+$/, "");
    const lines = base
      ? base.split(/\r?\n/).filter((l) => !/^\s*ZWS-Craft-Id\s*:/i.test(l))
      : [];
    const next = [...lines, `${EXTRA_CRAFT_ID_KEY}: ${docId}`].join("\n");
    if (next === base) return;
    item.setField("extra", next);
    markSelfSave(item.key);
    await item.saveTx();
    ztoolkit.log("Wrote craftDocId to item extra", item.key, docId);
  } catch (e) {
    ztoolkit.log("Write craftDocId to extra failed (non-fatal)", e);
  }
}

/** 清除 extra 中的 Craft 冗余行（映射文档被删时调用） */
export async function clearCraftDocIdFromExtra(
  item: Zotero.Item,
): Promise<void> {
  try {
    const base = ((item.getField("extra") as string) || "").replace(/\s+$/, "");
    const lines = base
      ? base.split(/\r?\n/).filter((l) => !/^\s*ZWS-Craft-Id\s*:/i.test(l))
      : [];
    const next = lines.join("\n");
    if (next === base) return;
    item.setField("extra", next);
    markSelfSave(item.key);
    await item.saveTx();
    ztoolkit.log("Cleared craftDocId from item extra", item.key);
  } catch (e) {
    ztoolkit.log("Clear craftDocId from extra failed (non-fatal)", e);
  }
}

function classifyCraftError(err: unknown): SyncResult["errorType"] {
  if (err instanceof CraftError) {
    if (err.status === 0 || err.code === "NETWORK") return "network";
    if (err.status === 401 || err.status === 403 || err.status === 429) {
      return "network";
    }
    return "mcp";
  }
  return "other";
}

/**
 * 全量替换文档正文：取根下子块 → 先插入新 Markdown → 再删旧子块。
 * 先插后删：insert 失败（断网/429）时旧内容仍在，不会留下只剩标题的空文档；
 * insert 成功而 delete 部分失败时内容短暂重复，下次同步 fetch 全量子块后自愈。
 */
/**
 * 全量替换文档正文：取根下子块 → 先插入新 Markdown → 再删旧子块。
 * 先插后删：insert 失败（断网/429）时旧内容仍在，不会留下只剩标题的空文档；
 * insert 成功而 delete 失败时，同轮重取子块复核后重删一次，仍滞留则抛错——
 * 本轮判失败可保住增量基准（recordSyncResult 不写 lastSuccess），
 * 下次同步走完整流程真正自愈；若静默容忍，增量跳过会让重复内容
 * 一直滞留到条目下次被修改。
 *
 * 分区模式（markerBlockId 已知或远端存在标记块）：
 * 标记块之前的块 = Zotero 区（同步器独占，可安全删除重写）；
 * 标记块及其后的块 = 用户笔记区，本函数永不触碰。
 * 无标记块（首次分区/老文档）：按全量替换处理，写入后在末尾建立标记。
 */
export async function replaceDocumentContent(
  client: CraftClient,
  docId: string,
  markdown: string,
  markerBlockId?: string,
): Promise<{ markerBlockId?: string }> {
  const root = await client.fetchBlocks(docId, { maxDepth: 1 });
  const blocks = (root.content || []).filter((b) => b.id && b.id !== docId);

  // 定位标记块：已知 id 优先（抗用户改文案），内容短语兜底（id 丢失/被移动）。
  // id 命中须排除分隔线块：`---` 开头的 marker markdown 会被 Craft 拆成
  // 「*** 分隔线 + 文本」两块，历史版本误把分隔线 id 记成了 marker
  const isDivider = (md: string) => {
    const t = md.trim();
    return t === "***" || t === "---";
  };
  let markerIdx = markerBlockId
    ? blocks.findIndex(
        (b) => b.id === markerBlockId && !isDivider(String(b.markdown || "")),
      )
    : -1;
  if (markerIdx < 0) {
    markerIdx = blocks.findIndex((b) =>
      String(b.markdown || "").includes(PARTITION_PHRASE),
    );
  }
  const marker = markerIdx >= 0 ? blocks[markerIdx] : undefined;

  if (marker) {
    // P1 块级增量：PUT 变更块（保留 id）、删多余、插缺失；匹配率不足回退全量
    const remote = blocks
      .slice(0, markerIdx)
      .map((b) => ({ id: b.id as string, markdown: String(b.markdown || "") }));
    const rendered = splitTopLevelBlocks(markdown);
    const plan = buildDiffPlan(remote, rendered);

    if (plan) {
      try {
        if (plan.puts.length) {
          await client.updateBlocks(plan.puts);
        }
      } catch (e) {
        // PUT 失败（如 MARKDOWN_PARSING_ERROR）→ 记录诊断并回退全量分区替换
        ztoolkit.log(
          "Craft block PUT failed, fallback to full partition replace",
          e,
          plan.puts
            .slice(0, 3)
            .map((p) => ({ id: p.id, md: p.markdown.slice(0, 120) })),
        );
        const fbIds = blocks.slice(0, markerIdx).map((b) => b.id);
        await deleteBlocksWithRecheck(client, docId, fbIds);
        if (markdown.trim()) {
          await client.insertBlocks(docId, markdown, {
            position: "before",
            siblingId: marker.id,
          });
        }
        return { markerBlockId: marker.id };
      }
      // 先插后删：降级插入的锚点可能是待删块，先插保锚点存在
      if (plan.inserts.length) {
        let insIdx = 0;
        while (insIdx < plan.inserts.length) {
          const anchor = plan.inserts[insIdx].anchorId;
          const chunk: string[] = [];
          while (
            insIdx < plan.inserts.length &&
            plan.inserts[insIdx].anchorId === anchor
          ) {
            chunk.push(plan.inserts[insIdx].markdown);
            insIdx++;
          }
          await client.insertBlocks(docId, chunk.join("\n\n"), {
            position: "before",
            siblingId: anchor ?? marker.id,
          });
        }
      }
      if (plan.deletes.length) {
        await deleteBlocksWithRecheck(client, docId, plan.deletes);
      }
      return { markerBlockId: marker.id };
    }
    // 匹配率不足（模板大改/结构漂移）→ 回退 P0 全量分区替换
    const oldIds = blocks.slice(0, markerIdx).map((b) => b.id);
    await deleteBlocksWithRecheck(client, docId, oldIds);
    if (markdown.trim()) {
      await client.insertBlocks(docId, markdown, {
        position: "before",
        siblingId: marker.id,
      });
    }
    return { markerBlockId: marker.id };
  }

  // 无标记：全量替换（先插后删保底）+ 末尾建立标记块
  const oldIds = blocks.map((b) => b.id);
  if (markdown.trim()) {
    await client.insertBlocks(docId, markdown, {
      position: "end",
      pageId: docId,
    });
  }
  const markerRes = await client.insertBlocks(
    docId,
    PARTITION_MARKER_MARKDOWN,
    {
      position: "end",
      pageId: docId,
    },
  );
  // Craft 会把 `---` 拆成「分隔线 + 文本」两块：取含短语的文本块，勿取 items[0]
  const markerItems = markerRes.items || [];
  const markerItem =
    markerItems.find((it) =>
      String(it.markdown || "").includes(PARTITION_PHRASE),
    ) ?? markerItems[markerItems.length - 1];
  const newMarkerId = markerItem?.id;
  await deleteBlocksWithRecheck(client, docId, oldIds);
  return { markerBlockId: newMarkerId };
}

/** 删除块 + 失败复核重删（滞留则抛错，下次同步自愈） */
async function deleteBlocksWithRecheck(
  client: CraftClient,
  docId: string,
  oldIds: string[],
): Promise<void> {
  if (!oldIds.length) return;

  const failed: string[] = [];
  for (let i = 0; i < oldIds.length; i += 100) {
    const batch = oldIds.slice(i, i + 100);
    try {
      await client.deleteBlocks(batch);
    } catch (e) {
      ztoolkit.log("deleteBlocks batch failed, will recheck", e);
      failed.push(...batch);
    }
  }
  if (!failed.length) return;

  // 复核：重取子块后，滞留块 = 失败批次 ∩ 仍存在的块
  // （新内容 id 不在 oldIds 里，不会误判；Craft 端合并/重排后
  // 部分旧 id 已消失，交集才是真滞留）
  const after = await client.fetchBlocks(docId, { maxDepth: 1 });
  const afterIds = new Set((after.content || []).map((b) => b.id));
  const leftover = failed.filter((id) => afterIds.has(id));
  if (!leftover.length) return;

  for (let i = 0; i < leftover.length; i += 100) {
    try {
      await client.deleteBlocks(leftover.slice(i, i + 100));
    } catch (e) {
      throw new CraftError(
        `旧内容清理失败（${leftover.length} 块滞留），本次同步判失败，下次同步将自动重试：${
          e instanceof Error ? e.message : String(e)
        }`,
        0,
        "DELETE_LEFTOVER",
      );
    }
  }
}

/** 读取文档 lastModifiedAt（映射基准用） */
async function fetchDocModified(
  client: CraftClient,
  docId: string,
): Promise<string | undefined> {
  try {
    const root = await client.fetchBlocks(docId, {
      maxDepth: 0,
      fetchMetadata: true,
    });
    return extractLastModified(root);
  } catch {
    return undefined;
  }
}

/** 同步元信息脚注：灰色小字 + 回链（Craft 块级 <caption>），追加在正文末尾 */
function buildSyncFootNote(data: { zoteroLink?: string }): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const link = data.zoteroLink
    ? ` · [在 Zotero 中打开](${data.zoteroLink})`
    : "";
  return `\n\n---\n<caption>同步于 ${time}${link}</caption>`;
}

export async function syncItemCraft(
  item: Zotero.Item,
  options?: SyncOptions,
): Promise<SyncResult> {
  const result: SyncResult = {
    success: false,
    itemKey: item.key,
    title: String(item.getField("title") || ""),
  };

  const cfg = getCraftConfig();
  if (!cfg.link || !cfg.token) {
    result.error = "Craft 未配置：请在设置中填写 API Link 与 Token";
    result.errorType = "other";
    return result;
  }
  const client = getCraftClient(cfg.link, cfg.token);
  const itemModified = getItemModifiedTime(item);

  try {
    const titleTemplate =
      options?.titleTemplate || String(getPref("titleTemplate") || "");
    const bodyTemplate =
      options?.bodyTemplate || String(getPref("bodyTemplate") || "");

    const include = options?.include ?? getDefaultExtractOptions();
    const data = extractItemData(item, include);
    const title = buildNoteTitle(data, titleTemplate);
    // 正文与脚注分离：脚注含同步时间（每次渲染必变），指纹只算正文，
    // 否则幂等跳过永远不命中
    const bodyMarkdown = wpsXmlToCraftMarkdown(
      buildNoteXml(data, bodyTemplate),
    );
    const contentHash = computeContentHash(bodyMarkdown);
    const markdown = bodyMarkdown + buildSyncFootNote(data);
    result.title = data.title;

    checkCancelled(options?.signal);

    const updateExisting =
      options?.updateExisting ?? Boolean(getPref("updateExisting"));
    let mappedEntry = updateExisting
      ? getCraftMappedEntry(item.key)
      : undefined;
    let docId = mappedEntry?.craftDocId;

    // extra 冗余恢复（映射丢失时）
    if (!docId && updateExisting) {
      const extraDocId = readCraftDocIdFromExtra(item);
      if (extraDocId) {
        ztoolkit.log("Restore craftDocId from extra", item.key, extraDocId);
        docId = extraDocId;
      }
    }

    // 增量跳过：文献未变更（纯本地判断，先行返回避免逐条远端校验的请求开销；
    // Craft 端手改检测由 changePoller 轮询兜底，条目实际变更时仍走完整流程）。
    // 要求 noteModified 基准存在：老映射基准缺失时跳过会让轮询永远无法检测该条
    // （轮询 filter 要求基准），走一次完整同步补上基准后恢复零请求跳过
    const incrementalSync =
      options?.incrementalSync ?? Boolean(getPref("incrementalSync"));
    if (
      incrementalSync &&
      docId &&
      mappedEntry?.lastSuccess &&
      mappedEntry.itemModified &&
      mappedEntry.noteModified &&
      mappedEntry.itemModified === itemModified
    ) {
      ztoolkit.log("Incremental craft sync: skip unchanged", item.key);
      result.success = true;
      result.noteId = docId;
      result.noteUrl = mappedEntry.noteUrl;
      recordSyncResult(item.key, {
        success: true,
        title: data.title,
        craftDocId: docId,
        noteUrl: mappedEntry.noteUrl,
        itemModified,
      });
      await writeCraftDocIdToExtra(item, docId);
      return result;
    }

    const promptOnConflict =
      options?.promptOnConflict ?? Boolean(getPref("promptOnConflict"));
    let forceNewDoc = false;

    // 存在性校验：文档被删（回收站）则清映射走新建。
    // fetchMetadata 顺带取 lastModifiedAt，零额外请求即可检测 Craft 侧手工修改
    let remoteModified: string | undefined;
    if (docId && updateExisting) {
      try {
        const root = await client.fetchBlocks(docId, {
          maxDepth: 0,
          fetchMetadata: true,
        });
        remoteModified = extractLastModified(root);
      } catch (e) {
        if (e instanceof CraftError && (e.status === 404 || e.status === 400)) {
          ztoolkit.log(
            "Mapped craft document missing, clearing mapping",
            item.key,
            docId,
          );
          removeMappedNote(item.key);
          await clearCraftDocIdFromExtra(item);
          docId = undefined;
          mappedEntry = undefined;
        }
        // 其余错误（网络/限流）保守沿用映射，避免误建重复文档
      }
    }

    // 内容指纹跳过：渲染正文与上次写入一致（条目改了不参与同步的字段、
    // 标签重排等渲染等价场景）→ 对齐基准后零写入返回。
    // 要求分区标记就绪：老映射无标记时走完整流程完成首次分区建标
    if (
      incrementalSync &&
      docId &&
      mappedEntry?.lastSuccess &&
      mappedEntry.markerBlockId &&
      mappedEntry.contentHash &&
      mappedEntry.contentHash === contentHash
    ) {
      ztoolkit.log("Content-hash craft sync: skip unchanged render", item.key);
      recordSyncResult(item.key, {
        success: true,
        title: data.title,
        craftDocId: docId,
        noteUrl: mappedEntry.noteUrl,
        itemModified,
        // 存在性校验已拿到的远端现状即新基准（Craft 区手改不再触发冲突）
        ...(remoteModified ? { noteModified: remoteModified } : {}),
        contentHash,
        markerBlockId: mappedEntry.markerBlockId,
      });
      result.success = true;
      result.noteId = docId;
      result.noteUrl = mappedEntry.noteUrl;
      await writeCraftDocIdToExtra(item, docId);
      return result;
    }

    // Craft 侧改动检测：上次同步后 Craft 文档被手工修改（lastModifiedAt 晚于记录基准）。
    // 仅在条目实际变更、走完整流程时执行；条目未变的增量跳过场景由 changePoller 轮询兜底。
    // noteModified 为 WPS 数字时间戳（目标切换场景）时 Date.parse 得 NaN，保守不触发。
    // 分区就绪（markerBlockId 存在）时跳过检测：标记后的用户笔记区手改是预期行为，
    // 标记前的 Zotero 区本就以 Zotero 为准会被安全覆盖，两者都不构成冲突
    if (
      docId &&
      mappedEntry?.lastSuccess &&
      mappedEntry.noteModified &&
      remoteModified &&
      !mappedEntry.markerBlockId
    ) {
      const prev = Date.parse(mappedEntry.noteModified);
      const curr = Date.parse(remoteModified);
      if (!Number.isNaN(prev) && !Number.isNaN(curr) && curr > prev) {
        ztoolkit.log(
          "Craft-side modification detected",
          item.key,
          mappedEntry.noteModified,
          "->",
          remoteModified,
        );
        if (promptOnConflict && options?.onConflict) {
          const resolution = await options.onConflict(
            item,
            data.title,
            mappedEntry,
            "craft",
          );
          if (resolution === "skip") {
            result.success = true;
            result.noteId = docId;
            result.noteUrl = mappedEntry.noteUrl;
            // skip 后对齐 noteModified 基准（Craft 端现状即新基准）：
            // 不更新会让每次同步都重复弹同一处 Craft 侧改动冲突。
            // itemModified 不动——条目侧变更尚未处理，下次同步仍会正常提示
            recordSyncResult(item.key, {
              success: true,
              title: data.title,
              craftDocId: docId,
              noteUrl: mappedEntry.noteUrl,
              noteModified: remoteModified,
            });
            return result;
          }
          if (resolution === "create-copy") {
            docId = undefined;
            mappedEntry = undefined;
            forceNewDoc = true;
          }
          // overwrite：继续走覆盖流程
        }
      }
    }

    // 冲突提示（Zotero 侧变更，映射存在）
    if (
      docId &&
      mappedEntry?.lastSuccess &&
      mappedEntry.itemModified &&
      mappedEntry.itemModified !== itemModified
    ) {
      if (promptOnConflict && options?.onConflict) {
        const resolution = await options.onConflict(
          item,
          data.title,
          mappedEntry,
          "item" as ConflictKind,
        );
        if (resolution === "skip") {
          result.success = true;
          result.noteId = docId;
          result.noteUrl = mappedEntry.noteUrl;
          // skip 后对齐 itemModified（本次已知晓条目变更并选择跳过），
          // 否则条目时间恒晚于基准，每次同步都重复弹同一处冲突；
          // noteModified 不动——Craft 端未写入，改动检测语义保持
          recordSyncResult(item.key, {
            success: true,
            title: data.title,
            craftDocId: docId,
            noteUrl: mappedEntry.noteUrl,
            itemModified,
            noteModified: mappedEntry.noteModified,
          });
          return result;
        }
        if (resolution === "create-copy") {
          docId = undefined;
          mappedEntry = undefined;
          forceNewDoc = true;
        }
      }
    }

    checkCancelled(options?.signal);

    let wasCreated = false;
    if (!docId) {
      // 搜索兜底：按标题召回已存在文档（映射丢失/extra 缺失场景）。
      // forceNewDoc（冲突选了"新建副本"）时跳过——否则会按同标题召回原文档，
      // 把"新建副本"退化成"覆盖原文档"
      if (updateExisting && !forceNewDoc) {
        try {
          const hits = await client.searchDocuments(data.title);
          const hit = (hits.items || []).find(
            (d) => d.id && (d.title || "").trim() === title.trim(),
          );
          if (hit) {
            // 归属校验：同名文献场景下该文档可能已映射给其他条目，
            // 接管会让两篇共写一个文档——宁可新建
            const owner = Object.entries(getAllMappings()).find(
              ([k, e]) => k !== item.key && e.craftDocId === hit.id,
            );
            if (owner) {
              ztoolkit.log(
                "Craft search fallback hit owned by another item, skip",
                hit.id,
                owner[0],
              );
            } else {
              docId = hit.id;
              ztoolkit.log("Craft search fallback hit", item.key, docId);
            }
          }
        } catch (e) {
          ztoolkit.log("Craft search fallback failed (non-fatal)", e);
        }
      }
    }

    if (!docId) {
      const targetFolder = await resolveArchiveFolderId(client, item, cfg);
      const created = await client.createDocuments([title], targetFolder);
      const doc = (created.items || [])[0];
      if (!doc?.id) {
        throw new CraftError("Craft 创建文档未返回 id", 0, "NO_DOC_ID");
      }
      docId = doc.id;
      wasCreated = true;
      ztoolkit.log("Created craft document", item.key, docId, title);
    }

    // 写入。映射文档在回收站时可读不可写（存在性校验的 fetchBlocks 照常 200，
    // POST /blocks 才报 400 "Cannot modify document in trash"）：清映射并本次自动重建
    let newMarkerId = mappedEntry?.markerBlockId;
    try {
      const replaced = await replaceDocumentContent(
        client,
        docId,
        markdown,
        mappedEntry?.markerBlockId,
      );
      newMarkerId = replaced.markerBlockId || newMarkerId;
    } catch (e) {
      if (
        e instanceof CraftError &&
        e.status === 400 &&
        /trash/i.test(e.message) &&
        !wasCreated
      ) {
        ztoolkit.log("Craft document in trash, recreating", item.key, docId);
        removeMappedNote(item.key);
        await clearCraftDocIdFromExtra(item);
        const targetFolder = await resolveArchiveFolderId(client, item, cfg);
        const created = await client.createDocuments([title], targetFolder);
        const doc = (created.items || [])[0];
        if (!doc?.id) {
          throw new CraftError("Craft 创建文档未返回 id", 0, "NO_DOC_ID");
        }
        docId = doc.id;
        wasCreated = true;
        const replaced = await replaceDocumentContent(client, docId, markdown);
        newMarkerId = replaced.markerBlockId;
      } else {
        throw e;
      }
    }

    const craftModified = await fetchDocModified(client, docId);
    // 写入后立读可能拿到 Craft 端尚未更新的旧时间：基准必须单调递增，
    // 读到早于旧基准的时间时保留旧基准，防止基准回退导致每次同步误报改动。
    // Date.parse 对非 ISO（WPS 数字时间戳）返回 NaN，比较不成立，天然不触发
    let effectiveModified = craftModified;
    const prevModified = mappedEntry?.noteModified;
    if (
      craftModified &&
      prevModified &&
      Date.parse(craftModified) < Date.parse(prevModified)
    ) {
      effectiveModified = prevModified;
    }
    const noteUrl = await client.webUrl(docId);

    recordSyncResult(item.key, {
      success: true,
      title: data.title,
      craftDocId: docId,
      noteUrl,
      itemModified,
      // 读取失败（空串）时不传，避免空值覆盖既有基准
      ...(effectiveModified ? { noteModified: effectiveModified } : {}),
      contentHash,
      ...(newMarkerId ? { markerBlockId: newMarkerId } : {}),
    });
    await writeCraftDocIdToExtra(item, docId);

    result.success = true;
    result.noteId = docId;
    result.noteUrl = noteUrl;
    result.noteModified = effectiveModified || undefined;
    if (wasCreated) {
      ztoolkit.log("Craft sync created", item.key, title);
    }
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.error = msg;
    result.errorType = classifyCraftError(e);
    result.errorCode = e instanceof CraftError ? e.status || e.code : undefined;
    // 失败不传 itemModified/noteModified：保留既有增量基准
    recordSyncResult(item.key, {
      success: false,
      title: result.title,
      error: msg,
      errorType: result.errorType,
      errorCode: result.errorCode,
    });
    ztoolkit.log("Craft sync failed", item.key, msg);
    return result;
  }
}
