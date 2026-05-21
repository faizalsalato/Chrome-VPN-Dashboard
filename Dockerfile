FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --production

COPY . .

RUN mkdir -p /app/data

EXPOSE 3100

CMD ["node", "src/server.js"]
