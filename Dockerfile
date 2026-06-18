# syntax=docker/dockerfile:1.6
#
# QOP Terminal backend — single-stage image.
# Runs migrations on container start, then boots the Node service.
# SQLite database lives under /data (mounted as a Fly volume in production).
#
FROM node:20-alpine

# Pin pnpm via corepack so build script behaviour matches local.
RUN corepack enable && corepack prepare pnpm@10.6.5 --activate

WORKDIR /app

# Dependency layer (cached unless lockfile changes)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# Source + build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm prisma generate
RUN pnpm build

# Volume mount target
RUN mkdir -p /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATABASE_URL="file:/data/qop.db"

EXPOSE 4000

# Apply any pending Prisma migrations, then start the server.
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/index.js"]
