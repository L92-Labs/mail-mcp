FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY apps/node/package.json apps/node/
RUN pnpm install --frozen-lockfile=false
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/node apps/node
RUN pnpm --filter @mail-mcp/core build && pnpm --filter @mail-mcp/node build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV PORT=8787
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core ./packages/core
COPY --from=build /app/apps/node ./apps/node
EXPOSE 8787
CMD ["node", "apps/node/dist/index.js"]
