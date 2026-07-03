FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js eslint.config.js ./
COPY src ./src
COPY views ./views
COPY public ./public

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000

CMD ["node", "server.js"]
