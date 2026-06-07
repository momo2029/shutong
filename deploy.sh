#!/bin/bash
# 书童部署脚本
# 用法: ./deploy.sh [--rebuild]
#   --rebuild: 重新构建 Docker 镜像并重建容器（环境变量/依赖变更时需要）

set -e

SERVER="root@118.196.144.216"
PROJECT_DIR="/Users/jf/code/esp32/shutong"
REMOTE_DIR="/opt/shutong"

echo "=== 1. 编译 TypeScript ==="
cd "$PROJECT_DIR/server"
npx tsc

echo "=== 2. 同步代码到服务器 ==="
rsync -avz --delete --exclude 'node_modules' --exclude 'data' --exclude '.git' \
  "$PROJECT_DIR/server/dist/" "$SERVER:$REMOTE_DIR/server/dist/"
rsync -avz --delete "$PROJECT_DIR/server/views/" "$SERVER:$REMOTE_DIR/server/views/"
rsync -avz "$PROJECT_DIR/server/public/" "$SERVER:$REMOTE_DIR/server/public/"

echo "=== 3. 整体复制到容器 ==="
ssh "$SERVER" '
  # dist / views / public 全部 tar 覆盖（不需要 rm，tar 直接覆盖旧文件）
  tar cf - -C /opt/shutong/server/dist . | docker exec -i docker-app-1 tar xf - -C /app/dist
  tar cf - -C /opt/shutong/server/views . | docker exec -i docker-app-1 tar xf - -C /app/views
  tar cf - -C /opt/shutong/server/public . | docker exec -i docker-app-1 tar xf - -C /app/public
  echo "容器内文件更新完成"
'

if [ "$1" = "--rebuild" ]; then
  echo "=== 4a. 完整构建 + 重启 ==="
  ssh "$SERVER" 'cd /opt/shutong/docker && docker compose build app && docker compose up -d app'
else
  echo "=== 4b. 重启服务 ==="
  ssh "$SERVER" 'docker compose -f /opt/shutong/docker/docker-compose.yml restart app'
fi

echo "=== 5. 验证 ==="
sleep 3

# 检查关键页面状态码
echo "  HTTP状态码检查:"
for url in "/devices" "/notes" "/notes/6cae7-a0b5" "/devices/55bedc16-4105-4d0d-ae77-ed4378a699e0"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://shutong.3198.net$url")
  status="✅"
  [ "$code" != "200" ] && [ "$code" != "302" ] && status="❌"
  echo "  $status $url → $code"
done

# 检查服务器日志有没有新错误（排除已知的 FOREIGN KEY 警告）
echo "  错误日志检查:"
errors=$(ssh "$SERVER" 'docker logs docker-app-1 --since 30s 2>&1 | grep -i "error\\|RangeError\\|ReferenceError" | grep -v "FOREIGN" | head -5')
if [ -z "$errors" ]; then
  echo "  ✅ 无新增错误"
else
  echo "  ❌ 发现错误:"
  echo "$errors"
fi

echo ""
echo "=== 部署完成 ==="
