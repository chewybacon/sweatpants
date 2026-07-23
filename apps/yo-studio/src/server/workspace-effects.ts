import { effectRuntimeValidators } from "@sweatpants/core";
import {
  createDurableEffectRegistration,
  type DurableEffectContext,
  type DurableEffectRegistration,
} from "@sweatpants/session-contract";
import type { WorkspaceConnector, WorkspaceFence } from "@sweatpants/workspace-runtime";

import {
  inspectWorkspace,
  listWorkspace,
  readWorkspaceFile,
  runWorkspaceScript,
  writeWorkspaceFile,
} from "../capabilities/workspace.ts";

export interface WorkspaceEffectAdapterOptions {
  readonly connector: WorkspaceConnector;
  readonly fenceFor: (context: DurableEffectContext) => WorkspaceFence;
}

/**
 * Binds authored workspace contracts to one fenced finite-HTTP connector.
 * Program code remains provider-neutral and the connector receives no journal
 * capability or terminal authority.
 */
export function createWorkspaceEffectRegistrations(
  options: WorkspaceEffectAdapterOptions,
): readonly DurableEffectRegistration[] {
  return [
    createDurableEffectRegistration(
      inspectWorkspace,
      { mode: "idempotent", mechanism: "inherent" },
      function* (_input, context) {
        const response = yield* options.connector.request({
          protocolVersion: 1,
          type: "inspect",
          fence: options.fenceFor(context),
          operationId: context.pullId,
        });
        if (response.type !== "inspect-result") {
          throw new Error("workspace inspect returned the wrong response type");
        }
        return { status: "ok", value: response };
      },
      effectRuntimeValidators(inspectWorkspace),
    ),
    createDurableEffectRegistration(
      readWorkspaceFile,
      { mode: "idempotent", mechanism: "inherent" },
      function* (input, context) {
        const response = yield* options.connector.request({
          protocolVersion: 1,
          type: "read",
          fence: options.fenceFor(context),
          operationId: context.pullId,
          workspaceVersion: input.workspaceVersion,
          path: input.path,
        });
        if (response.type !== "read-result") {
          throw new Error("workspace read returned the wrong response type");
        }
        return { status: "ok", value: response };
      },
      effectRuntimeValidators(readWorkspaceFile),
    ),
    createDurableEffectRegistration(
      listWorkspace,
      { mode: "idempotent", mechanism: "inherent" },
      function* (input, context) {
        const response = yield* options.connector.request({
          protocolVersion: 1,
          type: "list",
          fence: options.fenceFor(context),
          operationId: context.pullId,
          workspaceVersion: input.workspaceVersion,
          path: input.path,
        });
        if (response.type !== "list-result") {
          throw new Error("workspace list returned the wrong response type");
        }
        return { status: "ok", value: { ...response, entries: [...response.entries] } };
      },
      effectRuntimeValidators(listWorkspace),
    ),
    createDurableEffectRegistration(
      writeWorkspaceFile,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (input, context) {
        const response = yield* options.connector.request({
          protocolVersion: 1,
          type: "write",
          fence: options.fenceFor(context),
          operationId: context.pullId,
          workspaceVersion: input.expectedWorkspaceVersion,
          path: input.path,
          content: input.content,
        });
        if (response.type !== "write-result") {
          throw new Error("workspace write returned the wrong response type");
        }
        return { status: "ok", value: response };
      },
      effectRuntimeValidators(writeWorkspaceFile),
    ),
    createDurableEffectRegistration(
      runWorkspaceScript,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (input, context) {
        const response = yield* options.connector.request({
          protocolVersion: 1,
          type: "run-script",
          fence: options.fenceFor(context),
          operationId: context.pullId,
          workspaceVersion: input.workspaceVersion,
          script: input.script,
        });
        if (response.type !== "script-result") {
          throw new Error("workspace script returned the wrong response type");
        }
        return { status: "ok", value: response };
      },
      effectRuntimeValidators(runWorkspaceScript),
    ),
  ];
}
