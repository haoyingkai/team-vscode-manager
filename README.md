# Claude Team Manager

VS Code 插件，为 Claude Code 提供团队角色管理和多会话支持。

## 功能

- **角色管理** — 创建、编辑、删除团队角色（PM、开发、测试、架构师等）
- **多会话** — 每个角色独立会话，支持新建、恢复、重命名、删除
- **会话追踪** — 自动关联 Claude Code session ID，支持断点续聊
- **使用量面板** — 查看 Token 消耗、费用统计、配额使用情况
- **内置团队预设** — 一键初始化老周团队（PM/PD/ARCH/DEV/QA/CR）

## 设置

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| `claudeTeam.sessionMode` | 会话启动方式：终端 / VS Code 插件 Tab | `terminal` |
| `claudeTeam.skipPermissions` | 启动时添加 `--dangerously-skip-permissions`，跳过工具确认 | `false` |

## 使用方式

1. 安装插件后，侧边栏出现 **Claude Team** 图标
2. 点击角色右侧的对话图标，新建会话
3. 在 VS Code 设置中搜索 `claudeTeam` 调整偏好

## 前置依赖

- [Claude Code CLI](https://claude.ai/code) 已安装
- 项目目录下有 `.claude/skills/` 目录（角色 Skill 文件）

## 许可

MIT
