FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# BUG-065: 创建 .dockerignore 或确保 native modules 不被覆盖（npm ci 在 COPY 之前执行即可）
# 创建非 root 用户
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    mkdir -p /app/data/uploads && \
    chown -R appuser:appgroup /app/data

RUN ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/data.sqlite
ENV UPLOAD_DIR=/app/data/uploads
ENV TZ=Asia/Shanghai

EXPOSE 3000

# BUG-063: 以非 root 用户运行
USER appuser

# BUG-064: 添加健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["node", "src/server.js"]
