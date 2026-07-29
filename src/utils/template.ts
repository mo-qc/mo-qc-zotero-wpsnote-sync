/**
 * 轻量级模板引擎，用于自定义同步到 WPS 笔记的 XML 内容。
 *
 * 支持的语法：
 *   {{field}}          转义输出
 *   {{{field}}}        原样输出（用于已有 XML/HTML）
 *   {{#if field}}...{{else}}...{{/if}}
 *   {{#unless field}}...{{else}}...{{/unless}}
 *   {{#each list}}...{{/each}}
 *
 * 每个 {{#each}} 块内部可使用 {{this}}、{{field}} 访问当前项。
 */

import type {
  ZoteroItemData,
  ZoteroAttachment,
  ZoteroNote,
  ZoteroAnnotation,
} from "./xmlBuilder";
import { escapeXml, paragraph, link } from "./xmlHelpers";
import { markdownToWpsXml, splitMarkdownByTable } from "./markdown";

export { getDefaultTitleTemplate, getDefaultBodyTemplate };

function enrichAnnotation(a: ZoteroAnnotation) {
  const commentSplit = a.comment ? splitMarkdownByTable(a.comment) : null;
  return {
    ...a,
    typeLabel: annotationTypeLabel(a.type),
    textParagraph: a.text ? paragraph(a.text) : "",
    commentParagraph: a.comment ? paragraph(a.comment) : "",
    commentXml: a.comment ? markdownToWpsXml(a.comment) : "",
    commentHasTable: !!commentSplit?.table,
    commentBeforeTableXml: commentSplit?.before || "",
    commentTableXml: commentSplit?.table || "",
    commentAfterTableXml: commentSplit?.after || "",
    tagsJoined: a.tags.join(" · "),
    tagsXml: a.tags.map(tagToXml).join(""),
    hasText: !!a.text,
    hasComment: !!a.comment,
    hasImage: a.type === "image" && !!a.imageAttachmentKey,
    pageIndex:
      a.position?.pageIndex !== undefined
        ? String(a.position.pageIndex + 1)
        : a.pageLabel,
  };
}

function annotationTypeLabel(type: string): string {
  if (isChineseLocale()) {
    const labels: Record<string, string> = {
      highlight: "高亮",
      note: "批注",
      underline: "下划线",
      text: "文本",
      image: "截图",
      ink: "墨迹",
    };
    return labels[type] || type;
  }
  const labels: Record<string, string> = {
    highlight: "Highlight",
    note: "Note",
    underline: "Underline",
    text: "Text",
    image: "Image",
    ink: "Ink",
  };
  return labels[type] || type;
}

function tagToXml(tag: string): string {
  let normalized = String(tag || "").trim();
  if (!normalized) return "";
  if (!normalized.startsWith("#")) {
    normalized = "#" + normalized;
  }
  // WPS <tag> 要求：不能有空格、方括号；多级用 / 分隔
  normalized = normalized.replace(/\s+/g, "/").replace(/[[\]]/g, "");

  // 限制每级最多 20 字，最多 10 级
  const parts = normalized.slice(1).split("/").slice(0, 10);
  const limited = parts.map((p) => p.slice(0, 20));
  normalized = "#" + limited.join("/");

  if (normalized === "#") return "";
  return `<tag>${normalized}</tag>`;
}

function annotationColorName(color?: string): string {
  if (isChineseLocale()) {
    const names: Record<string, string> = {
      "#ff6666": "红色",
      "#ff8c19": "橙色",
      "#ffd400": "黄色",
      "#5fb236": "绿色",
      "#2ea8e5": "蓝色",
      "#a28ae5": "紫色",
      "#e56eee": "粉色",
      "#f198b2": "玫红",
      "#aaaaaa": "灰色",
      "#000000": "黑色",
    };
    return names[(color || "").toLowerCase()] || "未分类";
  }
  const names: Record<string, string> = {
    "#ff6666": "Red",
    "#ff8c19": "Orange",
    "#ffd400": "Yellow",
    "#5fb236": "Green",
    "#2ea8e5": "Blue",
    "#a28ae5": "Purple",
    "#e56eee": "Pink",
    "#f198b2": "Rose",
    "#aaaaaa": "Gray",
    "#000000": "Black",
  };
  return names[(color || "").toLowerCase()] || "Uncategorized";
}

