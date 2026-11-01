FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    librsvg2-bin \
    imagemagick \
    fonts-dejavu-core \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY images ./images
COPY js ./js
COPY json ./json

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3456

EXPOSE 3456

CMD ["node", "server/index.mjs"]
