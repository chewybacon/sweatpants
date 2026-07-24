import type { Operation } from "effection";
import {
  type DurableEffectContext,
  type DurableEffectRegistration,
} from "@sweatpants/session-contract";
import type { WorkspaceConnector, WorkspaceFence } from "@sweatpants/workspace-runtime";

import { workspace } from "../capabilities/workspace.ts";

export interface WorkspaceEffectBinding {
  readonly connector: WorkspaceConnector;
  readonly fence: WorkspaceFence;
}

export interface WorkspaceEffectAdapterOptions {
  readonly resolve: (context: DurableEffectContext) => Operation<WorkspaceEffectBinding>;
}

/**
 * Implements the authored workspace extension over one dynamically resolved,
 * fenced connector. The generic extension owns registration and middleware;
 * this provider contains only workspace protocol adaptation.
 */
export function createWorkspaceEffectRegistrations(
  options: WorkspaceEffectAdapterOptions,
): readonly DurableEffectRegistration[] {
  return workspace.implement({
    name: "yo-studio-workspace-provider",
    methods: {
      *inspect(_input, context) {
        const binding = yield* options.resolve(context);
        const response = yield* binding.connector.request({
          protocolVersion: 1,
          type: "inspect",
          fence: binding.fence,
          operationId: context.pullId,
        });
        if (response.type !== "inspect-result") {
          throw new Error("workspace inspect returned the wrong response type");
        }
        return response;
      },
      *readFile(input, context) {
        const binding = yield* options.resolve(context);
        const response = yield* binding.connector.request({
          protocolVersion: 1,
          type: "read",
          fence: binding.fence,
          operationId: context.pullId,
          workspaceVersion: input.workspaceVersion,
          path: input.path,
        });
        if (response.type !== "read-result") {
          throw new Error("workspace read returned the wrong response type");
        }
        return response;
      },
      *list(input, context) {
        const binding = yield* options.resolve(context);
        const response = yield* binding.connector.request({
          protocolVersion: 1,
          type: "list",
          fence: binding.fence,
          operationId: context.pullId,
          workspaceVersion: input.workspaceVersion,
          path: input.path,
        });
        if (response.type !== "list-result") {
          throw new Error("workspace list returned the wrong response type");
        }
        return { ...response, entries: [...response.entries] };
      },
      *writeFile(input, context) {
        const binding = yield* options.resolve(context);
        const response = yield* binding.connector.request({
          protocolVersion: 1,
          type: "write",
          fence: binding.fence,
          operationId: context.pullId,
          workspaceVersion: input.expectedWorkspaceVersion,
          path: input.path,
          content: input.content,
        });
        if (response.type !== "write-result") {
          throw new Error("workspace write returned the wrong response type");
        }
        return response;
      },
      *runScript(input, context) {
        const binding = yield* options.resolve(context);
        const response = yield* binding.connector.request({
          protocolVersion: 1,
          type: "run-script",
          fence: binding.fence,
          operationId: context.pullId,
          workspaceVersion: input.workspaceVersion,
          script: input.script,
        });
        if (response.type !== "script-result") {
          throw new Error("workspace script returned the wrong response type");
        }
        return response;
      },
    },
  }).registrations;
}
