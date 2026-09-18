# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY server.js .
COPY service-account-key.json .

# MCP server runs on stdin/stdout
# The port is not used by MCP, but Cloud Run requires PORT env var
ENV PORT=8080
ENV SERVICE_ACCOUNT_KEY_PATH=/app/service-account-key.json

# Cloud Run Health Check: a simple endpoint that returns 200
# (MCP server uses stdio, not HTTP, but Cloud Run needs HTTP health check)
EXPOSE 8080

# Start the MCP server
CMD ["node", "server.js"]
