# Etapa de construcción: generamos el bundle estático
FROM node:20-alpine AS build

WORKDIR /app

# Instalar dependencias primero (aprovechando el caché de capas)
COPY package*.json ./
RUN npm install

# Copiar el resto del código y construir
COPY . .
RUN npm run build

# Etapa de producción: servimos el bundle con nginx
FROM nginx:stable-alpine AS runner

ENV API_HOST=api.retiscan.online

COPY nginx.conf /etc/nginx/nginx.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["/bin/sh", "-c", "export API_HOST=$(echo \"${API_HOST:-api.retiscan.online}\" | sed -E 's|^https?://||; s|/.*$||') && envsubst '${API_HOST}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
