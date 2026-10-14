import type { Json } from "@sweatpants/foundation";

export interface DocumentCommandRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly input: Json;
}
