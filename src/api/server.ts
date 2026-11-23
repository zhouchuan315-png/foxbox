import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../core/app.ts';
import { ProfileValidationError } from '../core/services/profile.service.ts';
import { ProxyUnhealthyError } from '../core/services/proxy.service.ts';
import { AppError } from '../core/errors.ts';
import { renderIndex, resolveUiAsset } from './static.ts';
import { csvHeader, csvLine, datasetToJsonlLine } from '../core/services/dataset.service.ts';
import { warmupState } from '../core/engines/warmup.ts';

export interface ServerOptions {
  port?: number;
  /** 不传则每次启动随机生成，并打印到 stdout */
  token?: string;
  logger?: boolean;
}

const proxyProtocol = z.enum(['http', 'https', 'socks5']);

const createProxyBody = z.object({
  name: z.string().min(1).max(64),
  protocol: proxyProtocol.default('http'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  country: z.string().length(2).optional(),
  /** 建完立即预检，省一次手动点击；代价是请求会多等 1–3 秒 */
  check: z.boolean().optional(),
});

const updateProxyBody = z.object({
  name: z.string().min(1).max(64).optional(),
  protocol: proxyProtocol.optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  country: z.string().length(2).nullable().optional(),
});

const createProfileBody = z.object({
  name: z.string().min(1).max(64),
  country: z.string().length(2).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  locale: z.string().optional(),
  proxyId: z.string().optional().nullable(),
  groupId: z.string().optional().nullable(),
  startupUrl: z.string().url().optional().nullable(),
  headless: z.boolean().optional(),
  note: z.string().max(500).optional().nullable(),
  /** 1 / 1.25 / 1.5 / 1.75 / 2 / 2.5 / 3；不传取宿主实测值 */
  dpr: z.number().optional(),
  /** true 强制覆盖 canvas 读数，false 强制不覆盖，不传交给引擎判断 */
  canvasNoise: z.boolean().nullable().optional(),
});

const updateProfileBody = z.object({
  name: z.string().min(1).max(64).optional(),
  note: z.string().max(500).nullable().optional(),
  groupId: z.string().nullable().optional(),
  startupUrl: z.string().url().nullable().optional(),
  headless: z.boolean().optional(),
});

const listProfileQuery = z.object({
  groupId: z.string().optional(),
  ungrouped: z.coerce.boolean().optional(),
  status: z.enum(['idle', 'starting', 'running', 'error']).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createGroupBody = z.object({
  name: z.string().min(1).max(32),
  sortOrder: z.number().int().optional(),
});

const updateGroupBody = z.object({
  name: z.string().min(1).max(32).optional(),
  sortOrder: z.number().int().optional(),
});

const batchProfileBody = z
  .object({
    action: z.enum(['start', 'stop', 'delete', 'move']),
    ids: z.array(z.string().min(1)).min(1).max(200),
    groupId: z.string().nullable().optional(),
  })
  .refine((v) => v.action !== 'move' || v.groupId !== undefined, {
    message: 'move 动作必须传 groupId（可以是 null 表示移出分组）',
    path: ['groupId'],
  });

/**
 * 本地 API。
 *
 * 只 bind 127.0.0.1：这类工具的 API 一旦暴露到 0.0.0.0，
 * 等于把"任意网站可读写你的账号环境"变成了默认配置。
 * 即使在本机，也要 Bearer token——防止恶意网页通过 DNS rebinding 打进来。
 */
export async function startServer(
  app: AppContext,
  opts: ServerOptions = {},
): Promise<{ fastify: FastifyInstance; token: string; port: number }> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const port = opts.port ?? Number(process.env.FOXBOX_PORT ?? 7331);
  const fastify = Fastify({ logger: opts.logger ?? false });

  /**
   * Host 白名单是这里最要紧的一道门。
   *
   * API 只 bind 127.0.0.1 挡不住 DNS rebinding：恶意页面把 evil.com 解析到
   * 127.0.0.1，浏览器就认为它是同源的，Bearer 之外的 cookie / 页面内容都能读。
   * 但 rebinding 拿不到正确的 Host 头，所以按 Host 拒绝即可。
   */
  // 端口可能是 0（由系统分配），所以监听成功后再回填真实端口
  let boundPort = port;
  const isUiAsset = (url: string): boolean => url === '/' || url.startsWith('/ui/');

  fastify.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').toLowerCase();
    const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
    if (!allowedHosts.has(host)) {
      return reply.code(403).send({ error: 'FORBIDDEN_HOST', message: `不允许的 Host: ${host}` });
    }
    if (request.url === '/health') return;
    // 界面本身不含数据；它的访问控制交给 Host 白名单，页面内的 token 只在同源可用
    if (isUiAsset(request.url)) return;

    // 截图是<img>/<a> 直接访问的，没法带 Authorization 头，
    // 所以改从查询参数取 token——仍然要求凭证，只是换了个位置。
    if (request.url.startsWith('/files/')) {
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      if (query.get('t') !== token) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '缺少或错误的 token' });
      }
      return;
    }

    const auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '缺少或错误的 Bearer token' });
    }
  });

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProfileValidationError) {
      return reply.code(422).send({ error: 'FINGERPRINT_CONFLICT', issues: error.issues, message: error.message });
    }
    if (error instanceof ProxyUnhealthyError) {
      return reply.code(502).send({
        error: 'PROXY_UNHEALTHY',
        message: error.message,
        check: error.result,
      });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '请求参数不合法', issues: error.issues });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
      message: err.message ?? String(error),
    });
  });

  fastify.get('/health', async () => ({
    ok: true,
    home: app.paths.home,
    running: app.manager.listRunning().length,
    profiles: app.repos.profiles.countAll(),
  }));

  // ---------- 界面 ----------

  fastify.get('/', async (_request, reply) => {
    reply.header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    return reply.type('text/html; charset=utf-8').send(renderIndex(token, boundPort));
  });

  fastify.get<{ Params: { '*': string } }>('/ui/*', async (request, reply) => {
    const name = request.params['*'].split('?')[0] ?? '';
    const asset = resolveUiAsset(name);
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在' });
    reply.header('cache-control', 'no-store');
    return reply.type(asset.mime).send(fs.readFileSync(asset.file));
  });

  // ---------- 任务 ----------

  // 步骤用 discriminatedUnion：每种的必填字段不同，
  // 用一个大对象 + 可选字段会让"goto 忘了写 url"这类错误拖到执行时才暴露
  const taskStepBody = z.discriminatedUnion('type', [
    z.object({ type: z.literal('start') }),
    z.object({
      type: z.literal('goto'),
      url: z.string().min(1),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
      timeoutMs: z.number().int().positive().max(180_000).optional(),
    }),
    z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(120_000) }),
    z.object({
      type: z.literal('eval'),
      script: z.string().min(1),
      saveAs: z.string().regex(/^[\w-]+$/, 'saveAs 只能是字母数字下划线和短横线').optional(),
      timeoutMs: z.number().int().positive().max(180_000).optional(),
    }),
    z.object({
      type: z.literal('collect'),
      script: z.string().min(1),
      dataset: z.string().min(1).max(48),
      dedupeBy: z.array(z.string().min(1)).max(20).optional(),
      mode: z.enum(['upsert', 'append']).optional(),
      expectMinRows: z.number().int().min(0).max(2000).optional(),
      timeoutMs: z.number().int().positive().max(180_000).optional(),
    }),
    z.object({ type: z.literal('screenshot'), fullPage: z.boolean().optional() }),
    z.object({ type: z.literal('stop') }),
  ]);

  const createTaskBody = z.object({
    name: z.string().min(1).max(64),
    target: z.object({
      profileIds: z.array(z.string()).default([]),
      groupId: z.string().nullable().optional(),
    }),
    steps: z.array(taskStepBody).min(1).max(20),
    concurrency: z.number().int().min(1).max(3).optional(),
    /** 整条任务的总时限；不填默认 10 分钟 */
    timeoutMs: z.number().int().min(5_000).max(3_600_000).optional(),
    /** 只对瞬时错误重试（导航超时、代理断连），脚本报错不重试 */
    retries: z.number().int().min(0).max(3).optional(),
    /** 建完立即执行，省一次请求 */
    runNow: z.boolean().optional(),
  });

  /**
   * 任务截图。
   *
   * 只暴露 FOXBOX_HOME/screenshots 下的文件。screenshots 是任务唯一会写盘的地方，
   * 把根目录钉死在这里，即使路径里出现 .. 也走不出这个范围。
   */
  fastify.get<{ Params: { '*': string } }>('/files/*', async (request, reply) => {
    const rel = decodeURIComponent(request.params['*'] ?? '').replace(/^\/+/, '');
    const root = path.resolve(app.paths.home, 'screenshots');
    // 路径按 FOXBOX_HOME 解析（库里存的截图路径就是以 home 为基准的
    // screenshots/<task>/<file>.png），再把结果钉死在 screenshots 之下
    const target = path.resolve(app.paths.home, rel);
    if (!target.startsWith(root + path.sep)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '只能读取截图目录' });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '文件不存在' });
    }
    reply.header('cache-control', 'no-store');
    reply.header('content-disposition', `inline; filename="${path.basename(target)}"`);
    return reply.type('image/png').send(fs.readFileSync(target));
  });

  // ---------- 系统信息 ----------

  fastify.get('/api/system', async () => {
    const running = app.manager.listRunning();
    const profiles = app.repos.profiles.countAll();
    const engines = app.manager.describe();
    return {
      version: '0.1.0',
      home: app.paths.home,
      port,
      profiles,
      groups: app.services.groups.list().length,
      proxies: app.services.proxies.list().length,
      running: running.length,
      engines,
      tasks: app.repos.tasks.list(200).length,
      automations: app.services.automations.list().length,
      datasets: app.repos.datasets.list(200).length,
      automationsEnabled: app.services.automations.state(),
      warmup: warmupState(),
    };
  });

  fastify.get('/api/tasks', async () => app.services.tasks.list());

  fastify.post('/api/tasks', async (request, reply) => {
    const body = createTaskBody.parse(request.body);
    const task = app.services.tasks.create({
      name: body.name,
      target: body.target,
      steps: body.steps as Parameters<typeof app.services.tasks.create>[0]['steps'],
      concurrency: body.concurrency,
      timeoutMs: body.timeoutMs,
      retries: body.retries,
    });
    if (!body.runNow) return reply.code(201).send(task);
    // 先建后跑：任务本身是可重放的记录，执行只是它的一次运行
    app.services.tasks.launch(task.id);
    return reply.code(202).send(app.services.tasks.get(task.id));
  });

  fastify.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) =>
    app.services.tasks.get(request.params.id),
  );

  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/run', async (request, reply) => {
    const task = app.services.tasks.launch(request.params.id);
    return reply.code(202).send(task);
  });

  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request) =>
    app.services.tasks.cancel(request.params.id),
  );

  fastify.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    app.services.tasks.remove(request.params.id);
    return reply.code(204).send();
  });

  // ---------- 自动化 ----------

  // 动作与规则都用 discriminatedUnion：`switch_proxy` 少了 standbyProxyId 这类错误
  // 在录入时就该被挡住，而不是等代理真挂掉那天才发现规则是残的
  const automationActionBody = z.discriminatedUnion('type', [
    z.object({ type: z.literal('run_task'), taskId: z.string().min(1) }),
    z.object({
      type: z.literal('switch_proxy'),
      standbyProxyId: z.string().min(1),
      sameCountryOnly: z.boolean().optional(),
    }),
    z.object({ type: z.literal('stop_profiles') }),
    z.object({ type: z.literal('notify_only') }),
  ]);

  const automationSpecBody = z.union([
    z.object({ expr: z.string().min(1).max(120) }),
    z.object({
      intervalMinutes: z.number().int().min(1).max(1440),
      failThreshold: z.number().int().min(1).max(10).optional(),
      proxyIds: z.array(z.string()).max(200).optional(),
    }),
  ]);

  const createAutomationBody = z.object({
    name: z.string().min(1).max(64),
    kind: z.enum(['cron', 'proxy_watch']),
    spec: automationSpecBody,
    actions: z.array(automationActionBody).min(1).max(3),
    enabled: z.boolean().optional(),
  });

  const updateAutomationBody = z.object({
    name: z.string().min(1).max(64).optional(),
    spec: automationSpecBody.optional(),
    actions: z.array(automationActionBody).min(1).max(3).optional(),
    enabled: z.boolean().optional(),
  });

  fastify.get('/api/automations', async () => ({
    items: app.services.automations.list(),
    scheduler: app.services.automations.state(),
  }));

  /** 表达式试算：界面一边输入一边显示"接下来三次"，比让人对着 cron 猜有用 */
  fastify.get<{ Querystring: { expr?: string } }>('/api/automations/preview', async (request) => {
    const expr = String(request.query.expr ?? '').trim();
    if (!expr) return { expr: '', human: '', next: [] };
    return app.services.automations.preview(expr);
  });

  /** 手动催一次调度心跳：调试"到底有没有在调度"时不用等 20 秒 */
  fastify.post('/api/automations/tick', async () => {
    const outcomes = await app.services.automations.tick();
    return { outcomes, scheduler: app.services.automations.state() };
  });

  fastify.post('/api/automations', async (request, reply) => {
    const body = createAutomationBody.parse(request.body);
    const automation = app.services.automations.create({
      name: body.name,
      kind: body.kind,
      spec: body.spec as Parameters<typeof app.services.automations.create>[0]['spec'],
      actions: body.actions as Parameters<typeof app.services.automations.create>[0]['actions'],
      enabled: body.enabled,
    });
    return reply.code(201).send(automation);
  });

  fastify.get<{ Params: { id: string } }>('/api/automations/:id', async (request) =>
    app.services.automations.get(request.params.id),
  );

  fastify.patch<{ Params: { id: string } }>('/api/automations/:id', async (request) => {
    const body = updateAutomationBody.parse(request.body);
    return app.services.automations.update(request.params.id, {
      name: body.name,
      spec: body.spec as Parameters<typeof app.services.automations.update>[1]['spec'],
      actions: body.actions as Parameters<typeof app.services.automations.update>[1]['actions'],
      enabled: body.enabled,
    });
  });

  fastify.delete<{ Params: { id: string } }>('/api/automations/:id', async (request, reply) => {
    app.services.automations.remove(request.params.id);
    return reply.code(204).send();
  });

  fastify.post<{ Params: { id: string } }>('/api/automations/:id/run', async (request) =>
    app.services.automations.runNow(request.params.id),
  );

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/automations/:id/runs',
    async (request) => {
      const limit = Number(request.query.limit ?? 20);
      return app.services.automations.runs(request.params.id, Number.isFinite(limit) ? limit : 20);
    },
  );

  // ---------- 代理 ----------

  fastify.post('/api/proxies', async (request, reply) => {
    const body = createProxyBody.parse(request.body);
    const proxy = app.services.proxies.create({
      name: body.name,
      protocol: body.protocol,
      host: body.host,
      port: body.port,
      username: body.username ?? null,
      password: body.password ?? null,
      expectedCountry: body.country ?? null,
    });
    if (!body.check) return reply.code(201).send(proxy);

    // 首次预检失败不影响代理落库：用户往往要先建好再排查
    const check = await app.services.proxies.check(proxy.id);
    return reply.code(201).send({ ...app.services.proxies.get(proxy.id), check });
  });

  fastify.get('/api/proxies', async () => app.services.proxies.list());

  fastify.get<{ Params: { id: string } }>('/api/proxies/:id', async (request) =>
    app.services.proxies.get(request.params.id),
  );

  fastify.patch<{ Params: { id: string } }>('/api/proxies/:id', async (request) => {
    const body = updateProxyBody.parse(request.body);
    return app.services.proxies.update(request.params.id, {
      name: body.name,
      protocol: body.protocol,
      host: body.host,
      port: body.port,
      username: body.username,
      password: body.password,
      expectedCountry: body.country,
    });
  });

  fastify.delete<{ Params: { id: string } }>('/api/proxies/:id', async (request) => {
    app.services.proxies.remove(request.params.id);
    return { ok: true };
  });

  fastify.post<{ Params: { id: string } }>('/api/proxies/:id/check', async (request) =>
    app.services.proxies.check(request.params.id),
  );

  /** 批量预检：串行执行，避免同时开一堆连接把本地代理打满 */
  fastify.post('/api/proxies/check', async () => {
    const results = [];
    for (const proxy of app.services.proxies.list()) {
      results.push(await app.services.proxies.check(proxy.id));
    }
    return { checked: results.length, results };
  });

  // ---------- 分组 ----------

  fastify.get('/api/groups', async () => app.services.groups.list());

  fastify.post('/api/groups', async (request, reply) => {
    const body = createGroupBody.parse(request.body);
    return reply.code(201).send(app.services.groups.create(body.name, body.sortOrder));
  });

  fastify.patch<{ Params: { id: string } }>('/api/groups/:id', async (request) => {
    const body = updateGroupBody.parse(request.body);
    return app.services.groups.update(request.params.id, { name: body.name, sortOrder: body.sortOrder });
  });

  fastify.delete<{ Params: { id: string } }>('/api/groups/:id', async (request) => {
    app.services.groups.remove(request.params.id);
    return { ok: true };
  });

  // ---------- 环境 ----------

  fastify.post('/api/profiles', async (request, reply) => {
    const body = createProfileBody.parse(request.body);
    const profile = await app.services.profiles.create({
      name: body.name,
      country: body.country,
      os: body.os,
      locale: body.locale,
      proxyId: body.proxyId ?? null,
      groupId: body.groupId ?? null,
      startupUrl: body.startupUrl ?? null,
      headless: body.headless,
      note: body.note ?? null,
      dpr: body.dpr,
      canvasNoise: body.canvasNoise,
    });
    return reply.code(201).send(profile);
  });

  fastify.get('/api/profiles', async (request) => {
    const query = listProfileQuery.parse(request.query ?? {});
    return app.services.profiles.list(query);
  });

  fastify.get<{ Params: { id: string } }>('/api/profiles/:id', async (request) =>
    app.services.profiles.get(request.params.id),
  );

  fastify.patch<{ Params: { id: string } }>('/api/profiles/:id', async (request) => {
    const body = updateProfileBody.parse(request.body);
    return app.services.profiles.update(request.params.id, body);
  });

  fastify.post<{ Params: { id: string } }>('/api/profiles/:id/start', async (request) => {
    const result = await app.services.profiles.start(request.params.id);
    return {
      launchId: result.launchId,
      pid: result.pid,
      elapsedMs: result.elapsedMs,
      warnings: result.warnings,
    };
  });

  fastify.post<{ Params: { id: string } }>('/api/profiles/:id/stop', async (request) => {
    await app.services.profiles.stop(request.params.id);
    return { ok: true };
  });

  fastify.post<{ Params: { id: string } }>('/api/profiles/:id/selfcheck', async (request) => {
    return app.services.profiles.selfCheck(request.params.id);
  });

  /** 离线校验：不启动浏览器，只对库里固化的 preset 跑一致性规则 */
  fastify.get<{ Params: { id: string } }>('/api/profiles/:id/validate', async (request) =>
    app.services.profiles.validate(request.params.id),
  );

  // ---------- 外部自动化 ----------

  const runScriptBody = z.object({
    script: z.string().min(1).max(200_000),
    mode: z.enum(['page', 'playwright']).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    autoStart: z.boolean().optional(),
    screenshot: z.boolean().optional(),
  });

  /**
   * 外部脚本执行。
   *
   * 这是「外部驱动环境」的正式入口：对方不需要 Node、不需要知道 Juggler，
   * 把一段 async 函数体 POST 进来即可（形参 page / ctx）。脚本自己报错返回 422，
   * 接口/鉴权层面的错误仍走统一错误处理器。
   */
  fastify.post<{ Params: { id: string } }>('/api/profiles/:id/run-script', async (request, reply) => {
    const body = runScriptBody.parse(request.body ?? {});
    const outcome = await app.services.profiles.runScript(request.params.id, body);
    return reply.code(outcome.ok ? 200 : 422).send(outcome);
  });

  /**
   * 告诉外部「怎么连这个环境」。
   *
   * 这里没有 CDP 链接可给，而且不该假装有：Camoufox 是 Firefox（Juggler 协议），
   * 且环境是 persistent context，Camoufox 的 launchServer 明确不支持。
   * 与其返回一个 `cdp: null` 让人反复猜，不如把原因和可用的调用方式一起给出来。
   */
  fastify.get<{ Params: { id: string } }>('/api/profiles/:id/automation', async (request) => {
    const profile = app.services.profiles.get(request.params.id);
    const base = `http://127.0.0.1:${boundPort}`;
    const url = `${base}/api/profiles/${profile.id}/run-script`;
    const body = {
      mode: 'playwright',
      timeoutMs: 30_000,
      script: [
        "await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });",
        'return { title: await page.title(), url: page.url() };',
      ].join('\n'),
    };
    const bodyJson = JSON.stringify(body);
    return {
      profileId: profile.id,
      name: profile.name,
      engine: profile.engine,
      running: app.manager.isRunning(profile.id),
      transport: 'http-script',
      cdp: null,
      cdpReason:
        'Camoufox 基于 Firefox，走 Juggler 协议，没有 CDP 端点；且环境是 persistent context，' +
        'Playwright 的 launchServer 不支持把持久化上下文挂成 ws 端点。',
      exec: {
        url,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body,
      },
      modes: {
        page: '脚本作为页面上下文表达式执行（能读 DOM，不能导航/点击）',
        playwright: '脚本作为 async 函数体执行，形参 page（Playwright Page）与 ctx',
      },
      examples: {
        curl: `curl -s '${url}' -H 'authorization: Bearer ${token}' -H 'content-type: application/json' -d '${bodyJson}'`,
        python: [
          'import requests',
          `r = requests.post('${url}',`,
          `                  headers={'authorization': 'Bearer ${token}'},`,
          `                  json={'mode': 'playwright', 'script': ${JSON.stringify(body.script)}},`,
          '                  timeout=90)',
          'print(r.status_code, r.json())',
        ].join('\n'),
        node: [
          `const res = await fetch('${url}', {`,
          '  method: "POST",',
          `  headers: { authorization: "Bearer ${token}", "content-type": "application/json" },`,
          `  body: JSON.stringify(${bodyJson}),`,
          '});',
          'console.log(res.status, await res.json());',
        ].join('\n'),
      },
    };
  });

  fastify.post('/api/profiles/batch', async (request) => {
    const body = batchProfileBody.parse(request.body);
    return app.services.profiles.batch({
      action: body.action,
      ids: body.ids,
      groupId: body.groupId ?? null,
    });
  });

  fastify.delete<{ Params: { id: string } }>('/api/profiles/:id', async (request) => {
    app.services.profiles.remove(request.params.id);
    return { ok: true };
  });

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/profiles/:id/launches',
    async (request) => {
      const limit = Number(request.query.limit ?? 20);
      return app.repos.launches.forProfile(request.params.id, Number.isFinite(limit) ? limit : 20);
    },
  );

  // ---------- 会话巡检 ----------

  const probeRuleBody = z.discriminatedUnion('type', [
    z.object({ type: z.literal('selector'), selector: z.string().min(1), visible: z.boolean().optional() }),
    z.object({ type: z.literal('url'), mustNotMatch: z.string().min(1) }),
    z.object({ type: z.literal('script'), script: z.string().min(1) }),
  ]);

  const sessionRunBody = z.object({
    url: z.string().url(),
    rule: probeRuleBody,
    profileIds: z.array(z.string().min(1)).max(500).optional(),
    groupId: z.string().nullable().optional(),
    saveProbe: z.boolean().optional(),
    name: z.string().max(64).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  });

  fastify.get('/api/session/overview', async () => app.services.sessions.overview());

  fastify.get<{ Querystring: { limit?: string; profileId?: string } }>('/api/session/checks', async (request) => {
    const limit = Number(request.query.limit ?? 50) || 50;
    return app.services.sessions.recentChecks(limit, request.query.profileId || undefined);
  });

  /** 发起巡检：立即返回 job，进度靠轮询（50 个环境要跑几分钟，同步等必然超时） */
  fastify.post('/api/session/check', async (request, reply) => {
    const body = sessionRunBody.parse(request.body);
    const job = app.services.sessions.run({
      url: body.url,
      rule: body.rule,
      profileIds: body.profileIds,
      groupId: body.groupId ?? null,
      saveProbe: body.saveProbe,
      name: body.name,
      timeoutMs: body.timeoutMs,
    });
    return reply.code(202).send(job);
  });

  fastify.get<{ Params: { id: string } }>('/api/session/jobs/:id', async (request) =>
    app.services.sessions.getJob(request.params.id),
  );

  fastify.post<{ Params: { id: string } }>('/api/session/jobs/:id/cancel', async (request) =>
    app.services.sessions.cancelJob(request.params.id),
  );

  fastify.get<{ Params: { id: string } }>('/api/profiles/:id/session', async (request) => {
    const profile = app.services.profiles.get(request.params.id);
    return { status: profile.lastSessionStatus, checkedAt: profile.lastSessionCheckAt, history: app.services.sessions.history(profile.id) };
  });

  fastify.get('/api/probes', async () => app.services.sessions.listProbes());

  fastify.post('/api/probes', async (request, reply) => {
    const body = z
      .object({
        name: z.string().max(64).optional(),
        url: z.string().url(),
        rule: probeRuleBody,
        profileId: z.string().nullable().optional(),
        groupId: z.string().nullable().optional(),
        intervalHours: z.number().int().min(6).max(720).nullable().optional(),
      })
      .parse(request.body);
    const probe = app.services.sessions.createProbe(body);
    return reply.code(201).send(probe);
  });

  fastify.delete<{ Params: { id: string } }>('/api/probes/:id', async (request, reply) => {
    app.services.sessions.removeProbe(request.params.id);
    return reply.code(204).send();
  });

  // ---------- 通知与运维 ----------

  fastify.get('/api/notifiers', async () => ({
    items: app.services.notify.list(),
    logs: app.services.notify.recentLogs(30),
  }));

  fastify.post('/api/notifiers', async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(64),
        url: z.string().url(),
        secret: z.string().max(200).nullable().optional(),
        events: z.array(z.enum(['task.failed', 'session.expired', 'proxy.dead', 'automation.skipped'])).optional(),
      })
      .parse(request.body);
    return reply.code(201).send(app.services.notify.create(body));
  });

  fastify.delete<{ Params: { id: string } }>('/api/notifiers/:id', async (request, reply) => {
    app.services.notify.remove(request.params.id);
    return reply.code(204).send();
  });

  fastify.post<{ Params: { id: string } }>('/api/notifiers/:id/test', async (request) =>
    app.services.notify.test(request.params.id),
  );

  fastify.get('/api/system/storage', async () => app.services.retention.storage());

  /** 手动跑一次清理：调试保留策略时不用等到明天 */
  fastify.post('/api/retention/run', async () => app.services.retention.run());

  fastify.get('/api/audit', async () => app.repos.audit.recent(50));

  // ---------- 数据集 ----------

  fastify.get('/api/datasets', async () => app.services.datasets.list());

  fastify.get<{ Params: { id: string } }>('/api/datasets/:id', async (request) => {
    const dataset = app.services.datasets.get(request.params.id);
    return { ...dataset, bytes: app.services.datasets.bytes(dataset.id) };
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { offset?: string; limit?: string; profileId?: string; q?: string };
  }>('/api/datasets/:id/rows', async (request) => {
    const query = request.query;
    return app.services.datasets.rows(request.params.id, {
      offset: Number(query.offset ?? 0) || 0,
      limit: Number(query.limit ?? 50) || 50,
      profileId: query.profileId || undefined,
      q: query.q || undefined,
    });
  });

  /**
   * 导出。
   *
   * 走 reply.hijack 直接写 raw：10 万行时把整张表拼成字符串会让进程 RSS
   * 瞬间多几十 MB，而且首个字节要等到全部生成完才出去。这里按块写，
   * 并且处理背压——客户端慢的时候不能把数据全堆在内存里。
   */
  fastify.get<{
    Params: { id: string };
    Querystring: { format?: string; since?: string; profileId?: string };
  }>('/api/datasets/:id/export', async (request, reply) => {
    const dataset = app.services.datasets.get(request.params.id);
    const format = request.query.format === 'jsonl' ? 'jsonl' : 'csv';
    const since = Number(request.query.since ?? 0) || undefined;
    const profileId = request.query.profileId || undefined;

    const stamp = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const suffix = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
    const filename = `${dataset.name}-${suffix}.${format}`;

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      // RFC 5987：中文文件名不加 filename* 在 Safari 下会变成 "download"
      'content-disposition': `attachment; filename="dataset-${suffix}.${format}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
    });

    const pump = async (text: string): Promise<void> => {
      if (!text) return;
      if (!reply.raw.write(text)) {
        await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
      }
    };

    try {
      // BOM 不是洁癖：macOS 的 Excel 没有它会按 GBK 猜，中文列名和内容一起变乱码
      if (format === 'csv') await pump(`\uFEFF${csvHeader(dataset.columns)}`);

      let buffer = '';
      let count = 0;
      for (const row of app.repos.datasets.iterate(dataset.id, { since, profileId })) {
        buffer +=
          format === 'csv' ? csvLine(dataset.columns, row.data) : datasetToJsonlLine(row.data);
        count += 1;
        if (count % 500 === 0) {
          await pump(buffer);
          buffer = '';
        }
      }
      await pump(buffer);
      reply.raw.end();
    } catch (error) {
      // 头已经发出去了，只能在正文里留一句可读的话，不能改写状态码
      reply.raw.end(`\n# 导出中断: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/datasets/:id', async (request, reply) => {
    app.services.datasets.remove(request.params.id);
    return reply.code(204).send();
  });

  await fastify.listen({ port, host: '127.0.0.1' });
  const address = fastify.server.address();
  boundPort = typeof address === 'object' && address ? address.port : port;

  return { fastify, token, port: boundPort };
}