function groupAnnotationsByPage(
  annotations: ZoteroAnnotation[],
): { pageLabel: string; items: ZoteroAnnotation[] }[] {
  const groups = new Map<string, ZoteroAnnotation[]>();
  for (const ann of annotations) {
    const list = groups.get(ann.pageLabel) || [];
    list.push(ann);
    groups.set(ann.pageLabel, list);
  }
  return Array.from(groups.entries()).map(([pageLabel, items]) => ({
    pageLabel,
    items,
  }));
}

function groupAnnotationsByColor(
  annotations: ZoteroAnnotation[],
): { color: string; colorName: string; items: ZoteroAnnotation[] }[] {
  const groups = new Map<string, ZoteroAnnotation[]>();
  for (const ann of annotations) {
    const key = ann.color || "default";
    const list = groups.get(key) || [];
    list.push(ann);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).map(([color, items]) => ({
    color,
    colorName: annotationColorName(color),
    items,
  }));
}

function isTruthy(value: any): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "boolean") return value;
  return !!value;
}

function getValue(ctx: any, path: string): any {
  if (path === "this") return ctx;
  if (path === ".") return ctx;
  const parts = path.split(".");
  let value = ctx;
  for (const part of parts) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

type TemplateNode =
  | { type: "text"; value: string }
  | { type: "each"; path: string; children: TemplateNode[] }
  | {
      type: "if";
      path: string;
      children: TemplateNode[];
      elseChildren?: TemplateNode[];
    }
  | {
      type: "unless";
      path: string;
      children: TemplateNode[];
      elseChildren?: TemplateNode[];
    }
  | { type: "var"; path: string; raw: boolean };

function tokenizeTemplate(template: string): TemplateNode[] {
  const tokens: TemplateNode[] = [];
  const regex =
    /\{\{#each\s+([-\w.]+)\}\}|\{\{\/each\}\}|\{\{#if\s+([-\w.]+)\}\}|\{\{#unless\s+([-\w.]+)\}\}|\{\{else\}\}|\{\{\/if\}\}|\{\{\/unless\}\}|\{\{\{([-\w.]+)\}\}\}|\{\{([-\w.]+)\}\}/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        type: "text",
        value: template.slice(lastIndex, match.index),
      });
    }

    if (match[1]) {
      tokens.push({ type: "each", path: match[1], children: [] });
    } else if (match[0] === "{{/each}}") {
      tokens.push({ type: "text", value: "{{/each}}" });
    } else if (match[2]) {
      tokens.push({ type: "if", path: match[2], children: [] });
    } else if (match[3]) {
      tokens.push({ type: "unless", path: match[3], children: [] });
    } else if (match[0] === "{{else}}") {
      tokens.push({ type: "text", value: "{{else}}" });
    } else if (match[0] === "{{/if}}") {
      tokens.push({ type: "text", value: "{{/if}}" });
    } else if (match[0] === "{{/unless}}") {
      tokens.push({ type: "text", value: "{{/unless}}" });
    } else if (match[4]) {
      tokens.push({ type: "var", path: match[4], raw: true });
    } else if (match[5]) {
      tokens.push({ type: "var", path: match[5], raw: false });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < template.length) {
    tokens.push({ type: "text", value: template.slice(lastIndex) });
  }

  return tokens;
}

