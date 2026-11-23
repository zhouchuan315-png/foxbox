import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';
import { startFixtureSite } from './fixtures/login-site.ts';

/**
 * M6 验收：数据落地。
 *
 * 判据是「数据对不对」，不是「接口返回 200」：
 * 1. 同一批数据跑三次，行数不变、seen_count 累加
 * 2. 内容变了要更新而不是新增，first_seen_at 不能被覆盖（这是增量的基础）
 * 3. 超行数 / 超单行 / 非数组，一律失败且库里不留半批
 * 4. 采到 0 行不算失败，写了 expectMinRows 才算
 * 5. CSV 带 BOM、中文不乱码、列顺序按 schema
 * 6. 删任务不删数据；删数据集才删数据
 *
 * 全程打本地假站点，不依赖公网。
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const home = getArg('home') ?? path.join(process.cwd(), '.foxbox-m6-eval');
const skipBrowser = args.includes('--no-browser');

interface RawResponse {
  status: number;
  body: string;
  buffer: Buffer;
  headers: http.IncomingHttpHeaders;
}

function request(opts: {
  port: number;
  path: string;
  method?: string;
  token?: string;
  body?: unknown;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { host: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            body: buffer.toString('utf8'),
            buffer,
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface TaskShape {
  id: string;
  status: string;
  result: null | {
    runs: Array<{
      profileId: string;
      profileName: string;
      status: string;
      steps: Array<{
        type: string;
        status: string;
        output?: unknown;
        note?: string;
        error?: string;
        collect?: { dataset: string; written: number; inserted: number; updated: number; skipped: number };
      }>;
    }>;
    summary: { total: number; succeeded: number; failed: number; skipped: number };
  };
  error: string | null;
}

interface DatasetShape {
  id: string;
  name: string;
  columns: Array<{ key: string; type: string }>;
  rowCount: number;
  lastWriteAt: number | null;
}

interface RowsShape {
  rows: Array<{
    id: string;
    data: Record<string, unknown>;
    firstProfileId: string | null;
    lastProfileId: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
    seenCount: number;
  }>;
  total: number;
}

/** 页面里取订单表格。故意用朴素的 DOM API，脚本要在浏览器里直接跑 */
const SCRAPE_ORDERS = `Array.from(document.querySelectorAll('#orders tbody tr')).map(function (tr) {
  var cell = function (sel) { var el = tr.querySelector(sel); return el ? el.textContent.trim() : null; };
  return {
    orderNo: tr.getAttribute('data-order-no'),
    title: cell('.title'),
    price: cell('.price'),
    status: cell('.status'),
    updatedAt: cell('.updated')
  };
})`;

