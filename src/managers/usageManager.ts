import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

interface DailyEntry {
  date: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  modelsUsed: string[];
}

interface TimeStats {
  todayHours: number;
  todayMinutes: number;
  activeDays: number;
  firstActiveDate: string;
  totalDays: number;
}

export interface FullUsage {
  sessionCost: number;
  todayCost: number;
  weekCost: number;
  totalCost: number;
  todayTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  weekTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  totalTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  time: TimeStats;
  rateLimits: {
    fiveHour: { pct: number; resetIn: string } | null;
    sevenDay: { pct: number; resetIn: string } | null;
  };
}

export function formatTokens(n: number): string {
  if (n >= 1e6) { return `${(n / 1e6).toFixed(1)}M`; }
  if (n >= 1e3) { return `${(n / 1e3).toFixed(1)}K`; }
  return `${n}`;
}

export class UsageManager {
  private projectDir: string | null;
  private bunxPath: string;

  constructor(workspaceRoot: string) {
    const projectKey = workspaceRoot.replace(/\//g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', projectKey);
    this.projectDir = fs.existsSync(dir) ? dir : null;

    // 查找 bunx 路径
    this.bunxPath = fs.existsSync('/opt/homebrew/bin/bunx')
      ? '/opt/homebrew/bin/bunx'
      : 'bunx';
  }

  getUsage(): FullUsage | null {
    // 1. 从 ccusage 获取每日费用数据（最准确）
    const dailyData = this.getCcusageDaily();

    const now = new Date();
    const todayDate = now.toISOString().slice(0, 10);
    const weekAgoDate = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);

    const todayEntries = dailyData.filter(d => d.date === todayDate);
    const weekEntries = dailyData.filter(d => d.date >= weekAgoDate);

    const sumEntries = (entries: DailyEntry[]) => ({
      cost: entries.reduce((s, d) => s + d.totalCost, 0),
      input: entries.reduce((s, d) => s + d.inputTokens, 0),
      output: entries.reduce((s, d) => s + d.outputTokens, 0),
      cacheRead: entries.reduce((s, d) => s + d.cacheReadTokens, 0),
      cacheWrite: entries.reduce((s, d) => s + d.cacheCreationTokens, 0),
      total: entries.reduce((s, d) => s + d.totalTokens, 0),
    });

    const todaySum = sumEntries(todayEntries);
    const weekSum = sumEntries(weekEntries);
    const totalSum = sumEntries(dailyData);

    // 2. 时间统计
    const time = this.calcTimeStats(dailyData, todayDate);

    // 3. 从 ~/.claude/rate-limits.json 读取配额数据（由 statusline 脚本写入）
    const rateLimits = this.readRateLimits();

    return {
      sessionCost: 0,
      todayCost: todaySum.cost,
      weekCost: weekSum.cost,
      totalCost: totalSum.cost,
      todayTokens: { input: todaySum.input, output: todaySum.output, cacheRead: todaySum.cacheRead, cacheWrite: todaySum.cacheWrite, total: todaySum.total },
      weekTokens: { input: weekSum.input, output: weekSum.output, cacheRead: weekSum.cacheRead, cacheWrite: weekSum.cacheWrite, total: weekSum.total },
      totalTokens: { input: totalSum.input, output: totalSum.output, cacheRead: totalSum.cacheRead, cacheWrite: totalSum.cacheWrite, total: totalSum.total },
      time,
      rateLimits,
    };
  }

