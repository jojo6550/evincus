# Render runs the app from this image (render.yaml). KV writes go only to the persistent disk at /var/data.
FROM denoland/deno:2.7.14
WORKDIR /app
COPY . .
CMD ["run", "--allow-net", "--allow-read", "--allow-env", "--allow-write=/var/data", "main.js"]
