# dsh-prompt-reforge

一个 DeepSeek Harness（DSH）输入栏控件：把正在写的草稿重写成更精确的提示词，再点一下就能恢复原文。

它待在输入栏工具栏、模型选择器旁边。没有弹窗、没有侧栏——重写结果直接落在你已经盯着的那个输入框里。

```
[ + ]  [ 权限 ]                  [ ✨ ]  [ ▾ 模型 ]
                                   │
                                   └─ 点一下重铸，再点一下恢复
```

## 交互

| 状态 | 表现 |
| --- | --- |
| 草稿为空 | 按钮不可用，提示「先在输入框里写点内容，再来重铸。」 |
| 未选模型 | 不可用，提示「先选一个模型，再重铸。」 |
| 草稿里带引用 chip | 不可用——重写会丢掉 chip。提示「先移除引用，再重铸。」 |
| 就绪 | 按钮激活，可以点。 |
| 重铸中 | 转圈，显示「重铸中…」。再点一次即取消。 |
| 已重铸 | 草稿被替换，同一个按钮变成「恢复原文」。 |
| 之后继续打字 | 备份被丢弃，恢复操作不会悄悄吞掉你的修改。 |
| 失败 | 草稿原样不动，原因写在 tooltip 里。 |

重写走的是**该会话当前选中的模型与提供方**，因此结果贴合你接下来要对话的助手。草稿不会被发到别处。

## 安装

走 DSH 插件管理器，直接指向发布出来的 tarball：

```
plugin_manager action=install_bundle target=https://github.com/Cloud017/dsh-prompt-reforge/releases/download/v0.2.0/dsh-prompt-reforge-0.2.0.tgz
```

或指向本地检出目录：

```
plugin_manager action=install_bundle target=<本目录绝对路径>
```

或在图形界面里：**插件 → 添加插件 → 安装第三方插件**，粘贴 Release 地址、仓库地址或本地目录，然后重启 DSH。

装好后 `dsh.profile.bundles` 会多一条。本插件只增加一行宿主行，不改你的模型路由、提供方或默认模型。

## 实现

两半都在本包里：

- **宿主半**（`lib/index.js`）在 harness 的 web server 上注册一条 `POST /plugins/dsh-prompt-reforge/enhance` 路由。它校验请求、对会话已路由的模型调用 `ctx.llm.stream()`、返回归一化后的文本。它拒绝非回环请求，请求体上限 256 KiB、草稿上限 20 000 字，浏览器断开或 60 秒预算耗尽都会中止模型调用。
- **浏览器半**（`lib/client.js`）往 `conversation.input.right` 槽注册一个控件。它持有按钮状态机、用 `fetch` 调上面那条路由、并通过输入框自己的 `inputActions.setDraft` 把结果写回去。

浏览器 bundle 除模块加载器提供的 React 外不依赖任何东西；宿主半不从 `@deepseek-ai/*` 导入任何东西，而是通过 `ctx.get('llm')` 拿 LLM 运行时。

### 为什么状态放在 React 外面

按钮状态按会话分键、存在模块级 Map 里，而不是组件 state。输入栏座位随时会被卸载重挂（切会话、改尺寸、布局变化），而一次进行中的重写必须熬过这些。取消用 `AbortController` 的身份判定，而不是序号，因此被取消的调用即便迟到，也绝不会覆盖你的草稿。

### 请求契约

`POST /plugins/dsh-prompt-reforge/enhance`

```json
{ "draft": "粗糙的文本", "provider": "workbuddy", "model": "deepseek-v4.1-flash", "sessionId": "session-…" }
```

成功：`200 { "ok": true, "text": "…" }`

失败：`{ "ok": false, "error": { "code": "…", "message": "…" } }`

| 状态码 | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_body` | 请求体不是 JSON 对象 |
| 400 | `empty_draft` | 没有可重写的内容 |
| 400 | `missing_route` | 缺 `provider` 或 `model` |
| 403 | `request_not_trusted` | `Host` 非回环或 `Origin` 为外部来源 |
| 405 | `method_not_allowed` | 不是 POST |
| 413 | `body_too_large` / `draft_too_long` | 超过体积上限 |
| 499 | `aborted` | 浏览器已断开 |
| 502 | `empty_result` / 上游 code | 模型没给出可用结果 |
| 503 | `llm_unavailable` | 当前组合没有 LLM 运行时 |
| 504 | `timeout` | 超过 60 秒预算 |

## 配置

无需配置。上限常量在 `lib/index.js` 与 `lib/client.js` 顶部，想改就 fork：

| 常量 | 默认值 | 位置 |
| --- | --- | --- |
| `MAX_DRAFT_CHARS` | 20 000 | 两半必须一致 |
| `MAX_BODY_BYTES` | 256 KiB | 宿主半 |
| `MAX_TOKENS` | 2 048 | 宿主半 |
| `TIMEOUT_MS` | 60 000 | 宿主半 |
| `LENGTH_BUDGET` | 800 字符 | 提示词（`lib/prompts.js`） |

## 开发

```sh
node --test          # 65 项测试，除 Node 外无依赖
```

测试覆盖提示词流水线、路由（回环拒绝那条用裸 socket 驱动，因为 `fetch` 伪造不了 `Host` 头）、以及按钮状态机（对着一个最小 React 替身跑，不进 DOM、不开浏览器）。

结构：

```
lib/index.js     宿主半：路由、校验、LLM 调用、错误映射
lib/http.js      回环守卫、JSON 响应、有界请求体读取
lib/llm.js       流消费与失败分类
lib/prompts.js   系统提示词、用户模板、输出归一化
lib/client.js    浏览器半：输入栏控件
locale/          插件列表元数据
test/            node:test 套件
```

## 兼容性

DSH `0.2.1-rc.1` 及以上、`0.3.0` 以下。那些 `@deepseek-ai/*` peer 依赖声明为 optional：它们由 harness 组合图提供，本包从不安装；组合里缺一个只会降级功能，不会让客户端崩掉。

## 许可

MIT © Cloud017
