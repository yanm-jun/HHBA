#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const apiBaseUrl = String(process.env.HHBA_API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const approvalWebBaseUrl = String(process.env.HHBA_APPROVAL_WEB_BASE_URL || 'http://127.0.0.1:4173').replace(/\/+$/, '');
const instructions = `HHBA is the Human Capability Layer for AI Agents. Use normal digital tools first. When a user goal materially requires professional human execution, expert judgment, permissions, time, or real-world access that you cannot reliably provide, explain the Human Gap and call draft_human_capability_request. This MCP server is in Shadow Mode: it creates only non-billable drafts. It may return a browser confirmation URL, but only the user can confirm there; this MCP server cannot publish, spend money, or bypass explicit approval. Never imply a person has been contacted. Return to the user's original task after a deliverable bundle is available.`;

async function api(path, init = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, ...init
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`HHBA API returned invalid JSON (${response.status})`); }
  if (!response.ok) throw new Error(body.error || `HHBA API failed with ${response.status}`);
  return body;
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

const server = new McpServer(
  { name: 'hhba-human-capability', version: '0.1.0' },
  { instructions }
);

server.registerTool('draft_human_capability_request', {
  title: 'Draft a human capability request',
  description: 'Use only after digital work is insufficient. Creates a non-billable HHBA draft; it does not contact people, publish work, or spend money.',
  inputSchema: {
    goal: z.string().min(1).describe('The original user goal that needs help.'),
    human_gap_type: z.enum(['DIGITAL_EXECUTION', 'EXPERT_JUDGMENT', 'REALITY_EXECUTION']).describe('The kind of gap the agent cannot close.'),
    human_gap_reason: z.string().min(1).describe('Why normal digital tools or the agent cannot reliably complete the work.'),
    capability_requirements: z.array(z.string().min(1)).min(1).describe('Required human skills or execution abilities.'),
    deliverables: z.array(z.string().min(1)).min(1).describe('Concrete artifacts, conclusions, or evidence expected back.'),
    completed_work: z.array(z.string()).default([]).describe('Useful work already completed by the agent.'),
    location: z.object({ city: z.string().optional(), address: z.string().optional(), radius_km: z.number().positive().optional() }).optional().describe('Required for a real-world request.'),
    evidence_requirements: z.array(z.string()).default([]).describe('Evidence required for real-world work.'),
    budget: z.object({ currency: z.string().default('CNY'), min: z.number().nonnegative(), max: z.number().nonnegative() }).optional(),
    deadline: z.string().optional()
  },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, async (input) => {
  const draft = await api('/api/human-capability-requests/draft', {
    method: 'POST', body: JSON.stringify({
    goal: input.goal,
    agent_context: { source_agent: 'mcp', completed_work: input.completed_work },
    human_gap: { type: input.human_gap_type, reason: input.human_gap_reason },
    capability_requirements: input.capability_requirements,
    deliverables: input.deliverables,
    location: input.location,
    evidence_requirements: input.evidence_requirements,
    budget: input.budget,
    deadline: input.deadline
  })
  });
  return toolResult({
    ...draft,
    approvalUrl: `${approvalWebBaseUrl}/?approve=${encodeURIComponent(draft.id)}`,
    nextStep: 'Explain the Human Gap and offer the user this browser confirmation URL. Do not imply the request is published or assigned.'
  });
});

server.registerTool('get_human_capability_request', {
  title: 'Get a human capability request',
  description: 'Read a previously drafted HHBA request and its safe authorization state. Does not expose approval tokens.',
  inputSchema: { request_id: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ request_id }) => toolResult(await api(`/api/human-capability-requests/${encodeURIComponent(request_id)}`)));

server.registerTool('get_human_capability_result', {
  title: 'Get a completed human capability result',
  description: 'Retrieve the HHBA deliverable bundle, including artifacts or reality evidence, after internal delivery is complete.',
  inputSchema: { request_id: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ request_id }) => toolResult(await api(`/api/human-capability-requests/${encodeURIComponent(request_id)}/result`)));

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`HHBA MCP server running on stdio -> ${apiBaseUrl}`);
}

main().catch((error) => { console.error('HHBA MCP failed:', error); process.exit(1); });
