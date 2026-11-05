# DSH Session Link

**版本固定为 `0.1.0`。**同版本新构建使用独立安装包路径；本地回退包和个人验收材料不纳入仓库。

仓库：[pennxiang/dsh-session-link](https://github.com/pennxiang/dsh-session-link)。插件保持 `UNLICENSED`，公开源码不等于授予开源复用许可；配套补丁中的上游 DSH 代码保留 MIT 声明，见 [NOTICE](./NOTICE.md)。

同一 DSH 宿主中的普通会话、Better Sidebar btw、原生可续聊子代理可以发现彼此、双向发消息和交接任务。配合本次原生 Workspace 展示接口扩展，创建来源树直接出现在**左侧原生会话列表**；右侧“关联会话”页签仅作辅助。树不会把普通会话变成原生子代理，不需要 Better Sidebar 提供 UI。

## 原生通道优先，Link 跨域补充

- **同一 Team** 或宿主支持的**直接父子**任务，优先当前实际可用的原生 `send_message`。原生 Team 的 `target` 是成员名；原生父子协议使用 `agent_id`，同名工具不代表同协议。
- **独立会话、btw、不同代理树、非 Team 兄弟代理**，或原生工具确实不可用而 Link 获准时，使用 Session Link。保留子代理的跨会话通信，不笼统禁用 Link。
- `link_sessions` / `link_status` 的 `communication` 从准确调用 Agent 的 scoped registry、Team roster 与真实身份得出建议。`visible`、PTC 的 direct/SDK 可调用性、关系、`candidate` 与最终 Host admission 分开；不单靠 `parentId`，不声称查询已批准发送。btw 即便带 parent header 仍不是原生 managed child。
- Link 工具**始终走 Link**，不会暗中改调用原生工具；模型选择一条路径、只派发一次。原生超时或结果 unknown 不证明未送达，不能自动改走 Link 重发。策略读不到时不伪造可用性。
- 消息封装、投递结果和聊天卡明确标记 `Session Link`；其内部使用 Host inbox/carrier 不等于调用了原生 Team/父子工具。通信不改变所属关系、权限、沙箱或生命周期。
- 原生自动完成通知仍由原生产生，不自动镜像为 Link 消息，不自动 ACK；同一原生任务不要再建立第二份 Link 任务账本。Link 的任务状态不代替原生 settlement 或 Team task 状态。
- `link_session_create` 是创建持久普通会话；创建原生 subagent/Team 成员应使用对应原生生命周期工具，二者不是同一操作。

## Task + Context → 持久工作会话

`link_session_create` 创建 Host 持有的**普通独立 root**，可由用户继续聊天。创建账本保存创建者、目标 ID、Workspace 与用户提供的任务/背景摘要。关联是来源关系，不是 SubagentRuntime ownership，也不写原生 `parentSession`。

```json
{
  "provider": "目录中的 provider ID",
  "model": "该 provider 的精确 model ID",
  "reasoningEffort": "该模型支持的档位 ID",
  "title": "接口复核",
  "task": "检查接口的错误处理，报告可复现问题。",
  "context": "背景摘要：接口已迁移到新鉴权模块。",
  "decisions": "保持现有公开字段兼容。",
  "constraints": "先只读审查，不修改代码。",
  "requestId": "api-review-001"
}
```

- 先用 `link_models` 获取精确 provider/model/effort。指定值不支持就报错，不别名、不替换、不降低档位；省略 effort 时核对所选模型自身默认值，不沿用调用者旧档位。
- `provider`、`model`、`requestId` 必填；`task/context/decisions/constraints` 均为字符串，每项最多 4000 字符，序列化交接总计最多 12000 字符。只有提供 `task` 时才能提供其余三项。
- `initialMessage` 是可选的非结构化首条消息，与 `task` 互斥。两者都省略会创建空闲会话，不触发模型生成。提供任务/首条消息会启动工作并可能产生模型费用。
- 这些字段传递明确的摘要和约束，**不表示复制原始聊天历史**。
- `cwd` 为可选的已存在绝对目录，默认调用者有效工作目录。`workspaceId` 可显式指定；同时提供 cwd 时必须指向同一 canonical 目录。未指定时优先有效的来源 Workspace 成员关系，其次目标目录的已有 Workspace，无匹配时登记目标目录。跨目录不会盲目绑定来源 Workspace。
- 创建成功前验证成员关系持久保存；相同 cwd 本身不是绑定证明。无法登记、绑定失败或目录/ID冲突会明确报错并返回部分创建信息。
- 继承并核实调用者具名 permission preset、agent preset；自定义权限拒绝。创建只允许独立、无父引用的普通 runtime root，侧聊/子代理/带 parent 的 fork 不得借创建 root 扩大自己的 scope。它们仍可互通，并请求获授权的主会话创建。
- 新会话不随本插件卸载而销毁。

## 左侧原生 Workspace 会话树

- 原生 `uiWorkspace.sessionRelationsVersion === 1`、`registerSessionRelations({ id, version: 1, source })` 接收只读展示来源。DSH 仍拥有原列表、原 Session 行、点击导航、菜单、状态、排序与筛选；本插件不替换整个 Workspace 浏览器，不搬运 DOM，不伪造 `parentSession`。
- 同一工作区内的普通独立 root，按创建账本显示“主会话 + 一层关联会话”。后续关联会话统一平铺到该主会话下面，不再逐级嵌套或折叠。原生层仍验证实际成员、单父、去重和无环；跨工作区、侧聊、子代理、fork、归档及不可见项不冒充普通创建树。父项因原生筛选不可见时，仍可见的子项按原生规则回到根层，不丢失无关会话。
- 主会话与无关联的普通会话保持原生左对齐，不为主会话预留空的树线 gutter。只有主会话有折叠按钮，放在**会话标题右侧**、原生动作之前；关联行没有二级折叠按钮。中间关联项只画竖线，最后一项用圆角弧线与短横线收尾；全部关联项相同缩进。折叠键按工作区与主会话 ID 隔离，旧子项折叠状态不隐藏平铺后的关联会话。展示不改变原始来源边、会话身份、权限、ownership 或生命周期，搜索仍使用原生平铺结果。
- `source.getSnapshot()` 返回稳定、只读的 `{ schemaVersion: 1, edges, truncated, loading }`；每条边仅有 `workspaceId/sourceId/targetId/kind`。后台只返回当前 Workspace 成员之间的最小来源边，不返回标题、任务背景、结果或 transcript，不为显示而 retain/resume 会话。
- 原生消费者订阅且页面可见时才读取公共工作区元数据和关系端点；最多 100 个工作区、50000 个成员、1000 条汇总边、4 个并发请求，低频 60 秒刷新。每个工作区后台最多 200 条边；加载、部分数据和截断不伪装成完整关系。隐藏、成员变化、重连、取消和卸载会撤销过期读取，提交前重验成员。
- 此功能需要**配套的原生 DSH 客户端扩展**，不是声称未经修改的 rc.5 已有此接口。仅安装插件不会自动改写 DSH；缺少版本 1 接口时不注册左树、不读取其元数据，保留已有消息和辅助右栏，但不把右栏冒充左树。源码基线、完整补丁、可复现构建及回退流程见 [原生扩展集成指南](./docs/NATIVE-INTEGRATION.md)；应用升级可能覆盖该本地扩展。

## 原生“关联会话”辅助页签

打开当前 Session 的原生右侧栏，在指南中选择“关联会话”。

- 主项可折叠，条目点击按稳定精确 Session ID 导航。
- 树线中间条目仅竖线，只有最后一项使用圆角弧线和短横线收尾；不是节点关系图。
- 显示真实运行、空闲、离线、归档状态；任务状态单独展示。**idle 不代表任务完成。**没有可信未读数据时不虚构未读标记。
- 页面按创建账本恢复关联，不为显示而唤醒离线会话。归档/不存在/不可访问的目标给出错误，不打开同名替代会话。
- 只在可见时进行有界低频刷新，支持手动刷新；隐藏、卸载、请求取消会停止对应读取。
- 数据端点仅通过宿主 owner-admitted 的 exact Fetch 路由挂载，最多 4 KiB 请求体、有界元数据和超时，不暴露 transcript，不使用裸 HTTP 后门。

## 聊天中可点击的 Session 引用

本插件工具结果卡及本地结果卡提供蓝底蓝字的会话导航 chip，优先显示公共会话目录中的**当前标题**，重命名时更新；旧记录只有关联 ID 也能显示当前标题。没有可信标题时显示“未命名会话”，不把目录、ID 或任意事件文本伪装成标题。只共享懒订阅元数据，不 retain/resume 或读取历史。跳转始终通过已认证的**精确 ID**解析，聊天 chip 旁不显示复制按钮；标题不是目标身份。创建结果、发送结果、任务 owner/assignee、会话列表等均可导航。

辅助右栏的复制按钮生成宿主标准 `@[标题](dsh-session:...)` 上下文引用。官方 payload 使用 `base64url(JSON.stringify(id))`。**宿主目前把普通聊天中的这类 mention 渲染为非交互上下文 chip**；插件不承诺任意纯文本会话名或任意粘贴 Markdown 都能点击。聊天导航由正式工具行/Conversation node 扩展提供，不做全局 DOM 点击劫持或猜测 URL。

## 本地结果与独立回传

- `link_task` 提交 completed 前，实质结果先写入**执行 Session 自身**，通过宿主原生 surface + flush 确认持久化，再更新任务账本。
- `link_send` 向另一会话发送实质文本前，先在发送者自身聊天保存同一份发送内容，再进行远投。即使代理只调用回传工具，执行会话里也能看到原文并继续追问。
- 本地卡片明确标记“Session Link 插件记录 / 执行者回报或发送内容”，不会伪造真人输入或模型 assistant 回答。这个内容也是该 Session 后续请求可读的上下文。
- 专属客户端 Conversation definition 将此来源作为可见节点渲染；不能把宿主默认隐藏的 context notice 当作已完成 UI 展示。
- 本地记录不触发模型或 ACK。任务更新不自动转发，向创建者回传仍是另一个明确的 `link_send` 动作。
- append 不等于 durable flush；本地持久化失败时不远投、不虚报任务完成。已写入而结果未知时保守拒绝重复 append，按错误信息检查，不自动重发。

## 归档当前或关联会话：先选范围

可以对代理说“归档日报那个对话”或“归档当前会话”。代理先用 `link_session_archive` 的 `action: "list"` 查询公共元数据，精确确定目标；同名或描述不明确时先询问。有关联会话时，必须让用户明确选择**仅此会话**或**全部关联会话**，不能默认级联。归档列表中的 `isSelf` 标记当前调用者。

```json
{"action":"list","query":"日报","limit":10}
```

```json
{"action":"archive","targetId":"精确 Session ID","archiveScope":"single","requestId":"archive-daily-001"}
```

- 调用官方 `WorkspaceRegistry.archiveSession`，**不是删除会话、清空历史或移除 Workspace 成员关系**。不为查询或归档而恢复/唤醒冷会话；拿不到可信标题时标明不可用。
- 原生侧栏菜单与 `link_session_archive` 共用同一引擎。`archiveScope: "single"` 真正只归档精确目标，不检查或受无关后代的活动、目录、变化中关系影响；目标自身的权限、活动和未知副作用仍严格校验。
- `archiveScope: "related"` 才以完整创建账本及当前 Workspace 成员关系规划**主会话和全部关联普通后代**，不以左侧 200 条显示边界代替范围。跨 Workspace、btw、原生子代理、fork 不被混入；不完整、变化中或未知关系保守拒绝。选择全部后关系消失，不静默改成单体。
- 有关联候选而未选范围时返回 `ARCHIVE_SCOPE_REQUIRED`、`targetId`、`allowedScopes`，**没有可提交的 planId，也不归档**。用户选择后以新 `requestId` 和明确范围重新准备计划。原生 UI 选择全部后还会显示实际固定成员列表，即使空闲也须确认；取消任一确认都零提交。
- 固定计划保存范围与成员，后代优先、主会话最后。**范围同意不等于停止工作同意**：默认 `stopActivity: false`，所选任一成员有活动则零归档。不能只看 idle，turn、子代理、job、提醒均可能阻止操作。遇到 `ACTIVITY_REQUIRES_CONFIRMATION`，取得另一次明确停止授权后，携带**同一 `planId` 与 `archiveScope`**、新 `requestId`、`stopActivity: true` 提交；不能扩大成员或切换范围。
- 显式停止的宿主顺序是**先持久保存归档并取消 pin，再请求活动提供者停止**；停止失败可能被宿主记录而非回滚。因此成功只证明目标归档位已读回、已请求停止，**不证明所有任务已结束**。已归档目标直接 no-op，不重复停止。
- **允许用户明确要求归档调用者自身**，不再一律禁止 self。活动中的自身仍须单独停止授权；停止可能中断本次工具执行或最终回复。提交后即使调用者取消或退出，也保留已知副作用与持久读回结果，不能因没收到回复而重试。durable 子代理父系祖先仍禁止；祖先链缺失、循环或已归档时保守拒绝，创建来源树不等于原生父系。
- 普通会话、btw、子代理在其**实际 ToolRuntime scope / filter / guard** 允许时均可使用，不注册绕过继承过滤的子级 shadow、不借父会话身份执行。严格同目录模式还重验准确 Agent 与有效 cwd；冷 cwd 不可信则拒绝。
- 归档意图先持久保存，sender + requestId 去重；同 key 参数不一致报错。提交之后取消会等待已准入原生副作用排空并读回，unknown / partial 不自动重试或换 key。归档账本最多 1000 条，满时拒绝，不淘汰未知意图。
- 组归档不是原子事务；逐成员保存 intent、调用及读回结果，失败后停止继续，返回 `archivedIds` / `remaining` / `failed` 与 partial / unknown。重启、重叠计划、提交途中取消或结果不明均不自动重发，不通过新 key 绕过未知副作用。
- 原生 UI 全部关联的结果使用专用计数通知，**不提供只能恢复主会话的误导性组 Undo**。仅此会话使用原生单体结果和 Undo；取消范围、成员或活动确认均不提交。组恢复需使用原生取消归档入口逐项操作，不恢复 pin、已取消工作、已丢弃输入或已删除提醒。
- UI 通过独立的 `sessionArchiveProvidersVersion: 2` / `registerSessionArchiveProvider({ version: 2, ... })` 注册，旧版本 1 不可代替范围协议。范围问答绑定准确 provider 与目标，选择后才准备计划；提交绑定原计划对象、planId、scope 与生命周期，发出 I/O 前一次性消费，失败或 unknown 不可重复提交。卸载、替换、导航或计划变化不转给其他 provider，也不降级单体。
- UI 走经过认证的 owner-only `/api/session-link/archive`，不把只读显示关系 API 变成修改权限，不伪造 ToolRuntime Agent。模型入口仍通过真实调用者 scope/filter/guard；两条入口不互相借权，创建和提交共用服务写队列。
- 归档是 `session-link-control` 控制操作，不是消息投递、删除、原生任务完成通知或全部工作已停止的证明。

## 九个工具

| 工具 | 用途 |
|---|---|
| `link_models` | provider 及模型/推理能力目录，有限超时与取消 |
| `link_session_create` | 创建普通会话、结构化交接、登记 Workspace 与来源关联 |
| `link_sessions` | 发现 live 普通会话、btw、子代理；排除自身/目录过滤后计数 |
| `link_send` | 本地保存发送内容，再双向投递；支持模式、回复链和幂等 key |
| `link_status` | 运行状态、消息回执与原生/Link通道建议，三者不混淆 |
| `link_activity` | 有界可见执行摘要，不返回隐藏推理或原始工具参数/输出 |
| `link_task` | 参与者可读的任务创建、状态、CAS 更新与取消 |
| `link_reception` | 当前 Session 暂停或恢复新消息接收 |
| `link_session_archive` | 查找（含 isSelf）；明确 single / related 范围，可自归档；默认不停止活动 |

纯元数据目录/查询有限时取消，挂起 provider 不再占据所有变更操作的串行队列。append、flush、创建、绑定与远投等有副作用操作不能靠超时放弃后假称没有执行；卸载等待已准入写操作排空。

## 状态、范围和安全

- 本版支持同一进程中的 live 普通会话、当前 Better Sidebar 内置侧聊和本地可续聊原生子代理。一次性/外部后端/一开始已退出的子代理不被转换成可续聊代理。
- 侧聊 seeded descriptor 在继承边界末项的兼容例外要求严格结构和准确 runtime root 身份；不会开放一般祖先描述符或放宽 own-activity 过滤。
- 真正 managed 子代理通过宿主导出的内部 host carrier 投递，父代理仍是生命周期 owner、来源保留真正 sender；异步投递途中宿主可能合法恢复刚关闭的同一可续聊子代理。
- DSH 验证基线为 `0.2.1-rc.5`；模型局部 setter 与子代理 carrier 是内部兼容入口，仅精确验证版本启用。不会调用会顺带修改全局默认模型的公开选模型接口。
- 发送者来自准确的 Host `exec.agent`。peer 内容不代表人类授权，不得跨会话绕过审批、沙箱、工具过滤或 scoped guards。本插件不是额外的宿主安全沙箱。
- 默认允许跨目录，`sameDirectoryOnly` 对发现、读取、发送、创建和归档均生效；冷 header 的初始 cwd 不是最后有效 cwd，因此严格目录模式下冷目标保守拒绝。
- `accepted` 是传输接纳；`pending/claimed/discarded/unknown` 是回执证据，claimed 不等于读到或完成。任务 completed 是执行代理自行报告，不是独立验收。
- owner 才能取消，assignee 才能更新工作状态；更新/取消须最新 revision。取消只改变账本，不中断目标，不撤回既有输入。
- 默认每对会话双向合计 12 次/分钟、回复链最多 8 跳。没有自动 ACK 或普通回答自动转发。

## 持久化与失败恢复

状态位于 profile 的 `data/session-link`。目录/文件私有权限、原子保存、独占 writer lock。账本保存关系及幂等元数据，结果正文存在执行 Session 自身的原生记录中。

- 创建 intent 与新 ID 的接收隔离先行持久保存。只有配置成功才解除本次隔离，人工暂停不覆盖。partial/unknown 目标保持拒收 Link 消息/任务。
- **接收隔离不阻止人工 UI 或其他原生入口，也不是宿主级原子权限创建事务。**创建失败可能已有普通 root；先检查返回的 sessionId/workspaceId/stage/state，不自动换 key 重建。
- 创建最多保留 1000 个意图、每个调用者每分钟最多 10 个；消息保留默认 1000、任务 500、本地结果记录元数据默认 2000。容量满明确拒绝，不静默淘汰未知或仍被引用的记录。
- 普通已完成投递的幂等仅覆盖保留窗口；未知/在途和任务关联记录受保护。重启后未定 intent 变 unknown，不自动重发。
- 异常退出的 `.writer-lock` 需先核实旧宿主进程已停止、备份数据后人工清理。运行中不得删锁或用删除状态文件“修复”。

## 安装与验收

Desktop 由 Electron 独占管理，请通过**正在运行应用的插件管理器**安装或更新本地包，不能运行 `dsh plugin --profile desktop` 绕过。普通 Web profile 可使用 CLI。

兼容早期仅后端版本的无重启升级：rc.5 将 `dsh.client` 元数据按 Loader specifier + owning-tree base URL 缓存至重启，旧的“无客户端”结果也会缓存。本包在自有 bundle patch 中使用正式支持的相对路径 `./index.js` **替换同一个 `session-link` entry**；AppBoot 将其锚定到 bundle patch 所在目录并转成精确 file URL，从而重新读取本包元数据。浏览器模块 ID 仍为 `dsh-session-link`，不依赖写死的 profile 路径。不得追加另一个 entry 挂载双实例，不清改 Host 私有缓存，也不靠重启规避验收。

```sh
npm run check
npm test
DSH_RUNTIME=/absolute/path/to/dsh-runtime npm run test:host
DSH_RUNTIME=/absolute/path/to/dsh-runtime npm run test:integration
DSH_RUNTIME=/absolute/path/to/dsh-runtime npm run test:create-host
DSH_RUNTIME=/absolute/path/to/dsh-runtime npm run test:client-host
DSH_RUNTIME=/absolute/path/to/dsh-runtime npm run test:archive-host
npm pack --pack-destination artifacts/<unique-build-directory>
# Web profile 示例：
dsh plugin --profile web add /absolute/path/to/unique-build/dsh-session-link-0.1.0.tgz
```

GUI 验收需分别检查原生及实际安装皮肤的深浅、窄布局、导航和真实归档；静态或 mock 通过不代表 GUI 通过。未安装皮肤（例如本地未安装的 Codex 皮肤）及未执行的活动场景不宣称覆盖。新增客户端包后须验证当前 GUI 真正加载新文件，另起服务器不是更新当前应用，不擅自重启用户宿主。公开仓库不包含个人会话或本地验收截图、日志。
