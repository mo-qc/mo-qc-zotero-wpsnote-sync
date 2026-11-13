import { expect } from "chai";
import type {
  isMappingInvalidError as IsMappingInvalidError,
  classifyError as ClassifyError,
  readNoteIdFromExtra as ReadNoteIdFromExtra,
  clearNoteIdFromExtra as ClearNoteIdFromExtra,
  getVisibleNoteIds as GetVisibleNoteIds,
} from "../src/modules/syncEngine";

const storage: Record<string, any> = {};

(globalThis as any).Zotero = {
  Prefs: {
    get: (key: string) => storage[key],
    set: (key: string, value: any) => {
      storage[key] = value;
    },
  },
  log: () => {},
};

(globalThis as any).ztoolkit = {
  log: () => {},
};

/** 构造带 extra 字段的最小 Zotero.Item mock */
function makeItem(extra: string) {
  let field = extra;
  let saveCount = 0;
  return {
    getField: (n: string) => (n === "extra" ? field : ""),
    setField: (n: string, v: string) => {
      if (n === "extra") field = v;
    },
    saveTx: async () => {
      saveCount += 1;
      return 1;
    },
    getExtra: () => field,
    getSaveCount: () => saveCount,
  };
}

describe("syncEngine core branches", function () {
  let isMappingInvalidError: typeof IsMappingInvalidError;
  let classifyError: typeof ClassifyError;
  let readNoteIdFromExtra: typeof ReadNoteIdFromExtra;
  let clearNoteIdFromExtra: typeof ClearNoteIdFromExtra;
  let getVisibleNoteIds: typeof GetVisibleNoteIds;
  let writeNoteIdToExtra: (item: any, noteId: string) => Promise<void>;

  before(async function () {
    const mod = await import("../src/modules/syncEngine");
    isMappingInvalidError = mod.isMappingInvalidError;
    classifyError = mod.classifyError;
    readNoteIdFromExtra = mod.readNoteIdFromExtra;
    clearNoteIdFromExtra = mod.clearNoteIdFromExtra;
    getVisibleNoteIds = mod.getVisibleNoteIds;
    writeNoteIdToExtra = (mod as any).writeNoteIdToExtra;
  });

  describe("isMappingInvalidError", function () {
    it("命中英文 note not found", function () {
      expect(isMappingInvalidError(new Error("note not found"))).to.be.true;
    });

    it("命中中文 笔记不存在", function () {
      expect(isMappingInvalidError(new Error("笔记不存在"))).to.be.true;
    });

    it("命中 invalid note_id", function () {
      expect(isMappingInvalidError(new Error("invalid note_id"))).to.be.true;
    });

    it("命中 已删除", function () {
      expect(isMappingInvalidError(new Error("该笔记已删除"))).to.be.true;
    });

    it("网络错误不误判为映射失效", function () {
      expect(isMappingInvalidError(new Error("network timeout"))).to.be.false;
    });

    it("空消息返回 false", function () {
      expect(isMappingInvalidError({})).to.be.false;
    });
  });

  describe("classifyError", function () {
    it("401 归类为 mcp（鉴权）", function () {
      expect(classifyError({ code: 401 })).to.equal("mcp");
    });

    it("429 归类为 network（限流可重试）", function () {
      expect(classifyError({ code: 429 })).to.equal("network");
    });

    it("NOTE_NOT_FOUND 归类为 mcp", function () {
      expect(classifyError({ code: "NOTE_NOT_FOUND" })).to.equal("mcp");
    });

    it("IMAGE_ERROR 归类为 image", function () {
      expect(classifyError({ code: "IMAGE_ERROR" })).to.equal("image");
    });

    it("连接拒绝消息归类为 network", function () {
      expect(classifyError(new Error("ECONNREFUSED 127.0.0.1"))).to.equal(
        "network",
      );
    });

    it("api key 消息归类为 mcp", function () {
      expect(classifyError(new Error("invalid api key"))).to.equal("mcp");
    });

    it("图片消息归类为 image", function () {
      expect(classifyError(new Error("图片插入失败"))).to.equal("image");
    });

    it("未知错误归类为 other", function () {
      expect(classifyError(new Error("???"))).to.equal("other");
    });
  });

  describe("extra 冗余读写清", function () {
    it("readNoteIdFromExtra 解析 ZWS 行", function () {
      const item = makeItem("作者: 张三\nZWS-Note-Id: 123456\nDOI: 10.1");
      expect(readNoteIdFromExtra(item as any)).to.equal("123456");
    });

    it("readNoteIdFromExtra 不区分键名大小写", function () {
      const item = makeItem("zws-note-id : 999");
      expect(readNoteIdFromExtra(item as any)).to.equal("999");
    });

    it("readNoteIdFromExtra 无该行返回 undefined", function () {
      const item = makeItem("普通 extra 内容");
      expect(readNoteIdFromExtra(item as any)).to.be.undefined;
    });

    it("clearNoteIdFromExtra 只删 ZWS 行并保留其他行", async function () {
      const item = makeItem("作者: 张三\nZWS-Note-Id: 123456\nDOI: 10.1");
      await clearNoteIdFromExtra(item as any);
      expect(item.getExtra()).to.equal("作者: 张三\nDOI: 10.1");
      expect(item.getSaveCount()).to.equal(1);
    });

    it("clearNoteIdFromExtra 无该行时幂等不保存", async function () {
      const item = makeItem("作者: 张三");
      await clearNoteIdFromExtra(item as any);
      expect(item.getSaveCount()).to.equal(0);
    });

    it("writeNoteIdToExtra 追加且幂等", async function () {
      if (!writeNoteIdToExtra) this.skip();
      const item = makeItem("作者: 张三");
      await writeNoteIdToExtra(item as any, "111");
      expect(readNoteIdFromExtra(item as any)).to.equal("111");
      const saves = item.getSaveCount();
      await writeNoteIdToExtra(item as any, "111");
      expect(item.getSaveCount()).to.equal(saves);
    });
  });

  describe("operation lock", function () {
    let beginOperation: (kind: string) => boolean;
    let endOperation: () => void;
    let currentOperation: () => string | null;

    before(async function () {
      const mod = await import("../src/modules/syncEngine");
      beginOperation = mod.beginOperation;
      endOperation = mod.endOperation;
      currentOperation = mod.currentOperation;
    });

    afterEach(function () {
      endOperation();
    });

    it("acquires and releases", function () {
      expect(beginOperation("sync")).to.be.true;
      expect(currentOperation()).to.equal("sync");
      endOperation();
      expect(currentOperation()).to.be.null;
    });

    it("rejects a second operation while held", function () {
      expect(beginOperation("sync")).to.be.true;
      expect(beginOperation("pull")).to.be.false;
      expect(currentOperation()).to.equal("sync");
      endOperation();
      expect(beginOperation("pull")).to.be.true;
      expect(currentOperation()).to.equal("pull");
    });
  });

  describe("getVisibleNoteIds 可见集合缓存", function () {
    it("30 秒内重复调用只拉一次列表，过期后重取", async function () {
      let calls = 0;
      const client = {
        listNotes: async () => {
          calls += 1;
          return [{ note_id: "aaa" }, { note_id: "bbb" }];
        },
      } as any;

      const realNow = Date.now;
      try {
        // 每次用例先推进 31s 使上一轮缓存过期
        let now = realNow.call(Date) + 100_000;
        Date.now = () => now;

        const first = await getVisibleNoteIds(client);
        expect(calls).to.equal(1);
        expect(first.has("aaa")).to.be.true;
        expect(first.has("zzz")).to.be.false;

        // 10 秒后仍在 TTL 内：命中缓存
        now += 10_000;
        await getVisibleNoteIds(client);
        expect(calls).to.equal(1);

        // 再过 31 秒：过期重取
        now += 31_000;
        await getVisibleNoteIds(client);
        expect(calls).to.equal(2);
      } finally {
        Date.now = realNow;
      }
    });

    it("listNotes 失败向上抛出（由调用方保守兜底）", async function () {
      const client = {
        listNotes: async () => {
          throw new Error("network error");
        },
      } as any;
      const realNow = Date.now;
      try {
        Date.now = () => realNow.call(Date) + 999_999;
        let thrown: Error | null = null;
        try {
          await getVisibleNoteIds(client);
        } catch (e) {
          thrown = e as Error;
        }
        expect(thrown).to.not.be.null;
      } finally {
        Date.now = realNow;
      }
    });
  });
});
