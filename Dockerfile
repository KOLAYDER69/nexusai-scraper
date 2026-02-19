FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

# Install Playwright Chromium + ALL required system dependencies
RUN npx playwright install --with-deps chromium

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

CMD ["node", "dist/index.js"]
