# Build from inside bot/: docker build -t khub-bot .
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/data && chown -R node:node /app
COPY --chown=node:node src ./src
COPY --chown=node:node catalog ./catalog
USER node
CMD ["node", "src/supervisor.mjs"]
