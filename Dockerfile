FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html registro.html landing.html privacidad.html terminos.html ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
