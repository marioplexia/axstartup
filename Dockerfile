FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY index.html ./
COPY server server
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/ax.db
EXPOSE 3000
WORKDIR /app/server
# El seed es idempotente: crea el catálogo base la primera vez y no pisa lo aprendido.
CMD ["sh", "-c", "node seed.js && node index.js"]
