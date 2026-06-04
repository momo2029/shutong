FROM node:22

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
