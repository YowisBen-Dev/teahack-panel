FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip git ffmpeg curl unzip \
    libvips-dev libglib2.0-dev libjpeg-dev libpng-dev libwebp-dev \
    librsvg2-dev fontconfig build-essential pkg-config \
 && pip3 install --break-system-packages -U yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

RUN mkdir -p /app/bots
EXPOSE 8080
CMD ["node", "server.js"]
