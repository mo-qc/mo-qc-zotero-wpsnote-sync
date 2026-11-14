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
    key: "TSTKEY",
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

  describe("pickWpsSearchMatch / 自写标记", function () {
    let pickWpsSearchMatch: any;
    let markSelfSave: any;
    let isSelfSave: any;

    before(async function () {
      const mod = await import("../src/modules/syncEngine");
      pickWpsSearchMatch = (mod as any).pickWpsSearchMatch;
      markSelfSave = (mod as any).markSelfSave;
      isSelfSave = (mod as any).isSelfSave;
    });

    const ref = {
      templateTitle: "[Zotero] Attention Is All You Need",
      itemTitle: "Attention Is All You Need",
      itemKey: "ABCD1234",
    };
    const none = () => false;

    it("优先精确匹配模板渲染标题", function () {
      const cands = [
        { note_id: "1", title: "[Zotero] Attention Is All You Need and more" },
        { note_id: "2", title: "[Zotero] Attention Is All You Need" },
      ];
      expect(pickWpsSearchMatch(cands, ref, none)?.note_id).to.equal("2");
    });

    it("次选匹配唯一 item key", function () {
      const cands = [
        { note_id: "1", title: "我的阅读笔记 ABCD1234" },
        { note_id: "2", title: "另一篇也提到 Attention Is All You Need" },
      ];
      expect(pickWpsSearchMatch(cands, ref, none)?.note_id).to.equal("1");
    });

    it("宽松匹配放最后兜底", function () {
      const cands = [
        { note_id: "1", title: "[Zotero] attention is all you need" },
      ];
      expect(pickWpsSearchMatch(cands, ref, none)?.note_id).to.equal("1");
    });

    it("已归属其他条目的笔记不接管（防同名共写）", function () {
      const owned = (id?: string) => id === "1";
      const cands = [
        { note_id: "1", title: "[Zotero] Attention Is All You Need" },
        { note_id: "2", title: "无关笔记" },
      ];
      expect(pickWpsSearchMatch(cands, ref, owned)?.note_id).to.equal(
        undefined,
      );
    });

    it("被接管过滤后可回退到下一优先级候选", function () {
      const owned = (id?: string) => id === "1";
      const cands = [
        { note_id: "1", title: "[Zotero] Attention Is All You Need" },
        { note_id: "2", title: "含 key ABCD1234 的旧笔记" },
      ];
      expect(pickWpsSearchMatch(cands, ref, owned)?.note_id).to.equal("2");
    });

    it("大小写与首尾空白不敏感", function () {
      const cands = [
        { note_id: "1", title: "  [zotero] ATTENTION IS ALL YOU NEED  " },
      ];
      expect(pickWpsSearchMatch(cands, ref, none)?.note_id).to.equal("1");
    });

    it("空候选/空标题返回 undefined", function () {
      expect(pickWpsSearchMatch([], ref, none)).to.equal(undefined);
      expect(
        pickWpsSearchMatch(
          [{ note_id: "1", title: "x" }],
          { templateTitle: "", itemTitle: "", itemKey: "K" },
          none,
        ),
      ).to.equal(undefined);
    });

    describe("isSelfSave 窗口", function () {
      it("标记后窗口期内判定为自写", function () {
        markSelfSave("KEYSELF1");
        expect(isSelfSave("KEYSELF1")).to.equal(true);
      });

      it("未标记的 key 判定为否", function () {
        expect(isSelfSave("KEYOTHER")).to.equal(false);
      });

      it("窗口过期（>10s）后判定为否并清除记录", function () {
        markSelfSave("KEYEXPIRE");
        expect(isSelfSave("KEYEXPIRE")).to.equal(true);
        const realNow = Date.now;
        try {
          // 快进 11 秒越过 10s 窗口
          Date.now = () => realNow() + 11_000;
          expect(isSelfSave("KEYEXPIRE")).to.equal(false);
        } finally {
          Date.now = realNow;
        }
        // 记录已清除：恢复真实时间后仍为否
        expect(isSelfSave("KEYEXPIRE")).to.equal(false);
      });

      it("超过 1000 条上限时淘汰最早的 key", function () {
        // 插入 1005 个全新 key：无论此前集合里有多少条目，
        // 超出上限 1000 的部分都应按插入序淘汰最早的
        for (let i = 0; i < 1005; i += 1) {
          markSelfSave(`KEYCAP${i}`);
        }
        // 最早的 5 个被淘汰（仍在 10s 窗口内，只能是上限淘汰）
        expect(isSelfSave("KEYCAP0")).to.equal(false);
        expect(isSelfSave("KEYCAP4")).to.equal(false);
        // 边界之后的 key 保留
        expect(isSelfSave("KEYCAP5")).to.equal(true);
        expect(isSelfSave("KEYCAP1004")).to.equal(true);
      });
    });
  });
});
