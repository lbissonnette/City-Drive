# City Drive on Cloud Run. Zero npm dependencies, so this is just Node + the source.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Every server module at the root (server.js requires them), so a new one can't be missed.
COPY package.json *.js ./
COPY public ./public

# server.js saves frames to ./output, so the runtime user needs to own /app.
RUN mkdir output && chown -R node:node /app
USER node

# Cloud Run sets PORT (8080 by default); server.js reads it.
EXPOSE 8080
CMD ["node", "server.js"]
