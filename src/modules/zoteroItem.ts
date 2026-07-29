/**
 * 从 Zotero 中提取文献条目、子笔记与附件信息。
 */

import type {
  ZoteroItemData,
  ZoteroAttachment,
  ZoteroNote,
  ZoteroNoteImage,
  ZoteroAnnotation,
} from "../utils/xmlBuilder";

function getCreatorString(creator: any): string {
  const parts: string[] = [];
  if (creator.lastName) parts.push(creator.lastName);
  if (creator.firstName) parts.push(creator.firstName);
  if (creator.name) parts.push(creator.name);
  return parts.join(", ");
}

function extractYear(date?: string): string | undefined {
  if (!date) return undefined;
  const m = date.match(/(\d{4})/);
  return m ? m[1] : undefined;
}

function extractCiteKey(item: Zotero.Item): string | undefined {
  // Better BibTeX 会在 item.getField("citationKey") 或 extra 中提供
  try {
    const key = (item as any).getField("citationKey");
    if (key) return String(key);
  } catch {
    // ignore
  }

  const extra = String(item.getField("extra") || "");
  const m = extra.match(/(?:Citation Key|BibTeX key|citation key):\s*(.+)/i);
  if (m) return m[1].trim();

  return undefined;
}

function getAttachmentPath(attachment: Zotero.Item): string | undefined {
  try {
    const path = String(attachment.getFilePath?.() || "");
    return path || undefined;
  } catch {
    return undefined;
  }
}

export function getAttachmentDataUrl(
  attachmentKey: string,
): string | undefined {
  try {
    const att = Zotero.Items.get(attachmentKey);
    if (!att || !att.isAttachment() || !att.isImageAttachment()) {
      return undefined;
    }
    const path = att.getFilePath();
    if (!path) return undefined;
    const contentType = att.attachmentContentType || "image/png";
    return Zotero.File.generateDataURI(path, contentType);
  } catch (e: any) {
    ztoolkit.log(
      "Generate attachment data URI failed",
      attachmentKey,
      e?.message || String(e),
    );
    return undefined;
  }
}

function normalizeAnnotationText(html?: string): string {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractNoteImages(html: string): ZoteroNoteImage[] {
  const images: ZoteroNoteImage[] = [];
  const regex = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
    const keyMatch = tag.match(/\bdata-attachment-key=["']([^"']+)["']/i);
    const src = srcMatch ? srcMatch[1] : "";
    const alt = altMatch ? altMatch[1] : "";
    const attachmentKey = keyMatch ? keyMatch[1] : "";

    const image: ZoteroNoteImage = { src, alt, attachmentKey };
    if (src && src.startsWith("data:")) {
      image.dataUrl = src;
    }
    images.push(image);
  }
  return images;
}

