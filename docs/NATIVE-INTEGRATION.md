# 配套 DSH 客户端扩展

## 基线与范围

上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，版本 `0.2.1-rc.5`，精确基线 `b830ec950faba0a46dda564be3e2d854afed94f1`。

本仓库的 [源码补丁](./native-workspace.patch) 只修改 `packages/client/ui-workspace`，包含新增 contract、实现和测试文件，不包含上游完整工作树、编译产物或本机配置。插件本身不会自动修改应用安装目录。

需要两个独立能力：

- 展示：`sessionRelationsVersion === 1` / `registerSessionRelations`。只读来源边，原生列表仍拥有行、排序、筛选、导航和生命周期。
- 归档：`sessionArchiveProvidersVersion === 2` / `registerSessionArchiveProvider`。范围选择不是归档计划；选择后重新准备不可变计划，全部关联即使空闲也需确认实际成员，停止活动另行授权。不能用版本 1 代替版本 2，否则无法保证旧实现不忽略范围。

缺少对应能力时插件不注册该客户端扩展；不会搬运 DOM 或伪造 ToolRuntime 身份。模型侧工具及独立辅助栏不因此冒充左侧原生扩展。

## 在干净的上游源码中复现

需要兼容的 Node.js（上游要求 `^22.19.0 || >=24.0.0`）与 `pnpm@11.28.5`。以下 `PLUGIN` 指向本仓库的绝对目录，不能指向用户 profile。

```sh
export PLUGIN=/absolute/path/to/dsh-session-link
git clone https://github.com/deepseek-ai/deepseek-harness.git dsh-source
cd dsh-source
git checkout --detach b830ec950faba0a46dda564be3e2d854afed94f1
git apply --check "$PLUGIN/docs/native-workspace.patch"
git apply "$PLUGIN/docs/native-workspace.patch"
pnpm install --frozen-lockfile
pnpm exec vitest run packages/client/ui-workspace/tests
pnpm run build:artifacts
pnpm run build:check
```

构建遵循上游流程，先生成 Host contracts/Typert 等依赖，再编译 Client；不要把未生成依赖导致的类型错误用跳过检查、修改 tsconfig 或强制类型断言掩盖。此补丁不保证可直接应用于其他版本。

## 安装、刷新与回退

1. 在隔离源码中验证补丁及测试，按上游说明构建所需应用/客户端产物。
2. 备份对应版本原生客户端产物与当前插件包。不要提交 profile、凭据、会话、备份或日志。
3. 在目标版本安装配套客户端，通过正在运行的 Desktop 插件管理器安装本地插件包；普通 Web profile 可使用其 CLI。Desktop profile 不能由另一个 CLI 进程修改。
4. 使用当前应用的客户端模块刷新机制，并在**原 GUI 地址**刷新页面，核实实际加载的是新构建；另起服务器不等于更新原 GUI。插件卸载不会撤销已安装的原生补丁，应用升级可能覆盖它。
5. 出错时恢复同一基线的原生产物及原插件包。结果不明的归档、创建或投递不能当作未执行后自动重试。

本仓库不提供自动发现个人应用/profile 并覆盖文件的安装脚本，也不携带本机 Inspector 管理脚本。

## 可复现验证与限制

插件测试及隔离真实 Host 冒烟命令见 [README](../README.md)。部分纯原生投影回归可显式提供补丁后的源码目录：

```sh
DSH_NATIVE_SOURCE=/absolute/path/to/patched/dsh-source npm test
```

未提供可选源码且本地缺失时，仅相应原生投影用例标明 skip；显式给错路径应失败，而非假称通过。完整原生 UI 测试仍在上游 checkout 中运行。

真实 GUI 验收应使用专用无业务 fixture，分别检查原生/实际已安装皮肤、深浅及窄布局；用真实菜单取消/单体/全部关联确认，并读回归档位。未安装的皮肤、未执行的活动停止场景不能推断通过。本仓库不发布个人 GUI 截图、会话 ID、测试日志或现场验收记录。

许可及上游归属见 [NOTICE](../NOTICE.md)。
