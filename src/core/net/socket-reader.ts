import type * as net from 'node:net';

/**
 * 带缓冲的 socket 读取器。
 *
 * 为什么要自己写：代理握手（CONNECT / SOCKS5）要求「读满 N 字节」和
 * 「读到分隔符为止」两种语义，Node 的流接口给的是 chunk 事件，直接拼字符串
 * 很容易在握手响应跨 chunk 时解析错。这里把已到达但还没消费的字节留住，
 * 后续 HTTP 响应解析继续复用同一份缓冲，不会丢字节。
 */
export class SocketReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private failure?: Error;
  private waiter?: () => void;
  /** 每次有字节到达或状态变化就自增，用来区分"真的等到新数据"和"定时器到点" */
  private sequence = 0;

  private readonly onData: (chunk: Buffer) => void;
  private readonly onEnd: () => void;
  private readonly onError: (err: Error) => void;

  constructor(private readonly socket: net.Socket) {
    this.onData = (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.sequence += 1;
      this.wake();
    };
    this.onEnd = () => {
      this.ended = true;
      this.sequence += 1;
      this.wake();
    };
    this.onError = (err) => {
      this.failure = err;
      this.sequence += 1;
      this.wake();
    };
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('error', this.onError);
  }

  /** 交接给别的消费者（比如交给 tls.connect）前必须调用，否则会抢字节 */
  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('error', this.onError);
  }

  get pending(): number {
    return this.buffer.length;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /**
   * 等到「有新数据到达」或「对端结束」或「超时」。
   *
   * 必须用序号判断有没有新数据，不能用 buffer.length > 0。
   * 踩过的坑：早先写成"buffer 非空就直接返回"，在数据分批到达时
   * `while (buffer.length < n) awaitMore()` 会变成微任务空转——
   * 既不推进也不让出事件循环，定时器永远不触发，整个进程卡死且没有报错。
   * 而且它只在包被拆开时触发，http 代理测试能过、socks5 就挂，极难复现。
   */
  private async waitSignal(deadline: number, what: string): Promise<void> {
    if (this.ended || this.failure) return;
    const remain = deadline - Date.now();
    if (remain <= 0) throw new Error(`${what} 超时`);

    const seq = this.sequence;
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
      timer = setTimeout(resolve, remain);
    });
    if (timer) clearTimeout(timer);

    if (this.sequence === seq && !this.ended && !this.failure) throw new Error(`${what} 超时`);
  }

  /** 单独抽成方法，避开 TS 控制流分析把字段窄化成 never 的问题 */
  private throwIfStalled(what: string): void {
    const failure = this.failure;
    if (failure) throw new Error(`${what} 失败: ${failure.message}`);
    if (this.ended) throw new Error(`${what} 失败: 对端提前关闭连接`);
  }

  async readExactly(n: number, deadline: number, what: string): Promise<Buffer> {
    while (this.buffer.length < n) {
      this.throwIfStalled(what);
      await this.waitSignal(deadline, what);
    }
    const out = Buffer.from(this.buffer.subarray(0, n));
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** 返回内容包含分隔符本身，与 HTTP 头解析的习惯一致 */
  async readUntil(delimiter: Buffer, maxBytes: number, deadline: number, what: string): Promise<Buffer> {
    for (;;) {
      const index = this.buffer.indexOf(delimiter);
      if (index >= 0) {
        const end = index + delimiter.length;
        const out = Buffer.from(this.buffer.subarray(0, end));
        this.buffer = this.buffer.subarray(end);
        return out;
      }
      if (this.buffer.length > maxBytes) {
        throw new Error(`${what} 失败: 超过 ${maxBytes} 字节仍未出现分隔符`);
      }
      this.throwIfStalled(what);
      await this.waitSignal(deadline, what);
    }
  }

  /** 读到对端 FIN 为止（用于没有 content-length 的响应） */
  async readToEnd(maxBytes: number, deadline: number, what: string): Promise<Buffer> {
    while (!this.ended) {
      this.throwIfStalled(what);
      if (this.buffer.length > maxBytes) {
        throw new Error(`${what} 失败: 响应体超过 ${maxBytes} 字节`);
      }
      await this.waitSignal(deadline, what);
    }
    this.throwIfStalled(what);
    const out = Buffer.from(this.buffer);
    this.buffer = Buffer.alloc(0);
    return out;
  }
}