function parseTemplate(tokens: TemplateNode[]): TemplateNode[] {
  type Frame = {
    nodes: TemplateNode[];
    elseNodes?: TemplateNode[];
    type?: "each" | "if";
    inElse?: boolean;
  };
  const stack: Frame[] = [{ nodes: [] }];

  function currentNodes(): TemplateNode[] {
    const frame = stack[stack.length - 1];
    return frame.inElse ? frame.elseNodes || frame.nodes : frame.nodes;
  }

  function pushNode(token: TemplateNode) {
    currentNodes().push(token);
  }

  for (const token of tokens) {
    if (token.type === "text" && token.value === "{{/each}}") {
      const frame = stack.pop();
      if (!frame || frame.type !== "each") {
        throw new Error("Unexpected {{/each}}");
      }
      const block =
        stack[stack.length - 1].nodes[stack[stack.length - 1].nodes.length - 1];
      if (block && block.type === "each") {
        block.children = frame.nodes;
      }
    } else if (token.type === "text" && token.value === "{{else}}") {
      const frame = stack[stack.length - 1];
      if (!frame || frame.type !== "if") {
        throw new Error("Unexpected {{else}}");
      }
      frame.inElse = true;
      frame.elseNodes = [];
    } else if (
      token.type === "text" &&
      (token.value === "{{/if}}" || token.value === "{{/unless}}")
    ) {
      const frame = stack.pop();
      if (!frame || frame.type !== "if") {
        throw new Error(`Unexpected ${token.value}`);
      }
      const block =
        stack[stack.length - 1].nodes[stack[stack.length - 1].nodes.length - 1];
      if (block && (block.type === "if" || block.type === "unless")) {
        block.children = frame.nodes;
        if (frame.elseNodes) {
          block.elseChildren = frame.elseNodes;
        }
      }
    } else if (token.type === "each") {
      pushNode(token);
      stack.push({ nodes: [], type: "each" });
    } else if (token.type === "if" || token.type === "unless") {
      pushNode(token);
      stack.push({ nodes: [], type: "if" });
    } else {
      pushNode(token);
    }
  }

  if (stack.length !== 1) {
    throw new Error("Unclosed template block");
  }

  return stack[0].nodes;
}

function renderNodes(nodes: TemplateNode[], ctx: any, root: any): string {
  return nodes.map((node) => renderNode(node, ctx, root)).join("");
}

function renderNode(node: TemplateNode, ctx: any, root: any): string {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type === "var") {
    const value = getValue(ctx, node.path) ?? getValue(root, node.path);
    if (value === undefined || value === null) return "";
    return node.raw ? String(value) : escapeXml(String(value));
  }
  if (node.type === "each") {
    const list = getValue(ctx, node.path) ?? getValue(root, node.path);
    if (!Array.isArray(list) || !list.length) return "";
    return list
      .map((item: any) => renderNodes(node.children, item, root))
      .join("");
  }
  if (node.type === "if") {
    const value = getValue(ctx, node.path) ?? getValue(root, node.path);
    return isTruthy(value)
      ? renderNodes(node.children, ctx, root)
      : renderNodes(node.elseChildren || [], ctx, root);
  }
  if (node.type === "unless") {
    const value = getValue(ctx, node.path) ?? getValue(root, node.path);
    return isTruthy(value)
      ? renderNodes(node.elseChildren || [], ctx, root)
      : renderNodes(node.children, ctx, root);
  }
  return "";
}

function renderTemplate(template: string, ctx: any, root: any): string {
  const tokens = tokenizeTemplate(template);
  const nodes = parseTemplate(tokens);
  return renderNodes(nodes, ctx, root);
}

