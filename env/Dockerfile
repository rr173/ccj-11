FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DB_PATH=/data/wizard.db
# 回执核验码的 HMAC 密钥默认写入 /data/receipt-secret.key（随数据卷持久化）
ENV RECEIPT_SECRET_PATH=/data/receipt-secret.key
ENV PORT=3000
RUN mkdir -p /data && chown -R node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/verify',{method:'GET'}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
