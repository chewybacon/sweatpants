import { resolve } from "node:path";
import { getPlatformProxy } from "wrangler";

export interface WranglerTaskOptions {
  config?: string;
  environment?: string;
  /** Wrangler's --persist-to directory, without its automatically appended /v3. */
  persistTo?: string;
  /** Allow bindings explicitly marked remote in the Wrangler config. Defaults to false. */
  remoteBindings?: boolean;
}

export interface WranglerTaskContext<Env> {
  env: Env;
  args: string[];
}

export type WranglerTask<Env> = (context: WranglerTaskContext<Env>) => void | Promise<void>;

/** Bindings are valid only during the callback; always release the underlying workerd. */
export async function withWranglerEnv<Env, Result = void>(
  options: WranglerTaskOptions,
  task: (env: Env) => Result | Promise<Result>,
): Promise<Result> {
  const platform = await getPlatformProxy<Env>({
    configPath: options.config,
    environment: options.environment,
    persist: options.persistTo ? { path: resolve(options.persistTo, "v3") } : true,
    remoteBindings: options.remoteBindings ?? false,
  });
  try {
    return await task(platform.env);
  } finally {
    await platform.dispose();
  }
}