  /**
   * 从 ~/.claude/rate-limits.json 读取配额数据
   * 该文件由 statusline 脚本在每次 Claude Code 交互时写入
   */
  private readRateLimits(): FullUsage['rateLimits'] {
    const filePath = path.join(os.homedir(), '.claude', 'rate-limits.json');
    try {
      if (!fs.existsSync(filePath)) {
        return { fiveHour: null, sevenDay: null };
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      const updatedAt = data.updated_at || 0;

      // 数据超过 1 小时视为过期
      if (Date.now() - updatedAt > 3600000) {
        return { fiveHour: null, sevenDay: null };
      }

      const rl = data.rate_limits || {};

      const formatReset = (resetTs: number | undefined): string => {
        if (!resetTs) { return ''; }
        const diffMs = Math.max(0, resetTs * 1000 - Date.now());
        const min = Math.round(diffMs / 60000);
        if (min < 60) { return `${min}m`; }
        const h = Math.floor(min / 60);
        const m = min % 60;
        return `${h}h${m}m`;
      };

      return {
        fiveHour: rl.five_hour ? {
          pct: Math.round(rl.five_hour.used_percentage || 0),
          resetIn: formatReset(rl.five_hour.resets_at),
        } : null,
        sevenDay: rl.seven_day ? {
          pct: Math.round(rl.seven_day.used_percentage || 0),
          resetIn: formatReset(rl.seven_day.resets_at),
        } : null,
      };
    } catch {
      return { fiveHour: null, sevenDay: null };
    }
  }

  /**
   * 调用 ccusage daily --json 获取每日使用量
   */
  private getCcusageDaily(): DailyEntry[] {
    try {
      const output = execSync(`${this.bunxPath} --bun ccusage daily --json`, {
        timeout: 10000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(output);
      return data.daily || [];
    } catch {
      // ccusage 不可用，回退到手动解析 JSONL
      return this.parseDailyFromJsonl();
    }
  }

  /**
   * 回退方案：从 JSONL 文件手动解析（ccusage 不可用时）
   */
  private parseDailyFromJsonl(): DailyEntry[] {
    if (!this.projectDir) { return []; }

    const dailyMap = new Map<string, DailyEntry>();

    let files: string[];
    try {
      files = fs.readdirSync(this.projectDir).filter(f => f.endsWith('.jsonl'));
    } catch { return []; }

    // Opus 4.6 pricing
    const pricing: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
      'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    };
    const defaultPricing = pricing['claude-opus-4-6'];

    for (const file of files) {
      const filePath = path.join(this.projectDir!, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) { continue; }
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'assistant') { continue; }
            const usage = entry.message?.usage;
            if (!usage) { continue; }
            const ts = entry.timestamp || '';
            const date = ts.slice(0, 10);
            if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) { continue; }

            const model = entry.message?.model || 'claude-opus-4-6';
            const p = pricing[model] || defaultPricing;

            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            const cr = usage.cache_read_input_tokens || 0;
            const cw = usage.cache_creation_input_tokens || 0;

            const cost = (inp * p.input + out * p.output + cr * p.cacheRead + cw * p.cacheWrite) / 1e6;

            if (!dailyMap.has(date)) {
              dailyMap.set(date, {
                date,
                totalCost: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                totalTokens: 0,
                modelsUsed: [],
              });
            }
            const d = dailyMap.get(date)!;
            d.totalCost += cost;
            d.inputTokens += inp;
            d.outputTokens += out;
            d.cacheCreationTokens += cw;
            d.cacheReadTokens += cr;
            d.totalTokens += inp + out + cr + cw;
            if (!d.modelsUsed.includes(model)) { d.modelsUsed.push(model); }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 计算时间统计
   */
  private calcTimeStats(dailyData: DailyEntry[], todayDate: string): TimeStats {
    const activeDates = dailyData.map(d => d.date).sort();
    const firstDate = activeDates[0] || todayDate;
    const now = new Date();
    const totalDays = Math.floor((now.getTime() - new Date(firstDate).getTime()) / 86400000) + 1;

    // 今天使用时长：从 JSONL 文件的时间戳计算
    let todayDurationMs = 0;
    if (this.projectDir) {
      try {
        const files = fs.readdirSync(this.projectDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(this.projectDir!, file);
          let firstTs = 0;
          let lastTs = 0;
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            for (const line of content.split('\n')) {
              if (!line.trim()) { continue; }
              try {
                const entry = JSON.parse(line);
                const ts = entry.timestamp || '';
                if (!ts.startsWith(todayDate)) { continue; }
                const t = new Date(ts).getTime();
                if (!firstTs || t < firstTs) { firstTs = t; }
                if (t > lastTs) { lastTs = t; }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
          if (firstTs && lastTs > firstTs) {
            todayDurationMs += (lastTs - firstTs);
          }
        }
      } catch { /* skip */ }
    }

    const totalMinutes = Math.floor(todayDurationMs / 60000);
    return {
      todayHours: Math.floor(totalMinutes / 60),
      todayMinutes: totalMinutes % 60,
      activeDays: activeDates.length,
      firstActiveDate: firstDate,
      totalDays,
    };
  }
}
