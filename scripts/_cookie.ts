import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { startFixtureSite } from './fixtures/login-site.ts';

const site = await startFixtureSite();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foxbox-ck-'));
const app = createApp(home);
const p = await app.services.profiles.create({ name: 'ck', country: 'HK', os: 'macos', headless: true });
const dbFile = path.join(home, 'profiles', p.id, 'cookies.sqlite');

await app.services.profiles.start(p.id);
const page = await app.manager.page(p.id);
await page.goto(`${site.url}/login?go=1`);
console.log('登录后 URL:', page.url(), '（应为 /orders）');
await app.services.profiles.stop(p.id);
await new Promise((r) => setTimeout(r, 800));
console.log('cookies.sqlite 存在:', fs.existsSync(dbFile), fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0);

await app.services.profiles.start(p.id);
const page2 = await app.manager.page(p.id);
await page2.goto(`${site.url}/orders`);
console.log('重启后 /orders URL:', page2.url());
console.log('重启后 cookies:', await page2.evaluate('document.cookie'));
await app.services.profiles.stop(p.id);
await app.services.profiles.shutdown();
await site.close();
process.exit(0);
