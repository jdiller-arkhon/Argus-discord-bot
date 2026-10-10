# Build from the repository root:
#   docker build -f bots/argus/Dockerfile -t arkhon/argus-bot .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY bots/argus/package.json bots/argus/

# better-sqlite3 is native. When no prebuilt binary matches this Node version it
# compiles, which needs a toolchain; the headers come from the image itself.
FROM base AS toolchain
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV npm_config_nodedir=/usr/local

FROM toolchain AS build
RUN pnpm install --frozen-lockfile --filter "@arkhon/argus-bot..."
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/
COPY bots/argus/src bots/argus/src
COPY bots/argus/tsconfig.json bots/argus/
RUN pnpm exec tsc -b bots/argus

FROM toolchain AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@arkhon/argus-bot..."

# The runtime image has no compiler: only the installed dependencies are copied in.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=prod-deps /app/bots/argus/node_modules bots/argus/node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/bots/argus/dist bots/argus/dist
COPY bots/argus/faq.json bots/argus/
COPY --chmod=755 bots/argus/docker-entrypoint.sh /usr/local/bin/argus-entrypoint
RUN mkdir -p /app/data && chown node:node /app/data
WORKDIR /app/bots/argus
ENV ARGUS_DB_PATH=/app/data/argus.sqlite
EXPOSE 8080
VOLUME ["/app/data"]
# Starts as root only to give `node` the data directory, then runs as `node`.
ENTRYPOINT ["argus-entrypoint"]
CMD ["node", "dist/index.js"]
