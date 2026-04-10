import { TeamConfig } from './types';

/** 内置角色 ID，不可删除 */
export const BUILTIN_ROLE_IDS = new Set(['pm', 'pd', 'arch', 'dev', 'qa', 'cr']);

/**
 * 内置预设：老周团队
 * 插件安装后如果项目中没有 team.json，则使用此预设初始化。
 * skill_created 根据实际检测文件系统来决定。
 */
export const LAOZHOU_TEAM_PRESET: TeamConfig = {
  builtin_preset: 'laozhou-team-v1',
  roles: [
    {
      id: 'pm',
      name: '老周',
      title: '项目经理 PM',
      icon: 'megaphone',
      color: '#4CAF50',
      sort_order: 1,
      skill: 'team-pm',
      skill_created: false,
      description: '永远在线的团队入口，接收指令、拆解任务、协调角色、跟踪进度、随时汇报',
      shared_context: ['.team/tasks/', '.team/iterations/'],
    },
    {
      id: 'pd',
      name: '小苏',
      title: '产品经理 PD',
      icon: 'lightbulb',
      color: '#FF9800',
      sort_order: 2,
      skill: 'team-pd',
      skill_created: false,
      description: '需求讨论、竞品调研、画原型、写PRD、定义验收标准',
    },
    {
      id: 'arch',
      name: '老陈',
      title: '架构师 ARCH',
      icon: 'server',
      color: '#2196F3',
      sort_order: 3,
      skill: 'team-arch',
      skill_created: false,
      description: '技术选型、架构设计、接口定义、影响评估、开源调研',
    },
    {
      id: 'dev',
      name: '阿杰',
      title: '开发工程师 DEV',
      icon: 'code',
      color: '#9C27B0',
      sort_order: 4,
      skill: 'team-dev',
      skill_created: false,
      description: '根据技术方案编码实现，遵循项目规范',
    },
    {
      id: 'qa',
      name: '小林',
      title: '测试工程师 QA',
      icon: 'beaker',
      color: '#00BCD4',
      sort_order: 5,
      skill: 'team-qa',
      skill_created: false,
      description: '编写测试用例、执行测试、生成测试报告',
    },
    {
      id: 'cr',
      name: '老吴',
      title: '代码审查 CR',
      icon: 'eye',
      color: '#795548',
      sort_order: 6,
      skill: 'team-cr',
      skill_created: false,
      description: '审查代码质量、安全性、规范一致性、可维护性',
    },
  ],
  shared_context: {
    paths: ['.team/tasks/', '.team/shared/', '.team/iterations/'],
    protocol: '.claude/skills/team-pm/references/protocol.md',
  },
};