export function renderItemTemplate(
  template: string,
  item: ZoteroItemData,
): string {
  // 提供一些便于模板使用的别名和派生字段
  const enriched = {
    ...item,
    itemKey: item.key,
    authors: item.creators.join("; "),
    yearOrDate: item.year || item.date || "",
    hasDOI: !!item.DOI,
    hasURL: !!item.url,
    hasAbstract: !!item.abstract,
    hasAttachments: item.attachments.length > 0,
    hasNotes: item.notes.length > 0,
    hasTags: item.tags.length > 0,
    hasAnnotations: item.annotations.length > 0,
    // each 循环内可能用到的帮助字段
    attachments: item.attachments.map((a) => ({
      ...a,
      isPDF: a.isPDF || a.contentType === "application/pdf",
      zoteroOpenLink: link(
        `zotero://open-pdf/library/items/${a.key}`,
        a.isPDF ? "在 Zotero 中打开 PDF" : "在 Zotero 中打开",
      ),
    })),
    notes: item.notes.map((n) => ({
      ...n,
      plainText: n.content
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " "),
      contentParagraph: paragraph(
        n.content
          .replace(/<img\b[^>]*>/gi, "[图片]")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .trim(),
      ),
      hasImages: Array.isArray(n.images) && n.images.length > 0,
      imageCount: Array.isArray(n.images) ? n.images.length : 0,
    })),
    doiLink: item.DOI
      ? link(`https://doi.org/${encodeURIComponent(item.DOI)}`, item.DOI)
      : "",
    urlLink: item.url ? link(item.url, item.url) : "",
    abstractParagraph: item.abstract ? paragraph(item.abstract) : "",
    tagsJoined: item.tags.join(" · "),
    annotations: item.annotations.map((a) => enrichAnnotation(a)),
    annotationGroups: groupAnnotationsByPage(item.annotations).map((g) => ({
      pageLabel: g.pageLabel,
      items: g.items.map((a) => enrichAnnotation(a)),
    })),
    annotationGroupsByColor: groupAnnotationsByColor(item.annotations).map(
      (g) => ({
        color: g.color,
        colorName: g.colorName,
        items: g.items.map((a) => enrichAnnotation(a)),
      }),
    ),
  };

  let rendered = renderTemplate(template, enriched, enriched);

  // 清理空标签和连续空行
  rendered = rendered
    .replace(/<p>\s*<\/p>/g, "")
    .replace(/<h[1-6]>\s*<\/h[1-6]>/g, "")
    .replace(/\n\s*\n/g, "\n");

  return rendered;
}

const DEFAULT_TITLE_TEMPLATE = "[Zotero] {{title}}";

const DEFAULT_BODY_TEMPLATE_EN = `<h1>{{title}}</h1>
<highlightBlock emoji="💡" highlightBlockBackgroundColor="#FAF1E6" highlightBlockBorderColor="#FEC794">
{{#if authors}}<p><strong>Author(s):</strong> {{authors}}</p>{{/if}}
{{#if publicationTitle}}<p><strong>Source:</strong> {{publicationTitle}}</p>{{/if}}
{{#if yearOrDate}}<p><strong>Year:</strong> {{yearOrDate}}</p>{{/if}}
{{#if itemType}}<p><strong>Type:</strong> {{itemType}}</p>{{/if}}
{{#if hasDOI}}<p><strong>DOI:</strong> {{{doiLink}}}</p>{{/if}}
{{#if hasURL}}<p><strong>URL:</strong> {{{urlLink}}}</p>{{/if}}
{{#if citeKey}}<p><strong>BibTeX key:</strong> {{citeKey}}</p>{{/if}}
<p><strong>Zotero key:</strong> {{itemKey}}</p>
</highlightBlock>
{{#if hasAbstract}}
<h2>Abstract</h2>
{{{abstractParagraph}}}
{{/if}}
{{#if hasAttachments}}
<h2>Attachments</h2>
{{#each attachments}}
<p>📄 {{title}}{{#if isPDF}} (PDF stored locally in Zotero){{/if}}</p>
{{/each}}
{{/if}}
{{#if hasAnnotations}}
<h2>Annotations</h2>
{{#each annotationGroupsByColor}}
<h3>{{colorName}}</h3>
{{#each items}}
<highlightBlock emoji="📝" highlightBlockBackgroundColor="#F3F6F8" highlightBlockBorderColor="#D1D9E0">
<p><strong>[{{typeLabel}}]</strong></p>
{{{textParagraph}}}
{{#if comment}}<p><strong>Comment</strong></p>{{{commentBeforeTableXml}}}{{{commentAfterTableXml}}}{{/if}}
{{#if tags}}<p><strong>Tags:</strong> {{{tagsXml}}}</p>{{/if}}
</highlightBlock>
{{#if commentHasTable}}{{{commentTableXml}}}{{/if}}
{{/each}}
{{/each}}
{{/if}}
{{#if hasNotes}}
<h2>Notes</h2>
{{#each notes}}
{{#if title}}<h3>{{title}}</h3>{{/if}}
{{{contentParagraph}}}
{{#if hasImages}}<p><strong>Images:</strong> {{imageCount}} (external images will be inserted below)</p>{{/if}}
{{/each}}
{{/if}}
{{#if hasTags}}
<h2>Tags</h2>
<p>{{tagsJoined}}</p>
{{/if}}`;