function getAnnotationTypeLabel(type: string): string {
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

function extractAnnotationTags(raw: any): string[] {
  // Zotero 7 返回的 annotation 可能是普通对象（带 tags 数组）
  // 也可能是完整的 Zotero.Item（带 getTags() 方法）
  if (typeof raw.getTags === "function") {
    try {
      return (raw.getTags() || [])
        .map((t: any) => String(t.tag || ""))
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw.tags)) {
    return raw.tags.map((t: any) => String(t.tag || "")).filter(Boolean);
  }
  if (Array.isArray(raw._tags)) {
    return raw._tags.map((t: any) => String(t.tag || "")).filter(Boolean);
  }
  return [];
}

function extractAnnotationField(raw: any, field: string): string {
  // 优先取普通对象字段，再取 _field 私有字段，再取 getField 方法
  if (raw[field] !== undefined) return String(raw[field] || "");
  if (raw[`_${field}`] !== undefined) return String(raw[`_${field}`] || "");
  if (typeof raw.getField === "function") {
    try {
      return String(raw.getField(field) || "");
    } catch {
      // ignore
    }
  }
  return "";
}

function parseAnnotationPosition(raw: any): {
  pageIndex?: number;
  rects?: number[][];
} {
  const posStr =
    extractAnnotationField(raw, "annotationPosition") ||
    extractAnnotationField(raw, "position");
  if (!posStr) return {};
  try {
    const parsed = JSON.parse(posStr);
    return {
      pageIndex:
        typeof parsed.pageIndex === "number"
          ? parsed.pageIndex
          : typeof parsed.page === "number"
            ? parsed.page
            : undefined,
      rects: Array.isArray(parsed.rects) ? parsed.rects : undefined,
    };
  } catch {
    return {};
  }
}

function extractAnnotationImageKey(raw: any): string | undefined {
  const key =
    extractAnnotationField(raw, "imageAttachmentKey") ||
    extractAnnotationField(raw, "image");
  return key || undefined;
}

function extractAnnotations(item: Zotero.Item): ZoteroAnnotation[] {
  const annotations: ZoteroAnnotation[] = [];
  const attIds = item.getAttachments ? item.getAttachments() : [];

  for (const attId of attIds) {
    const att = Zotero.Items.get(attId);
    if (!att || !att.isPDFAttachment || !att.isPDFAttachment()) continue;

    let rawAnnotations: any[] = [];
    try {
      if (att.getAnnotations) {
        rawAnnotations = att.getAnnotations() || [];
      }
    } catch {
      // ignore
    }

    for (const raw of rawAnnotations) {
      const type = extractAnnotationField(raw, "annotationType") || "highlight";
      const text = normalizeAnnotationText(
        extractAnnotationField(raw, "annotationText"),
      );
      const comment = normalizeAnnotationText(
        extractAnnotationField(raw, "annotationComment"),
      );
      const color = extractAnnotationField(raw, "annotationColor");
      const pageLabel =
        extractAnnotationField(raw, "annotationPageLabel") || "0";
      const sortIndex = extractAnnotationField(raw, "annotationSortIndex");
      const position = parseAnnotationPosition(raw);
      const imageAttachmentKey = extractAnnotationImageKey(raw);

      // 跳过完全空内容的批注。
      // image 类型允许无 text/comment（截图本身即内容）；
      // ink 类型通常只有墨迹轨迹，若无评论可跳过；
      // 其他类型允许仅含评论或仅含高亮文本。
      const hasVisualContent =
        type === "image" && (Boolean(imageAttachmentKey) || Boolean(text));
      if (!text && !comment && !hasVisualContent) continue;

      annotations.push({
        key: String(raw.key || raw._key || ""),
        type,
        text,
        comment,
        color,
        pageLabel,
        sortIndex,
        authorName: extractAnnotationField(raw, "annotationAuthorName"),
        dateAdded: extractAnnotationField(raw, "dateAdded"),
        dateModified: extractAnnotationField(raw, "dateModified"),
        tags: extractAnnotationTags(raw),
        position,
        imageAttachmentKey,
      });
    }
  }

  // 按页码、再按位置排序。页码可能是数字或罗马数字，做健壮比较。
  annotations.sort((a, b) => {
    const pageA = Number(a.pageLabel);
    const pageB = Number(b.pageLabel);
    if (!Number.isNaN(pageA) && !Number.isNaN(pageB)) {
      const pageDiff = pageA - pageB;
      if (pageDiff !== 0) return pageDiff;
    } else {
      const pageCompare = String(a.pageLabel).localeCompare(
        String(b.pageLabel),
      );
      if (pageCompare !== 0) return pageCompare;
    }
    return String(a.sortIndex).localeCompare(String(b.sortIndex));
  });

  return annotations;
}

export function getItemModifiedTime(item: Zotero.Item): string {
  try {
    const raw = item.getField("dateModified");
    if (!raw) return "";
    const d = new Date(String(raw));
    if (isNaN(d.getTime())) return String(raw);
    return d.toISOString();
  } catch {
    return "";
  }
}

export function getSelectedItems(): Zotero.Item[] {
  const zoteroPane = Zotero.getActiveZoteroPane();
  if (!zoteroPane) return [];
  return (zoteroPane.getSelectedItems?.() || []) as Zotero.Item[];
}

export function getSelectedCollectionItems(): Zotero.Item[] {
  const zoteroPane = Zotero.getActiveZoteroPane();
  if (!zoteroPane) return [];
  const collection = zoteroPane.getSelectedCollection?.();
  if (!collection) return [];
  try {
    return (collection.getChildItems?.() || []).filter((item: Zotero.Item) =>
      item.isRegularItem?.(),
    );
  } catch {
    return [];
  }
}

export interface ExtractOptions {
  includeAbstract?: boolean;
  includeAttachments?: boolean;
  includeAnnotations?: boolean;
  includeTags?: boolean;
  includeNotes?: boolean;
}

export function extractItemData(
  item: Zotero.Item,
  options: ExtractOptions = {},
): ZoteroItemData {
  const opts = {
    includeAbstract: true,
    includeAttachments: true,
    includeAnnotations: true,
    includeTags: true,
    includeNotes: true,
    ...options,
  };

  const creators: string[] = [];
  const rawCreators = item.getCreators ? item.getCreators() : [];
  for (const c of rawCreators) {
    const s = getCreatorString(c);
    if (s) creators.push(s);
  }

  const date = String(item.getField("date") || "");
  const tags =
    opts.includeTags && item.getTags
      ? item
          .getTags()
          .map((t: any) => String(t.tag || ""))
          .filter(Boolean)
      : [];

  const notes: ZoteroNote[] = [];
  if (opts.includeNotes && item.getNotes) {
    const noteIds = item.getNotes();
    for (const noteId of noteIds) {
      const noteItem = Zotero.Items.get(noteId);
      if (noteItem && noteItem.isNote()) {
        const note = noteItem.getNote ? noteItem.getNote() : "";
        const noteHtml = String(note);
        notes.push({
          title: String(noteItem.getField("title") || ""),
          content: noteHtml,
          images: extractNoteImages(noteHtml),
        });
      }
    }
  }

  const attachments: ZoteroAttachment[] = [];
  if (opts.includeAttachments && item.getAttachments) {
    const attIds = item.getAttachments();
    for (const attId of attIds) {
      const att = Zotero.Items.get(attId);
      if (!att) continue;
      const contentType = String(
        att.getField("contentType") || att.attachmentContentType || "",
      );
      const path = getAttachmentPath(att);
      const url = String(att.getField("url") || "");
      attachments.push({
        title: String(att.getField("title") || "附件"),
        key: att.key,
        path,
        url: url || undefined,
        contentType,
        isPDF:
          contentType === "application/pdf" ||
          String(att.getField("title") || "")
            .toLowerCase()
            .endsWith(".pdf"),
      } as ZoteroAttachment);
    }
  }

  const annotations = opts.includeAnnotations ? extractAnnotations(item) : [];

  return {
    key: item.key,
    title: String(item.getField("title") || ""),
    itemType: Zotero.ItemTypes.getName(item.itemTypeID) || "document",
    creators,
    date: date || undefined,
    year: extractYear(date),
    abstract: opts.includeAbstract
      ? String(item.getField("abstractNote") || "")
      : "",
    url: String(item.getField("url") || ""),
    DOI: String(item.getField("DOI") || ""),
    publicationTitle: String(item.getField("publicationTitle") || ""),
    tags,
    notes,
    attachments,
    annotations,
    citeKey: extractCiteKey(item),
  };
}
