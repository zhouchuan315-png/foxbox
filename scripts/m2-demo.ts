import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { hostOsFamily } from '../src/core/paths.ts';
import { warmUpEngine } from '../src/core/engines/warmup.ts';
import { ProxyUnhealthyError } from '../src/core/services/proxy.service.ts';
import { COUNTRY_PROFILE, type OsFamily } from '../src/fingerprint/preset.ts';

/**
 * M2 验收：代理预检 / 分组 / 环境查询与更新。
 *
 * 判据不是「接口返回 200」，而是这四件业务事实：
 * 1. 实测出口国家能推断出来，且指纹的时区/语言跟着它走
 * 2. 申报国家与实际不符时被识别出来，而不是静默采信
 * 3. 代理失效时，启动前就被拦住
 * 4. 被环境引用的代理删不掉
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const home = getArg('home') ?? path.join(process.cwd(), '.foxbox');
const proxyUrl = getArg('proxy') ?? 'http://127.0.0.1:7890';
const os = (getArg('os') as OsFamily | undefined) ?? hostOsFamily();

function parseProxyUrl(input: string): {
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
} {
  const url = new URL(input);
  const protocol = url.protocol.replace(':', '');
  if (protocol !== 'http' && protocol !== 'https' && protocol !== 'socks5') {
    throw new Error(`不支持的代理协议: ${protocol}`);
  }
  return {
    protocol,
    host: url.hostname,
    port: Number(url.port || (protocol === 'https' ? 443 : 80)),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

const stamp = new Date().toISOString().slice(11, 19);

async function main(): Promise<void> {
  console.log('FoxBox M2 · 代理预检 / 分组 / 环境管理');
  console.log(`  home=${home}  os=${os}  proxy=${proxyUrl}`);
  console.log('');

  const app = createApp(home);
  const target = parseProxyUrl(proxyUrl);
  const checks: Array<[string, boolean, string]> = [];
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
  };

  if (!has('no-warmup')) {
    process.stdout.write('  [0/7] 预热引擎...');
    const warm = await warmUpEngine(os);
    console.log(warm.ok ? ` 完成 (${warm.elapsedMs}ms)` : ` 失败：${warm.error}`);
  }

  // 1. 建代理但不填国家，让预检自己判断
  process.stdout.write('  [1/7] 建代理 + 预检...');
  const proxy = app.services.proxies.create({
    name: `演示代理 ${stamp}`,
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
  });
  const check = await app.services.proxies.check(proxy.id);
  console.log(
    check.ok
      ? ` 完成 ${check.exitIp} / ${check.country} / 握手 ${check.connectMs}ms / 合计 ${check.latencyMs}ms`
      : ` 失败：${check.error}`,
  );
  record('代理预检成功', check.ok, check.ok ? `${check.exitIp} ${check.country}` : String(check.error));
  record('实测出口国家可识别', Boolean(check.country), String(check.country));

  if (!check.ok || !check.country) {
    console.log('\n  出口 IP 都没测通，后面的国家推断无法验证，先修代理。');
    return finish(app, checks);
  }

  const countryProfile = COUNTRY_PROFILE[check.country];
  record('国家在时区表内', Boolean(countryProfile), check.country);

  // 2. 只给 proxyId 建环境：国家应当自动来自实测
  process.stdout.write('  [2/7] 建环境（不传 country，只给 proxyId）...');
  const profile = await app.services.profiles.create({
    name: `M2 演示环境 ${stamp}`,
    proxyId: proxy.id,
    os,
    headless: true,
  });
  console.log(` 完成 时区=${profile.preset.timezone} 语言=${profile.preset.locale} 国家=${check.country}`);

  const tzOk = countryProfile?.timezones.includes(profile.preset.timezone) ?? false;
  const region = profile.preset.locale.split('-')[1]?.toUpperCase();
  const localeOk = countryProfile?.locales.some((l) => l.split('-')[1] === region) ?? false;
  record('时区跟随实测国家（R1）', tzOk, `${profile.preset.timezone} ∈ ${check.country}`);
  record('语言跟随实测国家（R2）', localeOk, profile.preset.locale);

  // 3. 分组与查询
  process.stdout.write('  [3/7] 分组与查询...');
  const group = app.services.groups.create(`演示分组 ${stamp}`);
  app.services.profiles.update(profile.id, { groupId: group.id });
  const byGroup = app.services.profiles.list({ groupId: group.id });
  const bySearch = app.services.profiles.list({ q: 'M2 演示' });
  const ungrouped = app.services.profiles.list({ ungrouped: true });
  console.log(` 完成 组内 ${byGroup.total} 个，搜索命中 ${bySearch.total} 个，未分组 ${ungrouped.total} 个`);
  record('按分组过滤命中', byGroup.items.some((p) => p.id === profile.id), `total=${byGroup.total}`);
  record('按名称搜索命中', bySearch.items.some((p) => p.id === profile.id), `total=${bySearch.total}`);
  record('分组计数正确', app.services.groups.list().some((g) => g.id === group.id && g.profileCount === 1), '');

  // 4. 更新（只允许改展示/调度字段）
  process.stdout.write('  [4/7] 更新环境名称与备注...');
  const renamed = app.services.profiles.update(profile.id, { name: `M2 改名 ${stamp}`, note: '由 M2 验收脚本写入' });
  console.log(` 完成 name=${renamed.name}`);
  record('改名与备注生效', renamed.note === '由 M2 验收脚本写入', renamed.name);
  record('指纹未被改动', renamed.preset.ua === profile.preset.ua, 'UA 与创建时一致');

  // 5. 申报国家与实际不符
  process.stdout.write('  [5/7] 申报国家与实际不符...');
  const wrong = app.services.proxies.create({
    name: `申报不符 ${stamp}`,
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    expectedCountry: 'US',
  });
  const wrongCheck = await app.services.proxies.check(wrong.id);
  const wrongProfile = await app.services.profiles.create({
    name: `M2 不一致环境 ${stamp}`,
    proxyId: wrong.id,
    os,
    headless: true,
  });
  console.log(` 完成 申报 US / 实测 ${wrongCheck.country}，指纹时区 ${wrongProfile.preset.timezone}`);
  record('识别申报与实测不一致', wrongCheck.countryMismatch === true, `US → ${wrongCheck.country}`);
  record(
    '不一致时按实测值生成指纹',
    Boolean(wrongCheck.country && COUNTRY_PROFILE[wrongCheck.country]?.timezones.includes(wrongProfile.preset.timezone)),
    wrongProfile.preset.timezone,
  );

  // 6. 失效代理必须在启动前被拦住
  process.stdout.write('  [6/7] 失效代理拦截...');
  const dead = app.services.proxies.create({
    name: `失效代理 ${stamp}`,
    protocol: 'http',
    host: '127.0.0.1',
    port: 7899,
    expectedCountry: 'HK',
  });
  let blocked = false;
  let blockMessage = '';
  try {
    await app.services.proxies.ensureHealthy(dead.id, { timeoutMs: 2500 });
  } catch (error) {
    blocked = error instanceof ProxyUnhealthyError;
    blockMessage = error instanceof Error ? error.message.slice(0, 70) : '';
  }
  console.log(blocked ? ` 已拦截：${blockMessage}` : ' 未拦截（异常）');
  record('启动前拦截失效代理', blocked, blockMessage);

  // 7. 被引用的代理不允许删除
  process.stdout.write('  [7/7] 删除被环境引用的代理...');
  let refused = false;
  let refuseMessage = '';
  try {
    app.services.proxies.remove(proxy.id);
  } catch (error) {
    refused = true;
    refuseMessage = error instanceof Error ? error.message : String(error);
  }
  console.log(refused ? ` 已拒绝：${refuseMessage}` : ' 未拒绝（异常）');
  record('被引用的代理禁止删除', refused, refuseMessage);

  // 收尾：软删环境 → 删组 → 删代理
  app.services.profiles.remove(profile.id);
  app.services.profiles.remove(wrongProfile.id);
  const afterDelete = app.services.groups.list().find((g) => g.id === group.id);
  record('删环境后分组计数归零', afterDelete?.profileCount === 0, `count=${afterDelete?.profileCount}`);
  app.services.groups.remove(group.id);
  for (const id of [proxy.id, wrong.id, dead.id]) {
    try {
      app.services.proxies.remove(id);
    } catch {
      // 已被引用则跳过，不影响结论
    }
  }

  finish(app, checks);
}

function finish(app: ReturnType<typeof createApp>, checks: Array<[string, boolean, string]>): void {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  验收结论');
  console.log(line);
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '通过  ' : '未达标'}  ${name.padEnd(26, ' ')} ${detail}`);
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n  ${failed === 0 ? 'M2 验收通过' : `${failed} 项未达标`}`);
  app.services.profiles.shutdown().finally(() => app.db.close());
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\nM2 验证失败：');
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
