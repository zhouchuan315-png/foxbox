/**
 * B 站视频采集脚本（在 FoxBox 环境的浏览器里执行，run-script 的 mode=playwright）
 *
 * 约定：调用方在脚本前面注入 `const P = {...}`，字段：
 *   mode    'popular' | 'search' | 'video'
 *   keyword 搜索关键词（mode=search 必填）
 *   bvid    视频号，字符串或数组（mode=video 用）
 *   limit   最多保留多少条，默认 20
 *   pages   翻几页，默认 1（每页约 20 条）
 *   delayMs 请求间隔基准，默认 450（会加 0~300ms 抖动）
 *
 * 不传 P 直接粘进 curl 也能跑，默认采「热门」第一页。
 *
 * 设计取舍：
 * - 走浏览器里的 fetch 而不是 Node 直连：这样带上环境自己的 Cookie（buvid3 等）和
 *   bilibili.com 的 Referer，风控命中率明显低；而且换环境就是换出口 IP。
 * - 搜索用 search/all/v2 而不是 wbi/search/type：后者在未登录环境会被要求 v_voucher
 *   （验证码），all/v2 目前不需要签名。
 * - 字段一律归一化，三种来源（热门/搜索/详情）输出同一个形状，方便直接进表格。
 */

const params = typeof P !== 'undefined' ? P : {};
const MODE = params.mode || 'popular';
const LIMIT = Math.max(1, Math.min(Number(params.limit) || 20, 200));
const PAGES = Math.max(1, Math.min(Number(params.pages) || 1, 10));
const DELAY = Math.max(0, Number(params.delayMs ?? 450));
// 列表接口只给「播放/点赞/收藏」，硬币、分享、分P、分辨率、标签要逐条打详情接口
const DETAIL = params.detail === true;

const warnings = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = () => sleep(DELAY + Math.floor(Math.random() * 300));

