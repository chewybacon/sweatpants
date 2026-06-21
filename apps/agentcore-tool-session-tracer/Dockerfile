FROM node:22-bookworm-slim AS build

WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/agentcore-tool-session-tracer ./apps/agentcore-tool-session-tracer
COPY apps/yo-chat/package.json ./apps/yo-chat/package.json
COPY apps/yo-chat/src/__generated__/agentcore-tool-registry.gen.ts ./apps/yo-chat/src/__generated__/agentcore-tool-registry.gen.ts
COPY apps/yo-chat/src/tools ./apps/yo-chat/src/tools

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sweatpants/agentcore-tool-session-tracer build

FROM node:22-bookworm-slim AS runtime

WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=8080
RUN corepack enable

COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/agentcore-tool-session-tracer ./apps/agentcore-tool-session-tracer
COPY --from=build /repo/node_modules ./node_modules

WORKDIR /repo/apps/agentcore-tool-session-tracer
EXPOSE 8080
CMD ["node", "dist/index.js"]
