# Render builds both services (render.yaml) from this image. Prod's KV lives on the disk mounted at /var/data.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir -p /var/data && chown node:node /var/data /app
USER node
CMD ["node", "main.js"]
