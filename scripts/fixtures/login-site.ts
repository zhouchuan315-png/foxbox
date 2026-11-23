import * as http from 'node:http';

/**
 * 验收用的本地假站点。
 *
 * 为什么需要它：M6 要验「去重 / 增量」，M7 要验「登录态过期」，M8 要验「重试」。
 * 这三件事都需要一个**可控**的站点——公网上的站点既不能改数据，也不会配合你
 * 制造一次 500 或一次未登录跳转。用公网做验收的结果是：断网、被墙、对方改版
 * 都会让测试变红，而红的原因和被测代码毫无关系。
 *
 * 只用 node:http，不引框架：这文件的作用是「稳定」，多一个依赖就多一个变量。
 */

export interface FixtureSite {
  port: number;
  url: string;
  close(): Promise<void>;
  /** 改一条订单的价格，用来验证 upsert 会更新内容而不是新增行 */
  setPrice(orderNo: string, price: string): boolean;
  reset(): void;
  /**
   * 请求统计。
   *
   * `maxConcurrent` 是验「巡检并发上限」的唯一可靠手段：从客户端数自己发起了
   * 几次请求没用，必须看服务端同时收到了几个。
   */
  stats(): { total: number; maxConcurrent: number; inFlight: number };
}

export interface FixtureOptions {
  /** 订单条数，默认 12 */
  orderCount?: number;
}

interface Order {
  orderNo: string;
  title: string;
  price: string;
  status: string;
  updatedAt: string;
}

const BASE_ORDERS: Order[] = [
  { orderNo: 'A1001', title: '原味挂耳咖啡 10 片', price: '58.00', status: '已发货', updatedAt: '2026-11-18' },
  { orderNo: 'A1002', title: '手冲滤纸 100 张', price: '19.90', status: '待发货', updatedAt: '2026-11-18' },
  { orderNo: 'A1003', title: '陶瓷滤杯 V60', price: '89.00', status: '已完成', updatedAt: '2026-11-17' },
  { orderNo: 'A1004', title: '电子秤 0.1g', price: '129.00', status: '已完成', updatedAt: '2026-11-17' },
  { orderNo: 'A1005', title: '咖啡豆 埃塞 日晒 200g', price: '78.00', status: '待付款', updatedAt: '2026-11-16' },
  { orderNo: 'A1006', title: '咖啡豆 哥伦比亚 水洗 200g', price: '72.00', status: '已发货', updatedAt: '2026-11-16' },
  { orderNo: 'A1007', title: '法压壶 350ml', price: '66.00', status: '已完成', updatedAt: '2026-11-15' },
  { orderNo: 'A1008', title: '奶泡器 电动', price: '45.00', status: '已退货', updatedAt: '2026-11-15' },
  { orderNo: 'A1009', title: '冷萃壶 1L', price: '99.00', status: '待发货', updatedAt: '2026-11-14' },
  { orderNo: 'A1010', title: '咖啡杯 双层玻璃 250ml', price: '39.00', status: '已完成', updatedAt: '2026-11-14' },
  { orderNo: 'A1011', title: '清洁片 咖啡机专用', price: '25.00', status: '待发货', updatedAt: '2026-11-13' },
  { orderNo: 'A1012', title: '密封罐 陶瓷', price: '52.00', status: '已完成', updatedAt: '2026-11-13' },
];

