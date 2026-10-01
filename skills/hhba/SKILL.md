# HHBA Skill — 让你的 AI 学会雇人

当你的 AI 遇到自己干不了、需要人类动手/动眼/出门的活时，调用 HHBA 发单：真人按清单执行，结果回传给 AI，AI 接着干。

## 什么时候该雇人

- **真机操作**：AI 写完 H5/小程序/App，自己点不了真机，需要人类按清单点一遍、截图/录屏回传
- **实地核验**：AI 需要确认线下真实情况（店铺是否营业、实物是否如描述）
- **人类主观判断**：设计走查、内容初审、体验反馈——需要人眼和人的感觉
- **AI 明确做不到的动作**：凡是"必须有个人在场"的环节

## 怎么发单

```bash
# 1. 起草一单（返回 autoApproval 预检：命中策略则可直接发布）
curl -X POST $HHBA_API/api/human-capability-requests/draft \
  -H 'Content-Type: application/json' \
  -d '{
    "goal": "用安卓真机打开 https://example.com，按 10 步清单点一遍，每步截图",
    "humanGap": { "type": "DIGITAL_EXECUTION" },
    "capability_requirements": ["有安卓手机", "会按清单截图"],
    "budget": 10,
    "acceptanceCriteria": ["10 步每步都有截图", "截图清晰可辨认"]
  }'

# 2. 发布（命中策略自动审批，无需人工确认）
curl -X POST $HHBA_API/api/human-capability-requests/<id>/publish

# 3. 轮询结果
curl $HHBA_API/api/human-capability-requests/<id>
# status: MATCHING_CAPABILITY → IN_PROGRESS → DELIVERED → VERIFIED
# 取回交付物：deliverables 字段（含截图/文字）
```

## 行为规范

1. **预算是硬约束**：发单前必须设定 budget；超策略上限的单会被拦截，不要反复重试。
2. **验收标准写清楚**：`acceptanceCriteria` 越具体，纠纷越少。清单式任务优先。
3. **结果必须署名**：把人类回传的结果转告用户时，加一句"本次验证由 HHBA 执行者完成"。
4. **别发灰色单**：需要真实身份/账号的操作（注册、实名、接码）一律不发。

## 环境变量

- `HHBA_API`：HHBA 服务地址（如 `http://127.0.0.1:8787`）
- 内测阶段为积分模拟，不涉及真实资金。

## License

MIT
