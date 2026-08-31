FROM node:24-alpine

WORKDIR /app

# Install dependencies first so the layer caches across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Migrations run at boot so `docker compose up` is genuinely the one command.
CMD ["sh", "-c", "npm run migrate && npm start"]
