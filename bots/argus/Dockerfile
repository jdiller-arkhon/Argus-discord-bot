# Build from the repository root:
#   docker build -f bots/argus/Dockerfile -t arkhon/argus-bot .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY bots/argus/package.json bots/argus/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@arkhon/argus-bot..."
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/
COPY bots/argus/src bots/argus/src
COPY bots/argus/tsconfig.json bots/argus/
RUN pnpm exec tsc -b bots/argus

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter "@arkhon/argus-bot..." && pnpm store prune
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/bots/argus/dist bots/argus/dist
COPY bots/argus/faq.json bots/argus/
RUN mkdir -p /app/data && chown node:node /app/data
USER node
WORKDIR /app/bots/argus
ENV ARGUS_DB_PATH=/app/data/argus.sqlite
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