/** HTML 实体 + <em> 高亮标签清理 */
function clean(input) {
  return String(input ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function durationToSec(value) {
  if (typeof value === 'number') return value;
  const parts = String(value || '')
    .split(':')
    .map((s) => Number(s));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function isoDate(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function cover(url) {
  if (!url) return null;
  return url.startsWith('//') ? `https:${url}` : url;
}

/**
 * 在页面上下文里发一次 GET。跨域没问题：目标都在 *.bilibili.com，
 * 页面已经带了 credentials，服务端也放行同族域名。
 */
async function jget(url) {
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const res = await page.evaluate(async (target) => {
      try {
        const r = await fetch(target, { credentials: 'include' });
        const text = await r.text();
        try {
          return { http: r.status, json: JSON.parse(text) };
        } catch {
          return { http: r.status, raw: text.slice(0, 200) };
        }
      } catch (error) {
        return { error: String((error && error.message) || error) };
      }
    }, url);

    if (res.error) {
      if (attempt < 2) {
        await sleep(1200);
        continue;
      }
      throw new Error(`请求失败：${res.error}`);
    }
    if (!res.json) throw new Error(`返回不是 JSON（HTTP ${res.http}）：${res.raw}`);

    const { code, message, data } = res.json;
    if (code === 0) return data;

    // -352/-412/-799 都是风控；回首页刷一下 Cookie 再试，别硬撞
    if ((code === -352 || code === -412 || code === -799) && attempt < 2) {
      warnings.push(`接口被风控（code=${code}），回首页刷新 Cookie 后重试第 ${attempt + 1} 次`);
      await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
      await sleep(1500 + attempt * 1500);
      continue;
    }
    throw new Error(`B站接口返回 code=${code} ${message || ''}`);
  }
  throw new Error('重试次数用尽');
}

/** 统一记录形状：三种来源缺的字段补 null，别让下游猜 */
function normalize(src, source) {
  return {
    bvid: src.bvid || null,
    aid: src.aid || src.id || null,
    title: clean(src.title),
    author: src.author || (src.owner && src.owner.name) || null,
    authorId: src.mid || (src.owner && src.owner.mid) || null,
    url: src.bvid ? `https://www.bilibili.com/video/${src.bvid}` : src.arcurl || null,
    cover: cover(src.pic),
    durationSec: durationToSec(src.duration),
    publishedAt: isoDate(src.pubdate),
    views: src.play ?? (src.stat && src.stat.view) ?? null,
    danmaku: src.danmaku ?? src.video_review ?? (src.stat && src.stat.danmaku) ?? null,
    comments: src.review ?? (src.stat && src.stat.reply) ?? null,
    likes: src.like ?? (src.stat && src.stat.like) ?? null,
    coins: (src.stat && src.stat.coin) ?? null,
    favorites: src.favorites ?? (src.stat && src.stat.favorite) ?? null,
    shares: (src.stat && src.stat.share) ?? null,
    category: src.typename || src.tname || null,
    tags: src.tag ? String(src.tag).split(',').map((s) => s.trim()).filter(Boolean) : [],
    description: clean(src.desc || src.description) || null,
    source,
  };
}

async function collectPopular(items) {
  for (let pageIndex = 1; pageIndex <= PAGES && items.length < LIMIT; pageIndex += 1) {
    const data = await jget(
      `https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pageIndex}`,
    );
    const list = data && data.list ? data.list : [];
    for (const item of list) {
      if (items.length >= LIMIT) break;
      if (!item.bvid) continue;
      const record = normalize(item, 'popular');
      record.rank = items.length + 1; // 榜单名次，翻页后连续
      items.push(record);
    }
    if (list.length === 0) break;
    if (items.length < LIMIT) await jitter();
  }
}

async function collectSearch(items) {
  const keyword = params.keyword;
  if (!keyword) throw new Error('mode=search 需要提供 keyword');
  let skipped = 0;
  for (let pageIndex = 1; pageIndex <= PAGES && items.length < LIMIT; pageIndex += 1) {
    const data = await jget(
      `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=${pageIndex}`,
    );
    // all/v2 把结果按类型分组，video 组里还混着直播（type=live_room）
    const group = (data.result || []).find((entry) => entry.result_type === 'video');
    const list = (group && group.data) || [];
    for (const item of list) {
      if (items.length >= LIMIT) break;
      if (item.type !== 'video' || !item.bvid) {
        skipped += 1;
        continue;
      }
      items.push(normalize(item, 'search'));
    }
    if (list.length === 0) break;
    if (items.length < LIMIT) await jitter();
  }
  if (skipped > 0) warnings.push(`搜索结果里跳过 ${skipped} 条非视频/直播条目`);
}

async function collectVideo(items) {
  const raw = params.bvid;
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error('mode=video 需要提供 bvid');

  for (const bvid of list.slice(0, LIMIT)) {
    const data = await jget(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    );
    const record = normalize(data, 'view');
    record.pages = Array.isArray(data.pages) ? data.pages.length : null;
    record.resolution =
      data.dimension && data.dimension.width ? `${data.dimension.width}x${data.dimension.height}` : null;
    try {
      const tags = await jget(
        `https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`,
      );
      if (Array.isArray(tags)) record.tags = tags.map((t) => t.tag_name).filter(Boolean);
    } catch (error) {
      warnings.push(`${bvid} 标签拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    items.push(record);
    if (items.length < list.length) await jitter();
  }
}

/**
 * 逐条补详情。
 *
 * 热门/搜索接口只给列表字段（播放、点赞、收藏、时长），硬币/分享/分P/分辨率/标签
 * 都在 view 接口里。50 条 = 100 次请求，按 450ms 间隔约 70 秒——所以做成可选项，
 * 不要默认替每个调用方付这个时间。
 */
async function enrichAll(list) {
  let failed = 0;
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    try {
      const view = await jget(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(item.bvid)}`,
      );
      const detail = normalize(view, 'view');
      detail.rank = item.rank ?? null;
      detail.category = detail.category || item.category; // view 的 tname 偶尔是空串
      detail.pages = Array.isArray(view.pages) ? view.pages.length : null;
      detail.resolution =
        view.dimension && view.dimension.width
          ? `${view.dimension.width}x${view.dimension.height}`
          : null;
      detail.source = `${item.source}+view`;
      try {
        const tags = await jget(
          `https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(item.bvid)}`,
        );
        if (Array.isArray(tags)) detail.tags = tags.map((tag) => tag.tag_name).filter(Boolean);
      } catch (error) {
        warnings.push(`${item.bvid} 标签拉取失败：${error instanceof Error ? error.message : String(error)}`);
      }
      list[index] = detail;
    } catch (error) {
      failed += 1;
      item.detailError = error instanceof Error ? error.message : String(error);
      warnings.push(`${item.bvid} 详情拉取失败，保留列表字段：${item.detailError}`);
    }
    if (index < list.length - 1) await jitter();
  }
  return failed;
}

// ---- 主流程 ----

await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
await sleep(600);

const items = [];
if (MODE === 'popular') await collectPopular(items);
else if (MODE === 'search') await collectSearch(items);
else if (MODE === 'video') await collectVideo(items);
else throw new Error(`未知 mode：${MODE}（支持 popular / search / video）`);

// 同一关键词翻页会有重复，按 bvid 去重且保留首次出现
const seen = new Set();
const unique = [];
for (const item of items) {
  if (!item.bvid || seen.has(item.bvid)) continue;
  seen.add(item.bvid);
  unique.push(item);
}

// video 模式本身就走的详情接口，不需要再补
const detailFailed = DETAIL && MODE !== 'video' ? await enrichAll(unique) : 0;

// 服务端在脚本结束后才截图。未登录时首页会弹登录浮层挡住内容，
// 这里收个尾，让留证截图能看到页面本身而不是一句「登录后你可以」。
try {
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    for (const selector of ['.bili-mini-mask', '.login-panel-popover', '.bili-mini-login']) {
      document.querySelectorAll(selector).forEach((node) => node.remove());
    }
  });
  await sleep(300);
} catch {
  /* 关不掉就算了，不影响数据 */
}

return {
  mode: MODE,
  params: {
    keyword: params.keyword || null,
    bvid: params.bvid || null,
    limit: LIMIT,
    pages: PAGES,
    detail: DETAIL,
  },
  collectedAt: new Date().toISOString(),
  total: unique.length,
  skipped: items.length - unique.length,
  detailFailed,
  warnings,
  items: unique,
};
