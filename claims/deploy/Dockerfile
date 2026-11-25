FROM docker.io/library/node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 git ca-certificates pkg-config tini \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.28.5 && npm cache clean --force
WORKDIR /app/deepseek-harness
RUN mkdir -p /data/harness && chown -R node:node /app/deepseek-harness /data
COPY --chown=node:node *.json *.yaml *.yml *.ts LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node apps ./apps
COPY --chown=node:node packages ./packages
COPY --chown=node:node native ./native
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node vendor ./vendor
COPY --chown=node:node benchmarks ./benchmarks
COPY --chown=node:node website ./website
COPY --chown=node:node python ./python
COPY --chown=node:node patches ./patches
COPY --chown=node:node docs ./docs
USER node
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=true \
    PNPM_CONFIG_STORE_DIR=/tmp/claims-pnpm-store pnpm install --frozen-lockfile \
    && rm -rf /tmp/claims-pnpm-store
ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH
RUN pnpm run build:artifacts

COPY --chown=node:node claims/package.json claims/package-lock.json ./claims/
COPY --chown=node:node claims/worker/package.json claims/worker/package-lock.json ./claims/worker/
RUN npm --prefix claims ci --workspaces=false --ignore-scripts --no-audit --no-fund
RUN npm --prefix claims/worker ci --workspaces=false --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node claims ./claims
RUN npm --prefix claims run build:review

# The runtime needs the compiled workspace. Avoid a second copy of the entire pnpm tree.
USER root
RUN apt-get purge -y --auto-remove build-essential python3 git pkg-config
USER node
ENV NODE_ENV=production DSH_HOME=/data/harness DSH_TELEMETRY_DISABLED=1
ENTRYPOINT ["/usr/bin/tini", "--", "node", "claims/runtime/launch.mjs"]
