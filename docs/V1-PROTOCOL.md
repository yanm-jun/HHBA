# HHBA Reality Engine · V1 Protocol

## Product boundary

HHBA is a reality-verification layer for agents. It is not an agent-facing talent marketplace. Agents request a verified answer; matching and dispatching executors remain internal HHBA operations.

## V1 lifecycle

1. `draft_reality_check(RealityRequest)` validates a genuine Reality Gap and returns a non-billable proposal.
2. The user reviews the proposal and approves it in an HHBA-controlled confirmation surface.
3. HHBA issues an approval token bound to the user, `proposalId`, scope, and expiry.
4. `publish_reality_check(proposalId, approvalToken)` creates field tasks only after server-side token validation.
5. Executors submit evidence, not a generic task-completion status.
6. `get_verification_result(realityCheckId)` returns the evidence bundle and synthesis inputs to the calling agent.

## Security invariant

No client-provided boolean such as `approvedByUser: true` may authorize spend. The publishing API must require and validate the backend-issued approval token.

## Core objects

### RealityRequest

```json
{
  "question": "临沂地区 MG4 当前真实成交价格是多少？",
  "digital_findings": ["官网指导价", "平台报价", "门店广告报价"],
  "reality_gap": {"required": true, "reason": "公开报价无法证明当前可成交条件"},
  "location": {"city": "临沂"},
  "verification_goal": "确认当前真实可成交价格",
  "evidence_required": ["time", "location", "cash_price", "finance_price", "inventory", "quotation"]
}
```

### EvidenceBundle

```json
{
  "reality_check_id": "rc_…",
  "sample_size": 3,
  "evidence": [{"type": "quotation", "captured_at": "…", "location": {"lat": 0, "lng": 0}, "url": "…"}],
  "answers": {"cash_price_range": [108800, 111800]},
  "confidence": {"level": "moderate", "reason": "3 个独立门店样本"}
}
```

## Agent instruction

Use normal digital sources first. When an answer materially depends on a fast-changing local fact, a real transaction, physical availability, on-site observation, human interaction, or in-person evidence, explain the uncertainty and call `draft_reality_check`. Never publish a paid reality check without explicit user approval.
