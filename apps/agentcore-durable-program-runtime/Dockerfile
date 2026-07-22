FROM node:22-bookworm-slim AS build

WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages ./packages
COPY apps/agentcore-durable-program-runtime ./apps/agentcore-durable-program-runtime
COPY apps/yo-chat/package.json ./apps/yo-chat/package.json
COPY apps/yo-chat/src/server/agentcore-durable-programs.ts ./apps/yo-chat/src/server/agentcore-durable-programs.ts
COPY apps/yo-chat/src/tools/pick-card ./apps/yo-chat/src/tools/pick-card
COPY apps/yo-chat/src/tools/play-ttt/tool.ts ./apps/yo-chat/src/tools/play-ttt/tool.ts
COPY apps/yo-chat/src/tools/tictactoe/types.ts ./apps/yo-chat/src/tools/tictactoe/types.ts

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sweatpants/session-contract build \
 && pnpm --filter @sweatpants/core build \
 && pnpm -C packages/tool-runtime-agentcore exec tsup \
 && pnpm --filter @sweatpants/agentcore-durable-program-runtime build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /repo/apps/agentcore-durable-program-runtime/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.cjs"]
