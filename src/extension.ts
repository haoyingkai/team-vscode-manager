import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from './managers/configManager';
import { SessionManager } from './managers/sessionManager';
import { UsageManager, formatTokens } from './managers/usageManager';
import { TeamTreeProvider, RoleTreeItem, SessionTreeItem } from './views/teamTreeProvider';
import { TeamRole } from './types';
import { BUILTIN_ROLE_IDS } from './presets';

let configManager: ConfigManager;
let sessionManager: SessionManager;
let usageManager: UsageManager;
let treeProvider: TeamTreeProvider;

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('Claude Team Manager 需要打开一个工作区');
    return;
  }

  // 初始化管理器
  configManager = new ConfigManager(workspaceRoot);
  sessionManager = new SessionManager(workspaceRoot);
  usageManager = new UsageManager(workspaceRoot);

  await configManager.load();
  await sessionManager.load();

  // 注册 TreeView（两个位置共享同一个 provider）
  treeProvider = new TeamTreeProvider(configManager, sessionManager);

  // 1. Activity Bar 独立面板（完整视图）
  const treeView = vscode.window.createTreeView('claudeTeamRoles', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 2. 文件浏览器侧边栏（折叠面板，可与文件列表共存）
  const explorerTreeView = vscode.window.createTreeView('claudeTeamRolesExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(explorerTreeView);

  context.subscriptions.push({ dispose: () => sessionManager.dispose() });

  // 终端关闭时刷新树，更新状态图标
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(() => {
      // 延迟一点刷新，等 sessionManager 内部先处理
      setTimeout(() => treeProvider.refresh(), 200);
    })
  );

  // ── 注册命令 ──

  // 使用量（单例面板，支持刷新）
  let usagePanel: vscode.WebviewPanel | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.showUsage', () => {
      if (usagePanel) {
        usagePanel.webview.html = renderUsageHtml(usageManager);
        usagePanel.reveal();
        return;
      }
      usagePanel = vscode.window.createWebviewPanel(
        'claudeTeamUsage',
        'Claude 使用量',
        vscode.ViewColumn.Active,
        { enableScripts: true }
      );
      usagePanel.webview.html = renderUsageHtml(usageManager);
      // 监听 webview 发来的刷新消息
      usagePanel.webview.onDidReceiveMessage((msg) => {
        if (msg.command === 'refresh' && usagePanel) {
          usagePanel.webview.html = renderUsageHtml(usageManager);
        }
      });
      usagePanel.onDidDispose(() => { usagePanel = undefined; });
    })
  );

  // 设置
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.openSettings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'claudeTeam'
      );
    })
  );

  // 刷新
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.refreshTree', async () => {
      await configManager.load();
      await sessionManager.load();
      treeProvider.refresh();
    })
  );

  // 新建 Session
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.newSession', async (item?: RoleTreeItem) => {
      let role: TeamRole | undefined;

      if (item instanceof RoleTreeItem) {
        role = item.role;
      } else {
        // 从命令面板触发，让用户选择角色
        const roles = configManager.getRoles();
        const picked = await vscode.window.showQuickPick(
          roles.map(r => ({ label: `$(${r.icon}) ${r.name}`, description: r.title, role: r })),
          { placeHolder: '选择角色' }
        );
        role = picked?.role;
      }

      if (!role) { return; }

      // 如果 Skill 未落地，先落地
      if (!role.skill_created) {
        const action = await vscode.window.showInformationMessage(
          `角色「${role.name}」的 Skill 文件尚未创建，是否现在创建？`,
          '创建并继续', '取消'
        );
        if (action !== '创建并继续') { return; }
        await configManager.materializeSkill(role);
        treeProvider.refresh();
      }

      try {
        await sessionManager.createSession(role);
        treeProvider.refresh();
      } catch {
        // 用户取消
      }
    })
  );

  // 恢复 Session
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.resumeSession', async (item?: SessionTreeItem) => {
      if (!(item instanceof SessionTreeItem)) { return; }
      const session = item.session;
      const role = configManager.getRoleById(session.role_id);
      if (!role) {
        vscode.window.showErrorMessage(`找不到角色 ${session.role_id}`);
        return;
      }
      await sessionManager.resumeSession(session, role);
      treeProvider.refresh();
    })
  );

  // 重命名 Session
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.renameSession', async (item?: SessionTreeItem) => {
      if (!(item instanceof SessionTreeItem)) { return; }
      const newTitle = await vscode.window.showInputBox({
        prompt: '新的对话名称',
        value: item.session.title,
      });
      if (newTitle) {
        await sessionManager.renameSession(item.session.id, newTitle);
        treeProvider.refresh();
      }
    })
  );

  // 删除 Session
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.deleteSession', async (item?: SessionTreeItem) => {
      if (!(item instanceof SessionTreeItem)) { return; }
      const confirm = await vscode.window.showWarningMessage(
        `确定删除对话「${item.session.title}」？`,
        { modal: true },
        '删除'
      );
      if (confirm === '删除') {
        await sessionManager.deleteSession(item.session.id);
        treeProvider.refresh();
      }
    })
  );

  // 添加角色
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.addRole', async () => {
      const name = await vscode.window.showInputBox({
        prompt: '角色昵称（如：老赵）',
        placeHolder: '老赵',
      });
      if (!name) { return; }

      const title = await vscode.window.showInputBox({
        prompt: '角色头衔（如：安全审计员）',
        placeHolder: '安全审计员',
      });
      if (!title) { return; }

      const description = await vscode.window.showInputBox({
        prompt: '角色职责简述',
        placeHolder: '代码安全审计、漏洞扫描、合规检查',
      });
      if (!description) { return; }

      // 让用户输入英文 ID（用于 skill 目录名）
      const idInput = await vscode.window.showInputBox({
        prompt: '角色 ID（英文，用于 skill 文件夹名，如 security、dba）',
        placeHolder: 'security',
        validateInput: (val) => {
          if (!val) { return '不能为空'; }
          if (!/^[a-z][a-z0-9-]*$/.test(val)) { return '只能用小写字母、数字、短横线，且以字母开头'; }
          const existing = configManager.getRoleById(val);
          if (existing) { return `ID "${val}" 已被「${existing.name}」占用`; }
          return null;
        },
      });
      if (!idInput) { return; }

      const iconPick = await vscode.window.showQuickPick([
        { label: '$(shield) shield', value: 'shield' },
        { label: '$(database) database', value: 'database' },
        { label: '$(globe) globe', value: 'globe' },
        { label: '$(graph) graph', value: 'graph' },
        { label: '$(tools) tools', value: 'tools' },
        { label: '$(terminal) terminal', value: 'terminal' },
        { label: '$(book) book', value: 'book' },
        { label: '$(megaphone) megaphone', value: 'megaphone' },
        { label: '$(person) person', value: 'person' },
        { label: '$(rocket) rocket', value: 'rocket' },
      ], { placeHolder: '选择图标' });

      const skillName = `team-${idInput}`;
      const roles = configManager.getRoles();
      const role: TeamRole = {
        id: idInput,
        name,
        title,
        icon: iconPick?.value || 'person',
        color: '#607D8B',
        sort_order: roles.length + 1,
        skill: skillName,
        skill_created: false,
        description: description || '',
      };

      await configManager.addRole(role);
      treeProvider.refresh();
      vscode.window.showInformationMessage(
        `角色「${name}(${title})」已添加 (skill: ${skillName})。首次创建对话时会自动生成 Skill 文件。`
      );
    })
  );

  // 编辑角色
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.editRole', async (item?: RoleTreeItem) => {
      if (!(item instanceof RoleTreeItem)) { return; }
      const role = item.role;

      if (role.skill_created) {
        // Skill 已落地，直接打开 SKILL.md 编辑
        const skillPath = vscode.Uri.file(
          `${workspaceRoot}/.claude/skills/${role.skill}/SKILL.md`
        );
        await vscode.window.showTextDocument(skillPath);
      } else {
        // Skill 未落地，编辑注册表中的描述
        const newDesc = await vscode.window.showInputBox({
          prompt: `编辑「${role.name}」的职责描述`,
          value: role.description,
        });
        if (newDesc) {
          await configManager.updateRole(role.id, { description: newDesc });
          treeProvider.refresh();
        }
      }
    })
  );

  // 删除角色
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.deleteRole', async (item?: RoleTreeItem) => {
      if (!(item instanceof RoleTreeItem)) { return; }
      const role = item.role;

      // 内置角色不可删除
      if (BUILTIN_ROLE_IDS.has(role.id)) {
        vscode.window.showWarningMessage(
          `「${role.name}(${role.title})」是内置角色，不可删除`
        );
        return;
      }

      let message = `确定删除角色「${role.name}(${role.title})」？`;
      const options: string[] = ['仅从注册表移除'];

      if (role.skill_created) {
        message += '\n\nSkill 文件夹已存在，是否一并删除？';
        options.push('同时删除 Skill 文件夹');
      }

      const action = await vscode.window.showWarningMessage(message, { modal: true }, ...options);

      if (!action) { return; }

      if (action === '同时删除 Skill 文件夹') {
        const skillDir = vscode.Uri.file(`${workspaceRoot}/.claude/skills/${role.skill}`);
        await vscode.workspace.fs.delete(skillDir, { recursive: true });
      }

      await configManager.deleteRole(role.id);
      treeProvider.refresh();
      vscode.window.showInformationMessage(`角色「${role.name}」已删除`);
    })
  );

  // 初始化团队（从预设）
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTeam.initTeam', async () => {
      const confirm = await vscode.window.showWarningMessage(
        '将用内置「老周团队」预设重新初始化，现有自定义角色不会被删除，但同 ID 的角色会被覆盖。继续？',
        '继续', '取消'
      );
      if (confirm === '继续') {
        await configManager.load();
        treeProvider.refresh();
        vscode.window.showInformationMessage('团队已从预设初始化');
      }
    })
  );

  // 监听 team.json 变化，自动刷新
  const teamJsonWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '.claude/team.json')
  );
  teamJsonWatcher.onDidChange(async () => {
    await configManager.load();
    treeProvider.refresh();
  });
  context.subscriptions.push(teamJsonWatcher);

  vscode.window.showInformationMessage('Claude Team Manager 已激活');
}

