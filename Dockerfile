# syntax=docker/dockerfile:1

# --- Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
# NODE_AUTH_TOKEN is mounted as a BuildKit secret — never written to any image layer.
# The secret is only available during this RUN step and cannot be extracted via docker history.
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN=$(cat /run/secrets/node_auth_token) npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Production Stage ---
FROM node:20-alpine AS production
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
# NODE_AUTH_TOKEN is mounted as a BuildKit secret — never written to any image layer.
# The secret is only available during this RUN step and cannot be extracted via docker history.
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN=$(cat /run/secrets/node_auth_token) npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist

ARG GIT_COMMIT_SHA=unknown
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

USER appuser

# No HEALTHCHECK -- workers monitored by process status and ValKey heartbeat
# No EXPOSE -- workers don't serve HTTP

CMD ["node", "dist/index.js"]
