import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TeamConfig, TeamRole } from '../types';
import { LAOZHOU_TEAM_PRESET } from '../presets';

/**
 * 管理 .claude/team.json 角色注册表
 */
export class ConfigManager {
  private configPath: string;
  private skillsDir: string;
  private config: TeamConfig | null = null;

  constructor(private workspaceRoot: string) {
    this.configPath = path.join(workspaceRoot, '.claude', 'team.json');
    this.skillsDir = path.join(workspaceRoot, '.claude', 'skills');
  }

  /**
   * 加载配置：team.json → 扫描已有 Skill → 内置预设
   */
  async load(): Promise<TeamConfig> {
    // 1. 尝试读取 team.json
    if (fs.existsSync(this.configPath)) {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(raw) as TeamConfig;
      // 同步检测 skill_created 状态
      this.syncSkillCreatedStatus();
      return this.config;
    }

    // 2. 没有 team.json，用内置预设初始化
    this.config = JSON.parse(JSON.stringify(LAOZHOU_TEAM_PRESET)) as TeamConfig;
    this.syncSkillCreatedStatus();

    // 3. 扫描是否有未注册的 team-* Skill 文件夹
    this.discoverUnregisteredSkills();

    // 4. 持久化
    await this.save();
    return this.config;
  }

  /**
   * 检测每个角色的 Skill 文件夹是否已存在
   */
  private syncSkillCreatedStatus(): void {
    if (!this.config) { return; }
    for (const role of this.config.roles) {
      const skillPath = path.join(this.skillsDir, role.skill, 'SKILL.md');
      role.skill_created = fs.existsSync(skillPath);
    }
  }

  /**
   * 扫描 .claude/skills/ 下未注册的 team-* 目录
   */
  private discoverUnregisteredSkills(): void {
    if (!this.config || !fs.existsSync(this.skillsDir)) { return; }

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    const registeredSkills = new Set(this.config.roles.map(r => r.skill));

    for (const entry of entries) {
      if (!entry.name.startsWith('team-')) { continue; }
      if (registeredSkills.has(entry.name)) { continue; }

      // 检查是否是目录（或符号链接指向目录）
      const fullPath = path.join(this.skillsDir, entry.name);
      const skillMd = path.join(fullPath, 'SKILL.md');
      if (!fs.existsSync(skillMd)) { continue; }

      // 从 SKILL.md frontmatter 提取信息
      const content = fs.readFileSync(skillMd, 'utf-8');
      const meta = this.parseFrontmatter(content);

      this.config.roles.push({
        id: entry.name.replace('team-', ''),
        name: meta.name || entry.name,
        title: meta.description?.split('。')[0] || entry.name,
        icon: 'person',
        color: '#607D8B',
        sort_order: this.config.roles.length + 1,
        skill: entry.name,
        skill_created: true,
        description: meta.description || '',
      });
    }
  }

  private parseFrontmatter(content: string): Record<string, string> {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) { return {}; }
    const result: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).trim();
        // 去掉引号
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[key] = val;
      }
    }
    return result;
  }

  async save(): Promise<void> {
    if (!this.config) { return; }
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  getConfig(): TeamConfig | null {
    return this.config;
  }

  getRoles(): TeamRole[] {
    return this.config?.roles.sort((a, b) => a.sort_order - b.sort_order) || [];
  }

  getRoleById(id: string): TeamRole | undefined {
    return this.config?.roles.find(r => r.id === id);
  }

  async addRole(role: TeamRole): Promise<void> {
    if (!this.config) { return; }
    this.config.roles.push(role);
    await this.save();
  }

  async updateRole(id: string, updates: Partial<TeamRole>): Promise<void> {
    if (!this.config) { return; }
    const idx = this.config.roles.findIndex(r => r.id === id);
    if (idx >= 0) {
      this.config.roles[idx] = { ...this.config.roles[idx], ...updates };
      await this.save();
    }
  }

  async deleteRole(id: string): Promise<void> {
    if (!this.config) { return; }
    this.config.roles = this.config.roles.filter(r => r.id !== id);
    await this.save();
  }

  /**
   * 为角色落地 Skill 文件夹（从模板生成 SKILL.md）
   */
  async materializeSkill(role: TeamRole): Promise<void> {
    const skillDir = path.join(this.skillsDir, role.skill);
    const skillMd = path.join(skillDir, 'SKILL.md');

    if (fs.existsSync(skillMd)) {
      role.skill_created = true;
      await this.save();
      return;
    }

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    const prompt = role.prompt_template || this.generateDefaultPrompt(role);
    const triggerWords = [role.name, role.title.split(' ')[0]].join("''");

    const content = `---
name: ${role.skill}
description: "${role.title}${role.name}。${role.description}。触发词：'${triggerWords}'。"
---

# ${role.title} — ${role.name}

## 人设

**姓名**: ${role.name}

## 协议文件

团队协作协议: [../team-pm/references/protocol.md](../team-pm/references/protocol.md)

## 核心职责

${prompt}
`;

    fs.writeFileSync(skillMd, content, 'utf-8');
    role.skill_created = true;
    await this.save();
  }

  private generateDefaultPrompt(role: TeamRole): string {
    return `- ${role.description}\n- 你是团队中的${role.title}，负责本职工作\n- 遵循团队协作协议`;
  }
}
