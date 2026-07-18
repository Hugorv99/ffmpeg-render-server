FROM node:18-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy font from repo (avoids unreliable network downloads during build)
COPY fonts/ /app/fonts/

COPY package*.json ./
RUN npm ci --production

COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
