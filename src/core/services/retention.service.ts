import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Paths } from '../paths.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';
import type { TaskRepo } from '../repositories/task.repo.ts';
import type { Db } from '../db/index.ts';

export interface RetentionDeps {
  paths: Paths;
  tasks: TaskRepo;
  audit: AuditRepo;
  db: Db;
}

export interface RetentionReport {
  screenshots: number;
  screenshotBytes: number;
  tasks: number;
  automationRuns: number;
  auditLogs: number;
  ranAt: number;
}

/**
 * 数据生命周期。
 *
 * 判断标准只有一句：**删了之后用户会不会损失他花时间换来的东西。**
 *   - 截图 / 任务历史 / 审计 —— 过程记录，可以过期（证据）
 *   - dataset_rows —— 用户采到的业务数据，永不自动删（资产）
 *   - profiles/* —— 登录态在里面，只能随环境删除，不参与 TTL
 *
 * 静默删除是不可接受的：每次清理都写一条审计汇总，用户要能看见"删了什么、释放多少"。
 */
export class RetentionService {
  private readonly screenshotDays: number;
  private readonly taskDays: number;
  private readonly automationRunDays: number;

  constructor(private readonly deps: RetentionDeps) {
    this.screenshotDays = daysFromEnv('FOXBOX_RETENTION_SCREENSHOT_DAYS', 30);
    this.taskDays = daysFromEnv('FOXBOX_RETENTION_TASK_DAYS', 90);
    this.automationRunDays = daysFromEnv('FOXBOX_RETENTION_AUTOMATION_DAYS', 180);
  }

  run(now = Date.now()): RetentionReport {
    const report: RetentionReport = {
      screenshots: 0,
      screenshotBytes: 0,
      tasks: 0,
      automationRuns: 0,
      auditLogs: 0,
      ranAt: now,
    };

    // 1. 截图目录：按目录 mtime 判，不依赖任务是否还在（任务可能已被手动删掉）
    const dir = path.join(this.deps.paths.home, 'screenshots');
    const screenshotCutoff = now - this.screenshotDays * 86_400_000;
    for (const entry of safeReaddir(dir)) {
      const full = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!entry.isDirectory() || stat.mtimeMs >= screenshotCutoff) continue;
      const bytes = dirBytes(full);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        report.screenshots += 1;
        report.screenshotBytes += bytes;
      } catch {
        /* 权限或正在被写：下次再说 */
      }
    }

    // 2. 任务历史：只删终态。queued/running 的记录还在被引用
    const purged = this.deps.tasks.purgeBefore(now - this.taskDays * 86_400_000, now);
    report.tasks = purged.length;

    // 3. 自动化触发历史
    const runs = this.deps.db
      .prepare('DELETE FROM automation_runs WHERE started_at < ?')
      .run(now - this.automationRunDays * 86_400_000);
    report.automationRuns = runs.changes;

    // 4. 审计日志：保留 30 天就够查"上周谁动过这个环境"
    const logs = this.deps.db
      .prepare('DELETE FROM audit_logs WHERE created_at < ?')
      .run(now - 30 * 86_400_000);
    report.auditLogs = logs.changes;

    const touched =
      report.screenshots + report.tasks + report.automationRuns + report.auditLogs > 0;
    if (touched) {
      this.deps.audit.log('retention.cleanup', null, {
        screenshots: report.screenshots,
        freedBytes: report.screenshotBytes,
        tasks: report.tasks,
        automationRuns: report.automationRuns,
        auditLogs: report.auditLogs,
      });
    }
    return report;
  }

  /**
   * 占用面板。
   *
   * profiles 这一项通常才是最大的：一个 Camoufox user-data 40–80MB，
   * 50 个环境就是 3GB，而用户对此完全没概念——不显示就永远不会有人管。
   */
  storage(): { screenshots: number; profiles: number; database: number; datasets: number; total: number } {
    const screenshots = dirBytes(path.join(this.deps.paths.home, 'screenshots'));
    const profiles = dirBytes(this.deps.paths.profilesDir);

    let database = 0;
    for (const name of ['foxbox.db', 'foxbox.db-wal', 'foxbox.db-shm']) {
      try {
        database += fs.statSync(path.join(this.deps.paths.home, name)).size;
      } catch {
        /* 不存在就是 0 */
      }
    }

    const datasets = Number(
      this.deps.db
        .prepare('SELECT COALESCE(SUM(LENGTH(data_json)), 0) AS n FROM dataset_rows')
        .get()?.n ?? 0,
    );

    return {
      screenshots,
      profiles,
      database,
      datasets,
      total: screenshots + profiles + database + datasets,
    };
  }
}

function daysFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (current: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 文件在遍历期间被删 */
        }
      }
    }
  };
  walk(dir, 0);
  return total;
}
