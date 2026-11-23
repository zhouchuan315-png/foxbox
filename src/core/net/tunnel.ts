import * as net from 'node:net';
import * as tls from 'node:tls';
import { SocketReader } from './socket-reader.ts';

export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyEndpoint {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface TunnelTarget {
  host: string;
  port: number;
}

/**
 * 失败阶段单独标出来，是为了给用户可执行的提示：
 * - proxy-connect / proxy-tls：代理地址写错、端口不通、证书问题
 * - proxy-auth：账号密码错，或代理不允许 CONNECT 到该端口
 * - target-connect：代理通了但目标不可达（多见于只放行 80/443 的代理）
 */
export type TunnelStage = 'proxy-connect' | 'proxy-tls' | 'proxy-auth' | 'target-connect' | 'timeout';

export class TunnelError extends Error {
  constructor(
    message: string,
    readonly stage: TunnelStage,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

const SOCKS5_ERRORS: Record<number, string> = {
  0x01: '代理内部错误',
  0x02: '代理规则禁止该连接',
  0x03: '网络不可达',
  0x04: '目标主机不可达',
  0x05: '目标拒绝连接',
  0x06: 'TTL 过期',
  0x07: '不支持的命令',
  0x08: '不支持的地址类型',
};

function tcpConnect(host: string, port: number, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    const remain = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TunnelError(`连接代理 ${host}:${port} 超时`, 'timeout'));
    }, remain);

    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new TunnelError(`连接代理 ${host}:${port} 失败: ${err.message}`, 'proxy-connect'));
    });

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function upgradeTls(socket: net.Socket, servername: string, deadline: number, stage: TunnelStage): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername,
      ALPNProtocols: ['http/1.1'],
      // 目标站点用公网证书；代理本身若做 TLS 中间人，这里会直接失败而不是静默降级
      rejectUnauthorized: true,
    });

    const remain = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new TunnelError(`与 ${servername} 的 TLS 握手超时`, 'timeout'));
    }, remain);

    secure.once('error', (err) => {
      clearTimeout(timer);
      secure.destroy();
      reject(new TunnelError(`与 ${servername} 的 TLS 握手失败: ${err.message}`, stage));
    });

    secure.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secure);
    });
  });
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`;
}

async function httpConnect(
  socket: net.Socket,
  target: TunnelTarget,
  auth: { username: string; password?: string } | undefined,
  deadline: number,
): Promise<void> {
  const reader = new SocketReader(socket);
  try {
    const hostPort = `${target.host}:${target.port}`;
    const lines = [`CONNECT ${hostPort} HTTP/1.1`, `Host: ${hostPort}`];
    if (auth) lines.push(`Proxy-Authorization: ${basicAuth(auth.username, auth.password ?? '')}`);
    lines.push('Proxy-Connection: keep-alive', '', '');
    socket.write(lines.join('\r\n'));

    const head = await reader.readUntil(Buffer.from('\r\n\r\n'), 8192, deadline, 'CONNECT 响应');
    const statusLine = head.toString('latin1').split('\r\n')[0] ?? '';
    const code = Number(statusLine.split(' ')[1]);
    if (code === 200) return;
    if (code === 407) throw new TunnelError(`代理要求重新认证（407）`, 'proxy-auth');
    throw new TunnelError(`代理拒绝 CONNECT：${statusLine.trim() || '响应不合法'}`, 'target-connect');
  } finally {
    reader.detach();
  }
}

async function socks5Connect(
  socket: net.Socket,
  target: TunnelTarget,
  auth: { username: string; password?: string } | undefined,
  deadline: number,
): Promise<void> {
  const reader = new SocketReader(socket);
  try {
    const useAuth = Boolean(auth?.username);
    socket.write(Buffer.from(useAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));

    const greeting = await reader.readExactly(2, deadline, 'SOCKS5 握手');
    if (greeting[0] !== 0x05) throw new TunnelError(`不是 SOCKS5 代理（版本字节 ${greeting[0]}）`, 'proxy-connect');
    const method = greeting[1]!;
    if (method === 0xff) throw new TunnelError('代理不接受任何认证方式', 'proxy-auth');

    if (method === 0x02) {
      if (!auth?.username) throw new TunnelError('代理要求用户名密码，但未配置', 'proxy-auth');
      const user = Buffer.from(auth.username, 'utf-8');
      const pass = Buffer.from(auth.password ?? '', 'utf-8');
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const [, status] = await reader.readExactly(2, deadline, 'SOCKS5 认证');
      if (status !== 0x00) throw new TunnelError('SOCKS5 用户名或密码被拒绝', 'proxy-auth');
    }

    const host = Buffer.from(target.host, 'utf-8');
    const port = Buffer.alloc(2);
    port.writeUInt16BE(target.port, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));

    const reply = await reader.readExactly(4, deadline, 'SOCKS5 连接响应');
    const code = reply[1]!;
    if (code !== 0x00) {
      throw new TunnelError(`SOCKS5 连接失败：${SOCKS5_ERRORS[code] ?? `错误码 0x${code.toString(16)}`}`, 'target-connect');
    }

    // BND.ADDR 长度依地址类型而定，必须读掉，否则残留字节会污染后续 HTTP 响应
    const atyp = reply[3]!;
    if (atyp === 0x01) {
      await reader.readExactly(4 + 2, deadline, 'SOCKS5 绑定地址');
    } else if (atyp === 0x04) {
      await reader.readExactly(16 + 2, deadline, 'SOCKS5 绑定地址');
    } else if (atyp === 0x03) {
      const len = await reader.readExactly(1, deadline, 'SOCKS5 绑定地址');
      await reader.readExactly(len[0]! + 2, deadline, 'SOCKS5 绑定地址');
    } else {
      throw new TunnelError(`SOCKS5 返回了未知地址类型 0x${atyp.toString(16)}`, 'target-connect');
    }
  } finally {
    reader.detach();
  }
}

/**
 * 建一条穿过代理到目标的 TCP 通道。
 *
 * 不使用 undici 的 ProxyAgent：它不支持 SOCKS5，而 socks5 恰恰是这类
 * 业务里最常见的协议。自己实现握手反而少一层依赖，也便于把失败原因
 * 定位到具体阶段。
 */
export async function openTunnel(
  proxy: ProxyEndpoint,
  target: TunnelTarget,
  deadline: number,
): Promise<{ socket: net.Socket; via: ProxyProtocol }> {
  let socket = await tcpConnect(proxy.host, proxy.port, deadline);

  try {
    if (proxy.protocol === 'https') {
      const secure = await upgradeTls(socket, proxy.host, deadline, 'proxy-tls');
      socket = secure;
      await httpConnect(socket, target, proxyAuth(proxy), deadline);
    } else if (proxy.protocol === 'http') {
      await httpConnect(socket, target, proxyAuth(proxy), deadline);
    } else {
      await socks5Connect(socket, target, proxyAuth(proxy), deadline);
    }
    return { socket, via: proxy.protocol };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function proxyAuth(proxy: ProxyEndpoint): { username: string; password?: string } | undefined {
  return proxy.username ? { username: proxy.username, password: proxy.password } : undefined;
}

export { upgradeTls };
