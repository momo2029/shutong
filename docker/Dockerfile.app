FROM node:22

WORKDIR /app

COPY package.json package-lock.json* ./
COPY . .

RUN npm install && npm run build && npm prune --omit=dev

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
