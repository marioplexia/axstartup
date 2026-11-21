FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html registro.html landing.html privacidad.html terminos.html seguridad.html precios.html auditoria.html tpu.html armadoras.html datos.html 404.html ./
COPY assets/og.png ./assets/og.png
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
