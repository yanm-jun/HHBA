#!/usr/bin/env bash
# HHBA 一键部署(Ubuntu 24.04, ECS).
# 用法:把本仓库传到服务器后,在仓库根目录执行 sudo bash deploy/ecs-setup.sh
# 做什么:装 Node 20 -> 拷到 /opt/hhba-demo -> 生成随机 INTERNAL_KEY
#        -> 写入 systemd(hhba-demo-api / hhba-demo-web) -> 启动.
# 注意:这只是演示环境(积分模拟,不涉及真实资金),不要接生产域名。
set -euo pipefail

RELEASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="/opt/hhba-demo"
API_SVC="hhba-demo-api"
WEB_SVC="hhba-demo-web"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root / sudo 运行: sudo bash deploy/ecs-setup.sh" >&2
  exit 1
fi

echo "==> 安装 Node.js 20"
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node --version

echo "==> 部署到 ${APP_DIR}"
mkdir -p "${APP_DIR}"
cp -r "${RELEASE_DIR}/server.js" "${RELEASE_DIR}/web-server.js" "${RELEASE_DIR}/package.json" \
    "${RELEASE_DIR}/index.html" "${RELEASE_DIR}/approve.html" \
    "${RELEASE_DIR}/ops.html" "${RELEASE_DIR}/tasks.html" "${APP_DIR}/"
mkdir -p "${APP_DIR}/data"

echo "==> 生成 INTERNAL_KEY"
if [ -f /etc/hhba-demo.env ]; then
  echo "已存在 /etc/hhba-demo.env,沿用旧 key(轮换请删除该文件后重跑)"
else
  if command -v openssl >/dev/null 2>&1; then
    KEY="$(openssl rand -hex 32)"
  else
    KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  printf 'HHBA_INTERNAL_API_KEY=%s\n' "${KEY}" > /etc/hhba-demo.env
  chmod 600 /etc/hhba-demo.env
fi

echo "==> 写入 systemd"
cat > "/etc/systemd/system/${API_SVC}.service" <<EOF
[Unit]
Description=HHBA demo API (HCP/0.2)
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/hhba-demo.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/${WEB_SVC}.service" <<EOF
[Unit]
Description=HHBA demo web (static + API proxy)
After=network.target ${API_SVC}.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=HHBA_WEB_HOST=0.0.0.0
Environment=HHBA_WEB_PORT=8080
ExecStart=/usr/bin/node web-server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${API_SVC}" "${WEB_SVC}"
sleep 3
systemctl is-active "${API_SVC}" "${WEB_SVC}"

PUB_IP="$(curl -fsSL --max-time 5 http://100.100.100.200/latest/meta-data/eip-address 2>/dev/null || echo '<ECS公网IP>')"
echo
echo "================ 部署完成 ================"
echo "前端: http://${PUB_IP}:8080/"
echo "健康检查: curl http://${PUB_IP}:8080/health"
echo "INTERNAL_KEY 已写入 /etc/hhba-demo.env (600 权限,妥善保管)"
echo "注意:请在 ECS 安全组放行 TCP 8080;这只是演示环境,不要接生产域名。"
echo "=========================================="