export function deactivate() {}

function renderUsageHtml(mgr: UsageManager): string {
  const usage = mgr.getUsage();
  if (!usage) {
    return '<html><body style="padding:30px;font-family:system-ui;color:#ccc;background:#1e1e1e"><h2>无法读取使用量数据</h2></body></html>';
  }

  const { todayCost, weekCost, totalCost, todayTokens, weekTokens, totalTokens, time, rateLimits } = usage;

  const fmt = formatTokens;

  const pctColor = (pct: number) =>
    pct >= 80 ? '#F44336' : pct >= 50 ? '#FF9800' : '#4CAF50';

  const progressBar = (pct: number) => {
    const c = pctColor(pct);
    return `<div style="background:rgba(255,255,255,0.08);border-radius:4px;height:8px;width:100%;margin-top:6px">
      <div style="background:${c};border-radius:4px;height:100%;width:${Math.min(100, pct)}%;transition:width 0.3s"></div>
    </div>`;
  };

  type Tk = typeof todayTokens;
  const row = (label: string, cost: number, t: Tk, color: string) => `
    <tr>
      <td style="font-weight:600;color:${color}">${label}</td>
      <td style="font-weight:700;font-size:1.1em">$${cost.toFixed(2)}</td>
      <td>${fmt(t.input)}</td>
      <td>${fmt(t.output)}</td>
      <td>${fmt(t.cacheRead)}</td>
      <td>${fmt(t.cacheWrite)}</td>
      <td>${fmt(t.total)}</td>
    </tr>`;

  const timeLabel = time.todayHours > 0
    ? `${time.todayHours}h${time.todayMinutes}m`
    : `${time.todayMinutes}m`;

  // 5小时配额卡片
  const fiveHourCard = rateLimits.fiveHour
    ? `<div class="card">
        <div class="label">5小时配额</div>
        <div class="value" style="color:${pctColor(rateLimits.fiveHour.pct)}">${rateLimits.fiveHour.pct}%</div>
        ${progressBar(rateLimits.fiveHour.pct)}
        <div class="sub">余 ${rateLimits.fiveHour.resetIn}</div>
      </div>`
    : `<div class="card">
        <div class="label">5小时配额</div>
        <div class="value" style="color:#888">--</div>
        <div class="sub">需运行中的会话</div>
      </div>`;

  // 7天配额卡片
  const sevenDayCard = rateLimits.sevenDay
    ? `<div class="card">
        <div class="label">7天配额</div>
        <div class="value" style="color:${pctColor(rateLimits.sevenDay.pct)}">${rateLimits.sevenDay.pct}%</div>
        ${progressBar(rateLimits.sevenDay.pct)}
        <div class="sub">余 ${rateLimits.sevenDay.resetIn}</div>
      </div>`
    : `<div class="card">
        <div class="label">7天配额</div>
        <div class="value" style="color:#888">--</div>
        <div class="sub">需运行中的会话</div>
      </div>`;

  return `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: var(--vscode-font-family, system-ui);
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 20px 30px;
    max-width: 860px;
  }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  h2 { margin: 0; }
  .refresh-btn {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 4px; padding: 6px 14px;
    cursor: pointer; font-size: 0.85em;
  }
  .refresh-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .subtitle { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  th { color: var(--vscode-descriptionForeground, #888); font-weight: 500; font-size: 0.82em; text-transform: uppercase; }
  .cards { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .card {
    flex: 1; min-width: 110px;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.05));
    border-radius: 8px; padding: 14px 16px; text-align: center;
  }
  .card .label { font-size: 0.72em; color: var(--vscode-descriptionForeground, #888); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 1.5em; font-weight: 700; }
  .card .sub { font-size: 0.72em; color: var(--vscode-descriptionForeground, #888); margin-top: 2px; }
  .section-title { font-size: 0.85em; color: var(--vscode-descriptionForeground, #888); margin: 20px 0 10px; text-transform: uppercase; font-weight: 600; }
  .note { color: var(--vscode-descriptionForeground, #666); font-size: 0.75em; margin-top: 16px; line-height: 1.6; }
  .data-source { display: inline-block; background: rgba(76,175,80,0.15); color: #4CAF50; padding: 1px 6px; border-radius: 3px; font-size: 0.7em; margin-left: 8px; }
</style>
</head>
<body>
  <div class="header">
    <h2>Claude Code 使用量 <span class="data-source">ccusage</span></h2>
    <button class="refresh-btn" onclick="refresh()">↻ 刷新</button>
  </div>
  <div class="subtitle">全部项目 · 更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>

  <div class="cards">
    <div class="card">
      <div class="label">今日费用</div>
      <div class="value" style="color:#4CAF50">$${todayCost.toFixed(2)}</div>
      <div class="sub">使用 ${timeLabel}</div>
    </div>
    ${fiveHourCard}
    <div class="card">
      <div class="label">本周费用</div>
      <div class="value" style="color:#FF9800">$${weekCost.toFixed(2)}</div>
    </div>
    ${sevenDayCard}
    <div class="card">
      <div class="label">活跃天数</div>
      <div class="value" style="color:#2196F3">${time.activeDays}</div>
      <div class="sub">共 ${time.totalDays} 天</div>
    </div>
    <div class="card">
      <div class="label">总费用</div>
      <div class="value" style="color:#2196F3">$${totalCost.toFixed(2)}</div>
    </div>
  </div>

  <div class="section-title">Token 明细</div>
  <table>
    <thead>
      <tr>
        <th>时段</th><th>费用</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>合计</th>
      </tr>
    </thead>
    <tbody>
      ${row('今天', todayCost, todayTokens, '#4CAF50')}
      ${row('本周', weekCost, weekTokens, '#FF9800')}
      ${row('总计', totalCost, totalTokens, '#2196F3')}
    </tbody>
  </table>

  <div class="note">
    费用数据来自 <strong>ccusage</strong>（基于实际 API 调用的多模型精确计费）<br>
    5h/7d 配额数据来自 Claude Code 运行时 API 响应，需要有活跃会话才能显示<br>
    定价参考：Opus $5/$25 · Sonnet $3/$15 · Haiku $1/$5（输入/输出 /MTok）· 缓存读 0.1x · 缓存写 1.25x
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }
  </script>
</body>
</html>`;
}
