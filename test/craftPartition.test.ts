import { expect } from "chai";

(globalThis as any).Zotero = {
  Prefs: { get: () => undefined, set: () => {} },
  log: () => {},
};
(globalThis as any).ztoolkit = { log: () => {} };

import {
  computeContentHash,
  replaceDocumentContent,
} from "../src/modules/craftSync";

interface MockBlock {
  id: string;
  markdown?: string;
}

/** 可编程 mock client：记录 insert/delete 调用，fetchBlocks 返回预置块 */
function makeClient(blocks: MockBlock[]) {
  const calls = {
    inserts: [] as Array<{
      pageId: string;
      markdown: string;
      position?: { position: string; pageId?: string; siblingId?: string };
    }>,
    deletes: [] as string[][],
    fetches: 0,
  };
  const client = {
    calls,
    async fetchBlocks(_docId: string, _opts?: unknown) {
      calls.fetches++;
      return { content: blocks.map((b) => ({ ...b })) } as any;
    },
    async insertBlocks(
      pageId: string,
      markdown: string,
      position?: { position: string; pageId?: string; siblingId?: string },
    ) {
      calls.inserts.push({ pageId, markdown, position });
      return { items: [{ id: `new-${calls.inserts.length}` }] } as any;
    },
    async deleteBlocks(ids: string[]) {
      calls.deletes.push(ids);
      // 从预置块中移除，模拟成功删除
      for (const id of ids) {
        const i = blocks.findIndex((b) => b.id === id);
        if (i >= 0) blocks.splice(i, 1);
      }
      return { items: ids } as any;
    },
  };
  return client;
}

const MARKER_ID = "marker-1";
const MARKER_MD = "以下为我的笔记";