function html(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px;color:#222}
  h1{font-size:18px;margin:0 0 16px}
  table{border-collapse:collapse;width:100%}
  th,td{border-bottom:1px solid #e6e6e6;padding:8px 10px;text-align:left}
  th{background:#fafafa;font-weight:600}
  .price{font-variant-numeric:tabular-nums}
  .bar{display:flex;gap:12px;align-items:center;margin-bottom:16px}
  a.btn,button{border:1px solid #d0d0d0;background:#fff;border-radius:6px;padding:6px 12px;color:#222;text-decoration:none;cursor:pointer;font:inherit}
</style></head><body>${body}</body></html>`;
}

export async function startFixtureSite(opts: FixtureOptions = {}): Promise<FixtureSite> {
  const orderCount = Math.max(1, Math.min(opts.orderCount ?? 12, BASE_ORDERS.length));
  let orders: Order[] = BASE_ORDERS.slice(0, orderCount).map((o) => ({ ...o }));
  /** /flaky 的调用计数：前两次 500，第三次 200。用进程内变量，重启即重置 */
  let flakyHits = 0;
  let flakySlowHits = 0;
  /** 并发观测：所有请求进出都记账，maxConcurrent 只增不减 */
  let total = 0;
  let inFlight = 0;
  let maxConcurrent = 0;

  const server = http.createServer((req, res) => {
    total += 1;
    inFlight += 1;
    if (inFlight > maxConcurrent) maxConcurrent = inFlight;
    res.on('close', () => {
      inFlight = Math.max(0, inFlight - 1);
    });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const headers = req.headers;
    const cookies = parseCookies(headers.cookie);
    const loggedIn = cookies.sid === 'ok';

    const send = (status: number, body: string, type = 'text/html; charset=utf-8'): void => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const redirect = (to: string, extraHeaders: Record<string, string> = {}): void => {
      res.writeHead(302, { location: to, 'cache-control': 'no-store', ...extraHeaders });
      res.end();
    };

    try {
      // ── 入口：未登录一律跳 /login，这是 M7 判定 expired 的依据
      if (pathname === '/') {
        return loggedIn ? redirect('/orders') : redirect('/login');
      }

      // ── 登录页：点一下就把 sid 钉上。不做表单 POST，验收脚本直接 GET 即可
      if (pathname === '/login') {
        if (url.searchParams.get('go') === '1') {
          // 必须带 Max-Age：只发会话 cookie 的话，浏览器一退出就丢，
          // 「重启环境后还在登录态」这件事根本没法验。
          // 真实站点的「记住我」也是持久 cookie，这里跟它对齐。
          return redirect('/orders', { 'set-cookie': 'sid=ok; Path=/; Max-Age=604800; HttpOnly' });
        }
        return send(
          200,
          html(
            '登录 - 假站点',
            `<h1>请先登录</h1>
             <p>这是一个用来做验收的假站点。点下面的按钮即视为「登录成功」。</p>
             <p><a class="btn" href="/login?go=1">登录</a></p>`,
          ),
        );
      }

      if (pathname === '/logout') {
        return redirect('/login', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
      }

      // ── 订单页：登录后可见。12 行、分页、可改价（验 upsert）
      if (pathname === '/orders') {
        if (!loggedIn) return redirect('/login');
        const page = Number(url.searchParams.get('page') ?? '1') || 1;
        const size = 6;
        const list = orders.slice((page - 1) * size, page * size);
        const rows = list
          .map(
            (o) =>
              `<tr data-order-no="${o.orderNo}"><td>${o.orderNo}</td><td class="title">${o.title}</td>` +
              `<td class="price">${o.price}</td><td class="status">${o.status}</td><td class="updated">${o.updatedAt}</td></tr>`,
          )
          .join('');
        const totalPages = Math.ceil(orders.length / size);
        return send(
          200,
          html(
            '订单 - 假站点',
            `<div class="bar"><h1>订单列表</h1><span>第 ${page}/${totalPages} 页</span>
               <a class="btn" href="/orders?page=${Math.max(1, page - 1)}">上一页</a>
               <a class="btn" href="/orders?page=${Math.min(totalPages, page + 1)}">下一页</a></div>
             <table id="orders"><thead><tr>
               <th>订单号</th><th>商品</th><th>价格</th><th>状态</th><th>更新时间</th>
             </tr></thead><tbody>${rows}</tbody></table>`,
          ),
        );
      }

      // ── 只对登录用户返回 JSON，验「采集到的数据」
      if (pathname === '/api/orders') {
        if (!loggedIn) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ items: orders }));
      }

      // ── 前两次 500、第三次 200：验重试策略
      if (pathname === '/flaky') {
        flakyHits += 1;
        if (flakyHits <= 2) return send(500, html('500', `<h1>${flakyHits === 1 ? '第一次' : '第二次'}失败</h1>`));
        return send(200, html('200', `<h1 id="ok">第三次成功</h1>`));
      }

      /**
       * 前两次「慢到超时」、第三次正常。
       *
       * 和 /flaky 的区别：/flaky 返 500，而 goto 不把 5xx 当失败，测不出重试；
       * 真实世界里的偶发失败大多是「慢」而不是「500」，所以重试得靠这个路由验。
       */
      if (pathname === '/flaky-slow') {
        flakySlowHits += 1;
        if (flakySlowHits <= 2) {
          return setTimeout(() => {
            if (!res.writableEnded) send(500, html('500', '<h1>慢了两次</h1>'));
          }, 6000);
        }
        return send(200, html('200', `<h1 id="ok">第三次成功</h1>`));
      }

      // ── 恒 500：验「打不开不能算会话过期」
      if (pathname === '/500') {
        return send(500, html('500', '<h1>服务器内部错误</h1>'));
      }

      // ── 慢响应：验任务级超时
      if (pathname === '/slow') {
        const ms = Math.min(Number(url.searchParams.get('ms') ?? '3000') || 3000, 30_000);
        return setTimeout(() => {
          if (!res.writableEnded) send(200, html('慢', '<h1>慢响应完成</h1>'));
        }, ms);
      }

      // ── 测试后门：改价 / 重置
      if (pathname === '/__set-price') {
        const no = url.searchParams.get('orderNo') ?? '';
        const price = url.searchParams.get('price') ?? '';
        const hit = orders.find((o) => o.orderNo === no);
        if (!hit) return send(404, JSON.stringify({ ok: false }), 'application/json');
        hit.price = price;
        return send(200, JSON.stringify({ ok: true, orderNo: no, price }), 'application/json');
      }

      if (pathname === '/__reset') {
        orders = BASE_ORDERS.slice(0, orderCount).map((o) => ({ ...o }));
        flakyHits = 0;
        total = 0;
        inFlight = 0;
        maxConcurrent = 0;
        return send(200, JSON.stringify({ ok: true }), 'application/json');
      }

      if (pathname === '/__stats') {
        return send(200, JSON.stringify({ total, maxConcurrent, inFlight }), 'application/json');
      }

      return send(404, html('404', '<h1>没有这个页面</h1>'));
    } catch (error) {
      return send(500, html('500', `<h1>假站点自己出错了</h1><pre>${String(error)}</pre>`));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    setPrice(orderNo: string, price: string) {
      const hit = orders.find((o) => o.orderNo === orderNo);
      if (!hit) return false;
      hit.price = price;
      return true;
    },
    reset() {
      orders = BASE_ORDERS.slice(0, orderCount).map((o) => ({ ...o }));
      flakyHits = 0;
      flakySlowHits = 0;
      total = 0;
      inFlight = 0;
      maxConcurrent = 0;
    },
    stats() {
      return { total, maxConcurrent, inFlight };
    },
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

/** 直接跑：手动看一眼假站点长什么样 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const site = await startFixtureSite();
  console.log(`假站点已启动: ${site.url}`);
  console.log(`  ${site.url}/login   → 点「登录」后才有 sid`);
  console.log(`  ${site.url}/orders  → 未登录会 302 到 /login`);
  console.log(`  ${site.url}/flaky   → 前两次 500，第三次 200`);
  console.log(`  ${site.url}/500     → 恒 500`);
}
