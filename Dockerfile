FROM node:20-alpine

WORKDIR /app

# Install root deps (concurrently)
COPY package*.json ./
RUN npm ci

# Install server deps (including devDeps for tsx)
COPY server/package*.json ./server/
RUN cd server && npm ci

# Install web deps
COPY web/package*.json ./web/
RUN cd web && npm ci

# Copy source
COPY server/ ./server/
COPY web/ ./web/

# Build web frontend (outputs to server/public/)
RUN cd web && npm run build

# Download 3D model assets (Git LFS files can't be copied from repo directly)
RUN mkdir -p server/public/models && \
    wget -q -O server/public/models/ellie_animation.glb \
    "https://github.com/tjamescouch/personas/raw/refs/heads/main/ellie/ellie_animation.glb"

# Server runs via tsx from source
EXPOSE 3000
WORKDIR /app/server
CMD ["npx", "tsx", "src/index.ts"]
