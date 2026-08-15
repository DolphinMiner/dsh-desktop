# DSH Desktop

[![CI](https://github.com/DolphinMiner/dsh-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/DolphinMiner/dsh-desktop/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[English](README.md)

DSH Desktop 是一个独立的社区项目，用 Electron 在 macOS 桌面端托管官方
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI。

> [!IMPORTANT]
> 当前版本是面向 Apple Silicon 的早期 MVP，尚未签名和公证。本项目与
> DeepSeek 没有关联，也未获得 DeepSeek 官方背书。

## 功能展示

![DSH Desktop 运行官方 DeepSeek Harness Web UI](docs/images/dsh-desktop-preview.png)

桌面宿主刻意保持很薄：

1. Electron 启动项目锁定版本并随应用打包的 `@deepseek-ai/dsh` 进程。
2. 产品自有的 `desktop` Profile 组合官方 base、Web bundle 和轻量桌面插件。
3. Harness 只监听 `127.0.0.1`，端口由操作系统随机分配。
4. Electron 验证健康状态后，在原生窗口中加载官方 Web UI。
5. 版本化、白名单化的子进程通道提供原生桌面能力。
6. 应用退出时，Electron 停止 Harness 子进程和未完成的桌面请求。

项目不 fork 或修改 Harness 的 Agent 循环、模型适配器、会话存储、工具和
Web UI。跨平台复用依赖 Electron 和官方 React Web UI，不依赖 React Native。

## 架构边界

```text
Electron 主进程
  -> 创建 desktop Profile，并用 --profile desktop 启动 dsh CLI
  -> 等待本机回环地址上的健康检查
  -> 代理类型化、白名单化的原生能力
  -> 在沙箱窗口中加载官方 Harness Web UI
  -> 应用退出时停止子进程
```

Harness 仍然是 Agent、模型调用、工具、会话、审批和持久化的唯一事实来源。
Electron 层负责窗口、进程生命周期、导航策略、原生通知和桌面能力校验；
Harness 网页渲染层不会获得 Electron 或 Node.js 的直接访问能力。

## 环境要求

- Apple Silicon Mac，当前仅打包 arm64 版本
- Node.js 24
- npm 10 或更高版本

## 本地开发

```bash
nvm use
npm ci
npm run check
npm start
```

生成未签名的 Apple Silicon 应用：

```bash
npm run package:mac
open "release/mac-arm64/DSH Desktop.app"
```

生成未签名的 DMG 和 ZIP：

```bash
npm run dist:mac
```

## 本地数据

Harness 数据保存在：

```text
~/Library/Application Support/DSH Desktop/harness
```

运行日志保存在：

```text
~/Library/Logs/DSH Desktop/harness.log
```

Electron 层不会读取或复制模型凭据。官方 Harness 的凭据提供器会把凭据
保存在它自己的数据目录中。日志和本地数据都应视为敏感信息。

## 安全模型

Harness 仅监听 `127.0.0.1`。Electron 渲染进程启用沙箱并关闭 Node.js
集成；外部导航会被拦截；桌面 IPC 只接受来自内置启动页精确地址的调用。
安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 当前限制

- 仅提供 Apple Silicon 构建。
- 尚未进行代码签名和 Apple 公证。
- 暂无自动更新。
- Connections、Dock 集成、Keychain 和 Computer Use 尚未实现。

## 桌面集成边界

Harness 继续负责工作区、工具、审批、会话持久化和生成文件。桌面插件只适配
Electron 环境才具备的原生能力，并通过版本化白名单协议调用 Electron 主进程。
协议会校验方法、参数、响应、请求 ID、超时、取消和断连；网页端无法直接调用
这条子进程能力通道。当前首个完整能力是任务完成或失败后的原生通知。

Computer Use 属于更大的独立能力，需要明确申请屏幕录制和辅助功能权限，
并提供严格限制的截图、点击和键盘操作。仅把 Harness 放进 Electron 窗口，
并不会自动获得这些能力。

## 参与贡献

提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。桌面宿主相关问题在
本仓库处理；Agent、模型、工具、会话和官方 Web UI 问题请提交到
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

版本变化记录在 [CHANGELOG.md](CHANGELOG.md)。本项目采用
[Apache-2.0](LICENSE) 许可证，依赖许可证见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