const DEFAULT_BODY_TEMPLATE_ZH = `<h1>{{title}}</h1>
<highlightBlock emoji="💡" highlightBlockBackgroundColor="#FAF1E6" highlightBlockBorderColor="#FEC794">
{{#if authors}}<p><strong>作者：</strong>{{authors}}</p>{{/if}}
{{#if publicationTitle}}<p><strong>来源：</strong>{{publicationTitle}}</p>{{/if}}
{{#if yearOrDate}}<p><strong>年份：</strong>{{yearOrDate}}</p>{{/if}}
{{#if itemType}}<p><strong>类型：</strong>{{itemType}}</p>{{/if}}
{{#if hasDOI}}<p><strong>DOI：</strong>{{{doiLink}}}</p>{{/if}}
{{#if hasURL}}<p><strong>URL：</strong>{{{urlLink}}}</p>{{/if}}
{{#if citeKey}}<p><strong>BibTeX key：</strong>{{citeKey}}</p>{{/if}}
<p><strong>Zotero key：</strong>{{itemKey}}</p>
</highlightBlock>
{{#if hasAbstract}}
<h2>摘要</h2>
{{{abstractParagraph}}}
{{/if}}
{{#if hasAttachments}}
<h2>附件</h2>
{{#each attachments}}
<p>📄 {{title}}{{#if isPDF}}（PDF 保存在 Zotero 本地）{{/if}}</p>
{{/each}}
{{/if}}
{{#if hasAnnotations}}
<h2>文献批注</h2>
{{#each annotationGroupsByColor}}
<h3>{{colorName}}</h3>
{{#each items}}
<highlightBlock emoji="📝" highlightBlockBackgroundColor="#F3F6F8" highlightBlockBorderColor="#D1D9E0">
<p><strong>[{{typeLabel}}]</strong></p>
{{{textParagraph}}}
{{#if comment}}<p><strong>批注</strong></p>{{{commentBeforeTableXml}}}{{{commentAfterTableXml}}}{{/if}}
{{#if tags}}<p><strong>标签：</strong>{{{tagsXml}}}</p>{{/if}}
</highlightBlock>
{{#if commentHasTable}}{{{commentTableXml}}}{{/if}}
{{/each}}
{{/each}}
{{/if}}
{{#if hasNotes}}
<h2>文献笔记</h2>
{{#each notes}}
{{#if title}}<h3>{{title}}</h3>{{/if}}
{{{contentParagraph}}}
{{#if hasImages}}<p><strong>图片：</strong>{{imageCount}} 张（外网可访问图片会自动插入下方）</p>{{/if}}
{{/each}}
{{/if}}
{{#if hasTags}}
<h2>标签</h2>
<p>{{tagsJoined}}</p>
{{/if}}`;

function isChineseLocale(): boolean {
  try {
    return Zotero.locale?.toLowerCase().startsWith("zh") || false;
  } catch {
    return false;
  }
}

function getDefaultTitleTemplate(): string {
  return DEFAULT_TITLE_TEMPLATE;
}

function getDefaultBodyTemplate(): string {
  return isChineseLocale()
    ? DEFAULT_BODY_TEMPLATE_ZH
    : DEFAULT_BODY_TEMPLATE_EN;
}
