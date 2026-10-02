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
# 应用文件下载源(jsDelivr,国内可达;pin 到 commit 保证 immutable)
FILE_BASE="https://cdn.jsdelivr.net/gh/yanm-jun/HHBA@7119aff"
APP_FILES="server.js web-server.js package.json package-lock.json index.html approve.html ops.html tasks.html docs.html executor.html assets/hero-visual.webp assets/tpl-h5.webp assets/tpl-miniprogram.webp assets/tpl-payment.webp"

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

echo "==> 下载应用文件(来自 ${FILE_BASE})"
for f in ${APP_FILES}; do
  curl -fsSL --max-time 60 --retry 3 "${FILE_BASE}/${f}" -o "${APP_DIR}/${f}" \
    || { echo "下载 ${f} 失败,请检查网络后重跑" >&2; exit 1; }
  echo "  更新 ${f}"
done

# systemd 实际从 server/ 子目录加载(server/server.js + server/web.js),
# 若存在则同步过去(连同 HTML,因 web.js 从自身所在目录提供静态文件)
if [ -d "${APP_DIR}/server" ]; then
  echo "==> 同步到 ${APP_DIR}/server (systemd 实际加载位置)"
  cp "${APP_DIR}/server.js" "${APP_DIR}/server/server.js"
  cp "${APP_DIR}/web-server.js" "${APP_DIR}/server/web.js"
  cp "${APP_DIR}/index.html" "${APP_DIR}/approve.html" \
     "${APP_DIR}/ops.html" "${APP_DIR}/tasks.html" \
     "${APP_DIR}/docs.html" "${APP_DIR}/executor.html" "${APP_DIR}/server/"
  # 同步静态资源(图片等):web.js 从 server/ 提供静态文件
  if [ -d "${APP_DIR}/assets" ]; then
    mkdir -p "${APP_DIR}/server/assets"
    cp -r "${APP_DIR}/assets/"* "${APP_DIR}/server/assets/"
  fi
fi

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
API_PORT="$(grep -oP 'HHBA_API_PORT=\K[0-9]+' "/etc/systemd/system/${API_SVC}.service" 2>/dev/null | head -1 || true)"
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
