# HHBA Human Capability Protocol · V0.1

## Product contract

HHBA is the **Human Capability Layer for AI Agents**. An agent should use it only after it has identified a material `human_gap`: a capability, permission, time, professional-judgment, or real-world-access gap that it cannot reliably close itself.

HHBA is not an agent-facing candidate marketplace. Candidate discovery, reservation, scoring, and dispatch stay inside HHBA's internal supply engine.

## Capability categories

| Type | Typical work | Required return |
| --- | --- | --- |
| `DIGITAL_EXECUTION` | UI/Figma, Java, 3D, video, data work | artifact files, links, handoff notes |
| `EXPERT_JUDGMENT` | code review, design review, audit, consultation | written opinion, findings, acceptance basis |
| `REALITY_EXECUTION` | visit, quotation, inventory check, inspection | timestamped evidence, location, structured answers |

## Safety invariant

An agent may create a draft but may never authorize expenditure or dispatch by sending an `approved: true` boolean. HHBA must issue a server-side, scope-bound, expiring `approvalToken`; publishing without it is rejected. The token is issued only after an HHBA-controlled browser confirmation session presents the scope and receives explicit consent. An agent/MCP process never receives a browser confirmation cookie or an approval endpoint that can mint a token.

## Canonical object: HumanCapabilityRequest

```json
{
  "goal": "彻底排查 Java 项目的性能问题",
  "agent_context": {
    "source_agent": "codex",
    "completed_work": ["已定位慢查询", "已收集压测日志"]
  },
  "human_gap": {
    "type": "DIGITAL_EXECUTION",
    "reason": "需要高级工程师进行架构审查、压测与改造"
  },
  "capability_requirements": ["Java", "性能优化", "Spring Boot"],
  "deliverables": ["性能诊断报告", "benchmark.csv", "改造 PR"],
  "budget": {"currency": "CNY", "min": 800, "max": 1500},
  "deadline": "2026-10-01T12:00:00+08:00"
}
```

For `REALITY_EXECUTION`, additionally provide `location` and `evidence_requirements`, such as GPS, capture time, photos, quotations, or inventory status.

## Agent-facing lifecycle

```text
DRAFT
  -> AWAITING_USER_APPROVAL
  -> APPROVED_FOR_PUBLISH
  -> MATCHING_CAPABILITY
  -> IN_PROGRESS
  -> DELIVERED
```

1. `POST /api/human-capability-requests/draft` creates a non-billable proposal.
2. `POST /:id/approval-sessions` starts a short-lived, HttpOnly browser-bound confirmation session; it does not issue a token.
3. The user explicitly consents at `POST /:id/approval-sessions/:approvalId/confirm`; only that browser session can receive a short-lived approval token.
4. `POST /:id/publish` validates and consumes the token, then enters internal matching.
5. HHBA's internal workers submit a `DeliverableBundle`.
6. The source agent obtains the bundle from `GET /:id/result` and continues the original work.

## Tools / HTTP mapping

| Agent tool | HTTP endpoint | May spend money? |
| --- | --- | --- |
| `draft_human_capability_request` | `POST /draft` | No |
| browser confirmation link | HHBA browser surface | No |
| `get_human_capability_request` | `GET /:id` | No |
| `get_human_capability_result` | `GET /:id/result` | No |

`submit_deliverable` is an internal HHBA dispatch operation, not a default public agent tool.

## Agent instruction

Use digital tools first. Propose HHBA only when the answer or deliverable materially depends on professional work that should be performed by a person, expert judgment, changing local information, physical-world conditions, human interaction, or in-person evidence. Explain the gap and proposed output before creating a draft. Never publish without explicit user approval.
