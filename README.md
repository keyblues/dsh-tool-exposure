# dsh-tool-exposure

[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-4c6ef5?style=flat-square)](#)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness-5b6bff?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square)](package.json)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5%2B-4D6BFE?style=flat-square)](package.json)
[![repository](https://img.shields.io/badge/repository-keyblues%2Fdsh--tool--exposure-181717?style=flat-square&logo=github)](https://github.com/keyblues/dsh-tool-exposure)

> **English** — Role-scoped tool exposure for DeepSeek Harness (DSH) agent presets: a Settings page where you pick a role and raise or lower which tools registered by third-party plugins that role can see — per tool group, and per tool inside a group. The resulting mask is registered through `ctx.tools.restrict` when the agent is created, so a hidden tool is both invisible and uncallable (`UNKNOWN_TOOL`); configuration saves take effect only for new sessions (snapshot semantics), while existing sessions keep the tool surface they were created with.

按**角色（agent preset）**管理「第三方插件注册的工具」的暴露面。提供一个 Settings 页：
先用角色卡片选一个角色，再在下方逐组（以及组内单个工具）开关它能看到什么。

```
Settings → 工具暴露

角色
┌──────────────────────┐ ┌──────────────────────┐
│ 资产专家  白名单      │ │ standard  默认  [选中]│
│ 企业互联网资产…       │ │                      │
│ 可见 21/30           │ │ 可见 30/30           │
└──────────────────────┘ └──────────────────────┘

资产专家 · 21/30            [恢复全局默认]
  基线        默认开放 / 白名单   [白名单]
  FOFA 测绘   fofa_* · 3 个工具    ●
  鸿蒙设备    hdc_*, hms_* · 21    ○
  最终可见工具 ▸
```

## 它解决什么问题

DSH 里工具按注册位置分两层：

| 来源 | 例子 | 可见范围 |
| --- | --- | --- |
| profile 级（Host 全局） | `dsh-fofatoto`(fofa_*)、`@local/icp-mcp`(mcp__icp__*)、`fengniao_*`、`everything_*`、`dsh-hdc-bridge`(hdc_*/hms_*) | **所有角色都看得见** |
| preset 内挂载（scope-local） | redteam 的 tscanplus/reqable、各 preset 自己的 fs/pwsh/web/subagent… | 只有该角色看得见 |

第二类天然按角色隔离；第一类此前只能整体保留或整体搬进 preset。本插件用
`ctx.tools.restrict({ deny })` 在 **agent 作用域**给第一类工具加掩码，从而做到「插件只装一份（共享连接/服务/配置页），
但工具按角色收窄」。

## 机制（全部是 DSH 现有 API，不改任何内置插件）

- **受管集合**：`config.sources` 各组 `match` 通配符对「当前全局工具名」展开的并集。不在任何组里的全局工具
  **永远不受影响**（页面里显示为「未归组」）。
- **角色识别**：`agentPresets.composedPreset(agent.ctx)`。注意时机：`agent/created` 触发时 preset 可能还没挂载完
  （实测子代理会返回 undefined），所以解析不到角色的 agent 先挂起，在**第一次 `agent/pre-step`**
  （preset 已挂载、请求尚未组装）补应用；能直接解析到角色的 agent 就在创建时应用。
  首次 pre-step 仍解析不到时最多再等 2 个 pre-step（共 3 次），之后按 unlisted 应用并留日志，避免永久静默 fail-open。
- **应用点**：把该角色应隐藏的受管工具用 `agent.ctx.tools.restrict({ deny })` 注册在
  `agent.ctx.effect()` 上。效果是「看不见 + 调不到」：lookup/dispatch 一致消失，调用得到 `UNKNOWN_TOOL`；
  PTC 模式下连 SDK 绑定都不会生成。
- **快照语义**：只在 agent 创建（或第一次 pre-step）时应用。**配置保存只影响新建会话**，已有会话保持创建时的工具面。
  插件加载/重载时已存在的 agent 会被标记为 legacy，不重算。
- **晚注册工具**：尚未开始第一步的 agent（`agent/inbox/claimed` 之前）会在 `tools/change` 时重算一次，
  用于收掉 MCP 等异步晚注册的工具；一旦开始工作即冻结。
- **硬约束**（来自 `ctx.tools` 契约）：`restrict` 过滤 global 与 ancestor preset 层；本插件只下发
  「当前确实已注册的全局工具名」，scope-local 名字不参与。未知名字 / 空过滤器 / own-scope 名字会抛错，
  因此空集合直接跳过，异常只记日志不崩会话。
- **保留 transport 不参与**：PTC 模式的 `run_code` 是 dsh-tools 的保留 transport（“per-agent restrictions must not remove it”），
  从受管集合与 deny 里排除；否则 `restrict` 会抛错、整条策略静默失效（fail-open）。
- **读取失败 fail-closed**：`tools.schemas()` 抛错（例如某插件注册了非法 `parameters`）时，不会当成「没有工具」
  去下发空掩码，而是保留现有掩码、不落已应用签名，等下一次 `tools/change` 再试；页面给一条 error 诊断。
- **状态存储**：每个 agent 的 PENDING/LEGACY/STARTED/APPLIED 状态放在模块级 `WeakMap` 里，不写 agent 属性，
  因此被 `Object.freeze` 的 agent 也能正确记录，不会每次重算都叠加一层永不解绑的 restriction。
- **路由挂载**：`webServer` 是可替换服务；路由按「当前实例」判重，服务替换后会重新注册，不会出现永久 404。
- **同源校验**：除 `x-dsh-tool-exposure-plugin` 守卫头外，还校验 `Host` / `Origin` 必须是本机 webServer 的 origin
  或 loopback（DNS rebinding 下攻击页面的 origin 与 Host 相同，自定义头挡不住）；不匹配一律 403。
- **状态共享**：agent 状态 WeakMap 挂在 `globalThis` 的 Symbol 槽上，插件禁用/启用或 HMR 产生的新模块实例
  仍能 lift 旧实例注册的掩码（否则页面上的「解除现有会话策略」会失效）。

## 配置模型

矩阵页保存会经 `configEditor` 写回本 profile 的 `cordis.patch.yml` 中 `tool-exposure` 行的 `config`：

```yaml
- id: tool-exposure
  name: 'dsh-tool-exposure'
  config:
    unlisted: open            # 未在 roles 中出现的角色：open=不限制 / closed=看不到受管工具
    sources:
      fofatoto: { label: FOFA 测绘, match: ['fofa_*'] }
      icp:      { label: ICP 备案,  match: ['mcp__icp__*'] }
      fengniao: { label: 企业工商,  match: ['fengniao_*'] }
      everything: { label: 全盘检索, match: ['everything_*'] }
      hdc:      { label: 鸿蒙设备与 DevEco, match: ['hdc_*', 'hms_*'] }
    roles:
      asset-expert:
        mode: allow           # allow=基线全不给；open=基线全给
        groups: { fofatoto: on, icp: on, fengniao: on, everything: on }
        tools:  { fofa_export: on }   # 单工具例外，优先级最高
```

解析顺序：`mode` 基线 → `groups` 整组覆盖 → `tools` 单工具覆盖 → 用当前已注册的全局工具名裁剪。
`match` 只支持 `*` 与 `?`，其余字符按字面量处理；多个模式用逗号分隔（写成单字符串也会被拆开）；
同一工具被多个组匹配时按 `sources` 书写顺序取第一个组（因此工具组 id 限定小写字母开头，纯数字键会打乱
JS 对象枚举顺序）。PTC 保留的 `run_code` 不参与受管集合。

输入约束：

- `match` 可以写成数组或单个字符串；单项 ≤ 256 字符、总长 ≤ 4096（超出会在页面/Host 两侧被拒绝，防止超长通配符）。
- `match` 为空（或非数组/非字符串）的组会被**保留**并给诊断，而不是静默删除——静默删除会让组内工具
  变成「未归组」，策略被悄悄放宽。
- 角色 id 来自 preset registry（registry 只要求 trim 非空），因此写入侧接受大写、点、下划线、空格等；
  只拒绝控制字符和 `__proto__` / `prototype` / `constructor` 这类危险键。
- 工具组 id 由页面 slug 生成：`^[a-z][a-z0-9-]{0,31}$`。手改配置留下的非法 id 会出现在页面上并带诊断，
  可用「改名」修正（改名会同步重映射各角色的组覆盖）。

保存时：

- 请求里缺少 `sources` 或 `roles` 字段会被 Host 拒绝（400），避免空请求把现有配置清空；
- 配置里有、但当前 preset 名册里已不存在的角色条目（`orphanRoles`）会原样保留并回传，不会因为一次页面保存被静默删除；
- 例外：手改配置留下的**非法 role id** 条目不会回传（否则会让整次保存被 400 卡死），保存时会丢弃并留诊断；
- 非法 JSON → 400，超过 256 KiB → 413，match 过长 → 400（均由 Host 路由返回，不再是笼统 500）。

## 安装

要求 Node.js ≥ 20，DSH `>=0.2.1-rc.5 <0.3.0-0`（见 `package.json` 的 `engines`）。本 bundle 零运行时依赖、
无安装脚本、无构建步骤，从 GitHub 源码安装即可使用。

### 从 GitHub 安装（推荐）

1. 打开侧边栏「插件」页；
2. 点右上角「添加插件」→「安装第三方插件」；
3. 在「包名或地址」里输入本仓库地址：

   ```text
   https://github.com/keyblues/dsh-tool-exposure
   ```

4. 安装完成后**刷新页面**（Settings 矩阵页由 Client 半在页面启动时加载）；页面显示「工具暴露」即安装成功，
   首次打开为 `roles: {}` + `unlisted: open`，工具面与安装前一致。

也可以让 Agent 代劳：

```text
plugin_manager(action: "install_bundle", target: "github:keyblues/dsh-tool-exposure")
```

### 从本地目录安装（开发调试）

clone 本仓库后，用 `plugin_manager` → `install_bundle`，target 指向本目录绝对路径。本地目录以 `link:` 方式安装，
不打包、不下载；之后 `git pull` 更新代码无需重装（Host 模块仍需按下方说明重新加载）。

### 安装后

- `Config.listConfigs` 出现 `include:tool-exposure`（或 patchId `tool-exposure`）
- Settings 里出现「工具暴露」页（order 25，排在「Agent 预设」之后）
- 默认配置 `roles: {}` + `unlisted: open`：**行为与安装前完全一致**，不会误伤任何角色

**改了 Host 代码（index.js）之后**：已加载的模块不会热替换，需要让 Loader 重新导入 —— 用
`plugin_manager` → `set_plugin` 对 `include:tool-exposure` 先 `enabled: false` 再 `enabled: true`
（实测可加载新模块），或重启 Harness。

**改了 Client 代码（client.js）之后**：刷新页面即可（浏览器缓存的是启动时拉取的 bundle）；想不刷新就生效，
同样用上面的禁用/启用一次——模块图变化会让打开中的页面重新加载该 client bundle。

## 页面操作

页面沿用 Host 自带设置页的设计语言（标题 18/600、说明 13/tertiary、行分隔 .5px、开关 36×20、
按钮 28/32 高、输入框 32 高，全部 `--dsw-*` token）：

- **角色卡片**：点卡片选中要编辑的角色；卡片显示名称、说明、模式与「可见/受管」计数，未配置的角色带标记，
  默认 preset 带「默认」徽标（来自 `remoteExportList()`）
- **基线**：分段控件切换该角色 `默认开放` / `白名单`；未配置角色点已选中的默认项不会物化配置
- **恢复全局默认**：已配置角色可一键删掉自己的条目，重新继承全局 unlisted
- **工具组行**：整组开关（部分可见时显示为半选态，状态文字同步提示）；点组名展开单工具开关；
  与基线一致的开关值会删掉覆盖，不会留下 off→on 往返的粘性配置
- **最终可见工具**：展开后按当前草稿实时列出可见/隐藏工具名（保存前即可核对）
- **全局**：「没有单独配置的角色」继承不限制 / 看不到受管工具
- **管理工具组**：增删组、改 label 与 match（逗号分隔通配符）、改名；新增表单会内联提示 id/重名/空 match
  的原因，中文名称会自动生成 `group-N` 占位 id；match 输入框有长度上限
- **顶部工具条**：重新扫描、放弃修改、保存（脏态才可点）、有未保存修改提示
- **解除现有会话策略**：只影响 live 会话，不改配置；带二次确认
- 保存后提示「已保存，新建会话生效」，Host 插件热重载；随后在后台重扫，只有服务端快照与刚提交的草稿一致
  才刷新界面（避免用重载前的旧配置覆盖草稿），重扫期间不再锁住整页交互
- 只读模式（无 `configEditor`）下所有改草稿控件禁用，提示文案跟随界面语言

## 开发自检

```bash
node test/host-policy.mjs    # Host 单测（43 项：解析/归组/策略/状态机/inventory/路由/同源校验/跨实例状态/事件接线）
node test/static-checks.mjs  # 静态一致性（16 项：文案键、CSS 类覆盖、模块契约、manifest 与 Host/Client parity）
node test/client-smoke.mjs   # Client 渲染与交互（25 项：桩 loader + 迷你 React + 假 fetch）

npm test                     # 等价于依次跑完上面三个
```

`client-smoke.mjs` 会载入真实的 `client.js`，渲染完整页面并断言：注册参数、样式注入、加载态、
角色卡片、开关状态、展开工具、编辑后脏态、保存请求体序列化、删除工具组后的引用/例外清理、
孤儿角色条目的保留、保存成功但重扫失败时不出现矛盾脏态。改动后先跑这三个，再看页面。

## 验收清单

| 检查 | 方法 | 期望 |
| --- | --- | --- |
| 声明行激活 | `cordis_inspect_query` Host `Config.listConfigs`（`name: dsh-tool-exposure`） | 出现 `include:tool-exposure`；本插件未导出 Config schema，故 `status: absent` 属正常，以路由可用为准 |
| 页面已注册 | `cordis_inspect_query` Client `Slots.listSubTree` `root=settings.section` | occupants 含 `tool-exposure`（order 25，active） |
| 路由可用 | `GET /plugins/dsh-tool-exposure/inventory`（带 `x-dsh-tool-exposure-plugin: 1`） | 返回 roles/sources/tools |
| 默认不误伤 | 默认配置下新建会话 | 工具面与安装前一致 |
| 策略生效 | 给某角色收掉一组后**新建会话** | 该组工具调用返回 `UNKNOWN_TOOL`；其它组正常 |
| 快照语义 | 改配置后观察已有会话 | 工具面不变 |
| 生效清单 | 页面的「最终可见工具」本地实时计算；`GET .../effective?role=<id>` 供脚本核对 | 两者与配置一致 |
| 解除现有会话 | `POST .../reset` | 返回 `lifted` 数量，现有会话工具面恢复 |
| 保存校验 | `POST .../save` 带 `{}` / 坏 JSON / 超长 match | 分别 400 / 400 / 413 或 400，且配置不变 |
| 同源校验 | 带合法守卫头但 `Host: evil.example:1130` 请求任一路由 | 403；正常 127.0.0.1 访问仍 200 |

## 诊断接口

Host 半还挂了两个只用于排查的同源路由（同样要求 `x-dsh-tool-exposure-plugin: 1`，不是正常使用路径）：

- `GET /plugins/dsh-tool-exposure/debug/agents`：列出 live agent 的角色解析、deny 数量、已应用签名、
  pending/started/legacy 标记。用来确认「为什么某个会话没被收窄」。
- `POST /plugins/dsh-tool-exposure/debug/apply`：对全部 live agent 强制重算一次（含 legacy，绕过快照语义），
  仅调试用；强制应用后会清掉该 agent 的 legacy 标记，让它重新参与后续 reconcile。

## 边界与风险

- **只管全局工具**。preset 内挂载的 scope-local 工具不受本插件影响（它们本来就按角色隔离，正确做法是
  「不想给就别挂」）。
- **保存会热重载 Host 插件**（矩阵是低频操作）。重载瞬间页面请求可能失败，页面会自动重试。
- **快照语义的代价**：插件卸载后，页面与路由都会消失，已有会话上的掩码要等会话结束才释放。
  需要立即恢复时，要在**卸载/禁用之前**点页面上的「解除现有会话策略」（`POST /reset`）；
  已经卸载的话需先重新启用插件再解除。这是刻意的安全取舍（卸载不 fail-open）。
- **晚注册工具**：若某插件在 agent 创建之后才注册工具（HMR、手动装插件），该 agent 已开始工作则不会
  自动收窄——新建会话即可。未开始的 agent 会被重算。
- **KV cache**：可见工具集变化会让该 agent 下一次请求的 schema 前缀变化，从首个变化 token 起失效；
  只影响新请求，不影响会话历史。
- **工具归属没有 API**：`ToolDefinition` 不暴露注册者，所以「工具组」由 `match` 规则维护，不是自动归属。
  页面会把没被任何组匹配的全局工具列进「未归组」。
- **重复的 guard 头**：Node 会合并成 `"1, 1"`，路由按逗号列表接受；实测 HTTP 层对重复头整体返回 400，
  所以这条只是防御性处理。
- **`run_code` 不受管**：PTC 模式的 `run_code` 是保留 transport，插件既不隐藏它也不把它写进 deny；
  这与 dsh-tools 的契约一致，不是遗漏。

## 回滚

`plugin_manager` → `remove_bundle` → `dsh-tool-exposure`。profile 的 bundles 与依赖会被清掉，
页面与策略行消失；工作目录里的本 bundle 不受影响，可随时重装。已有会话上的掩码按快照语义等会话结束释放。

## 许可

[MIT](LICENSE) © 2026 keyblues
