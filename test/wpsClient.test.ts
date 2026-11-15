import { expect } from "chai";
import { WpsMcpClient, findMarkerBlockId } from "../src/modules/wpsMcpClient";

type Call = { name: string; args: Record<string, any> };

function makeClient(
  handler: (name: string, args: Record<string, any>) => unknown,
) {
  const client = new WpsMcpClient({
    endpoint: "http://127.0.0.1:0/mcp",
    apiKey: "test",
  });
  const calls: Call[] = [];
  (client as any).callTool = async (
    name: string,
    args: Record<string, any>,
  ) => {
    calls.push({ name, args });
    return handler(name, args);
  };
  return { client, calls };
}

describe("WpsMcpClient", function () {
  describe("readNote", function () {
    it("sends note_id / offset / block_limit", async function () {
      const { client, calls } = makeClient(() => ({
        title: "t",
        content: "<p>x</p>",
        pagination: {
          offset: 0,
          limit: 119,
          returned_blocks: 119,
          has_more: false,
        },
      }));

      await client.readNote("note-1", 0, 50);

      expect(calls[0].name).to.equal("read_note");
      expect(calls[0].args).to.deep.equal({
        note_id: "note-1",
        offset: 0,
        block_limit: 50,
      });
    });

    it("advances by server next_offset instead of requested block_limit", async function () {
      // 服务端把单页放大到 119 块：若按请求的 50 自增，会重复读取 50-118 块
      const { client } = makeClient((_name, args) => ({
        title: "t",
        content: "<p>x</p>",
        pagination: {
          offset: args.offset,
          limit: 119,
          returned_blocks: args.offset === 0 ? 119 : 81,
          has_more: args.offset === 0,
          next_offset: args.offset + (args.offset === 0 ? 119 : 81),
        },
      }));

      const first = await client.readNote("note-1", 0, 50);
      expect(first.hasMore).to.equal(true);
      expect(first.nextOffset).to.equal(119);

      const second = await client.readNote("note-1", first.nextOffset, 50);
      expect(second.hasMore).to.equal(false);
      expect(second.nextOffset).to.equal(200);
    });

    it("falls back to offset + returned_blocks when next_offset is missing", async function () {
      const { client } = makeClient((_name, args) => ({
        title: "t",
        content: "<p>x</p>",
        pagination: {
          offset: args.offset,
          limit: 100,
          returned_blocks: 100,
          has_more: true,
        },
      }));

      const page = await client.readNote("note-1", 200, 100);
      expect(page.nextOffset).to.equal(300);
    });

    it("throws when content is empty", async function () {
      const { client } = makeClient(() => ({ title: "t", content: "" }));
      let error: unknown;
      try {
        await client.readNote("note-1");
      } catch (e) {
        error = e;
      }
      expect(String((error as Error)?.message)).to.contain("read_note");
    });
  });

  describe("listNotes", function () {
    it("pages until has_more is false and dedupes by note_id", async function () {
      const pages: Record<number, any> = {
        1: {
          notes: [
            { note_id: "a", update_time: 1 },
            { note_id: "b", update_time: 2 },
          ],
          meta: { has_more: true },
        },
        2: {
          notes: [
            { note_id: "b", update_time: 2 },
            { note_id: "c", update_time: 3 },
          ],
          meta: { has_more: false },
        },
      };
      const { client, calls } = makeClient((_name, args) => pages[args.page]);

      const notes = await client.listNotes(1000);

      expect(notes.map((n) => n.note_id)).to.deep.equal(["a", "b", "c"]);
      expect(calls).to.have.length(2);
      expect(calls[0].args.page_size).to.equal(200);
    });

    it("stops when the server ignores paging and repeats the same page", async function () {
      const { client, calls } = makeClient(() => ({
        notes: [{ note_id: "a" }],
        meta: { has_more: true },
      }));

      const notes = await client.listNotes(1000);

      expect(notes.map((n) => n.note_id)).to.deep.equal(["a"]);
      // 第二页全部是重复条目 → 立即停止，不会无限翻页
      expect(calls).to.have.length(2);
    });

    it("maps note_id to update_time", async function () {
      const { client } = makeClient(() => ({
        notes: [
          { note_id: "a", update_time: 111 },
          { note_id: "b", update_time: "222" },
          { note_id: "", update_time: 333 },
        ],
        meta: { has_more: false },
      }));

      const times = await client.getNoteUpdateTimes();

      expect(times.get("a")).to.equal(111);
      expect(times.get("b")).to.equal(222);
      expect(times.size).to.equal(2);
    });
  });

  describe("findMarkerBlockId", function () {
    const phrase = "以下为我的笔记";

    it("locates marker paragraph id", function () {
      const xml = `<h1 id="h1">t</h1>\n\n<p id="m1">✍️ ${phrase}（Zotero 同步不会覆盖此区域）</p>`;
      expect(findMarkerBlockId(xml, phrase, new Set(["h1", "m1"]))).to.equal(
        "m1",
      );
    });

    it("skips inline ids not in top-level set", function () {
      const xml = `<p id="p1"><strong id="s1">✍️ ${phrase}</strong></p>`;
      expect(findMarkerBlockId(xml, phrase, new Set(["p1", "h1"]))).to.equal(
        "p1",
      );
    });

    it("returns undefined when phrase absent", function () {
      expect(findMarkerBlockId("<p id='p1'>hello</p>", phrase, new Set(["p1"])))
        .to.be.undefined;
    });

    it("returns undefined when no id before phrase is top-level", function () {
      const xml = `<strong id="s1">${phrase}</strong>`;
      expect(findMarkerBlockId(xml, phrase, new Set(["p1"]))).to.be.undefined;
    });
  });

  describe("appendMarkerBlock", function () {
    const phrase = "以下为我的笔记";
    const markerXml = `<p>✍️ ${phrase}（Zotero 同步不会覆盖此区域）</p>`;

    it("inserts after last outline block and returns extracted id", async function () {
      // 第一次 outline（appendMarkerBlock 定位末块）：a,b；
      // insert 后第二次 outline（extractMarkerBlockId）：含新块 m1
      let outlineCalls = 0;
      const { client, calls } = makeClient((name) => {
        if (name === "get_note_outline") {
          outlineCalls++;
          return outlineCalls === 1
            ? { blocks: [{ id: "a" }, { id: "b" }] }
            : { blocks: [{ id: "a" }, { id: "b" }, { id: "m1" }] };
        }
        if (name === "edit_block") return {};
        if (name === "read_note")
          return {
            title: "t",
            content: `<p id="b">x</p>\n\n${markerXml.replace("<p>", '<p id="m1">')}`,
            pagination: { has_more: false },
          };
        return {};
      });

      const id = await client.appendMarkerBlock("n1", markerXml, phrase);

      const insert = calls.find((c) => c.name === "edit_block");
      expect(insert).to.exist;
      expect(insert!.args.anchor_id).to.equal("b");
      expect(insert!.args.position).to.equal("after");
      expect(insert!.args.content).to.equal(markerXml);
      expect(id).to.equal("m1");
    });

    it("returns undefined when outline is empty", async function () {
      const { client, calls } = makeClient((name) => {
        if (name === "get_note_outline") return { blocks: [] };
        return {};
      });
      const id = await client.appendMarkerBlock("n1", markerXml, phrase);
      expect(id).to.be.undefined;
      expect(calls.filter((c) => c.name === "edit_block")).to.have.lengthOf(0);
    });
  });
});
