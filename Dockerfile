# Supertext Plugin Health — production image (Railway).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# The app bundles postgres into its chunks; the migration script needs the package itself (no dependencies).
COPY --from=build --chown=node:node /app/node_modules/postgres ./node_modules/postgres
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build --chown=node:node /app/src/lib/db-url.mjs ./src/lib/db-url.mjs
USER node
EXPOSE 8080
# Migrations first (creates COMMANDO_DB_NAME on a shared server if needed), then the app.
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node server.js"]
