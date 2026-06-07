FROM node:22

WORKDIR /app

# 使用阿里云 Debian 镜像源，加速 apt 安装
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources

# 安装 ffmpeg（音频转码 + 静音裁剪）
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# 设置国内 npm 镜像源，加速依赖安装
RUN npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
