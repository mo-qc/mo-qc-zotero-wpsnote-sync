/**
 * 将 Zotero 文献数据组装为 WPS 笔记可识别的语义 XML。
 * WPS 笔记 block 模型要求：写入操作的 content 必须是合法 XML，
 * 且只使用顶层 block 标签（h1-h6、p、blockquote、codeblock、table、highlightBlock、columns、hr）。
 */

import {
  renderItemTemplate,
  getDefaultTitleTemplate,
  getDefaultBodyTemplate,
} from "./template";

export { escapeXml, paragraph, normalizeForXml, link } from "./xmlHelpers";
export { markdownToWpsXml, splitMarkdownByTable } from "./markdown";

export interface ZoteroNoteImage {
  src?: string;
  alt?: string;
  attachmentKey?: string;
  dataUrl?: string;
}

export interface ZoteroNote {
  title?: string;
  content: string;
  images: ZoteroNoteImage[];
}

export interface ZoteroAttachment {
  key: string;
  title: string;
  path?: string;
  url?: string;
  contentType?: string;
  isPDF?: boolean;
}

export interface ZoteroAnnotation {
  key: string;
  type: string;
  text: string;
  comment: string;
  color?: string;
  pageLabel: string;
  sortIndex: string;
  authorName: string;
  dateAdded: string;
  dateModified: string;
  tags: string[];
  position?: {
    pageIndex?: number;
    rects?: number[][];
  };
  imageAttachmentKey?: string;
}

export interface ZoteroItemData {
  key: string;
  title: string;
  itemType: string;
  creators: string[];
  date?: string;
  year?: string;
  abstract?: string;
  url?: string;
  DOI?: string;
  publicationTitle?: string;
  tags: string[];
  notes: ZoteroNote[];
  attachments: ZoteroAttachment[];
  annotations: ZoteroAnnotation[];
  citeKey?: string;
}

export function buildNoteTitle(
  item: ZoteroItemData,
  template?: string,
): string {
  const tpl = template?.trim() || getDefaultTitleTemplate();
  return renderItemTemplate(tpl, item);
}

export function buildNoteXml(item: ZoteroItemData, template?: string): string {
  const tpl = template?.trim() || getDefaultBodyTemplate();
  return renderItemTemplate(tpl, item);
}
