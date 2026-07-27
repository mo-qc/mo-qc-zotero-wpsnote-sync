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
};

(globalThis as any).ztoolkit = {
  log: () => {},
};

const {
  recordSyncResult,
  getMappedEntry,
  getAllMappings,
  removeMappedNote,
} = await import("../src/modules/syncMapping");

describe("syncMapping", function () {
  beforeEach(function () {
    Object.keys(storage).forEach((k) => delete storage[k]);
  });

  it("records a successful sync result", function () {
    recordSyncResult("ITEM1", {
      success: true,
      title: "Test Item",
      noteId: "NOTE1",
      noteUrl: "https://example.com/note/NOTE1",
      itemModified: "2025-07-27T00:00:00.000Z",
    });
    const entry = getMappedEntry("ITEM1");
    expect(entry).to.exist;
    expect(entry?.noteId).to.equal("NOTE1");
    expect(entry?.title).to.equal("Test Item");
    expect(entry?.lastSuccess).to.equal(true);
    expect(entry?.itemModified).to.equal("2025-07-27T00:00:00.000Z");
  });

  it("records a failed sync result", function () {
    recordSyncResult("ITEM1", {
      success: false,
      title: "Test Item",
      error: "network error",
      errorType: "network",
    });
    const entry = getMappedEntry("ITEM1");
    expect(entry?.lastSuccess).to.equal(false);
    expect(entry?.lastError).to.equal("network error");
    expect(entry?.lastErrorType).to.equal("network");
  });

  it("removes a mapping", function () {
    recordSyncResult("ITEM1", {
      success: true,
      noteId: "NOTE1",
    });
    removeMappedNote("ITEM1");
    expect(getMappedEntry("ITEM1")).to.be.undefined;
  });

  it("preserves existing fields when updating", function () {
    recordSyncResult("ITEM1", {
      success: true,
      title: "Test Item",
      noteId: "NOTE1",
      noteUrl: "https://example.com/note/NOTE1",
      itemModified: "2025-07-27T00:00:00.000Z",
    });
    recordSyncResult("ITEM1", {
      success: false,
      error: "timeout",
    });
    const entry = getMappedEntry("ITEM1");
    expect(entry?.title).to.equal("Test Item");
    expect(entry?.noteId).to.equal("NOTE1");
    expect(entry?.noteUrl).to.equal("https://example.com/note/NOTE1");
    expect(entry?.lastSuccess).to.equal(false);
  });

  it("lists all mappings", function () {
    recordSyncResult("ITEM1", { success: true, noteId: "NOTE1" });
    recordSyncResult("ITEM2", { success: true, noteId: "NOTE2" });
    const all = getAllMappings();
    expect(Object.keys(all)).to.have.lengthOf(2);
    expect(all.ITEM1.noteId).to.equal("NOTE1");
    expect(all.ITEM2.noteId).to.equal("NOTE2");
  });
});
