export interface TeamRole {
  id: string;
  name: string;        // 角色昵称，如 "老周"
  title: string;       // 角色头衔，如 "项目经理 PM"
  icon: string;        // VS Code codicon 名
  color: string;       // 十六进制颜色
  sort_order: number;
  skill: string;       // 对应的 skill 名，如 "team-pm"
  skill_created: boolean;
  description: string;
  prompt_template?: string;  // Skill 未落地时的角色提示词
  shared_context?: string[];
  private_context?: string[];
}

export interface TeamSession {
  id: string;           // 内部 ID
  role_id: string;
  title: string;
  claude_session_id?: string;  // Claude Code 原生 session ID
  created: string;
  status: 'active' | 'paused' | 'done';
}

export interface TeamConfig {
  builtin_preset: string;
  roles: TeamRole[];
  shared_context: {
    paths: string[];
    protocol?: string;
  };
}

export interface SessionStore {
  sessions: Record<string, TeamSession>;
}
