# syntax=docker/dockerfile:1.6
#
# DM Capital backend — single-stage image.
# Runs migrations on container start, then boots the Node service.
# SQLite database lives under /data (mounted as a Fly volume in production).
#
# Use Debian slim (not Alpine): Prisma's query engine needs OpenSSL 3 on glibc.
# Alpine/musl + OpenSSL is a common source of "Error load..." at migrate deploy.
FROM node:20-slim

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.6.5 --activate

WORKDIR /app

# Dependency layer (cached unless lockfile changes)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# Source + build
COPY tsconfig.json ./
COPY src ./src
COPY docker-start.sh ./
RUN chmod +x docker-start.sh
RUN DATABASE_URL_DURABLE="postgresql://user:pass@localhost:5432/dm_capital?sslmode=require" \
    DIRECT_URL_DURABLE="postgresql://user:pass@localhost:5432/dm_capital?sslmode=require" \
    pnpm prisma:generate:all
RUN pnpm build

# Volume mount target
RUN mkdir -p /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATABASE_URL="file:/data/dm-capital.db"

EXPOSE 4000

# Apply pending local SQLite migrations (self-healing), then start the service.
# Durable Neon migrations are run explicitly via pnpm prisma:deploy:durable.
CMD ["./docker-start.sh"]
