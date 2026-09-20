const http = require('http');
const { randomUUID } = require('crypto');

const requests = new Map();
const json = (response, status, body) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:4173',
    'Access-Control-Allow-Headers': 'Content-Type, X-HHBA-Approval-Token'
  });
  response.end(JSON.stringify(body));
};

const readBody = (request) => new Promise((resolve, reject) => {
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 100000) request.destroy();
  });
  request.on('end', () => {
    try { resolve(JSON.parse(raw || '{}')); }
    catch { reject(new Error('Request body must be valid JSON.')); }
  });
});

function createDraft(goal, capability) {
  const id = `hr_${randomUUID().slice(0, 8)}`;
  const request = {
    id, goal, capability, status: 'DRAFT',
    createdAt: new Date().toISOString(), approvalToken: null
  };
  requests.set(id, request);
  return request;
}

http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return json(response, 204, {});
  if (request.method === 'GET' && request.url === '/health') {
    return json(response, 200, { status: 'ok', service: 'hhba-human-capability-api', version: '0.2.0' });
  }

  if (request.method === 'POST' && request.url === '/api/human-requests/draft') {
    try {
      const { goal, capability } = await readBody(request);
      if (!goal || !capability) return json(response, 400, { error: 'goal and capability are required' });
      const draft = createDraft(goal, capability);
      return json(response, 201, {
        id: draft.id, status: draft.status,
        proposedDeliverables: ['专业成果文件', '交付说明', '验收依据'],
        approvalRequired: true
      });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  const humanRequestMatch = request.url.match(/^\/api\/human-requests\/([^/]+)\/(approval|publish)$/);
  if (request.method === 'POST' && humanRequestMatch) {
    const [, id, action] = humanRequestMatch;
    const humanRequest = requests.get(id);
    if (!humanRequest) return json(response, 404, { error: 'human request not found' });
    if (action === 'approval') {
      humanRequest.status = 'AWAITING_USER_APPROVAL';
      humanRequest.approvalToken = `hhba_appr_${randomUUID()}`;
      return json(response, 201, { approvalToken: humanRequest.approvalToken, expiresInSeconds: 900, status: humanRequest.status });
    }
    if (request.headers['x-hhba-approval-token'] !== humanRequest.approvalToken) {
      return json(response, 403, { error: 'a valid backend-issued approval token is required' });
    }
    humanRequest.status = 'MATCHING_CAPABILITY';
    humanRequest.dispatchedAt = new Date().toISOString();
    return json(response, 201, { requestId: humanRequest.id, status: humanRequest.status });
  }

  // Temporary compatibility for the previous prototype UI.
  if (request.method === 'POST' && request.url === '/api/reality-checks/draft') {
    try {
      const { question, location } = await readBody(request);
      if (!question || !location) return json(response, 400, { error: 'question and location are required' });
      const draft = createDraft(question, location);
      return json(response, 201, { id: draft.id, status: draft.status });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  return json(response, 404, { error: 'not found' });
}).listen(8787, '127.0.0.1', () => console.log('HHBA API listening at http://127.0.0.1:8787'));
