FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps apps
RUN npm run build

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/db apps/api/db
COPY scripts/verify-runtime.mjs scripts/verify-runtime.mjs
# Fail the actual runtime image build if a native/optional parser dependency is missing.
RUN node scripts/verify-runtime.mjs
USER node
EXPOSE 3000
CMD ["node","apps/api/dist/main.js"]

FROM nginx:1.28-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
