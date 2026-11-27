# 配置参考

[返回首页](../README.md) · [使用指南](usage.md)

## 配置位置

页面保存会通过 DSH 的配置编辑服务，把规则写入当前配置档案 `cordis.patch.yml` 中 ID 为 `tool-exposure` 的配置行。下面是首次安装的默认值。手工维护时，请编辑同一配置行。

```yaml
- id: tool-exposure
  name: dsh-tool-exposure
  config:
    discovery: true
    unlisted: open
    sources: {}
    roles: {}
```

| 字段 | 取值与用途 |
| --- | --- |
| `discovery` | `true` 读取全局共享和当前角色从预设继承的工具，按注册来源自动分组。`false` 只管理 `sources` 匹配的全局工具。 |
| `unlisted` | `open` 让未单独配置的角色看到所有受管工具。`closed` 对这些角色隐藏所有受管工具。 |
| `sources` | 自定义分组，键为组 ID，每项包含 `label` 和 `match`。 |
| `roles` | 按预设 ID 保存规则。每项可设置 `mode`、`groups` 和 `tools`。 |

早期配置如果定义了 `sources` 并省略 `discovery`，会按手工分组读取。要启用自动发现，打开「高级设置 → 按提供插件自动分组」并保存，或显式设置 `discovery: true`。

## 角色规则

1. 先应用角色的 `mode`。`open` 是「默认开放」，`allow` 是「白名单」。未单独配置的角色使用 `unlisted`。
2. 用 `groups` 中的 `"on"` 或 `"off"` 覆盖整组。自动分组和自定义分组都使用稳定的组 ID。
3. 用 `tools` 中的 `"on"` 或 `"off"` 覆盖单个工具。单个工具的设置优先于该工具的组设置。

规则只作用于该角色实际继承的受管工具。Agent 自身作用域中注册的工具和 PTC 保留的 `run_code` 由 DSH 管理。

每个全局 MCP 服务器除了工具，还在系统提示词里拥有两段文字：服务器名单中的条目和它自己的说明（instructions）。关闭一个服务器组时，这些提示词与工具一起对该角色隐藏；组开着但工具被逐个全部关闭时同样隐藏。服务器名单只点名对该角色仍可见的资源工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`），三者全部隐藏时整段名单删除。没有工具、只提供说明或资源的服务器也会形成零工具组，开关只管理其提示词。

下面的示例关闭标准模式中的 `archive` MCP 组（工具与提示词一并隐藏），仅放行该组的 `lookup` 工具。其他组按「默认开放」计算。

```yaml
- id: tool-exposure
  name: dsh-tool-exposure
  config:
    discovery: true
    unlisted: open
    sources: {}
    roles:
      standard:
        mode: open
        groups:
          "@mcp/archive": "off"
        tools:
          "mcp__archive__lookup": "on"
```

`standard` 是预设 ID。手工配置时，使用角色卡片上的 ID、实际的 MCP 服务器名和工具列表展开后显示的完整工具名。

## 分组规则

| 自动分组 ID | 归属 |
| --- | --- |
| `@official` | 其他由 `@deepseek-ai/` 下的官方包注册的工具。 |
| `@mcp/<服务器名>` | 已全局注册的某个 MCP 服务器。有工具时开关同时管理工具与提示词；没有工具时（只提供说明或资源）开关只管理提示词。 |
| `@plugin/<插件包名>` | 第三方插件工具，例如 `@plugin/@vendor/notes`。 |
| `@unknown` | 缺少注册来源的工具。 |

自动发现开启时，先确定官方工具和各个全局 MCP 服务器的归属。其余工具按 `sources` 的书写顺序匹配第一个自定义组，再按插件包名或未知来源归组。每个 MCP 服务器根据自身的组覆盖、角色默认规则和单工具设置计算可见性。关闭自动发现时不建立 MCP 零工具组，服务器提示词按角色 `mode` 兜底：`open` 保留宿主原文，`allow` 一并隐藏。

自定义分组可以写成如下映射，放在 `config.sources` 下。

```yaml
notes:
  label: 笔记工具
  match:
    - "notes_*"
    - "search_notes"
```

- 自定义组 ID 以小写字母开头，之后可以使用小写字母、数字和连字符，总长最多 32 个字符。
- `match` 接受数组或逗号分隔的字符串。`*` 匹配任意数量的字符，`?` 匹配一个字符，其他字符按字面值匹配。单项最多 256 个字符，每组总长最多 4096 个字符。
- 兜底组 `"*"` 宜放在最后。页面新建自定义组时会排在兜底组之前。
- 缺少匹配项的自定义组会保留配置并显示诊断。可在「管理工具组」修复匹配规则或改名，改名会同步更新角色对该组的引用。

页面会保留当前预设清单之外的有效角色配置。恢复该预设后，可继续使用同一角色 ID 的设置。手工编辑后可用「重新扫描」载入，再通过「最终可见工具」核对结果。
