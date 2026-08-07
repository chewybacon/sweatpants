/** Provider response identity shared by the canonical model and adapter-facing response contracts. */
export interface ModelResponseSource {
  api: string;
  provider: string;
  model: string;
  responseModel: string | null;
}
