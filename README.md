# dsh-cost-meter

DeepSeek Harness 会话费用插件。它在输入区下方的用量行——也就是已经显示「输入 / 输出 / 缓存命中率」的那一行——新增一个**当前对话费用**徽标；点开后按模型和峰谷时段列出本会话的分项费用，并显示账户余额。

A per-conversation cost plugin for DeepSeek Harness. It adds a **current conversation cost** pill to the composer's usage dock — the ambient row below the input area that already carries the token-total and cache-hit-rate pill — and expands into a breakdown priced by model and peak/off-peak phase, together with the account balance.

```
   [◷ 1.2M tok · 99.2%]  [¥ 0.9745]        ← composer dock
                          └─ click
   ┌──────────────────────────────────────────┐
   │ 会话费用                          ¥0.9745 │
   │ [谷时]  距切换 33分                       │
   │ 输入 · 缓存未命中    164K tok    ¥0.1636 │
   │ 输入 · 缓存命中      20.2M tok   ¥0.4045 │
   │ 输出                 102K tok    ¥0.4063 │
   │ 合计                 20.5M tok   ¥0.9745 │
   │ 缓存命中率 99.2% · 118 次调用 · 1 轮      │
   │                                          │
   │ 按模型计价                                │
   │ deepseek-official / deepseek-flash       │
   │   118 次 · 20.5M tok            ¥0.9745  │
   │                                          │
   │ 账户余额                      ¥123.45    │
   │ 赠送 ¥10.00 · 充值 ¥113.45 · 更新于 13:2 │
   │ ──────────────────────────────────────── │
   │ 价格表 官方页面 · 更新于 13:35   [刷新]   │
   └──────────────────────────────────────────┘
```

## 安装 / Install

```bash
# 在 DSH 中，用绝对路径安装本目录（会写入当前 profile）
# In DSH, install this directory by absolute path (writes to the current profile)
plugin_manager install_bundle /Users/liofranxx/Desktop/project/dsh-plugin/dsh-cost-meter
```

安装后 `plugin_manager` 返回的 `application` 决定改动是否生效：`applied` 表示已经通过 HMR 生效，`restart-required` 表示需要完全重启 DSH 才会加载新的 JavaScript 模块。

`install_bundle` 会把本目录链接进 profile 的 `node_modules` 并在 `dsh.profile.bundles` 中登记；不要把本目录手工拷进 `$DSH_HOME`，也不要手工编辑 profile 的 `package.json` 或 `cordis.patch.yml`。

## 它从哪里取数 / Where the numbers come from

| 显示项 | 来源 |
|---|---|
| 每个模型、每次调用的 token | 会话日志里的 `assistant/message` 事件，使用 provider 上报的 `usage`（`inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`） |
| 每次调用的模型 | 该事件的 `message.source.provider` / `message.source.model` |
| 每次调用的峰谷时段 | 该事件自己的时间戳 → 北京时间规则 |
| 价格 | 优先读取兄弟插件 `dsh-deepseek-peak-pricing` 已同步的官方价格快照；否则用内置兜底表 |
| 余额 | 优先 `ctx.deepseekAccount`（已登录的 DeepSeek 账户）；否则用开放平台 API Key 查询 `GET https://api.deepseek.com/user/balance` |

三点设计取舍：

1. **费用在 Host 端算，不在浏览器算。** 浏览器的 `tokenUsage` 投影只有整场会话的合计，无法说明哪次调用属于哪个模型、计在哪个时段。Host 端用 `ctx.sessionQuery.readSession(sessionId)` 拿到完整日志后逐条计价，浏览器只负责渲染。浏览器从不解析会话日志，也从不接触 API Key。
2. **按“每次调用的时刻”计价，而不是按“当前时刻”。** 一次会话跨过 14:00 的切换时，切换前后分别按高峰价和谷时价计费，最终费用与账单一致。`pricing.phase` 只用来显示当前时段和倒计时。
3. **价格表只有一个来源。** 兄弟插件已经在同步官方价格页，本插件直接复用它的快照，避免两个插件报出两组价格。没有它时用内置兜底表，插件独立可用。

## 配置 / Configuration

可选配置文件：`<DSH_HOME>/storages/dsh-cost-meter/config.json`（默认 `~/.dsh/storages/dsh-cost-meter/config.json`）。首次挂载会写一份带注释的示例，删掉注释行不影响解析。

```json
{
  "locale": "zh",
  "decimals": 4,
  "useSiblingPricing": true,
  "holidays": ["2026-10-01", "2026-10-02"],
  "cacheSeconds": 8,
  "prices": {
    "models": {
      "deepseek-flash": {
        "peak":    { "cacheHit": 0.04, "cacheMiss": 2,   "output": 8 },
        "offPeak": { "cacheHit": 0.02, "cacheMiss": 1,   "output": 4 }
      }
    }
  },
  "balance": {
    "enabled": true,
    "apiKeyEnv": "DEEPSEEK_BALANCE_API_KEY",
    "fallbackKeyEnvs": ["DEEPSEEK_API_KEY"],
    "baseUrl": "https://api.deepseek.com",
    "refreshMinutes": 5
  }
}
```

