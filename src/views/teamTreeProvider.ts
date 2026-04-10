import * as vscode from 'vscode';
import { ConfigManager } from '../managers/configManager';
import { SessionManager } from '../managers/sessionManager';
import { TeamRole, TeamSession } from '../types';
import { BUILTIN_ROLE_IDS } from '../presets';

type TreeItem = RoleTreeItem | SessionTreeItem;

export class RoleTreeItem extends vscode.TreeItem {
  constructor(public readonly role: TeamRole, sessionCount: number) {
    super(
      `${role.name} (${role.title})`,
      sessionCount > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    const isBuiltin = BUILTIN_ROLE_IDS.has(role.id);
    this.iconPath = new vscode.ThemeIcon(role.icon, new vscode.ThemeColor('charts.foreground'));
    this.description = role.skill_created ? role.description : `${role.description} [未激活]`;
    this.tooltip = new vscode.MarkdownString(
      `**${role.name}** — ${role.title}${isBuiltin ? ' (内置)' : ''}\n\n${role.description}\n\nSkill: \`${role.skill}\` ${role.skill_created ? '✅' : '⏳ 首次使用时创建'}`
    );
    // 内置角色用不同的 contextValue，菜单中不显示删除
    this.contextValue = isBuiltin ? 'role-builtin' : 'role';
  }
}

export interface SessionSummary {
  firstMessage: string;
  lastMessage: string;
  messageCount: number;
  claudeTitle: string;
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: TeamSession,
    hasActiveTerminal: boolean = false,
    summary: SessionSummary | null = null,
  ) {
    super(session.title, vscode.TreeItemCollapsibleState.None);

    // 终端活跃 → 绿点，暂停 → 灰点，完成 → 勾
    const statusIcon = hasActiveTerminal ? '●'
      : session.status === 'active' ? '◐'
      : session.status === 'paused' ? '○'
      : '✓';
    const statusColor = hasActiveTerminal ? 'testing.iconPassed'
      : session.status === 'active' ? 'testing.iconSkipped'
      : session.status === 'paused' ? 'testing.iconSkipped'
      : 'testing.iconQueued';

    this.iconPath = new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor(statusColor));
    const terminalHint = hasActiveTerminal ? ' [终端活跃]' : '';
    const resumable = session.claude_session_id ? ' [可恢复]' : '';
    this.description = `${statusIcon} ${this.formatDate(session.created)}${terminalHint}${resumable}`;

    // 构建丰富的 tooltip
    const tip = new vscode.MarkdownString('', true);
    tip.isTrusted = true;
    tip.supportHtml = true;

    tip.appendMarkdown(`### ${session.title}\n\n`);

    // Claude 会话摘要
    if (summary) {
      tip.appendMarkdown(`**会话主题**: ${summary.claudeTitle}\n\n`);
      tip.appendMarkdown(`---\n\n`);
      tip.appendMarkdown(`**首条消息**:\n> ${summary.firstMessage}\n\n`);
      if (summary.lastMessage && summary.lastMessage !== summary.firstMessage) {
        tip.appendMarkdown(`**最近消息**:\n> ${summary.lastMessage}\n\n`);
      }
      tip.appendMarkdown(`**消息数**: ${summary.messageCount} 条\n\n`);
      tip.appendMarkdown(`---\n\n`);
    } else if (session.claude_session_id) {
      tip.appendMarkdown(`*会话摘要加载中...*\n\n---\n\n`);
    }

    // 状态信息
    tip.appendMarkdown(
      `- **终端**: ${hasActiveTerminal ? '🟢 活跃' : '⚪ 已关闭'}\n`
      + `- **Claude 会话**: ${session.claude_session_id ? `\`${session.claude_session_id.slice(0, 8)}...\`` : '未关联'}\n`
      + `- **创建时间**: ${this.formatDateFull(session.created)}\n`
    );

    this.tooltip = tip;
    this.contextValue = 'session';

    // 点击恢复 session
    this.command = {
      command: 'claudeTeam.resumeSession',
      title: 'Resume Session',
      arguments: [this],
    };
  }

  private formatDate(iso: string): string {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
  }

  private formatDateFull(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
}

export class TeamTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private configManager: ConfigManager,
    private sessionManager: SessionManager,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      // 根节点：返回所有角色
      const roles = this.configManager.getRoles();
      return roles.map(role => {
        const sessions = this.sessionManager.getSessionsByRole(role.id);
        return new RoleTreeItem(role, sessions.length);
      });
    }

    if (element instanceof RoleTreeItem) {
      // 角色节点：返回该角色的 sessions
      const sessions = this.sessionManager.getSessionsByRole(element.role.id);
      return sessions.map(s => {
        const summary = s.claude_session_id
          ? this.sessionManager.getClaudeSessionSummary(s.claude_session_id)
          : null;
        return new SessionTreeItem(
          s,
          this.sessionManager.hasActiveTerminal(s.id),
          summary,
        );
      });
    }

    return [];
  }

  getParent(element: TreeItem): TreeItem | undefined {
    // 不需要实现 getParent 对于基础功能
    return undefined;
  }
}
