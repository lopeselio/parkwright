# Build the web client, then run the Node server (which serves it) on Node 24 with native TS type stripping.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/content/package.json packages/content/
COPY packages/sim/package.json packages/sim/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @parkwright/web build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web
COPY --from=build /app/apps/web/dist /app/web
COPY apps/server/src /app/server/src
COPY apps/server/package.json /app/server/
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 8080
CMD ["node", "server/src/main.ts"]
