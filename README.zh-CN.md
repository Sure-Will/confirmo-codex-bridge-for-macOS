# confirmo-codex-bridge-for-macOS

面向 macOS 的非官方桥接层，用来连接 Codex CLI 与
[`yetone's Confirmo`](https://github.com/yetone/confirmo-releases)。

这是一个面向 macOS 的本地桥接项目，用来给 Confirmo 补上更稳定的
Codex CLI 状态识别能力，而不必等待 Codex 官方完整生命周期 hooks 落地。

[English README](./README.md)

## 作用

- 读取本地 `~/.codex/state_5.sqlite`
- 读取 `~/.codex/sessions/...` 下的 rollout JSONL 事件
- 推导 `working`、`completed`、`idle` 三种会话状态
- 将状态写入 `~/.confirmo/codex-status/`
- 安装一个很薄的用户级 shim，让 Codex completion 事件进入这个仓库维护的桥接层

## 相关项目

这个仓库是面向 Confirmo 的**非官方适配项目**，对应的上游项目是：

- Confirmo：[`yetone's Confirmo`](https://github.com/yetone/confirmo-releases)
- 作者：`yetone`

边界说明：

- 这个仓库**不是** Confirmo 官方仓库
- 这个仓库**不是** `yetone` 官方维护的扩展
- 这个仓库的目标，是改善 macOS 上 Confirmo 与 Codex CLI 的状态桥接体验

## 仓库结构

- `bin/codex-bridge.js`：常驻 sidecar，负责读取 Codex 本地状态并输出给 Confirmo
- `bin/codex-notify.js`：轻量 notify hook
- `bin/install.js`：安装 LaunchAgent、写入 shim、更新 Codex notify 配置
- `bin/patch-confirmo.js`：预留给 Confirmo 本体 patch 的脚本，目前默认禁用

## 为什么需要这个桥接层

Codex CLI 当前公开可配置的 `notify` 更偏向 “turn 完成后通知”，而不是完整实时生命周期事件。
但 Codex 本地其实会写出更丰富的状态，比如 `task_started`、`function_call`、
`reasoning`、`task_complete` 等。

这个仓库直接利用这些本地状态，给 Confirmo 输出更稳定的 `working` / `completed` / `idle`
识别结果。

## 安装

在仓库目录里执行：

```bash
node bin/install.js
launchctl unload ~/Library/LaunchAgents/com.sure.confirmo.codex-bridge.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.sure.confirmo.codex-bridge.plist
```

`install.js` 目前会做这些事：

- 写入 `~/.confirmo/hooks/confirmo-codex-hook.js`
- 把 Codex 的 `notify` 指向这个 shim
- 安装 `~/Library/LaunchAgents/com.sure.confirmo.codex-bridge.plist`

如果只想手动跑一轮 bridge：

```bash
node bin/codex-bridge.js --once --verbose
```

## 当前限制

- `bin/patch-confirmo.js` 目前仍然是禁用状态
- 如果 Confirmo 后续版本修改了内部 Codex 监控逻辑，可能还需要继续适配
- 如果未来 Codex 官方补上完整 hooks，这个仓库的部分桥接逻辑可能可以简化

## 许可证说明

当前仓库使用的是 `MIT` 许可证，见 [LICENSE](./LICENSE)。

为了减少争议，建议继续保持这几个边界：

- 这个仓库只发布你自己的桥接代码
- README 明确它是面向 Confirmo 的非官方兼容项目
- 不要把 Confirmo 的源码、资源、图标或二进制直接打包进来
