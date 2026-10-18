# Render builds both services (render.yaml) from this image. Prod's KV lives on the disk mounted at /var/data.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "main.js"]
