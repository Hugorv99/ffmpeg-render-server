FROM node:18-alpine

# FFmpeg + wget for font download
RUN apk add --no-cache ffmpeg wget

WORKDIR /app

# Download Luckiest Guy font (used for subtitles)
RUN mkdir -p /app/fonts && \
    wget -q -O /app/fonts/LuckiestGuy-Regular.ttf \
    "https://github.com/google/fonts/raw/main/ofl/luckiestguy/LuckiestGuy-Regular.ttf" && \
    ls -lh /app/fonts/

COPY package*.json ./
RUN npm ci --production

COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
