import { expect } from "chai";
import { WpsMcpClient } from "../src/modules/wpsMcpClient";

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
});
