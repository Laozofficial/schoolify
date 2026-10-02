# syntax=docker/dockerfile:1.7

# Pinned: Node 24.21 breaks jsonschema 1.5 ($ref resolution throws "Invalid URL"),
# which makes every app ace command (incl. `node ace worker`) fail to load.
ARG NODE_VERSION=24.18.0-alpine

# ---------- deps ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node ace build --ignore-ts-errors

# ---------- production deps ----------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./
EXPOSE 3333
CMD ["node", "bin/server.js"]

# ---------- dev ----------
FROM node:${NODE_VERSION} AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 3333
CMD ["npm", "run", "dev"]