describe("craft partition (P0)", function () {
  describe("computeContentHash", function () {
    it("same text → same hash", function () {
      expect(computeContentHash("hello world")).to.equal(
        computeContentHash("hello world"),
      );
    });

    it("different text → different hash", function () {
      expect(computeContentHash("hello")).to.not.equal(
        computeContentHash("hello!"),
      );
      expect(computeContentHash("")).to.not.equal(computeContentHash("a"));
    });

    it("returns 16-hex fingerprint", function () {
      expect(computeContentHash("x")).to.match(/^[0-9a-f]{16}$/);
    });
  });

  describe("replaceDocumentContent (partitioned)", function () {
    it("with marker by id: deletes only Zotero region, inserts before marker", async function () {
      const blocks: MockBlock[] = [
        { id: "old-a", markdown: "旧正文A" },
        { id: "old-b", markdown: "旧正文B" },
        { id: MARKER_ID, markdown: MARKER_MD },
        { id: "user-note", markdown: "我手写的读后感" },
      ];
      const client = makeClient(blocks);

      const res = await replaceDocumentContent(
        client as any,
        "doc-1",
        "新正文",
        MARKER_ID,
      );

      // 只删了 marker 之前的块，用户笔记区与 marker 保留
      expect(client.calls.deletes).to.deep.equal([["old-a", "old-b"]]);
      expect(blocks.map((b) => b.id)).to.deep.equal([MARKER_ID, "user-note"]);
      // 新正文插在 marker 之前
      expect(client.calls.inserts).to.have.length(1);
      expect(client.calls.inserts[0].position).to.deep.equal({
        position: "before",
        siblingId: MARKER_ID,
      });
      expect(res.markerBlockId).to.equal(MARKER_ID);
    });

    it("marker id missing → falls back to phrase match", async function () {
      const blocks: MockBlock[] = [
        { id: "old-a", markdown: "旧正文" },
        { id: "marker-2", markdown: "---\n\n**✍️ 以下为我的笔记**（...）" },
        { id: "user-note", markdown: "手写内容" },
      ];
      const client = makeClient(blocks);

      const res = await replaceDocumentContent(
        client as any,
        "doc-1",
        "新正文",
        "stale-id-not-found",
      );

      expect(client.calls.deletes).to.deep.equal([["old-a"]]);
      expect(client.calls.inserts[0].position).to.deep.equal({
        position: "before",
        siblingId: "marker-2",
      });
      expect(res.markerBlockId).to.equal("marker-2");
      expect(blocks.map((b) => b.id)).to.deep.equal(["marker-2", "user-note"]);
    });

    it("marker id points to divider (Craft split `---`) → falls back to phrase", async function () {
      // Craft 把 marker markdown 的 `---` 拆成「分隔线 + 文本」两块，
      // 历史版本误记分隔线 id；id 命中分隔线时必须落短语兜底
      const blocks: MockBlock[] = [
        { id: "old-a", markdown: "旧正文" },
        { id: "div-1", markdown: "***" },
        {
          id: "marker-txt",
          markdown: "**✍️ 以下为我的笔记**（Zotero 同步不会覆盖此区域）",
        },
        { id: "user-note", markdown: "手写内容" },
      ];
      const client = makeClient(blocks);

      const res = await replaceDocumentContent(
        client as any,
        "doc-1",
        "新正文",
        "div-1",
      );

      // 分隔线与旧正文都在 marker 文本前 → 一并删除
      expect(client.calls.deletes).to.deep.equal([["old-a", "div-1"]]);
      expect(client.calls.inserts[0].position).to.deep.equal({
        position: "before",
        siblingId: "marker-txt",
      });
      expect(res.markerBlockId).to.equal("marker-txt");
      expect(blocks.map((b) => b.id)).to.deep.equal([
        "marker-txt",
        "user-note",
      ]);
    });

    it("no marker (legacy doc): full replace + creates marker at end", async function () {
      const blocks: MockBlock[] = [
        { id: "old-a", markdown: "老内容" },
        { id: "old-b", markdown: "老内容2" },
      ];
      const client = makeClient(blocks);

      const res = await replaceDocumentContent(
        client as any,
        "doc-1",
        "新正文",
        undefined,
      );

      // 先插正文（end），再插 marker（end），最后删旧块
      expect(client.calls.inserts).to.have.length(2);
      expect(client.calls.inserts[0].markdown).to.equal("新正文");
      expect(client.calls.inserts[0].position).to.deep.equal({
        position: "end",
        pageId: "doc-1",
      });
      expect(client.calls.inserts[1].markdown).to.include("以下为我的笔记");
      expect(client.calls.deletes).to.deep.equal([["old-a", "old-b"]]);
      expect(res.markerBlockId).to.equal("new-2");
      // 旧块已删，新块（mock 不自动追加）——断言旧块不在
      expect(blocks).to.have.length(0);
    });

    it("empty markdown with marker: clears Zotero region only, keeps marker", async function () {
      const blocks: MockBlock[] = [
        { id: "old-a", markdown: "旧正文" },
        { id: MARKER_ID, markdown: MARKER_MD },
        { id: "user-note", markdown: "手写" },
      ];
      const client = makeClient(blocks);

      const res = await replaceDocumentContent(
        client as any,
        "doc-1",
        "   \n  ",
        MARKER_ID,
      );

      expect(client.calls.inserts).to.have.length(0);
      expect(client.calls.deletes).to.deep.equal([["old-a"]]);
      expect(blocks.map((b) => b.id)).to.deep.equal([MARKER_ID, "user-note"]);
      expect(res.markerBlockId).to.equal(MARKER_ID);
    });

    it("marker at index 0: nothing to delete, still inserts before marker", async function () {
      const blocks: MockBlock[] = [
        { id: MARKER_ID, markdown: MARKER_MD },
        { id: "user-note", markdown: "手写" },
      ];
      const client = makeClient(blocks);

      const res = await replaceDocumentContent(
        client as any,
        "doc-1",
        "新正文",
        MARKER_ID,
      );

      expect(client.calls.deletes).to.have.length(0);
      expect(client.calls.inserts[0].position).to.deep.equal({
        position: "before",
        siblingId: MARKER_ID,
      });
      expect(res.markerBlockId).to.equal(MARKER_ID);
    });
  });
});
