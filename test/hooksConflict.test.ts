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
  setTimeout: (fn: () => void, _ms: number) => {
    // 不执行：测试只关心策略函数，不触发排程
    return 1 as any;
  },
  clearTimeout: () => {},
};

/** 记录 ProgressWindow 通知，验证"远端手改提醒"确实发出 */
const notifyLog: { text?: string; type?: string }[] = [];

(globalThis as any).ztoolkit = {
  log: () => {},
  ProgressWindow: class {
    constructor(_name: string, _opts?: any) {}
    createLine(line: { text?: string; type?: string }) {
      notifyLog.push({ text: line.text, type: line.type });
      return this;
    }
    show() {
      return this;
    }
  },
};

(globalThis as any).addon = {
  data: {
    config: { addonName: "Zotero WPS Note Sync", addonID: "test@addon" },
  },
};

describe("hooks autoSyncConflictPolicy / 自动同步冲突策略", function () {
  let autoSyncConflictPolicy: any;

  before(async function () {
    // 其他测试文件的顶层代码会覆盖 globalThis.ztoolkit（只剩 log），
    // 在导入 hooks 前重建完整 mock，保证 ProgressWindow 可用
    (globalThis as any).ztoolkit = {
      log: () => {},
      ProgressWindow: class {
        constructor(_name: string, _opts?: any) {}
        createLine(line: { text?: string; type?: string }) {
          notifyLog.push({ text: line.text, type: line.type });
          return this;
        }
        show() {
          return this;
        }
      },
    };
    const mod = await import("../src/hooks");
    autoSyncConflictPolicy = (mod as any).autoSyncConflictPolicy;
  });

  beforeEach(function () {
    notifyLog.length = 0;
    // 防再次被并行加载的其他套件覆盖
    if (typeof (globalThis as any).ztoolkit?.ProgressWindow !== "function") {
      (globalThis as any).ztoolkit = {
        log: () => {},
        ProgressWindow: class {
          constructor(_name: string, _opts?: any) {}
          createLine(line: { text?: string; type?: string }) {
            notifyLog.push({ text: line.text, type: line.type });
            return this;
          }
          show() {
            return this;
          }
        },
      };
    }
  });

  it("kind 为 undefined：覆盖（无冲突信号）", function () {
    expect(autoSyncConflictPolicy(undefined, "标题")).to.equal("overwrite");
    expect(notifyLog.length).to.equal(0);
  });

  it("kind=item（Zotero 侧变更）：覆盖且不提醒", function () {
    expect(autoSyncConflictPolicy("item", "标题")).to.equal("overwrite");
    expect(notifyLog.length).to.equal(0);
  });

  it("kind=wps（WPS 端手改）：跳过并弹提醒", function () {
    expect(autoSyncConflictPolicy("wps", "某文献标题")).to.equal("skip");
    expect(notifyLog.length).to.equal(1);
    expect(notifyLog[0].type).to.equal("warning");
    expect(notifyLog[0].text).to.include("WPS");
    expect(notifyLog[0].text).to.include("自动同步已跳过");
  });

  it("kind=craft（Craft 端手改）：跳过并弹提醒", function () {
    expect(autoSyncConflictPolicy("craft", "某文献标题")).to.equal("skip");
    expect(notifyLog.length).to.equal(1);
    expect(notifyLog[0].text).to.include("Craft");
  });

  it("超长标题被截断到 40 字符内（不撑爆通知条）", function () {
    const long = "很".repeat(100);
    autoSyncConflictPolicy("wps", long);
    expect(notifyLog[0].text!.length).to.be.lessThan(120);
  });
});
