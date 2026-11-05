# 许可与第三方声明

## DSH Session Link 原创部分

插件 manifest 保持 `license: "UNLICENSED"`、`private: true`。公开源码仓库不等于授予开源复用许可证，本次发布没有自行将插件原创代码改为 MIT 或其他许可。若需要额外使用、分发或再许可授权，应向权利人确认。

## 配套 DSH 补丁中的上游内容

[原生 Workspace 源码补丁](./docs/native-workspace.patch) 基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `0.2.1-rc.5`，精确提交 `b830ec950faba0a46dda564be3e2d854afed94f1`。

其中包含的上游 DSH 内容保留其 MIT 许可及 `Copyright (c) 2026 DeepSeek` 声明，完整正文位于 [DSH MIT License](./LICENSES/DSH-MIT.txt)。该上游许可不自动变成插件原创部分或新增修改的额外许可授予。

仓库不包含完整上游代码树、预编译应用、个人 profile、凭据、会话内容或本机测试证据。
