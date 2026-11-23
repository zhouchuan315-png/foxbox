import { createApp } from './core/app.ts';
import { hostOsFamily } from './core/paths.ts';
import { warmUpForProfiles } from './core/engines/warmup.ts';
import { startServer } from './api/server.ts';

/**
 * 服务入口。
 *
 * 顺序讲究：先听端口，再预热引擎。
 * 预热要 30 秒，如果放在 listen 之前，前端连"服务是否起来"都判断不了。
 */
async function main(): Promise<void> {
  const app = createApp(process.env.FOXBOX_HOME);

  const recovered = app.services.profiles.reconcile();
  if (recovered.length > 0) {
    console.log(`[恢复] 清理了 ${recovered.length} 条未正常关闭的会话`);
  }

  // 上一次进程里的任务已经不可能继续（句柄随进程消失），
  // 不标记的话界面上会永远挂着一条"执行中"
  const staleTasks = app.repos.tasks.failOrphans('进程重启，任务已中断');
  if (staleTasks > 0) {
    console.log(`[恢复] ${staleTasks} 条未完成任务已标记为中断`);
  }

  const staleRuns = app.services.automations.reconcile();
  if (staleRuns > 0) {
    console.log(`[恢复] ${staleRuns} 条自动化触发记录已收尾`);
  }

  const { token, port } = await startServer(app, {
    port: Number(process.env.FOXBOX_PORT ?? 7331),
    // 固定 token 便于脚本调用；不设则每次随机，安全性更高
    token: process.env.FOXBOX_TOKEN,
    logger: process.env.FOXBOX_LOG === '1',
  });

  console.log(`FoxBox 本地服务已启动`);
  console.log(`  地址   http://127.0.0.1:${port}`);
  console.log(`  Token  ${token}`);
  console.log(`  数据   ${app.paths.home}`);

  // 调度器在 listen 之后才起：先让界面能打开，再让规则开始跑。
  // 这个顺序也保证了"服务没起来时规则不会在真空中触发"。
  const tickMs = Number(process.env.FOXBOX_TICK_MS ?? 20_000);
  app.services.automations.start(Number.isFinite(tickMs) ? tickMs : 20_000);
  const automations = app.services.automations.list();
  if (automations.length > 0) {
    const enabled = automations.filter((a) => a.enabled).length;
    console.log(`[调度] ${enabled} 条规则启用（心跳 ${Math.round(tickMs / 1000)}s）`);
  }

  // 生命周期清理：启动先跑一次（可能几天没开），之后每天一次。
  // 只清过程记录（截图/任务历史/审计），数据集永远不动——那是用户的业务数据。
  const runRetention = (): void => {
    try {
      const report = app.services.retention.run();
      if (report.screenshots + report.tasks + report.automationRuns + report.auditLogs > 0) {
        console.log(
          `[清理] 截图 ${report.screenshots} 个目录（${Math.round(report.screenshotBytes / 1048576)}MB）、` +
            `任务 ${report.tasks} 条、触发记录 ${report.automationRuns} 条、审计 ${report.auditLogs} 条`,
        );
      }
    } catch (error) {
      // 清理失败不该影响服务：下次还会跑
      console.log(`[清理] 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  runRetention();
  const retentionTimer = setInterval(runRetention, 24 * 3600_000);
  retentionTimer.unref?.();

  // 预热在后台跑，不阻塞服务可用性。  // 按库里实际存在的身份 OS 逐个预热——只热宿主 OS 的话，
  // 那些异系统身份的环境第一次点开仍要现场生成，用户看到的是"启动要几十秒"。
  const osList = app.repos.profiles.osFamilies();
  const warmTargets = osList.length > 0 ? osList : [hostOsFamily()];
  void warmUpForProfiles(warmTargets as ReturnType<typeof hostOsFamily>[]).then((results) => {
    for (const r of results) {
      console.log(
        r.ok
          ? `[预热] ${r.os} 就绪，耗时 ${r.elapsedMs}ms`
          : `[预热] ${r.os} 失败：${r.error}（该身份的首次启动会明显变慢）`,
      );
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] 正在关闭所有环境...`);
    // 先停调度：否则心跳可能在关闭过程中又拉起一条新任务
    app.services.automations.stop();
    // 再让任务停下：否则它可能在浏览器被关掉之后继续往里发指令
    await app.services.tasks.shutdown();
    // service.shutdown 内部会走 manager.shutdown，级联关闭所有浏览器进程
    await app.services.profiles.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // 父进程看护：只在桌面壳里生效（壳会传 FOXBOX_PARENT_PID）。
  //
  // 壳被 killall / 崩溃时不会走 RunEvent::Exit，stop_child() 也就不会执行，
  // 后端会变成孤儿：端口一直占着、环境还挂在内存里、"关窗即退出"名不副实。
  // `kill(pid, 0)` 只探测存活不发信号；父进程没了就自己走同一条优雅关闭路径。
  const parentPid = Number(process.env.FOXBOX_PARENT_PID ?? '');
  if (Number.isFinite(parentPid) && parentPid > 0) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(timer);
        console.log(`\n[壳已退出] 父进程 ${parentPid} 不在了，后端自行收尾`);
        void shutdown('parent-gone');
      }
    }, 5_000);
    timer.unref?.();
  }
}

main().catch((error) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
