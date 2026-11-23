import type * as net from 'node:net';
import type { SocketReader } from './socket-reader.ts';

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const CRLF = Buffer.from('\r\n');
const HEAD_END = Buffer.from('\r\n\r\n');

export interface HttpRequestSpec {
  host: string;
  path: string;
  userAgent?: string;
  headers?: Record<string, string>;
}

/**
 * 在已建立的通道上发一个最小 HTTP/1.1 GET。
 *
 * 刻意不用 node:http：那套 API 需要把 socket 塞进 agent/createConnection，
 * 与「已经做过握手/TLS 的自定义 socket」配合时行为不透明。这里只发一行
 * 请求、解析一次响应，代码量比调试 agent 还少。
 *
 * 固定 `Accept-Encoding: identity`：不做 gzip 解压，响应体就是明文。
 */
export function writeHttpGet(socket: net.Socket, spec: HttpRequestSpec): void {
  const lines = [
    `GET ${spec.path} HTTP/1.1`,
    `Host: ${spec.host}`,
    `User-Agent: ${spec.userAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}`,
    'Accept: application/json, text/plain, */*',
    'Accept-Encoding: identity',
    'Connection: close',
  ];
  for (const [key, value] of Object.entries(spec.headers ?? {})) lines.push(`${key}: ${value}`);
  lines.push('', '');
  socket.write(lines.join('\r\n'));
}

async function readChunked(reader: SocketReader, deadline: number, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const line = await reader.readUntil(CRLF, 1024, deadline, 'chunk 长度');
    const size = Number.parseInt(line.toString('latin1').trim(), 16);
    if (!Number.isFinite(size)) throw new Error('chunked 响应的长度字段损坏');
    if (size === 0) {
      // 末尾可能是空行，也可能是 trailer，读到空行为止
      const trailer = await reader.readUntil(CRLF, 2048, deadline, 'chunk 结束');
      if (trailer.length > 2) {
        await reader.readUntil(CRLF, 2048, deadline, 'chunk trailer 结束');
      }
      break;
    }
    const chunk = await reader.readExactly(size, deadline, 'chunk 数据');
    await reader.readExactly(2, deadline, 'chunk 分隔符');
    parts.push(chunk);
    total += size;
    if (total > maxBytes) throw new Error(`响应体超过 ${maxBytes} 字节`);
  }
  return Buffer.concat(parts);
}

export async function readHttpResponse(
  reader: SocketReader,
  deadline: number,
  maxBytes = 64 * 1024,
): Promise<HttpResult> {
  const head = await reader.readUntil(HEAD_END, 16 * 1024, deadline, 'HTTP 响应头');
  const text = head.toString('latin1');
  const lines = text.split('\r\n');
  const statusLine = lines[0] ?? '';
  const status = Number(statusLine.split(' ')[1]);
  if (!Number.isFinite(status)) throw new Error(`HTTP 响应状态行不合法: ${statusLine.slice(0, 80)}`);

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  let body: Buffer;
  if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
    body = await readChunked(reader, deadline, maxBytes);
  } else if (headers['content-length']) {
    const length = Number(headers['content-length']);
    body = await reader.readExactly(length, deadline, 'HTTP 响应体');
  } else {
    body = await reader.readToEnd(maxBytes, deadline, 'HTTP 响应体');
  }

  return { status, headers, body: body.toString('utf-8') };
}
