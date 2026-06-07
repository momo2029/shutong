FROM node:22

WORKDIR /app

# 设置国内 npm 镜像源，加速依赖安装
RUN npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
