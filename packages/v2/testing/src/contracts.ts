export interface Latch<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export interface ProtocolRequest {
  readonly id: string;
  readonly token: string;
}

export interface ProtocolReply {
  readonly status: number;
  readonly body: string;
}

export interface ProtocolRig {
  readonly requests: readonly ProtocolRequest[];
  readonly aborted: readonly string[];
  send(request: ProtocolRequest, signal: AbortSignal): Promise<ProtocolReply>;
  waitForRequests(count: number): Promise<void>;
  reply(id: string, reply: ProtocolReply): void;
  fail(id: string, error: Error): void;
}
