// A minimal Chrome DevTools Protocol client over Bun's built-in WebSocket.
// It speaks flat sessions: one browser socket, with a sessionId on each page or iframe message.

const COMMAND_TIMEOUT_MS = 30_000;

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (message) => this.receive(String(message.data)));
    socket.addEventListener("close", () => this.failAll(new Error("DevTools connection closed")));
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
  }

  /** Sends a command and resolves with its result. Rejects on a protocol error or timeout. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Subscribes to protocol events. Returns a function that unsubscribes. */
  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }

  private receive(data: string): void {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } } & Partial<CdpEvent>;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? "protocol error"}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
      for (const listener of this.listeners) listener(event);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
