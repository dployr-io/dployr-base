FROM node:22-alpine

WORKDIR /app
RUN npm install -g http-server

COPY public ./public

CMD ["http-server", "public", "-p", "8787", "-a", "0.0.0.0"]
