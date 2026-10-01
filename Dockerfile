FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY . .
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
