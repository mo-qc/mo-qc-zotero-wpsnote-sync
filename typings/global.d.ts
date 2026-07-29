declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

// XPCOM 全局变量，Zotero 插件环境可用
/* eslint-disable no-var */
declare var Components: any;
declare var Cc: typeof Components.classes;
declare var Ci: typeof Components.interfaces;
declare var Services: any;
/* eslint-enable no-var */
