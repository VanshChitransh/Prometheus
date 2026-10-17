# One image for the worker and the relay; compose.yaml picks the entrypoint.
# Node 24 runs the .ts sources directly (type stripping), so there is no build step.
FROM node:24.10-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Only the runtime folders: .env* and state/ can never end up in the image.
COPY shared shared
COPY worker worker
COPY relay relay
# The commit, shown as the worker entity's `version` ("dev" without it):
# docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) …
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
# The docs assistant (relay/ask.ts) answers from these.
COPY web/docs web/docs
COPY web/src/docsMeta.ts web/src/docsMeta.ts
# Root on purpose: the state/ bind mount is root-owned. `node`, not `npm run`, so SIGTERM reaches it.
CMD ["node", "relay/index.ts"]
