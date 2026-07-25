# One image for all three TraceBill processes; the compose file picks which to run.
FROM node:22.16-alpine

WORKDIR /app

# Workspace manifests first, so npm ci is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY gateway/package.json gateway/
COPY app/package.json app/
COPY demo/package.json demo/
RUN npm ci

COPY . .

# SQLite and the bootstrap credentials live here, on a shared volume.
ENV TRACEBILL_DB=/data/tracebill.db
RUN mkdir -p /data

EXPOSE 3002 4400 4500

CMD ["node", "scripts/dev.js", "--only=gateway,app"]
