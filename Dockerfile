# Build the web client, install the server's production deps, then run the Node server (which serves the client)
# on Node 24 with TypeScript transform (enums and parameter properties need more than type stripping).
# Workspace packages stay outside node_modules (pnpm symlinks them), which Node requires for TS loading.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/content/package.json packages/content/
COPY packages/sim/package.json packages/sim/
COPY packages/chain/package.json packages/chain/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @parkwright/web build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @parkwright/server...

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
WORKDIR /app
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web SAVES_DIR=/tmp/saves
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/server/node_modules /app/apps/server/node_modules
COPY --from=prod-deps /app/packages/sim/node_modules /app/packages/sim/node_modules
COPY --from=prod-deps /app/packages/chain/node_modules /app/packages/chain/node_modules
COPY package.json /app/
COPY packages/content/package.json /app/packages/content/
COPY packages/content/src /app/packages/content/src
COPY packages/sim/package.json /app/packages/sim/
COPY packages/sim/src /app/packages/sim/src
COPY packages/chain/package.json /app/packages/chain/
COPY packages/chain/src /app/packages/chain/src
COPY apps/server/package.json /app/apps/server/
COPY apps/server/src /app/apps/server/src
COPY --from=build /app/apps/web/dist /app/web
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 8080
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "apps/server/src/main.ts"]
