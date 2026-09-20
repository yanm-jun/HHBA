const apiBase = 'http://127.0.0.1:8787/api/human-capability-requests';

async function call(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json();
  return { response, body };
}

const draft = await call('/draft', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    goal: '为发布会制作一份专业 Figma 设计稿',
    agent_context: { source_agent: 'approval-smoke-test' },
    human_gap: { type: 'DIGITAL_EXECUTION', reason: '需要专业设计师完成可交付设计文件。' },
    capability_requirements: ['UI 设计', 'Figma'], deliverables: ['Figma 文件']
  })
});
if (draft.response.status !== 201) throw new Error(`draft failed: ${JSON.stringify(draft.body)}`);

const session = await call(`/${draft.body.id}/approval-sessions`, { method: 'POST' });
if (session.response.status !== 201 || !session.body.approvalId) throw new Error(`session failed: ${JSON.stringify(session.body)}`);
const cookie = session.response.headers.get('set-cookie');
if (!cookie?.includes('HttpOnly')) throw new Error('approval session did not set an HttpOnly cookie');
const cookieHeader = cookie.split(';')[0];

const deniedConfirm = await call(`/${draft.body.id}/approval-sessions/${session.body.approvalId}/confirm`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true })
});
if (deniedConfirm.response.status !== 403) throw new Error(`confirmation without browser cookie should be denied: ${deniedConfirm.response.status} ${JSON.stringify(deniedConfirm.body)}`);

const confirmed = await call(`/${draft.body.id}/approval-sessions/${session.body.approvalId}/confirm`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader }, body: JSON.stringify({ consent: true })
});
if (confirmed.response.status !== 201 || !confirmed.body.approvalToken || confirmed.body.status !== 'APPROVED_FOR_PUBLISH') {
  throw new Error(`browser confirmation failed: ${JSON.stringify(confirmed.body)}`);
}

const deniedPublish = await call(`/${draft.body.id}/publish`, { method: 'POST' });
if (deniedPublish.response.status !== 403) throw new Error('publish without approval token should be denied');

const published = await call(`/${draft.body.id}/publish`, {
  method: 'POST', headers: { 'X-HHBA-Approval-Token': confirmed.body.approvalToken }
});
if (published.response.status !== 201 || published.body.status !== 'MATCHING_CAPABILITY') throw new Error(`publish failed: ${JSON.stringify(published.body)}`);

const replay = await call(`/${draft.body.id}/publish`, {
  method: 'POST', headers: { 'X-HHBA-Approval-Token': confirmed.body.approvalToken }
});
if (replay.response.status !== 403) throw new Error('approval token replay should be denied');

const publiclySubmitted = await call(`/${draft.body.id}/deliverables`, { method: 'POST' });
if (publiclySubmitted.response.status !== 404) throw new Error('public deliverable submission must not exist');

const forbiddenClaim = await fetch(`http://127.0.0.1:8787/internal/human-capability-requests/${draft.body.id}/claim`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handler_id: 'designer_01' })
});
if (forbiddenClaim.status !== 403) throw new Error('internal claim without internal key should be denied');

const internalHeaders = { 'Content-Type': 'application/json', 'X-HHBA-Internal-Key': 'hhba-local-internal-dev-key' };
const claimResponse = await fetch(`http://127.0.0.1:8787/internal/human-capability-requests/${draft.body.id}/claim`, {
  method: 'POST', headers: internalHeaders, body: JSON.stringify({ handler_id: 'designer_01', handler_display_name: 'Ming · UI Designer' })
});
const claim = await claimResponse.json();
if (claimResponse.status !== 201 || claim.status !== 'IN_PROGRESS') throw new Error(`internal claim failed: ${JSON.stringify(claim)}`);

const deliveryResponse = await fetch(`http://127.0.0.1:8787/internal/human-capability-requests/${draft.body.id}/deliver`, {
  method: 'POST', headers: internalHeaders, body: JSON.stringify({ summary: '已交付设计稿。', artifacts: [{ name: 'Figma file', url: 'https://figma.example/file' }], acceptance_notes: '可交给 Agent 继续开发。' })
});
const delivery = await deliveryResponse.json();
if (deliveryResponse.status !== 201 || delivery.status !== 'DELIVERED') throw new Error(`internal delivery failed: ${JSON.stringify(delivery)}`);

const result = await call(`/${draft.body.id}/result`);
if (result.response.status !== 200 || !result.body.deliverableBundle?.artifacts?.length) throw new Error('agent result retrieval failed');

console.log(JSON.stringify({ requestId: draft.body.id, browserConfirmation: 'required', published: published.body.status, internalClaim: claim.status, delivered: delivery.status, replay: 'denied' }));
