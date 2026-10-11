FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/package.json ./web/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --from=build --chown=node:node /app/docs ./docs
# NAS ACLs can expose source files with mode 000; normalize image permissions.
RUN chmod -R a=rX /app && mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/v1/health').then(r => {if(!r.ok) process.exit(1)}).catch(() => process.exit(1))"
CMD ["node", "server/dist/index.js"]
