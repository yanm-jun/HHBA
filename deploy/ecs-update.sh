#!/usr/bin/env bash
# HHBA 演示环境更新脚本(增量更新,不重装)。
# 用法: sudo bash deploy/ecs-update.sh
# 做什么:备份 /opt/hhba-demo -> 从 GitHub 拉最新代码 -> 只替换应用文件
#        -> npm install -> 重启 hhba-demo-api / hhba-demo-web -> 健康检查。
# 不碰: /etc/hhba-demo.env(沿用旧 key)、systemd 端口配置、data/ 数据、
#       生产服务(nginx/OpenNest/postgres/gitea/new-api)。
set -euo pipefail

APP_DIR="/opt/hhba-demo"
API_SVC="hhba-demo-api"
WEB_SVC="hhba-demo-web"
REPO_URL="https://github.com/yanm-jun/HHBA.git"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root / sudo 运行: sudo bash deploy/ecs-update.sh" >&2
  exit 1
fi

if [ ! -f "/etc/systemd/system/${API_SVC}.service" ]; then
  echo "错误:找不到 ${API_SVC}.service,这台机器没部署过 HHBA 演示,别跑。" >&2
  exit 1
fi

echo "==> 当前服务配置(确认端口,勿动生产端口):"
grep -H "Environment" "/etc/systemd/system/${API_SVC}.service" "/etc/systemd/system/${WEB_SVC}.service" || true

BAK="/opt/hhba-demo.bak.$(date +%Y%m%d%H%M%S)"
echo "==> 备份 ${APP_DIR} -> ${BAK}"
cp -a "${APP_DIR}" "${BAK}"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
echo "==> 从 GitHub 拉取最新代码"
git clone --depth 1 "${REPO_URL}" "${TMP}/repo" 2>&1 | tail -1

echo "==> 替换应用文件(保留 data/ 与 /etc/hhba-demo.env)"
for f in server.js web-server.js package.json package-lock.json \
         index.html approve.html ops.html tasks.html; do
  if [ -f "${TMP}/repo/${f}" ]; then
    cp "${TMP}/repo/${f}" "${APP_DIR}/"
    echo "  更新 ${f}"
  else
    echo "  跳过 ${f}(仓库中没有)"
  fi
done

echo "==> 安装依赖"
cd "${APP_DIR}"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2

echo "==> 安全检查:生产环境不许开 OTP debug"
if grep -rq "HHBA_OTP_DEBUG" "/etc/systemd/system/${API_SVC}.service" \
     "/etc/systemd/system/${WEB_SVC}.service" 2>/dev/null; then
  echo "警告:systemd 里发现 HHBA_OTP_DEBUG,请手动检查后再继续!" >&2
  exit 1
fi

echo "==> 重启服务"
systemctl restart "${API_SVC}" "${WEB_SVC}"
sleep 4
systemctl is-active "${API_SVC}" "${WEB_SVC}"

echo "==> 健康检查"
API_PORT="$(grep -oP 'HHBA_API_PORT=\K[0-9]+' "/etc/systemd/system/${API_SVC}.service" | head -1)"
API_PORT="${API_PORT:-8787}"
curl -fsSL --max-time 10 "http://127.0.0.1:${API_PORT}/health" || \
  { echo "API 健康检查失败,查看: journalctl -u ${API_SVC} -n 50" >&2; exit 1; }
WEB_PORT="$(grep -oP 'HHBA_WEB_PORT=\K[0-9]+' "/etc/systemd/system/${WEB_SVC}.service" | head -1)"
WEB_PORT="${WEB_PORT:-18080}"
curl -fsSL --max-time 10 -o /dev/null -w "web %{http_code}\n" "http://127.0.0.1:${WEB_PORT}/"

echo
echo "================ 更新完成 ================"
echo "备份在: ${BAK}"
echo "回滚: sudo rm -rf ${APP_DIR} && sudo mv ${BAK} ${APP_DIR} \\"
echo "      && sudo systemctl restart ${API_SVC} ${WEB_SVC}"
echo "=========================================="
