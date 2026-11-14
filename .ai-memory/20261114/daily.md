# 2026-11-14

## [16:40] 动作: Craft 同步真机联调，修复 2 个阻断性 bug

- 文件: src/modules/craftClient.ts（2 处）
  1. 插件沙箱无全局 `AbortController`（WPS 路径走 `Zotero.HTTP.request` 故未暴露），`request()` 直接 `new AbortController()` 抛错 → 改用 `Promise.race` 超时，不依赖 signal
  2. `deleteBlocks` body 字段名 `ids` 被 Craft API 拒（400 VALIDATION_ERROR，details 指明 `path: ["blockIds"]`）→ 改为 `{ blockIds: ids }`（真机实验确认 200）
- 决策: 凭据写入用 execute_js 复刻 secret.ts 的 XOR+btoa 混淆算法，与插件 setCraftApiToken 读取同源；craftApiLink 明文、craftApiToken 混淆
- 验证: tsc=0 / prettier+eslint=0 / 89 单测通过 / build 成功；真机端到端：新建路径 + 更新路径均 success，Craft 文档 96e7f78e-6d34-4198-dbfc-97a064e90442 内容 11 子块完整，映射 craftDocId/lastSuccess 正常，noteId 复用不重复建
- 备注: .scaffold/build/zotero-wps-笔记同步-fix2.xpi 为绕过 MCP 安装工具参数去重的临时副本，可删

## [23:00] 动作: 依据 Zotero MCP / Craft API / WPS 笔记 MCP 文档做能力对齐优化

- 修复: `WpsMcpClient.readNote` 分页语义错误（请求 `limit` 未被识别、按 50 自增）→ 改用文档参数 `block_limit` + 服务端 `next_offset`，兜底 `offset + returned_blocks`；>119 块笔记回流不再重复拼接内容（真机 150 块探针：2 页 / 150 唯一 / 0 重复）
- 优化: 改动轮询 O(n)→O(1)。WPS 端一次 `list_notes` 取全量 `update_time` 索引，Craft 端一次 `GET /documents?fetchMetadata=true` 取 `lastModifiedAt`；批量失败时退回逐条 `get_note_info`/`fetchBlocks`
- 修复: `listNotes` 只拉一页会把未返回笔记误判「已删」→ 清映射后重复建笔记；改为 `page/page_size` 翻页 + note_id 去重 + 重复页即停
- 保真: `markdown.ts` 列表改输出原生 `p listType/listLevel`（保留嵌套层级、有序列表按同层连续项分配 `listId`），新增围栏代码块→`codeblock lang`（含 CDATA 与 `]]>` 拆分）与引用块；`htmlToWps.ts` 支持 `<pre><code class="language-x">`→codeblock（代码块内换行先占位，避免被顶层分块切碎）
- 回流: WPS 笔记图片块经 `read_image` 取 base64 回填 `<img src>`，不再退化为占位符
- Craft: `X-RateLimit-Reset` 实测是「距重置秒数」不是 epoch（修正）；新增 `X-BlockBudget-*` pacing、`listDocuments` 日期过滤、`moveDocuments`（`destination` 对象）、`searchInDocument`；`codeblock lang` 与 `p listType` 层级双向还原
- 修复: `pref-colorSemanticMap-help` 的 `{...}` 被 Fluent 当占位符解析，打包时整条帮助文本被静默丢弃 → 转义为 `{"{"}`/`{"}"}`
- 验证: tsc=0 / prettier+eslint=0 / 107 单测通过（新增 wpsClient 分页用例、markdown 代码块与嵌套列表用例、htmlToWps 代码块用例）/ 构建成功 / 真机：插件重载无错、WPS 单条同步成功、批量列表与分页确认、探针笔记已清理
- 备注: 实测 `PUT /blocks` 载荷为 `{blocks:[{id,markdown}]}`（传 `content` 才 400），既有实现正确；`PUT /documents/move` 必须 `{documentIds, destination:{folderId|destination}}`

