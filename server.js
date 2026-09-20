const http = require('http');
const { randomUUID } = require('crypto');

const requests = new Map();
const capabilityTypes = new Set(['DIGITAL_EXECUTION', 'EXPERT_JUDGMENT', 'REALITY_EXECUTION']);
const approvalLifetimeMs = 15 * 60 * 1000;

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:4173',
    'Access-Control-Allow-Headers': 'Content-Type, X-HHBA-Approval-Token'
  });
  response.end(JSON.stringify(body));
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 100000) request.destroy(); });
    request.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Request body must be valid JSON.')); } });
  });
}
function list(value) { return Array.isArray(value) ? value.filter(Boolean) : []; }
function serialize(item) {
  const { approval, ...safe } = item;
  return { ...safe, approval: approval ? { status: approval.consumedAt ? 'CONSUMED' : 'ISSUED', expiresAt: approval.expiresAt } : null };
}
function normalize(input) {
  const goal = String(input.goal || '').trim();
  const type = String(input.human_gap?.type || input.capability_type || 'DIGITAL_EXECUTION').trim();
  if (!goal) throw new Error('goal is required');
  if (!capabilityTypes.has(type)) throw new Error(`human_gap.type must be one of: ${[...capabilityTypes].join(', ')}`);
  const requirements = list(input.capability_requirements);
  const legacyCapability = String(input.capability || '').trim();
  if (!requirements.length && !legacyCapability) throw new Error('capability_requirements is required');
  if (type === 'REALITY_EXECUTION' && !input.location) throw new Error('location is required for REALITY_EXECUTION');
  return {
    id: `hcr_${randomUUID().slice(0, 8)}`, status: 'DRAFT', goal,
    agentContext: { sourceAgent: String(input.agent_context?.source_agent || 'unknown').trim(), completedWork: list(input.agent_context?.completed_work) },
    humanGap: { type, reason: String(input.human_gap?.reason || 'Agent identified a human capability gap.').trim() },
    capabilityRequirements: requirements.length ? requirements : [legacyCapability],
    deliverables: list(input.deliverables).length ? list(input.deliverables) : ['专业成果文件', '交付说明', '验收依据'],
    evidenceRequirements: list(input.evidence_requirements), location: input.location || null, budget: input.budget || null, deadline: input.deadline || null,
    createdAt: new Date().toISOString(), publishedAt: null, approval: null, deliverableBundle: null
  };
}
function find(id, response) {
  const item = requests.get(id);
  if (!item) json(response, 404, { error: 'human capability request not found' });
  return item;
}

http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return json(response, 204, {});
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', service: 'hhba-human-capability-api', protocol: 'HCP/0.1' });

  if (request.method === 'POST' && request.url === '/api/human-capability-requests/draft') {
    try {
      const item = normalize(await readBody(request));
      requests.set(item.id, item);
      return json(response, 201, { id: item.id, status: item.status, proposal: { humanGap: item.humanGap, deliverables: item.deliverables, evidenceRequirements: item.evidenceRequirements, budget: item.budget, deadline: item.deadline }, approvalRequired: true });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  const match = request.url.match(/^\/api\/human-capability-requests\/([^/]+)(?:\/(approval|publish|deliverables|result))?$/);
  if (match) {
    const [, id, action] = match;
    const item = find(id, response);
    if (!item) return;
    if (request.method === 'GET' && !action) return json(response, 200, serialize(item));
    if (request.method === 'GET' && action === 'result') {
      if (!item.deliverableBundle) return json(response, 409, { error: 'deliverables are not available yet', status: item.status });
      return json(response, 200, { requestId: id, status: item.status, deliverableBundle: item.deliverableBundle });
    }
    if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' });
    if (action === 'approval') {
      if (item.status !== 'DRAFT') return json(response, 409, { error: `cannot request approval from ${item.status}` });
      item.status = 'AWAITING_USER_APPROVAL';
      item.approval = { token: `hhba_appr_${randomUUID()}`, expiresAt: new Date(Date.now() + approvalLifetimeMs).toISOString(), consumedAt: null };
      return json(response, 201, { approvalToken: item.approval.token, expiresAt: item.approval.expiresAt, status: item.status });
    }
    if (action === 'publish') {
      const approval = item.approval;
      const valid = approval && !approval.consumedAt && new Date(approval.expiresAt) > new Date() && request.headers['x-hhba-approval-token'] === approval.token;
      if (!valid) return json(response, 403, { error: 'a valid, unexpired backend-issued approval token is required' });
      approval.consumedAt = new Date().toISOString(); item.status = 'MATCHING_CAPABILITY'; item.publishedAt = approval.consumedAt;
      return json(response, 201, { requestId: id, status: item.status, dispatch: 'INTERNAL_HHBA_MATCHING' });
    }
    if (action === 'deliverables') {
      if (!['MATCHING_CAPABILITY', 'IN_PROGRESS'].includes(item.status)) return json(response, 409, { error: `cannot accept deliverables from ${item.status}` });
      try {
        const body = await readBody(request); const artifacts = list(body.artifacts); const evidence = list(body.evidence);
        if (!artifacts.length && !evidence.length) return json(response, 400, { error: 'artifacts or evidence is required' });
        item.status = 'DELIVERED';
        item.deliverableBundle = { submittedAt: new Date().toISOString(), summary: String(body.summary || '').trim(), artifacts, evidence, structuredAnswers: body.structured_answers || {}, acceptanceNotes: String(body.acceptance_notes || '').trim() };
        return json(response, 201, { requestId: id, status: item.status });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
  }
  return json(response, 404, { error: 'not found' });
}).listen(8787, '127.0.0.1', () => console.log('HHBA API listening at http://127.0.0.1:8787'));
