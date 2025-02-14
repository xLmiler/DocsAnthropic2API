FROM node:18-slim

RUN sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    chromium \
    chromium-sandbox \
	&& rm -rf /var/lib/apt/lists/*

# 设置 Chromium 环境变量
ENV CHROME_BIN=/usr/bin/chromium

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --omit=dev \
    --registry=https://registry.npmmirror.com


# 复制所有源代码
COPY . .

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["node", "index.js"]