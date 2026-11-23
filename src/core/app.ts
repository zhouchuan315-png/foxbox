import { openDatabase } from './db/index.ts';
import { createSecretBox } from './crypto/secret-box.ts';
import { resolvePaths, type Paths } from './paths.ts';
import { ProfileRepo } from './repositories/profile.repo.ts';
import { GroupRepo } from './repositories/group.repo.ts';
import { ProxyRepo } from './repositories/proxy.repo.ts';
import { LaunchRepo } from './repositories/launch.repo.ts';
import { AuditRepo } from './repositories/audit.repo.ts';
import { TaskRepo } from './repositories/task.repo.ts';
import { AutomationRepo } from './repositories/automation.repo.ts';
import { DatasetRepo } from './repositories/dataset.repo.ts';
import { SessionRepo } from './repositories/session.repo.ts';
import { NotifyRepo } from './repositories/notify.repo.ts';
import { EngineManager } from './engines/manager.ts';
import { CamoufoxAdapter } from './engines/camoufox.adapter.ts';
import { ProfileService } from './services/profile.service.ts';
import { ProxyService } from './services/proxy.service.ts';
import { GroupService } from './services/group.service.ts';
import { TaskService } from './services/task.service.ts';
import { AutomationService } from './services/automation.service.ts';
import { DatasetService } from './services/dataset.service.ts';
import { SessionService } from './services/session.service.ts';
import { NotifyService } from './services/notify.service.ts';
import { RetentionService } from './services/retention.service.ts';
import type { Db } from './db/index.ts';

export interface AppContext {
  paths: Paths;
  db: Db;
  manager: EngineManager;
  services: {
    profiles: ProfileService;
    proxies: ProxyService;
    groups: GroupService;
    tasks: TaskService;
    automations: AutomationService;
    datasets: DatasetService;
    sessions: SessionService;
    notify: NotifyService;
    retention: RetentionService;
  };
  repos: {
    profiles: ProfileRepo;
    groups: GroupRepo;
    proxies: ProxyRepo;
    launches: LaunchRepo;
    audit: AuditRepo;
    tasks: TaskRepo;
    automations: AutomationRepo;
    datasets: DatasetRepo;
    sessions: SessionRepo;
    notifiers: NotifyRepo;
  };
}

/**
 * 组装根。显式依赖注入，不用全局单例——
 * 这样测试可以给每个用例开一份独立的 FOXBOX_HOME。
 */
export function createApp(homeOverride?: string): AppContext {
  const paths = resolvePaths(homeOverride);
  const db = openDatabase(paths.dbFile);
  const secrets = createSecretBox(paths.keyFile);

  const profiles = new ProfileRepo(db);
  const groups = new GroupRepo(db);
  const proxies = new ProxyRepo(db, secrets);
  const launches = new LaunchRepo(db);
  const audit = new AuditRepo(db);
  const tasks = new TaskRepo(db);
  const automations = new AutomationRepo(db);
  const datasets = new DatasetRepo(db);
  const sessions = new SessionRepo(db);
  const notifiers = new NotifyRepo(db);

  // 启动超时可通过环境变量收紧：低配机器上正常启动就要 30s+，
  // 但挂起时没必要等满 90s 才报错（诊断和重试策略都依赖这个旋钮）
  const num = (name: string): number | undefined => {
    const raw = process.env[name];
    // 注意不能用 Number(x) || undefined：空字符串会变成 0，
    // 而 0 在重试次数里是"不重试"这个合法取值
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const manager = new EngineManager({
    maxConcurrent: 4,
    launchTimeoutMs: num('FOXBOX_LAUNCH_TIMEOUT_MS'),
    launchRetries: num('FOXBOX_LAUNCH_RETRIES'),
    // 重试要留痕：静默重试会让"启动为什么慢了 90 秒"变成一桩悬案
    onRetry: (profileId, attempt, error) => {
      audit.log('profile.launch_retry', profileId, {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  manager.register(new CamoufoxAdapter());

  const proxyService = new ProxyService({ proxies, audit });
  const groupService = new GroupService({ groups, audit });
  const profileService = new ProfileService({
    paths,
    profiles,
    groups,
    proxies,
    launches,
    audit,
    manager,
    proxyService,
  });

  const datasetService = new DatasetService({ datasets, audit });
  const notifyService = new NotifyService({ notifiers, audit });
  const sessionService = new SessionService({
    sessions,
    profiles,
    profileService,
    manager,
    audit,
    notify: notifyService,
  });
  const retentionService = new RetentionService({ paths, tasks, audit, db });

  const taskService = new TaskService({
    paths,
    tasks,
    audit,
    profiles,
    profileService,
    manager,
    datasets: datasetService,
    notify: notifyService,
  });

  const automationService = new AutomationService({
    automations,
    tasks,
    audit,
    profiles,
    proxies,
    profileService,
    proxyService,
    taskService,
    manager,
    notify: notifyService,
  });

  return {
    paths,
    db,
    manager,
    repos: { profiles, groups, proxies, launches, audit, tasks, automations, datasets, sessions, notifiers },
    services: {
      profiles: profileService,
      proxies: proxyService,
      groups: groupService,
      tasks: taskService,
      automations: automationService,
      datasets: datasetService,
      sessions: sessionService,
      notify: notifyService,
      retention: retentionService,
    },
  };
}
