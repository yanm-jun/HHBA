# HHBA · AI 包工头协议

人出钱、定预算、定规则；AI 在规则内自动拆单、发单、管人、盯进度、验收、结算。
你只管定方向，剩下的它搞定。

> **当前为积分模拟阶段：全流程记账，但不涉及真实资金结算。**

## 协议

后端实现 **HCP/0.2**（`GET /health` 可查）：

- `POST /internal/policies` — 老板定策略：单任务预算上限、日/月封顶、允许的任务类型、执行者可靠分门槛
- 任务发布命中策略 → 自动审批直接发单；超预算 / 无策略命中 → 转人工确认
- `POST /internal/tasks/:id/verify` — 验收（通过 +2 / 打回 −10 可靠分）
- `GET /internal/ledger` — 积分账本（boss / escrow / 执行者）

## 本地启动

```bash
npm run api   # 后端 127.0.0.1:8787 (需要 HHBA_INTERNAL_API_KEY,见下)
npm run ui    # 前端 127.0.0.1:4173
```

环境变量：`HHBA_INTERNAL_API_KEY`（必填，无默认值；本地可用 `HHBA_ALLOW_INSECURE_DEV_KEY=1` 走开发默认 key）、`HHBA_UI_ORIGIN`（CORS，默认 `http://127.0.0.1:4173`）。

页面：`/` 落地页、`approve.html` 人工审批、`tasks.html` 执行者接单、`ops.html` 包工头控制台。

## 部署到阿里云 ECS（演示）

```bash
sudo bash deploy/ecs-setup.sh
```

装 Node 20 → 拷到 `/opt/hhba-demo` → 生成随机 key → 注册 `hhba-demo-api` / `hhba-demo-web` 两个 systemd 服务。前端对外 `0.0.0.0:8080`，记得安全组放行 TCP 8080。

## 版本

- v0.4.0：后端 v0.3（策略自动审批、积分账本、执行者可靠分）+ 前端 v0.4（荧光绿 × 绮菫紫）