## [23:15] 修复: 设置页下拉框点不动（同步目标/阅读预设/接口类型）

- 现象: 三个 `<html:select>` 可聚焦但弹不出下拉（真机点击复现，命中测试确认元素可达、pointer-events 正常）
- 根因: Zotero 偏好窗格文档是 XUL 命名空间（there.is.only.xul），Zotero 自带设置全用 XUL `<menulist native="true">`；HTML `<select>` 在该 iframe 里原生弹层不工作
- 修复: 三处 select 换成 `<menulist class="zws-menulist" preference="..." native="true"><menupopup><menuitem/></menupopup></menulist>`；preferenceScript 对 mcpInterfaceType 同时监听 change+command（macOS 原生 menulist 选完可能只发 command）
- 二次坑: XUL menuitem 的可见文本来自 `label` 属性，Fluent 纯值语法只写 textContent → menulist 收起时空白；8 个菜单项键改为 `.label =` 属性语法
- 验证: 真机确认三个 menulist 标签正确、绑定值正确（mcpInterfaceType 正确回显 local）、command 事件后 `extensions.zotero.zoterowpsnotesync.syncTarget` 正确写回 wps/craft、复选框交互正常；偏好已还原（syncTarget=wps, readingPreset=full, mcpInterfaceType=local, craftArchiveByTag=false）
- 备注: Zotero `_initImportedNodesPostInsert` 会在插入时把 preference 自动补全为完整键名并绑定 command/input/change 三个事件

## [23:35] 修复: 审查发现的 5 个正确性缺陷（数据丢失类）

1. auto-sync 静默覆盖远端手改（hooks.ts）：新增 `autoSyncConflictPolicy`——kind=item（条目自身变更=推送意图）照常覆盖；kind=wps/craft（远端手改）跳过本次+ProgressWindow 提醒，不受 promptOnConflict 影响。E2E：远端插入 REMOTE-EDIT-MARKER 后触发条目修改，自动同步后 marker 幸存
2. WPS 标题搜索兜底无归属校验（syncEngine.ts）：新纯函数 `pickWpsSearchMatch`，匹配优先级=精确模板标题>含唯一 itemKey>宽松包含文献标题，每级过滤已映射给其他条目的候选（对齐 Craft 侧既有校验）。8 个单测覆盖
3. 自身 extra 写入触发第二轮全量同步（syncEngine/craftSync/hooks）：新增 `markSelfSave/isSelfSave`（10s 窗口，Map 上限 1000），writeNoteIdToExtra/clearNoteIdFromExtra/writeCraftDocIdToExtra/clearCraftDocIdFromExtra 在 saveTx 前标记，hooks.onNotify 过滤
4. Craft 先插后删的滞留（craftSync.ts）：删除失败后同轮重取子块复核（滞留=失败批次∩仍存在块）重删一次，仍滞留抛 DELETE_LEFTOVER 判本轮失败（不写 lastSuccess，下次同步完整流程自愈）
5. 回流图片全灭（wpsMcpClient/ui.ts）：根因是 read_image 的 base64 在 MCP 原生 image content 项里，parseToolResult 只认 text 把它丢了——现在保留 __mcpContent，readImage 优先读 image 项；回填改为按 read_note 的 `<img id>` 逐块对应（不再按 outline 顺序错位），同块去重，无 id 时退回 outline 按序。E2E：探针笔记插图→pull→子笔记含 data:image/png;base64 且复用既有子笔记

- 验证: tsc=0 / eslint+prettier=0 / 116 单测通过（+9）/ 构建成功 / 新 XPI 已装并重载 / 错误台仅剩 zoterostyle 无关报错
- 清理: 探针笔记（含图片）已删、临时映射与 extra 已还原为 586551322554、_zws_probe2 标签已移除、探针回流子笔记已删除
- 未验证披露: 修复 1/3/4 的完整自动同步链路只做了关键路径 E2E（远端冲突跳过）与单测，长窗口时序（10s 窗口外真实用户编辑、批量并发下 Craft 滞留重删）未做自动化覆盖