async function main(): Promise<void> {
  console.log('FoxBox M6 · 数据落地');
  console.log(`  home=${home}${skipBrowser ? '（跳过真实浏览器）' : ''}`);

  fs.rmSync(home, { recursive: true, force: true });
  const site = await startFixtureSite();
  const app = createApp(home);
  const { fastify, token, port } = await startServer(app, { port: 0 });

  const checks: Array<[string, boolean, string]> = [];
  let finished = false;
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
    console.log(`  ${ok ? '·' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const api = async <T>(p: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const res = await request({ port, path: p, token, ...init });
    return (res.body ? JSON.parse(res.body) : null) as T;
  };

  const createAndRun = async (name: string, body: Record<string, unknown>): Promise<TaskShape> => {
    const created = await api<TaskShape>('/api/tasks', { method: 'POST', body: { name, runNow: true, ...body } });
    return waitTask(created.id);
  };

  const waitTask = async (id: string, timeoutMs = 240_000): Promise<TaskShape> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await api<TaskShape>(`/api/tasks/${id}`);
      if (task.status !== 'running' && task.status !== 'queued') return task;
      await sleep(600);
    }
    return api<TaskShape>(`/api/tasks/${id}`);
  };

  const dataset = async (name: string): Promise<DatasetShape | undefined> =>
    (await api<DatasetShape[]>('/api/datasets')).find((d) => d.name === name);

  const rows = async (name: string, extra = ''): Promise<RowsShape> => {
    const ds = await dataset(name);
    if (!ds) return { rows: [], total: 0 };
    return api<RowsShape>(`/api/datasets/${ds.id}/rows?limit=200${extra}`);
  };

  try {
    // ── 准备
    const group = await api<{ id: string }>('/api/groups', { method: 'POST', body: { name: 'M6 演示' } });
    const mkProfile = (name: string): Promise<{ id: string; name: string }> =>
      api('/api/profiles', { method: 'POST', body: { name, country: 'HK', os: 'macos', groupId: group.id, headless: true } });
    const p1 = await mkProfile('采集环境 A');
    const p2 = await mkProfile('采集环境 B');
    record('准备两个环境', Boolean(p1.id && p2.id), `${p1.name} / ${p2.name}`);

    if (skipBrowser) {
      console.log('\n（--no-browser：只验证接口与数据模型，不跑真实浏览器）');
      return finish();
    }

    // ── 任务 A：主链路。分两页采 12 条，跑三次
    const taskA = {
      name: '采集订单（两页）',
      target: { profileIds: [p1.id] },
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/login?go=1` },
        { type: 'goto', url: `${site.url}/orders?page=1` },
        { type: 'collect', dataset: '订单', dedupeBy: ['orderNo'], script: SCRAPE_ORDERS },
        { type: 'goto', url: `${site.url}/orders?page=2` },
        { type: 'collect', dataset: '订单', dedupeBy: ['orderNo'], script: SCRAPE_ORDERS },
        { type: 'stop' },
      ],
    };

    const t0 = Date.now();
    const runA1 = await createAndRun(taskA.name, taskA);
    const firstMs = Date.now() - t0;
    record(
      '首次采集任务成功',
      runA1.status === 'succeeded',
      `${runA1.status} ${firstMs}ms · ${JSON.stringify(runA1.result?.runs[0]?.steps[3]?.collect)}`,
    );

    const afterFirst = await dataset('订单');
    record('首次写入 12 行', afterFirst?.rowCount === 12, `rowCount=${afterFirst?.rowCount}`);
    record(
      'schema 按首次出现顺序',
      (afterFirst?.columns ?? []).map((c) => c.key).join(',') === 'orderNo,title,price,status,updatedAt',
      (afterFirst?.columns ?? []).map((c) => `${c.key}:${c.type}`).join(' '),
    );

    // 再跑两次：数据没变，行数必须纹丝不动
    await createAndRun(taskA.name, taskA);
    const runA3 = await createAndRun(taskA.name, taskA);
    const afterThree = await dataset('订单');
    record('跑三次后行数仍是 12（去重生效）', afterThree?.rowCount === 12, `rowCount=${afterThree?.rowCount}`);

    const page1 = await rows('订单');
    const seen = page1.rows.map((r) => r.seenCount);
    record(
      'seen_count 累加到 3',
      seen.every((n) => n === 3),
      `seen=${[...new Set(seen)].join('/')}`,
    );
    record(
      '回执区分 inserted / updated',
      runA3.result?.runs[0]?.steps[3]?.collect?.inserted === 0 &&
        (runA3.result?.runs[0]?.steps[3]?.collect?.updated ?? 0) === 6,
      JSON.stringify(runA3.result?.runs[0]?.steps[3]?.collect),
    );

    // ── 任务 B：改一条价格，验证 upsert 更新而不新增
    const beforeChange = (await rows('订单')).rows.find((r) => r.data.orderNo === 'A1001');
    site.setPrice('A1001', '88.88');
    await createAndRun(taskA.name, taskA);
    const afterChange = (await rows('订单')).rows.find((r) => r.data.orderNo === 'A1001');
    const afterChangeCount = (await dataset('订单'))?.rowCount;
    record('改价后行数不变（按 orderNo 判重）', afterChangeCount === 12, `rowCount=${afterChangeCount}`);
    record(
      '改价后内容被更新',
      afterChange?.data.price === '88.88',
      `${String(beforeChange?.data.price)} → ${String(afterChange?.data.price)}`,
    );
    record(
      'first_seen_at 不被覆盖（增量的基础）',
      beforeChange?.firstSeenAt === afterChange?.firstSeenAt,
      `${beforeChange?.firstSeenAt} vs ${afterChange?.firstSeenAt}`,
    );
    site.setPrice('A1001', '58.00');

    // ── 任务 C：全字段哈希 + 空结果
    const taskC = {
      name: '全字段哈希',
      target: { profileIds: [p1.id] },
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/login?go=1` },
        { type: 'goto', url: `${site.url}/orders?page=1` },
        { type: 'collect', dataset: '订单-全字段', script: SCRAPE_ORDERS },
        { type: 'goto', url: `${site.url}/orders?page=99` },
        { type: 'collect', dataset: '订单-全字段', script: SCRAPE_ORDERS },
        { type: 'stop' },
      ],
    };
    const runC1 = await createAndRun(taskC.name, taskC);
    record('空页采到 0 行仍算成功', runC1.status === 'succeeded', runC1.status);
    record(
      '0 行时步骤 note 说明「采到 0 行」',
      (runC1.result?.runs[0]?.steps[5]?.note ?? '').includes('0 行'),
      runC1.result?.runs[0]?.steps[5]?.note ?? '(无)',
    );

    const fullHashCount = (await dataset('订单-全字段'))?.rowCount;
    site.setPrice('A1001', '99.99');
    await createAndRun(taskC.name, taskC);
    const fullHashCount2 = (await dataset('订单-全字段'))?.rowCount;
    record(
      '全字段哈希：改一个字段就新增一行',
      fullHashCount === 6 && fullHashCount2 === 7,
      `${fullHashCount} → ${fullHashCount2}`,
    );
    site.setPrice('A1001', '58.00');

    // ── 任务 D：expectMinRows
    const runD = await createAndRun('期望至少一行', {
      target: { profileIds: [p1.id] },
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/login?go=1` },
        { type: 'goto', url: `${site.url}/orders?page=99` },
        { type: 'collect', dataset: '订单-期望', expectMinRows: 1, script: SCRAPE_ORDERS },
        { type: 'stop' },
      ],
    });
    record(
      'expectMinRows 未达则任务失败',
      runD.status === 'failed' && (runD.result?.runs[0]?.steps[3]?.error ?? '').includes('少于期望'),
      runD.result?.runs[0]?.steps[3]?.error ?? runD.status,
    );
    record('失败时不落库', (await dataset('订单-期望')) === undefined, '数据集未被创建');

    // ── 任务 E：三处上限，全部要「失败且不写」
    const limitCases: Array<{ name: string; script: string; expect: string }> = [
      {
        name: '超过 2000 行',
        script: 'Array.from({length: 2001}, function (_, i) { return { i: i }; })',
        expect: '超过上限',
      },
      {
        name: '单行超过 8KB',
        script: "Array.from({length: 1}, function () { return { big: 'x'.repeat(9000) }; })",
        expect: '单行上限',
      },
      {
        name: '返回值不是数组',
        script: '({ notAnArray: true })',
        expect: '必须返回数组',
      },
    ];
    for (const item of limitCases) {
      const run = await createAndRun(`上限校验 · ${item.name}`, {
        target: { profileIds: [p1.id] },
        steps: [
          { type: 'start' },
          { type: 'collect', dataset: '上限校验', script: item.script },
          { type: 'stop' },
        ],
      });
      const error = run.result?.runs[0]?.steps[1]?.error ?? '';
      record(
        `${item.name} → 失败且说明原因`,
        run.status === 'failed' && error.includes(item.expect),
        error.slice(0, 70) || run.status,
      );
    }
    record('上限校验数据集一行都没写进去', (await dataset('上限校验')) === undefined, '数据集未被创建');

    // ── 任务 F：append 模式 + 写错数据集名
    const appendTask = {
      name: '流水追加',
      target: { profileIds: [p1.id] },
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/login?go=1` },
        { type: 'goto', url: `${site.url}/orders?page=1` },
        { type: 'collect', dataset: '订单流水', mode: 'append', script: SCRAPE_ORDERS },
        { type: 'collect', dataset: '订单明细', dedupeBy: ['orderNo'], script: SCRAPE_ORDERS },
        { type: 'stop' },
      ],
    };
    await createAndRun(appendTask.name, appendTask);
    await createAndRun(appendTask.name, appendTask);
    const appendCount = (await dataset('订单流水'))?.rowCount;
    record('append 模式每次都是新行', appendCount === 12, `rowCount=${appendCount}`);

    const typo = await dataset('订单明细');
    record(
      '名字写错会新建一张表，且列表里看得见',
      Boolean(typo) && typo!.name !== '订单',
      `订单=${(await dataset('订单'))?.rowCount} 行 / 订单明细=${typo?.rowCount} 行`,
    );

    // ── 任务 G：两个环境采同一批数据，记录谁最先/最后看到
    const multi = await createAndRun('双环境采集', {
      target: { profileIds: [p1.id, p2.id] },
      concurrency: 1,
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/login?go=1` },
        { type: 'goto', url: `${site.url}/orders?page=1` },
        { type: 'collect', dataset: '双环境', dedupeBy: ['orderNo'], script: SCRAPE_ORDERS },
        { type: 'stop' },
      ],
    });
    const multiRows = await rows('双环境');
    const bothProfiles =
      multiRows.rows.length > 0 &&
      multiRows.rows.every((r) => r.firstProfileId === p1.id && r.lastProfileId === p2.id);
    record(
      '多环境采集记录 first/last 环境',
      multi.status === 'succeeded' && bothProfiles,
      `first=${multiRows.rows[0]?.firstProfileId?.slice(0, 8)} last=${multiRows.rows[0]?.lastProfileId?.slice(0, 8)}`,
    );

    // ── 导出
    const ds = (await dataset('订单'))!;
    const csv = await request({ port, path: `/api/datasets/${ds.id}/export?format=csv`, token });
    const csvLines = csv.body.split('\r\n').filter(Boolean);
    record('CSV 首字节是 BOM', csv.buffer[0] === 0xef && csv.buffer[1] === 0xbb && csv.buffer[2] === 0xbf, csv.buffer.subarray(0, 3).toString('hex'));
    record('CSV 行数 = 12 + 表头', csvLines.length === 13, `lines=${csvLines.length}`);
    record('CSV 中文不乱码', csv.body.includes('原味挂耳咖啡') && csv.body.includes('已发货'), csvLines[1]?.slice(0, 40) ?? '');
    record(
      'CSV 列顺序按 schema',
      csvLines[0]?.replace(/^\uFEFF/, '') === 'orderNo,title,price,status,updatedAt',
      csvLines[0]?.replace(/^\uFEFF/, '') ?? '',
    );
    record(
      'CSV 文件名带正确编码',
      String(csv.headers['content-disposition'] ?? '').includes("filename*=UTF-8''"),
      String(csv.headers['content-disposition'] ?? '').slice(0, 60),
    );

    const jsonl = await request({ port, path: `/api/datasets/${ds.id}/export?format=jsonl`, token });
    const jsonlLines = jsonl.body.split('\n').filter(Boolean);
    let jsonlOk = true;
    for (const line of jsonlLines) {
      try {
        JSON.parse(line);
      } catch {
        jsonlOk = false;
      }
    }
    record('JSONL 每行可解析', jsonlOk && jsonlLines.length === 12, `lines=${jsonlLines.length}`);

    // since 过滤
    const future = Date.now() + 60_000;
    const sinceEmpty = await request({ port, path: `/api/datasets/${ds.id}/export?format=jsonl&since=${future}`, token });
    record('since 过滤生效', sinceEmpty.body.trim() === '', `bytes=${sinceEmpty.buffer.length}`);

    // ── 删任务不删数据
    const beforeDelete = (await dataset('订单'))?.rowCount;
    await api(`/api/tasks/${runA3.id}`, { method: 'DELETE' });
    const afterTaskDelete = (await dataset('订单'))?.rowCount;
    record(
      '删任务后数据仍在（数据是资产）',
      beforeDelete === 12 && afterTaskDelete === 12,
      `${beforeDelete} → ${afterTaskDelete}`,
    );

    // ── 删数据集才删数据
    await api(`/api/datasets/${ds.id}`, { method: 'DELETE' });
    const gone = await request({ port, path: `/api/datasets/${ds.id}/rows`, token });
    record('删数据集后连行一起删', gone.status === 404, `HTTP ${gone.status}`);
    record('删后列表里查不到', (await dataset('订单')) === undefined, 'name 已释放');
  } finally {
    await site.close();
    finish();
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    const passed = checks.filter((c) => c[1]).length;
    console.log('');
    console.log(`  ${passed}/${checks.length} 通过`);
    const failed = checks.filter((c) => !c[1]);
    if (failed.length > 0) {
      console.log('  未通过：');
      for (const [name, , detail] of failed) console.log(`    × ${name}${detail ? ` — ${detail}` : ''}`);
    }
    void fastify.close();
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

await main();
