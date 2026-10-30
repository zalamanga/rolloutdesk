FROM node:22-alpine AS build
WORKDIR /build
ENV NODE_OPTIONS=--max-old-space-size=512
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

FROM nginx:1.30.0-alpine
COPY frontend/nginx-main.conf /etc/nginx/nginx.conf
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/dist /usr/share/nginx/html
COPY docs/openapi.json /usr/share/nginx/html/openapi.json
COPY docs/postman/RolloutDesk.postman_collection.json /usr/share/nginx/html/postman.collection.json
COPY docs/postman/RolloutDesk.local.postman_environment.example.json /usr/share/nginx/html/postman.environment.example.json
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
