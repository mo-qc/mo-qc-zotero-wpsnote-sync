/**
 * 分区标记短语（Craft 与 WPS 两端 marker 文案共用）。
 * 独立小模块：craftSync 与 syncEngine 互相 import 会成环，
 * 模块级常量在环上求值会触发 TDZ，故短语放在无依赖的本模块。
 */
export const PARTITION_PHRASE = "以下为我的笔记";
