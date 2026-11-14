# Zotero → WPS 笔记同步

[![zotero target version](https://img.shields.io/badge/Zotero-7%2B-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)

一个 Zotero 7+ 插件（已在 Zotero 10 上验证），通过 WPS MCP（Model Context Protocol）接口将文献条目、子笔记、PDF 链接和批注同步到 **WPS 笔记**，并支持受控双向回流。

[English](../README.md) | [简体中文](./README-zhCN.md)

## 功能

- **手动与自动同步**：右键选中文献条目后一键同步；或给条目添加指定标签后自动触发同步。
- **丰富内容**：同步元数据、摘要、附件、PDF 批注、子笔记和标签。
- **Markdown 支持**：将批注与笔记转换为 WPS 兼容的 XML，支持粗体、斜体、链接、表格、嵌套列表（`listLevel` 层级）、清单、围栏代码块（含语言标记）、引用块、行内/块级 LaTeX 公式和行内代码。
- **本地图片**：同步笔记时，本地附件图片会以 base64 data URI 形式嵌入；从 WPS 回流时通过 `read_image` 取回图片块并转为 data URI。
- **增量同步**：通过记录 Zotero 修改时间，跳过未发生变化的条目。
- **冲突处理**：当已同步条目发生变化时，提示选择覆盖、跳过或新建副本。
- **去重更新**：通过本地 item-key → note-id 映射表更新已有 WPS 笔记，并支持映射失效检测与重建。
- **同步历史**：查看最近同步状态、WPS 笔记 ID 和错误信息。
- **可取消进度**：关闭同步进度窗口即可取消当前同步。
- **文件夹同步**：支持一次性同步整个分类/文件夹。
- **模板自定义**：使用类 Mustache 模板引擎自定义笔记标题与正文，内置预设模板，并可用当前选中文献做实时渲染预览。
- **受控双向同步**：后台轮询比对 WPS 端 `update_time`，发现改动先提醒再拉取；手动「从 WPS 拉取」把笔记写回 Zotero 子笔记，重复拉取复用同一篇（不堆重复）。
- **回收站感知**：同步的笔记在 WPS 端被删除（进回收站）后，自动清理映射与条目 extra 中的 `ZWS-Note-Id` 冗余，下次同步重建新笔记。
- **映射自愈**：WPS 笔记 ID 冗余写入条目 extra 字段，映射存储丢失后可自动恢复。
- **MCP 配置验证**：粘贴 MCP JSON 后可一键「验证配置」（格式结构 + 真实连接测试），防复制粘贴错误。
- **语义富文本输出**：内容按 WPS 原生块渲染（高亮块、分栏、表格、引用、代码块），而非拍平纯文本。
- **自动同步触发**：按标签自动同步；元数据/批注/子笔记修改后数秒内自动重新同步（AI 工具写入的子笔记改动也能触发）。
- **并发控制**：批量同步支持可配置并发数，避免触发 WPS 限流。
- **MCP Server 对外端点**：插件在本机 `http://127.0.0.1:23119/wpsnote/mcp`（Streamable HTTP）提供 MCP 端点，供 Claude、llm-for-zotero 等外部 AI 客户端读取同步状态、检出 WPS 改动，并在设置中显式开启后触发同步/回流。写工具默认关闭，可选配访问令牌。
- **AI 对话式同步**：向 llm-for-zotero 注册 `wps_sync_status`、`wps_poll_changes`、`wps_sync_item`、`wps_pull_note` 四个 agent 工具，可在对话中让 AI 代为同步或回流（写操作需聊天内确认卡）。
- **Better Notes 笔记链接转换**：子笔记中的 Better Notes `zotero://note/u/<KEY>/` 链接自动改写为目标笔记的 WPS 可点击链接；未同步或死链降级为纯文本。

## 环境要求

- Zotero 7+（开发与验证环境为 Zotero 10）
- Node.js LTS
- WPS 笔记 MCP API Key（云端或本地 streamable_http 端点）

## 快速开始

1. 安装依赖：

   ```sh
   npm install
   ```

2. 复制环境变量文件并配置 Zotero 路径：

   ```sh
   cp .env.example .env
   ```

3. 启动开发服务器：

   ```sh
   npm start
   ```

   该命令会自动构建插件、启动 Zotero 并开启热重载。

4. 在 Zotero 插件首选项中填入 **WPS MCP API Key** 和端点。

5. 选中一个或多个条目，右键选择 **"同步到 WPS 笔记"**。

## 构建

```sh
npm run build
```

构建产物位于 `.scaffold/build/`。

## 测试

```sh
npm run test:unit
```

## 配置说明

在 Zotero 中打开 **编辑 → 首选项 → Zotero → WPS 笔记同步**。

| 首选项            | 说明                                                     |
| ----------------- | -------------------------------------------------------- |
| MCP 端点          | WPS MCP 端点，例如 `https://ainote.kdocs.cn/mcp-svc/mcp` |
| API Key           | WPS MCP API 密钥                                         |
| 接口类型          | 云端 MCP 或本地 streamable_http                          |
| 默认标签          | 每次同步时附加的标签                                     |
| 更新已存在的笔记  | 更新已有 WPS 笔记，而非创建新笔记                        |
| 增量同步          | 跳过自上次同步以来未变化的条目                           |
| 冲突时提示        | 条目变更时询问处理方式                                   |
| 同步内容开关      | 摘要、附件、PDF 批注、标签、子笔记                       |
| 自动同步标签      | 添加该标签后自动同步                                     |
| 修改时自动同步    | 元数据/批注变更后数秒内自动重新同步                      |
| 同步并发数        | 批量同步并行数（建议 1–5）                               |
| WPS 改动轮询      | 定期检查已同步笔记的 WPS 端改动并提醒                    |
| MCP Server 写操作 | 允许外部 MCP 客户端调用同步/回流工具（默认关闭）         |
| MCP Server 令牌   | 可选：要求 MCP 客户端携带的访问令牌                      |
| 标题/正文模板     | 使用模板语法自定义输出格式                               |

### 模板语法

变量使用双大括号，原样输出 XML 使用三大括号：

```text
{{title}}
{{{abstractParagraph}}}
```

条件判断：

```text
{{#if hasAbstract}}
<h2>摘要</h2>
{{{abstractParagraph}}}
{{/if}}
```

循环：

```text
{{#each attachments}}
<p>{{title}}</p>
{{/each}}
```

常用变量包括 `title`、`authors`、`yearOrDate`、`publicationTitle`、`itemType`、`DOI`、`url`、`citeKey`、`itemKey`、`abstractParagraph`、`doiLink`、`urlLink`、`hasAnnotations`、`annotationGroupsByColor`、`hasNotes`、`contentParagraph`、`hasTags` 等。

## 项目结构

```text
.
├── addon/              # 插件静态资源（manifest、bootstrap、UI、本地化）
├── src/                # TypeScript 源码
│   ├── modules/        # 业务模块（同步引擎、MCP 客户端、UI 等）
│   └── utils/          # 工具函数（模板引擎、XML 辅助、偏好设置）
├── test/               # 单元测试
├── typings/            # TypeScript 类型声明
└── zotero-plugin.config.ts
```

## 致谢

本插件基于 [windingwind](https://github.com/windingwind) 的 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) 构建，并使用了以下开源项目：

- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)
- [zotero-types](https://github.com/windingwind/zotero-types)

## 许可证

本项目采用 GNU Affero General Public License v3.0 或更新版本（AGPL-3.0+）授权。完整文本见 [LICENSE](../LICENSE)。
