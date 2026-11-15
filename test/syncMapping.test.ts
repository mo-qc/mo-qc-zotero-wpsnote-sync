import { expect } from "chai";
import type {
  recordSyncResult as RecordSyncResult,
  getMappedEntry as GetMappedEntry,
  getAllMappings as GetAllMappings,
  removeMappedNote as RemoveMappedNote,
  recordPullNoteId as RecordPullNoteId,
  updateNoteModified as UpdateNoteModified,
} from "../src/modules/syncMapping";

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

describe("syncMapping", function () {
  let recordSyncResult: typeof RecordSyncResult;
  let getMappedEntry: typeof GetMappedEntry;
  let getAllMappings: typeof GetAllMappings;
  let removeMappedNote: typeof RemoveMappedNote;
  let recordPullNoteId: typeof RecordPullNoteId;
  let updateNoteModified: typeof UpdateNoteModified;

  before(async function () {
    const mod = await import("../src/modules/syncMapping");
    recordSyncResult = mod.recordSyncResult;
    getMappedEntry = mod.getMappedEntry;
    getAllMappings = mod.getAllMappings;
    removeMappedNote = mod.removeMappedNote;
    recordPullNoteId = mod.recordPullNoteId;
    updateNoteModified = mod.updateNoteModified;
  });

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

  it("records pull note id for re-pull reuse", function () {
    recordSyncResult("ITEM1", { success: true, noteId: "NOTE1" });
    recordPullNoteId("ITEM1", "777");
    expect(getMappedEntry("ITEM1")?.pullNoteId).to.equal("777");
    // 覆盖更新：重复拉取只保留最新子笔记 id
    recordPullNoteId("ITEM1", "888");
    expect(getMappedEntry("ITEM1")?.pullNoteId).to.equal("888");
    // 其他字段不受影响
    expect(getMappedEntry("ITEM1")?.noteId).to.equal("NOTE1");
  });

  it("ignores pull note id when mapping missing", function () {
    recordPullNoteId("NOPE", "777");
    expect(getMappedEntry("NOPE")).to.be.undefined;
  });

  it("updates note modified baseline without touching sync state", function () {
    recordSyncResult("ITEM1", { success: true, noteId: "NOTE1" });
    const before = getMappedEntry("ITEM1")?.lastSync;
    updateNoteModified("ITEM1", "1794550000000");
    const entry = getMappedEntry("ITEM1");
    expect(entry?.noteModified).to.equal("1794550000000");
    expect(entry?.lastSync).to.equal(before);
    expect(entry?.lastSuccess).to.equal(true);
  });

  it("records and preserves wpsMarkerBlockId independently of craft marker", function () {
    recordSyncResult("ITEM1", {
      success: true,
      noteId: "NOTE1",
      craftDocId: "DOC1",
      markerBlockId: "craft-marker",
      wpsMarkerBlockId: "wps-marker",
    });
    let entry = getMappedEntry("ITEM1");
    expect(entry?.markerBlockId).to.equal("craft-marker");
    expect(entry?.wpsMarkerBlockId).to.equal("wps-marker");

    // 后续同步结果不带 marker 字段时，已有值保留（undefined 不覆盖）
    recordSyncResult("ITEM1", { success: true, noteId: "NOTE1" });
    entry = getMappedEntry("ITEM1");
    expect(entry?.markerBlockId).to.equal("craft-marker");
    expect(entry?.wpsMarkerBlockId).to.equal("wps-marker");
  });
});
