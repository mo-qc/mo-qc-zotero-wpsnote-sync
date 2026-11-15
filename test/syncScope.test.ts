import { expect } from "chai";

const storage: Record<string, any> = {};
const libraries: Record<number, { libraryType: string }> = {};

(globalThis as any).Zotero = {
  Prefs: {
    get: (key: string) => storage[key],
    set: (key: string, value: any) => {
      storage[key] = value;
    },
  },
  Libraries: {
    get: (id: number) => libraries[id] || false,
  },
  log: () => {},
};

(globalThis as any).ztoolkit = {
  log: () => {},
};

const PREF_KEY = "extensions.zotero.zoterowpsnotesync.autoSyncLibraries";

describe("auto-sync library scope", function () {
  let getAutoSyncLibraryIds: typeof import("../src/utils/prefs").getAutoSyncLibraryIds;
  let isAutoSyncLibrary: typeof import("../src/utils/prefs").isAutoSyncLibrary;

  before(async function () {
    const mod = await import("../src/utils/prefs");
    getAutoSyncLibraryIds = mod.getAutoSyncLibraryIds;
    isAutoSyncLibrary = mod.isAutoSyncLibrary;
  });

  beforeEach(function () {
    for (const k of Object.keys(storage)) delete storage[k];
    for (const k of Object.keys(libraries)) delete libraries[Number(k)];
    libraries[1] = { libraryType: "user" };
    libraries[2] = { libraryType: "group" };
    libraries[3] = { libraryType: "feed" };
  });

  describe("getAutoSyncLibraryIds", function () {
    it("returns null when pref is unset/empty", function () {
      expect(getAutoSyncLibraryIds()).to.equal(null);
      storage[PREF_KEY] = "";
      expect(getAutoSyncLibraryIds()).to.equal(null);
    });

    it("parses a valid id list", function () {
      storage[PREF_KEY] = "[1,2]";
      expect(getAutoSyncLibraryIds()).to.deep.equal([1, 2]);
    });

    it("keeps an explicit empty list (sync nothing)", function () {
      storage[PREF_KEY] = "[]";
      expect(getAutoSyncLibraryIds()).to.deep.equal([]);
    });

    it("returns null for invalid JSON or non-array", function () {
      storage[PREF_KEY] = "not-json";
      expect(getAutoSyncLibraryIds()).to.equal(null);
      storage[PREF_KEY] = '{"1":true}';
      expect(getAutoSyncLibraryIds()).to.equal(null);
    });

    it("drops non-numeric entries", function () {
      storage[PREF_KEY] = '["abc",2,-1,0]';
      expect(getAutoSyncLibraryIds()).to.deep.equal([2]);
    });
  });

  describe("isAutoSyncLibrary (unconfigured default)", function () {
    it("excludes feed libraries", function () {
      expect(isAutoSyncLibrary(3)).to.equal(false);
    });

    it("includes user and group libraries", function () {
      expect(isAutoSyncLibrary(1)).to.equal(true);
      expect(isAutoSyncLibrary(2)).to.equal(true);
    });

    it("conservatively excludes unknown libraries", function () {
      expect(isAutoSyncLibrary(999)).to.equal(false);
    });
  });

  describe("isAutoSyncLibrary (explicit whitelist)", function () {
    it("only allows listed libraries, feeds need explicit opt-in", function () {
      storage[PREF_KEY] = "[1]";
      expect(isAutoSyncLibrary(1)).to.equal(true);
      expect(isAutoSyncLibrary(2)).to.equal(false);
      expect(isAutoSyncLibrary(3)).to.equal(false);
    });

    it("explicit empty list syncs nothing", function () {
      storage[PREF_KEY] = "[]";
      expect(isAutoSyncLibrary(1)).to.equal(false);
      expect(isAutoSyncLibrary(2)).to.equal(false);
    });

    it("explicitly selected feed library is allowed", function () {
      storage[PREF_KEY] = "[3]";
      expect(isAutoSyncLibrary(3)).to.equal(true);
      expect(isAutoSyncLibrary(1)).to.equal(false);
    });
  });
});
