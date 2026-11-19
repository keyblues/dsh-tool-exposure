# 开发指南

[返回首页](../README.md) · [配置参考](configuration.md)

## 在本地调试

使用 Node.js 24.9 或更高版本和兼容的 DSH。该项目以原生 JavaScript 加载，宿主提供 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/dsh-scope`。

在开发用 DSH 环境的第三方插件安装入口输入仓库的本地目录绝对路径，或在启用了插件管理工具的会话里调用 `plugin_manager`，将 `action` 设为 `install_bundle`，`target` 设为该绝对路径。DSH 会以本地链接方式安装。变更宿主模块、工具服务或组合配置后重启 DSH。客户端变更可刷新页面测试。

| 文件 | 职责 |
| --- | --- |
| [cordis.patch.yml](../cordis.patch.yml) | 加载来源记录服务和工具暴露策略。组合包使用继承官方实现的工具服务承接注册。 |
| [registry.js](../registry.js)、[providers.js](../providers.js) | 记录 Cordis Loader 注册上下文，读取全局和预设的继承目录，识别官方、插件与全局 MCP 来源。 |
| [index.js](../index.js) | 生成角色工具清单，计算策略，调用 DSH 的 `tools.restrict({ deny })`，并提供读写配置与诊断路由。 |
| [client.js](../client.js) | 在 `sidebar.panellist` 和 `main` 注册入口与页面，管理草稿、筛选、保存和重新扫描。 |
| [icon.svg](../icon.svg)、[locale](../locale/) | 插件主图标及 DSH 读取的中英文名称与说明。 |

读取预设目录时，宿主挂载临时作用域并在读取后释放。创建会话或子代理时应用策略；如果预设仍在挂载，宿主在后续 `agent/pre-step` 补应用，最多尝试三次，然后使用未列出角色的规则。尚未开始工作的 Agent 会在工具异步注册时重新计算，开始工作后使用已应用的策略。保存通过配置版本校验串行写入，同时编辑时较早读取的版本会收到冲突提示。

## 运行检查

```sh
npm install
npm test
npm pack --dry-run
```

`npm test` 依次检查宿主策略、静态约定、客户端交互和真实注册服务。Windows 可复用默认位置安装的 DSH 桌面版。可用 `DSH_NODE_EXECUTABLE` 指定桌面程序，并用 `DSH_TEST_INSTALL_DIR` 指定受测的 DSH 包目录。能找到 DSH CLI 时，集成检查还会启动独立配置档案，验证实际注册和保存过程。缺少对应运行依赖的检查会输出 `SKIP`。

使用下面的命令启动独立 DSH Web 预览。终端会输出本机访问地址和 `stopFile` 路径。预览默认运行 30 分钟，可用 `DSH_PREVIEW_MINUTES` 在 1 到 120 分钟内设置时长，或创建 `stopFile` 提前结束。

```sh
node test/visual-server.mjs
```

README 的功能截图使用独立配置中的示例角色、插件和 MCP 服务器。更新截图时可在预览中复现。

## 本机诊断

路由前缀为 `/plugins/dsh-tool-exposure`。从当前 DSH Web 源访问时，附上 `x-dsh-tool-exposure-plugin: 1` 请求头。宿主同时校验请求的 `Host` 和 `Origin`。

| 方法与端点 | 用途 |
| --- | --- |
| `GET /ping` | 确认当前宿主插件已挂载，以及是否可编辑配置。 |
| `GET /inventory` | 获取角色、全局工具、各角色完整的继承工具清单、插件元数据和配置版本。 |
| `GET /effective?role=standard` | 查看指定角色在已保存策略下的可见和隐藏工具。 |
| `GET /debug/agents` | 查看已加载 Agent 的预设、当前限制和启动状态。 |
| `POST /save` | 校验并提交草稿。版本冲突返回 `409`，JSON 请求体上限为 256 KiB。 |
| `POST /reset` | 解除本插件对当前已加载会话和子代理的限制。 |
| `POST /debug/apply` | 为当前已加载会话和子代理强制重算策略，供本机调试。 |
