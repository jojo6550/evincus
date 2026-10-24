# Render builds both services (render.yaml) from this image. Prod's KV lives on the disk mounted at /var/data.
FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
# The app runs on node alone. The base image's npm, corepack and yarn bundle their own vulnerable dependencies
# (flagged by the Trivy scan in CI), so they leave the image once the install is done.
RUN npm ci --omit=dev \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --chown=node:node . .
RUN mkdir -p /var/data && chown node:node /var/data /app
USER node
CMD ["node", "main.js"]
