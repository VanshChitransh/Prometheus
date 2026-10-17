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
# Root on purpose: the state/ bind mount is root-owned. `node`, not `npm run`, so SIGTERM reaches it.
CMD ["node", "relay/index.ts"]
