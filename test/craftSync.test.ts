import { expect } from "chai";

const storage: Record<string, any> = {};

(globalThis as any).Zotero = {
  Prefs: {
    get: (key: string) => storage[key],
    set: (key: string, value: any) => {
      storage[key] = value;
    },
  },
  log: () => {},
  HTTP: { request: async () => ({}) },
};

(globalThis as any).ztoolkit = {
  log: () => {},
};

type Block = { id: string };

/** 可编排的 CraftClient mock：fetchBlocks 按调用次序返回预设快照 */
function makeClient(opts: {
  snapshots: Block[][];
  deleteFailTimes?: number; // 前 N 次 deleteBlocks 抛错
}) {
  let fetchCount = 0;
  let deleteCount = 0;
  const deleteCalls: string[][] = [];
  const client = {
    fetchBlocks: async (_docId: string, _o?: any) => {
      const snap =
        opts.snapshots[Math.min(fetchCount, opts.snapshots.length - 1)];
      fetchCount += 1;
      return { content: snap.map((b) => ({ id: b.id })) };
    },
    insertBlocks: async (_docId: string, _md: string) => ({ ok: true }),
    deleteBlocks: async (ids: string[]) => {
      deleteCalls.push(ids);
      deleteCount += 1;
      if (deleteCount <= (opts.deleteFailTimes ?? 0)) {
        throw new Error("network down");
      }
      return { ok: true };
    },
    getFetchCount: () => fetchCount,
    getDeleteCalls: () => deleteCalls,
  };
  return client;
}

describe("craftSync replaceDocumentContent / DELETE_LEFTOVER", function () {
  let replaceDocumentContent: any;
  let CraftError: any;

  before(async function () {
    const mod = await import("../src/modules/craftSync");
    replaceDocumentContent = (mod as any).replaceDocumentContent;
    const cc = await import("../src/modules/craftClient");
    CraftError = (cc as any).CraftError;
  });

  it("删除一次成功：不抛错，只删一轮", async function () {
    const client = makeClient({
      snapshots: [[{ id: "old1" }, { id: "old2" }], [{ id: "new1" }]],
      deleteFailTimes: 0,
    });
    await replaceDocumentContent(client as any, "DOC", "# new");
    expect(client.getDeleteCalls().length).to.equal(1);
    expect(client.getDeleteCalls()[0]).to.deep.equal(["old1", "old2"]);
  });

  it("首次写入（无旧块）：不调用删除", async function () {
    const client = makeClient({ snapshots: [[]] });
    await replaceDocumentContent(client as any, "DOC", "# new");
    expect(client.getDeleteCalls().length).to.equal(0);
  });

  it("删除失败但复核无滞留（旧块已被 Craft 端合并）：不抛错", async function () {
    const client = makeClient({
      // 第 1 次 fetch：旧块存在；第 2 次 fetch（复核）：旧块已消失，只剩新块
      snapshots: [[{ id: "old1" }], [{ id: "new1" }]],
      deleteFailTimes: 1,
    });
    await replaceDocumentContent(client as any, "DOC", "# new");
    // 只尝试删了一轮，复核后无滞留不再重删
    expect(client.getDeleteCalls().length).to.equal(1);
    expect(client.getFetchCount()).to.equal(2);
  });

  it("删除失败且复核有滞留：同轮重删成功，不抛错", async function () {
    const client = makeClient({
      // 复核时旧块仍在（+ 新块插入），交集 = old1
      snapshots: [[{ id: "old1" }], [{ id: "new1" }, { id: "old1" }]],
      deleteFailTimes: 1,
    });
    await replaceDocumentContent(client as any, "DOC", "# new");
    expect(client.getDeleteCalls().length).to.equal(2);
    expect(client.getDeleteCalls()[1]).to.deep.equal(["old1"]);
  });

  it("重删仍失败：抛 DELETE_LEFTOVER，本轮判失败", async function () {
    const client = makeClient({
      snapshots: [[{ id: "old1" }], [{ id: "new1" }, { id: "old1" }]],
      deleteFailTimes: 2, // 首删 + 重删都失败
    });
    try {
      await replaceDocumentContent(client as any, "DOC", "# new");
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e).to.be.instanceOf(CraftError);
      expect(e.code).to.equal("DELETE_LEFTOVER");
      expect(e.message).to.include("1 块滞留");
    }
  });

  it("新内容 id 不参与滞留判定（不误删新块）", async function () {
    const client = makeClient({
      // 复核快照只有新块——old1 已被 Craft 端移除，但失败批次里有 old1
      snapshots: [[{ id: "old1" }], [{ id: "new1" }]],
      deleteFailTimes: 1,
    });
    await replaceDocumentContent(client as any, "DOC", "# new");
    // 交集为空：没有第二次 delete 调用
    expect(client.getDeleteCalls().length).to.equal(1);
  });
});
