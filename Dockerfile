# syntax=docker/dockerfile:1

# The DS1821+ is x86-64, so no cross-building is needed. Pin the platform anyway
# so an image built on an arm laptop still runs on the NAS.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime

# There are no runtime dependencies: the app uses nothing outside node's own
# standard library, so the image carries dist and nothing else. No npm install
# here, and nothing in node_modules to audit.
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./

# The queue and the OAuth grants live here. Mount a volume over it.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DESK_DATA_DIR=/data \
    SHIM_HOST=0.0.0.0 \
    SHIM_PORT=4040 \
    NODE_ENV=production

# The container talks to Ghost directly. The ghst transport would need the CLI
# installed and a network hop through it for no gain inside a long-running
# service.
ENV DESK_TRANSPORT=direct

USER node
EXPOSE 4040
VOLUME ["/data"]

# nodeinfo needs neither a token nor a reachable Ghost, which makes it the one
# honest liveness probe: it answers if and only if the process is serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SHIM_PORT||4040)+'/.well-known/nodeinfo').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["shim", "--with-runner"]
