import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TeamSession, SessionStore, TeamRole } from '../types';

/**
 * 管理 .claude/team-sessions.json + 终端生命周期
 */
export class SessionManager {
  private storePath: string;
  private store: SessionStore = { sessions: {} };

  /** sessionId → 活跃终端实例（终端模式） */
  private terminalMap = new Map<string, vscode.Terminal>();

  /** 已在 VS Code 插件模式中打开的 session ID 集合 */
  private openedExtSessions = new Set<string>();

  private disposables: vscode.Disposable[] = [];

  constructor(private workspaceRoot: string) {
    this.storePath = path.join(workspaceRoot, '.claude', 'team-sessions.json');

    // 监听终端关闭
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closedTerminal) => {
        for (const [sessionId, terminal] of this.terminalMap.entries()) {
          if (terminal === closedTerminal) {
            this.terminalMap.delete(sessionId);
            const session = this.store.sessions[sessionId];
            if (session && session.status === 'active') {
              session.status = 'paused';
              this.save();
            }
            break;
          }
        }
      })
    );

    // 监听 Tab 关闭：当 Claude Code Tab 数量减少时，同步清理
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        if (event.closed.length > 0 && this.openedExtSessions.size > 0) {
          const claudeTabCount = this.countClaudeCodeTabs();
          // 如果所有 Claude Code Tab 都关了，清空集合
          if (claudeTabCount === 0) {
            for (const sid of this.openedExtSessions) {
              const session = this.store.sessions[sid];
              if (session && session.status === 'active') {
                session.status = 'paused';
              }
            }
            this.openedExtSessions.clear();
            this.save();
          }
        }
      })
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  async load(): Promise<void> {
    if (fs.existsSync(this.storePath)) {
      const raw = fs.readFileSync(this.storePath, 'utf-8');
      this.store = JSON.parse(raw);
    }
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8');
  }

  getSessionsByRole(roleId: string): TeamSession[] {
    return Object.values(this.store.sessions)
      .filter(s => s.role_id === roleId)
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
  }

  getSession(id: string): TeamSession | undefined {
    return this.store.sessions[id];
  }

  /**
   * 创建新 session 并打开 Claude Code 终端
   */
  async createSession(role: TeamRole): Promise<TeamSession> {
    const sessionId = this.generateId();
    const title = await vscode.window.showInputBox({
      prompt: `为 ${role.name}(${role.title}) 的新对话命名`,
      placeHolder: '例如：需求讨论-用户系统',
      value: `${role.name}-${new Date().toLocaleDateString('zh-CN')}`,
    });

    if (!title) {
      throw new Error('用户取消了创建');
    }

    const session: TeamSession = {
      id: sessionId,
      role_id: role.id,
      title,
      created: new Date().toISOString(),
      status: 'active',
    };

    this.store.sessions[sessionId] = session;
    await this.save();

    const mode = this.getSessionMode();

    if (mode === 'vscode-extension') {
      await this.openVscodeExtensionSession(role, session);
    } else {
      const terminal = this.createTerminal(role, session);
      const skillCommand = `/${role.skill}`;
      const rolePrompt = `你现在是${role.name}（${role.title}），请按照 ${skillCommand} 的角色设定工作。用户接下来的消息是你的工作指令。`;
      const escapedPrompt = rolePrompt.replace(/'/g, "'\\''");
      const skipFlag = this.getSkipPermissions() ? ' --dangerously-skip-permissions' : '';
      terminal.sendText(`claude${skipFlag} --append-system-prompt '${escapedPrompt}'`);

      // 异步检测 Claude Code 创建的 session ID
      this.detectClaudeSessionId(session);
    }

    return session;
  }

  /**
   * 恢复或切换到已有 session
   */
  async resumeSession(session: TeamSession, role: TeamRole): Promise<void> {
    const mode = this.getSessionMode();

    if (mode === 'vscode-extension') {
      if (this.openedExtSessions.has(session.id)) {
        // 已打开，聚焦到 Claude Code 区域
        await vscode.commands.executeCommand('claude-vscode.focus');
        vscode.window.showInformationMessage(
          `「${session.title}」已在 Claude Code Tab 中打开，请在编辑器标签栏切换到对应标签页`
        );
        return;
      }
      // 未打开，新开 Tab
      await this.openVscodeExtensionSession(role, session, session.claude_session_id);
      return;
    }

    // 终端模式
    // 1. 检查是否有活跃终端 → 直接切换
    const existingTerminal = this.terminalMap.get(session.id);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    // 2. 终端已关闭，需要新开终端并恢复 Claude 会话
    session.status = 'active';
    await this.save();

    const terminal = this.createTerminal(role, session);

    const skipFlag = this.getSkipPermissions() ? ' --dangerously-skip-permissions' : '';

    if (session.claude_session_id) {
      terminal.sendText(`claude${skipFlag} --resume ${session.claude_session_id}`);
    } else {
      const skillCommand = `/${role.skill}`;
      const rolePrompt = `你现在是${role.name}（${role.title}），请按照 ${skillCommand} 的角色设定工作。用户接下来的消息是你的工作指令。`;
      const escapedPrompt = rolePrompt.replace(/'/g, "'\\''");
      terminal.sendText(`claude${skipFlag} --append-system-prompt '${escapedPrompt}'`);

      this.detectClaudeSessionId(session);
    }
  }

  async renameSession(id: string, newTitle: string): Promise<void> {
    const session = this.store.sessions[id];
    if (session) {
      session.title = newTitle;
      await this.save();
    }
  }

  async deleteSession(id: string): Promise<void> {
    // 关闭关联的终端
    const terminal = this.terminalMap.get(id);
    if (terminal) {
      terminal.dispose();
      this.terminalMap.delete(id);
    }
    // 清理 VS Code 插件模式的记录
    this.openedExtSessions.delete(id);
    delete this.store.sessions[id];
    await this.save();
  }

  async updateSessionStatus(id: string, status: TeamSession['status']): Promise<void> {
    const session = this.store.sessions[id];
    if (session) {
      session.status = status;
      await this.save();
    }
  }

  /**
   * 检查某个 session 是否有活跃的终端或 Tab
   */
  hasActiveTerminal(sessionId: string): boolean {
    return this.terminalMap.has(sessionId) || this.openedExtSessions.has(sessionId);
  }

  /**
   * 从 Claude session JSONL 中读取会话摘要
   * 提取首条用户消息 + 最近一条用户消息 + 消息计数
   */
  getClaudeSessionSummary(claudeSessionId: string): {
    firstMessage: string;
    lastMessage: string;
    messageCount: number;
    claudeTitle: string;
  } | null {
    const dir = this.getClaudeProjectDir();
    if (!dir) { return null; }

    const filePath = path.join(dir, `${claudeSessionId}.jsonl`);
    if (!fs.existsSync(filePath)) { return null; }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      let firstUserMsg = '';
      let lastUserMsg = '';
      let userMsgCount = 0;
      let assistantMsgCount = 0;

      for (const line of lines) {
        if (!line.trim()) { continue; }
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            const textContent = entry.message.content.find(
              (c: { type: string }) => c.type === 'text'
            );
            if (textContent?.text) {
              const text = textContent.text
                .replace(/<[^>]*>/g, '')  // 去掉 HTML/XML 标签
                .trim();
              if (!text || this.isSystemMessage(text)) {
                // 跳过系统注入消息、斜杠命令和空消息
                continue;
              }
              if (!firstUserMsg) {
                firstUserMsg = text;
              }
              lastUserMsg = text;
              userMsgCount++;
            }
          } else if (entry.type === 'assistant') {
            assistantMsgCount++;
          }
        } catch {
          // 跳过无法解析的行
        }
      }

      // 截断长文本
      const truncate = (s: string, len: number) =>
        s.length > len ? s.slice(0, len) + '...' : s;

      // 生成标题：取首条用户消息的前 50 个字符
      const claudeTitle = firstUserMsg
        ? truncate(firstUserMsg, 50)
        : '(无用户消息)';

      return {
        firstMessage: truncate(firstUserMsg, 120),
        lastMessage: truncate(lastUserMsg, 120),
        messageCount: userMsgCount + assistantMsgCount,
        claudeTitle,
      };
    } catch {
      return null;
    }
  }

  // ── 私有方法 ──

  /**
   * 读取用户设置的会话打开方式
   */
  private getSessionMode(): 'terminal' | 'vscode-extension' {
    return vscode.workspace.getConfiguration('claudeTeam').get<string>('sessionMode', 'terminal') as 'terminal' | 'vscode-extension';
  }

  private getSkipPermissions(): boolean {
    return vscode.workspace.getConfiguration('claudeTeam').get<boolean>('skipPermissions', false);
  }

  /**
   * 通过 VS Code Claude Code 插件打开会话（新 Tab）
   * KNOWN BUG: VS Code Tab API 无法为 Claude Code 的 Webview Tab 提供唯一标识，
   * 导致无法精确追踪和切换特定 Tab。当前实现只能防止重复打开，无法自动切换。
   */
  private async openVscodeExtensionSession(
    role: TeamRole,
    session: TeamSession,
    resumeSessionId?: string,
  ): Promise<void> {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open');

      this.openedExtSessions.add(session.id);
      session.status = 'active';
      await this.save();

      // 异步检测 Claude session ID
      this.detectClaudeSessionId(session);
    } catch {
      vscode.window.showWarningMessage(
        'Claude Code VS Code 插件未安装或命令不可用，回退到终端模式'
      );
      const skillCommand = `/${role.skill}`;
      const rolePrompt = `你现在是${role.name}（${role.title}），请按照 ${skillCommand} 的角色设定工作。`;
      const terminal = this.createTerminal(role, session);
      const escapedPrompt = rolePrompt.replace(/'/g, "'\\''");
      const skipFlag = this.getSkipPermissions() ? ' --dangerously-skip-permissions' : '';
      terminal.sendText(`claude${skipFlag} --append-system-prompt '${escapedPrompt}'`);

      this.detectClaudeSessionId(session);
    }
  }

  /**
   * 统计当前打开的 Claude Code Tab 数量
   */
  private countClaudeCodeTabs(): number {
    let count = 0;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { viewType?: string } | undefined;
        if (input?.viewType?.includes('claude')) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * 判断是否为 Claude Code 系统注入的消息（非真实用户输入）
   */
  private isSystemMessage(text: string): boolean {
    // 斜杠命令
    if (text.startsWith('/')) { return true; }
    // Skill 触发时注入的元信息
    if (text.startsWith('Base directory for this skill:')) { return true; }
    if (text.startsWith('Skill directory:')) { return true; }
    // system-reminder 标签残留
    if (text.startsWith('system-reminder')) { return true; }
    // 纯路径行
    if (/^\/[\w\-/.]+$/.test(text)) { return true; }
    // 很短且像是 metadata（少于 5 个字符的纯 ASCII）
    if (text.length < 3 && /^[\x20-\x7e]+$/.test(text)) { return true; }
    return false;
  }

  /**
   * 创建终端并记录到 Map
   */
  private createTerminal(role: TeamRole, session: TeamSession): vscode.Terminal {
    const terminalName = `${role.name}(${role.title}) - ${session.title}`;
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: this.workspaceRoot,
      iconPath: new vscode.ThemeIcon(role.icon),
    });
    terminal.show();
    this.terminalMap.set(session.id, terminal);
    return terminal;
  }

  /**
   * 获取 Claude Code 项目的 session 目录
   * 路径规则: ~/.claude/projects/{workspaceRoot 的路径用 - 替换 /}
   */
  private getClaudeProjectDir(): string | null {
    const projectKey = this.workspaceRoot.replace(/\//g, '-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);
    return fs.existsSync(projectDir) ? projectDir : null;
  }

  /**
   * 异步检测 Claude Code 新创建的 session ID
   * 策略：找到创建时间在 session 创建之后、且尚未被其他 session 占用的最新 .jsonl 文件
   */
  private async detectClaudeSessionId(
    session: TeamSession,
  ): Promise<void> {
    const maxAttempts = 10;
    const intervalMs = 2000;
    const sessionCreatedAt = new Date(session.created).getTime();

    // 收集已被其他 session 占用的 claude_session_id
    const occupiedIds = new Set<string>();
    for (const s of Object.values(this.store.sessions)) {
      if (s.id !== session.id && s.claude_session_id) {
        occupiedIds.add(s.claude_session_id);
      }
    }

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));

      const dir = this.getClaudeProjectDir();
      if (!dir) { continue; }

      // 找在 session 创建时间之后修改的 .jsonl 文件，且未被占用
      const candidates = fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = path.join(dir, f);
          const stat = fs.statSync(fullPath);
          return {
            name: f,
            id: f.replace('.jsonl', ''),
            mtimeMs: stat.mtimeMs,
            birthtimeMs: stat.birthtimeMs,
          };
        })
        .filter(f => {
          // 创建时间或修改时间在 session 创建之后
          const fileTime = Math.max(f.birthtimeMs, f.mtimeMs);
          return fileTime >= sessionCreatedAt - 5000; // 5秒容差
        })
        .filter(f => !occupiedIds.has(f.id))  // 排除已占用的
        .sort((a, b) => b.birthtimeMs - a.birthtimeMs); // 最新的排前面

      if (candidates.length > 0) {
        session.claude_session_id = candidates[0].id;
        await this.save();
        return;
      }
    }
  }

  private generateId(): string {
    return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
}