| 字段 | 说明 |
|---|---|
| `locale` | `zh` / `en`。仅作兜底，面板实际跟随 DSH 语言。 |
| `decimals` | 金额小数位，2–8，默认 4。低于该量级的金额自动多给两位，不会被舍入成 `0.00`。 |
| `useSiblingPricing` | `false` 时忽略兄弟插件的快照，直接用内置表。 |
| `holidays` | 北京时间法定节假日 `YYYY-MM-DD`，全天按谷时计价。内置为空，需要时自行填写。 |
| `cacheSeconds` | 同一会话的计价结果缓存时长，同时决定浏览器轮询间隔。 |
| `prices` | 覆盖价格表的任意子集，单位是「币种 / 百万 token」。支持 `models` 为对象或数组两种写法。 |
| `balance.apiKeyEnv` | 开放平台 API Key 所在的**环境变量名**（不是 Key 本身）。通过 `ctx.credentials` 解析，因此进程环境、凭据库、`.env` 三层都生效，Key 不写入插件配置、不回传浏览器。 |
| `balance.fallbackKeyEnvs` | 上者缺失时依次尝试的名字。 |
| `balance.baseUrl` | 余额端点前缀，默认官方地址。 |

余额查询失败不会清掉上一次的好结果：面板会继续显示上一次的数字并标注「刷新失败」，而不是变成空白。

官方账户登录用的是推理令牌，与开放平台 API Key 是两套凭据。把推理令牌用于 `/user/balance` 会返回 401 —— 这时请设置 `DEEPSEEK_BALANCE_API_KEY` 为开放平台 Key。

## 价格与时段规则 / Pricing rule

高峰时段为北京时间周一至周五 09:00–12:00 与 14:00–18:00（不含 `holidays` 列出的法定节假日）；其余时间——包括周末与节假日全天——为谷时，谷时价为高峰价的一半。规则与时段窗来自价格表的 `rules` 字段，因此跟随官方页面的更新。

## 扩展点 / Extension point

| 项 | 值 |
|---|---|
| Host 服务 | `webServer`（必需）；`sessionQuery`、`deepseekAccount`、`credentials`、`web` 全部按可选依赖用 `ctx.get()` 访问 |
| 路由 | `GET /cost-meter/api/state?sessionId=…`、`POST /cost-meter/api/refresh?sessionId=…`、`GET /cost-meter/api/pricing` |
| Client 插槽 | `conversation.composer.dock`，`id: cost-meter`，`order: 1`（宿主自己的用量徽标是 `order: 0`） |
| 样式 | 只使用 `--dsw-alias-*` / `--dsw-specific-*` / `--dsw-radius-*` 等主题 token，类名统一 `dcm-` 前缀 |
| 依赖 | 无。仅 Node 内置模块与 `require('react')` / `require('react-dom')`（后两者由页面的种子模块表提供） |

面板用 `createPortal` 挂到 `document.body`，与宿主自己的用量/耗时面板做法一致——输入区是滚动容器，弹出层留在插槽内会被裁掉。

## 测试 / Tests

```bash
npm test
```

- `test/pricing.test.mjs` — 峰谷规则（含周末、节假日、跨日窗口与切换时刻）、价格表归一化、模型匹配、分桶计价、会话折叠。
- `test/host.test.mjs` — 配置解析、价格表优先级、payload 组装，以及 `GET /cost-meter/api/state` 的端到端行为（含跨站与非法 Host 拒绝）。全部在临时 `DSH_HOME` 下运行，不读写真 profile，不发网络请求。
- `test/client-bundle.test.mjs` — 浏览器包在沙箱模块表下物化、只引用种子模块、注册到正确的插槽与顺序、徽标渲染、缺失 `slots`/`sessionId` 时的降级，以及样式表不含字面颜色。

## 已知边界 / Known limits

- **`holidays` 默认是空的。** 内置兜底表不含法定节假日，因此节假日会被当成工作日按窗口计价。需要精确时请填写，或依赖兄弟插件显示的高峰/谷时徽标核对。
- **只对已上报 `usage` 的调用计价。** 未上报 usage 的 `assistant/message` 会被跳过（不计入次数），价格表未匹配到的模型会照常统计 token 但费用为 0，并在面板上标注「未匹配价格表」。
- **余额取决于凭据。** 未登录 DeepSeek 账户且未设置开放平台 Key 时，余额一栏会说明原因而不是显示一个数字。
- **子代理会话单独计价。** 每个会话只统计自己的日志，父会话不汇总子代理的费用。
