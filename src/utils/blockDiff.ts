/**
 * 块级增量 diff：渲染 markdown 拆块 vs Craft 回读块，产出 PUT/插入/删除计划。
 * 匹配率过低时返回 null，调用方回退全量分区替换（正确性优先）。
 */

export interface RemoteBlock {
  id: string;
  markdown: string;
}

export interface DiffPlan {
  /** 原地更新（保留块 id） */
  puts: Array<{ id: string; markdown: string }>;
  /** 新增块：插在 anchorId 之前（anchorId 为 null = 文档开头/marker 前） */
  inserts: Array<{ markdown: string; anchorId: string | null }>;
  /** 删除的块 id */
  deletes: string[];
}

/** 归一化：去首尾空白、统一换行、`---`↔`***`、压缩行尾空白 */
export function normalizeBlockMd(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/^---$/gm, "***")
    .replace(/[ \t]+$/gm, "");
}

/**
 * 把渲染 markdown 拆成顶层块。
 * 渲染保证块间以空行分隔；callout 与代码块内部允许空行，需配对识别。
 */
export function splitTopLevelBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) blocks.push(t);
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) {
      flush();
      continue;
    }

    // callout：配对收集（内部允许空行）
    if (t.startsWith("<callout>")) {
      flush();
      const chunk = [line];
      if (!t.includes("</callout>")) {
        for (i++; i < lines.length; i++) {
          chunk.push(lines[i]);
          if (lines[i].trim().includes("</callout>")) break;
        }
      }
      const joined = chunk.join("\n").trim();
      if (joined) blocks.push(joined);
      continue;
    }

    // 代码围栏：配对收集（内部允许空行）
    if (t.startsWith("```")) {
      flush();
      const chunk = [line];
      for (i++; i < lines.length; i++) {
        chunk.push(lines[i]);
        if (lines[i].trim().startsWith("```")) break;
      }
      const joined = chunk.join("\n").trim();
      if (joined) blocks.push(joined);
      continue;
    }

    buf.push(line);
  }
  flush();
  return blocks;
}

/** 匹配查找窗口：块序列局部错位的容忍范围 */
const SEARCH_WINDOW = 30;
/** 真匹配率下限（内容原样复用的块占比）：低于则回退全量替换 */
const MIN_MATCH_RATIO = 0.5;

/**
 * 顺序对齐 diff。
 * 返回 null 表示无法可靠对齐（调用方回退全量分区替换）。
 */
export function buildDiffPlan(
  remote: RemoteBlock[],
  rendered: string[],
): DiffPlan | null {
  const plan: DiffPlan = { puts: [], inserts: [], deletes: [] };
  if (!rendered.length && !remote.length) return plan;
  if (!rendered.length) {
    // 正文为空：清空 Zotero 区
    for (const b of remote) plan.deletes.push(b.id);
    return plan;
  }

  const normRemote = remote.map((b) => normalizeBlockMd(b.markdown));
  const normRender = rendered.map((m) => normalizeBlockMd(m));

  let i = 0; // remote 游标
  let j = 0; // rendered 游标
  let matches = 0;

  const takeRenderAnchor = (afterIdx: number): string | null => {
    // 插入锚点：remote 中 afterIdx 之后的第一个保留块
    for (let k = afterIdx + 1; k < remote.length; k++) {
      if (!plan.deletes.includes(remote[k].id)) return remote[k].id;
    }
    return null; // 追加到 Zotero 区末尾（marker 前由调用方处理）
  };

  while (i < remote.length && j < normRender.length) {
    if (normRemote[i] === normRender[j]) {
      matches++;
      i++;
      j++;
      continue;
    }

    // 在 remote 前方窗口找 rendered[j]：找到 = remote[i..k) 多余 → 删
    let foundInRemote = -1;
    const endR = Math.min(remote.length, i + 1 + SEARCH_WINDOW);
    for (let k = i + 1; k < endR; k++) {
      if (normRemote[k] === normRender[j]) {
        foundInRemote = k;
        break;
      }
    }
    if (foundInRemote >= 0) {
      for (let k = i; k < foundInRemote; k++) plan.deletes.push(remote[k].id);
      i = foundInRemote;
      continue;
    }

    // 在 rendered 前方窗口找 remote[i]：找到 = rendered[j..k) 新增 → 插
    let foundInRender = -1;
    const endD = Math.min(normRender.length, j + 1 + SEARCH_WINDOW);
    for (let k = j + 1; k < endD; k++) {
      if (normRemote[i] === normRender[k]) {
        foundInRender = k;
        break;
      }
    }
    if (foundInRender >= 0) {
      const anchor = takeRenderAnchor(i - 1);
      for (let k = j; k < foundInRender; k++) {
        plan.inserts.push({ markdown: rendered[k], anchorId: anchor });
      }
      j = foundInRender;
      continue;
    }

    // 双向都找不到 → 视为原地修改（保留 id，PUT 更新内容；不算真匹配）
    // PUT 要求 markdown 解析为单一块：含空行（callout/代码块内部多段）会 400，
    // 降级为删除原块 + 在原位后继块前插入
    if (/\n[ \t]*\n/.test(rendered[j])) {
      plan.deletes.push(remote[i].id);
      plan.inserts.push({
        markdown: rendered[j],
        anchorId: remote[i + 1]?.id ?? null,
      });
    } else {
      plan.puts.push({ id: remote[i].id, markdown: rendered[j] });
    }
    i++;
    j++;
  }

  // remote 剩余 → 删除
  while (i < remote.length) {
    plan.deletes.push(remote[i].id);
    i++;
  }
  // rendered 剩余 → 插入（锚点：remote 末尾之后 = marker 前）
  if (j < normRender.length) {
    const anchor = takeRenderAnchor(remote.length - 1);
    for (; j < normRender.length; j++) {
      plan.inserts.push({ markdown: rendered[j], anchorId: anchor });
    }
  }

  const denom = remote.length || normRender.length || 1;
  if (matches / denom < MIN_MATCH_RATIO) return null;
  return plan;
}
