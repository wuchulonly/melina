// SSE 的解析。
// 按字节流喂进来，块切在哪里都行；空行分隔消息，data 多行时用换行接起来。

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

export class SseParser {
  #buffer = '';
  #data: string[] = [];
  #id: string | undefined;
  #event: string | undefined;
  #skipLf = false; // 上一块以 \r 结尾：下一块开头的 \n 是同一个换行
  readonly #onMessage: (m: SseMessage) => void;

  constructor(onMessage: (m: SseMessage) => void) {
    this.#onMessage = onMessage;
  }

  push(chunk: string): void {
    let text = chunk;
    if (this.#skipLf && text.length > 0) {
      if (text.startsWith('\n')) text = text.slice(1);
      this.#skipLf = false;
    }
    this.#buffer += text;
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.#buffer);
      if (!match) return;
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      if (match[0] === '\r' && this.#buffer.length === 0) this.#skipLf = true;
      this.#line(line);
    }
  }

  #line(line: string): void {
    if (line === '') {
      if (this.#data.length > 0) {
        const message: SseMessage = { data: this.#data.join('\n') };
        if (this.#id !== undefined) message.id = this.#id;
        if (this.#event !== undefined) message.event = this.#event;
        this.#onMessage(message);
      }
      this.#data = [];
      this.#event = undefined;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'id') this.#id = value;
    else if (field === 'event') this.#event = value;
  }
}
