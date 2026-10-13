FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 8787

CMD ["sh", "-c", "npx wrangler d1 migrations apply dombook-saas --local && npx wrangler dev --ip 0.0.0.0 --port 8787"]
