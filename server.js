import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const requests = new Map();
const capabilityTypes = new Set(['DIGITAL_EXECUTION', 'EXPERT_JUDGMENT', 'REALITY_EXECUTION']);
const approvalLifetimeMs = 15 * 60 * 1000;
const dataDirectory = path.join(process.cwd(), 'data');
const dataFile = path.join(dataDirectory, 'human-capability-requests.json');
const policiesFile = path.join(dataDirectory, 'policies.json');
const ledgerFile = path.join(dataDirectory, 'ledger.json');
const executorsFile = path.join(dataDirectory, 'executors.json');
// 前端页面地址可配置(默认本地 UI);生产部署时设为公网域名
const uiOrigin = process.env.HHBA_UI_ORIGIN || 'http://127.0.0.1:4173';

// 包工头模式:内部 key 缺失时拒绝启动(除非显式允许开发模式),避免生产环境落到公开默认值
const internalApiKey = process.env.HHBA_INTERNAL_API_KEY || 'hhba-local-internal-dev-key';
if (!process.env.HHBA_INTERNAL_API_KEY && process.env.HHBA_ALLOW_INSECURE_DEV_KEY !== '1') {
  console.error('[HHBA] HHBA_INTERNAL_API_KEY is not set. Set it, or explicitly opt into the insecure dev key with HHBA_ALLOW_INSECURE_DEV_KEY=1.');
  process.exit(1);
}
const internalSessions = new Map();
const internalSessionLifetimeMs = 8 * 60 * 60 * 1000;

function loadRequests() {
  try {
    const saved = JSON.parse(readFileSync(dataFile, 'utf8'));
    for (const item of saved.requests || []) requests.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function persist() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${dataFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, requests: [...requests.values()] }, null, 2));
  renameSync(temporaryFile, dataFile);
}
function audit(item, event, details = {}) {
  item.updatedAt = new Date().toISOString();
  item.audit = [...(item.audit || []), { at: item.updatedAt, event, ...details }];
}

// ---- 包工头模式:老板(人)定预算与规则,AI 在规则内自动发单 ----
const policies = new Map();
function loadPolicies() {
  try {
    const saved = JSON.parse(readFileSync(policiesFile, 'utf8'));
    for (const item of saved.policies || []) policies.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function persistPolicies() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${policiesFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, policies: [...policies.values()] }, null, 2));
  renameSync(temporaryFile, policiesFile);
}

// ---- 积分账本:暂不碰真实金钱,积分只是数字 ----
const BOSS_INITIAL_CREDITS = 100000;
const ledger = { entries: [], balances: {} };
function loadLedger() {
  try {
    const saved = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    ledger.entries = saved.entries || [];
    ledger.balances = saved.balances || {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (ledger.balances.boss === undefined) {
    ledger.balances.boss = BOSS_INITIAL_CREDITS;
    ledger.entries.push({
      id: `led_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), type: 'GRANT',
      requestId: null, amount: BOSS_INITIAL_CREDITS, from: 'system', to: 'boss',
      note: '老板账户初始积分(模拟,非真实货币)'
    });
    persistLedger();
  }
}
function persistLedger() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${ledgerFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, balances: ledger.balances, entries: ledger.entries }, null, 2));
  renameSync(temporaryFile, ledgerFile);
}
function balanceOf(account) { return ledger.balances[account] || 0; }
function addLedgerEntry(type, { requestId = null, amount, from, to, note = '' }) {
  const entry = { id: `led_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), type, requestId, amount, from, to, note };
  ledger.entries.push(entry);
  return entry;
}
// 发单时冻结:老板 -> escrow
function freezeCredits(requestId, amount) {
  if (!(amount > 0)) return 0;
  if (balanceOf('boss') < amount) throw new Error('老板积分余额不足,无法冻结');
  ledger.balances.boss = balanceOf('boss') - amount;
  ledger.balances.escrow = balanceOf('escrow') + amount;
  addLedgerEntry('FREEZE', { requestId, amount, from: 'boss', to: 'escrow', note: '发单冻结' });
  persistLedger();
  return amount;
}
// 验收通过:escrow -> 执行者
function settleCredits(requestId, amount, handlerId) {
  if (!(amount > 0)) return 0;
  const account = `executor:${handlerId}`;
  if (balanceOf('escrow') < amount) throw new Error('冻结积分不足,无法结算');
  ledger.balances.escrow = balanceOf('escrow') - amount;
  ledger.balances[account] = balanceOf(account) + amount;
  addLedgerEntry('SETTLE', { requestId, amount, from: 'escrow', to: account, note: '验收通过,结算给执行者' });
  persistLedger();
  return amount;
}
// 验收打回:escrow -> 老板(解冻退回)
function unfreezeCredits(requestId, amount, note = '验收打回,解冻退回') {
  if (!(amount > 0)) return 0;
  if (balanceOf('escrow') < amount) throw new Error('冻结积分不足,无法解冻');
  ledger.balances.escrow = balanceOf('escrow') - amount;
  ledger.balances.boss = balanceOf('boss') + amount;
  addLedgerEntry('UNFREEZE', { requestId, amount, from: 'escrow', to: 'boss', note });
  persistLedger();
  return amount;
}

// ---- 执行者可靠分:所有执行者保留,基准分 100 ----
const executors = new Map();
function loadExecutors() {
  try {
    const saved = JSON.parse(readFileSync(executorsFile, 'utf8'));
    for (const item of saved.executors || []) executors.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function persistExecutors() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${executorsFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, executors: [...executors.values()] }, null, 2));
  renameSync(temporaryFile, executorsFile);
}
// 找不到则按基准分 100 建档(老执行者自动保留)
function getExecutor(id) {
  const key = String(id).trim();
  let executor = executors.get(key);
  if (!executor) {
    const now = new Date().toISOString();
    executor = { id: key, displayName: null, reliabilityScore: 100, completedTasks: 0, rejectedTasks: 0, createdAt: now, updatedAt: now };
    executors.set(key, executor);
    persistExecutors();
  }
  return executor;
}
function adjustReliability(id, delta) {
  const executor = getExecutor(id);
  executor.reliabilityScore = Math.min(120, Math.max(0, (executor.reliabilityScore ?? 100) + delta));
  executor.updatedAt = new Date().toISOString();
  persistExecutors();
  return executor.reliabilityScore;
}

// ---- 工头通用化:不再绑定 OpenClaw,任何 AI 工具都能当工头 ----
function normalizeForeman(input) {
  const raw = input.foreman;
  if (raw && typeof raw === 'object') {
    return {
      tool: String(raw.tool || 'unknown').trim().toLowerCase() || 'unknown',
      id: raw.id != null && String(raw.id).trim() ? String(raw.id).trim() : null,
      name: raw.name != null && String(raw.name).trim() ? String(raw.name).trim() : null
    };
  }
  // 兼容旧写法:读不到 foreman 时从 agent_context 推断
  const sourceAgent = String(input.agent_context?.source_agent || 'unknown').trim();
  return { tool: (sourceAgent || 'unknown').toLowerCase(), id: null, name: null };
}

function normalizePolicy(input, existing) {
  const now = new Date().toISOString();
  const name = String(input.name ?? existing?.name ?? '默认策略').trim() || '默认策略';
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : (existing?.enabled ?? true);
  const toAmount = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('policy budget fields must be non-negative numbers');
    return parsed;
  };
  const maxAmountPerTask = toAmount(input.maxAmountPerTask ?? existing?.maxAmountPerTask ?? null);
  const dailyBudgetCap = toAmount(input.dailyBudgetCap ?? existing?.dailyBudgetCap ?? null);
  const monthlyBudgetCap = toAmount(input.monthlyBudgetCap ?? existing?.monthlyBudgetCap ?? null);
  const allowedTypes = input.allowedTypes !== undefined ? list(input.allowedTypes) : (existing?.allowedTypes || []);
  for (const type of allowedTypes) {
    if (!capabilityTypes.has(type)) throw new Error(`allowedTypes must be one of: ${[...capabilityTypes].join(', ')}`);
  }
  const minReliabilityRaw = input.minReliabilityScore ?? existing?.minReliabilityScore ?? null;
  let minReliabilityScore = null;
  if (minReliabilityRaw !== null && minReliabilityRaw !== undefined && minReliabilityRaw !== '') {
    minReliabilityScore = Number(minReliabilityRaw);
    if (!Number.isFinite(minReliabilityScore) || minReliabilityScore < 0 || minReliabilityScore > 120) {
      throw new Error('minReliabilityScore must be a number between 0 and 120');
    }
  }
  return {
    id: existing?.id || `pol_${randomUUID().slice(0, 8)}`,
    name, enabled, maxAmountPerTask, dailyBudgetCap, monthlyBudgetCap, allowedTypes, minReliabilityScore,
    createdAt: existing?.createdAt || now, updatedAt: now
  };
}
function budgetAmountOf(item) {
  const budget = item.budget;
  if (typeof budget === 'number' && Number.isFinite(budget)) return budget;
  if (typeof budget === 'string') {
    const match = budget.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (match) return parseFloat(match[0]);
  }
  return null;
}
function dayStartIso() { const date = new Date(); date.setHours(0, 0, 0, 0); return date.toISOString(); }
function monthStartIso() { const date = new Date(); date.setDate(1); date.setHours(0, 0, 0, 0); return date.toISOString(); }
// 已发布任务的预算都计入支出(含已结算),用于日/月预算上限
function spendSince(startIso) {
  let total = 0;
  for (const item of requests.values()) {
    if (!item.publishedAt || item.publishedAt < startIso) continue;
    const amount = budgetAmountOf(item);
    if (amount !== null) total += amount;
  }
  return total;
}
// 按老板定的预算/规则评估任务:命中任一启用策略即自动放行
function evaluatePolicy(item) {
  const amount = budgetAmountOf(item);
  if (amount === null) return { eligible: false, reason: '任务未填写可识别的预算金额,需要人工确认' };
  let scoreBlocked = false;
  for (const policy of policies.values()) {
    if (!policy.enabled) continue;
    if (policy.allowedTypes?.length && !policy.allowedTypes.includes(item.humanGap.type)) continue;
    if (policy.maxAmountPerTask != null && amount > policy.maxAmountPerTask) continue;
    if (policy.dailyBudgetCap != null && spendSince(dayStartIso()) + amount > policy.dailyBudgetCap) continue;
    if (policy.monthlyBudgetCap != null && spendSince(monthStartIso()) + amount > policy.monthlyBudgetCap) continue;
    if (policy.minReliabilityScore != null) {
      const executorId = item.preferredExecutor || item.assignment?.handlerId || null;
      if (!executorId) { scoreBlocked = true; continue; }
      const score = getExecutor(executorId).reliabilityScore ?? 100;
      if (score < policy.minReliabilityScore) { scoreBlocked = true; continue; }
    }
    return { eligible: true, policy };
  }
  if (scoreBlocked) return { eligible: false, reason: '执行者可靠分低于策略要求,需要人工确认' };
  return { eligible: false, reason: '没有匹配的自动审批策略,需要人工确认' };
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': uiOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, X-HHBA-Approval-Token, X-HHBA-Internal-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE'
  });
  response.end(JSON.stringify(body));
}
function jsonWithHeaders(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': uiOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, X-HHBA-Approval-Token, X-HHBA-Internal-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    ...headers
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
  const { approval, assignment, audit, ...safe } = item;
  return { ...safe, approval: approval ? {
    status: approval.consumedAt ? 'CONSUMED' : approval.token ? 'ISSUED' : 'AWAITING_BROWSER_CONFIRMATION',
    autoApproved: Boolean(approval.autoApproved),
    policyId: approval.policyId || null,
    policyName: approval.policyName || null,
    expiresAt: approval.expiresAt,
    browserConfirmedAt: approval.browserConfirmedAt || null
  } : null };
}
function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter((pair) => pair.length));
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
  const preferredExecutorRaw = input.preferred_executor ?? input.preferredExecutor;
  return {
    id: `hcr_${randomUUID().slice(0, 8)}`, status: 'DRAFT', goal,
    foreman: normalizeForeman(input),
    agentContext: { sourceAgent: String(input.agent_context?.source_agent || 'unknown').trim(), completedWork: list(input.agent_context?.completed_work) },
    humanGap: { type, reason: String(input.human_gap?.reason || 'Agent identified a human capability gap.').trim() },
    capabilityRequirements: requirements.length ? requirements : [legacyCapability],
    acceptanceCriteria: list(input.acceptance_criteria ?? input.acceptanceCriteria).map((criterion) => String(criterion).trim()).filter(Boolean),
    preferredExecutor: preferredExecutorRaw != null && String(preferredExecutorRaw).trim() ? String(preferredExecutorRaw).trim() : null,
    deliverables: list(input.deliverables).length ? list(input.deliverables) : ['专业成果文件', '交付说明', '验收依据'],
    evidenceRequirements: list(input.evidence_requirements), location: input.location || null, budget: input.budget || null, deadline: input.deadline || null,
    frozenAmount: 0, verification: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), publishedAt: null, approval: null, assignment: null, deliverableBundle: null,
    audit: [{ at: new Date().toISOString(), event: 'DRAFT_CREATED', actor: 'agent' }]
  };
}
function find(id, response) {
  const item = requests.get(id);
  if (!item) json(response, 404, { error: 'human capability request not found' });
  return item;
}
function hasInternalAccess(request) {
  if (request.headers['x-hhba-internal-key'] === internalApiKey) return true;
  const sessionId = cookies(request).hhba_internal_session;
  const session = sessionId && internalSessions.get(sessionId);
  return Boolean(session && new Date(session.expiresAt) > new Date());
}
function internalRequestView(item) { return { ...serialize(item), assignment: item.assignment, audit: item.audit || [] }; }

loadRequests();
loadPolicies();
loadLedger();
loadExecutors();

http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return json(response, 204, {});
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', service: 'hhba-human-capability-api', protocol: 'HCP/0.2' });

  if (request.method === 'POST' && request.url === '/api/human-capability-requests/draft') {
    try {
      const item = normalize(await readBody(request));
      requests.set(item.id, item);
      persist();
      const policyCheck = evaluatePolicy(item);
      return json(response, 201, { id: item.id, status: item.status, proposal: { foreman: item.foreman, humanGap: item.humanGap, acceptanceCriteria: item.acceptanceCriteria, preferredExecutor: item.preferredExecutor, deliverables: item.deliverables, evidenceRequirements: item.evidenceRequirements, budget: item.budget, deadline: item.deadline }, approvalRequired: true,
        autoApproval: policyCheck.eligible
          ? { eligible: true, policyId: policyCheck.policy.id, policyName: policyCheck.policy.name }
          : { eligible: false, reason: policyCheck.reason } });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  if (request.method === 'POST' && request.url === '/internal/session') {
    if (request.headers['x-hhba-internal-key'] !== internalApiKey) return json(response, 403, { error: 'invalid HHBA internal key' });
    const sessionId = `hhba_ops_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + internalSessionLifetimeMs).toISOString();
    internalSessions.set(sessionId, { expiresAt });
    return jsonWithHeaders(response, 201, { status: 'authenticated', expiresAt }, {
      'Set-Cookie': `hhba_internal_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/internal; Max-Age=${Math.floor(internalSessionLifetimeMs / 1000)}`
    });
  }

  // 积分账本查询(需 internal key 或 ops session):余额 + 账本流水
  if (request.method === 'GET' && request.url === '/internal/ledger') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    return json(response, 200, {
      balances: ledger.balances,
      escrow: balanceOf('escrow'),
      entries: ledger.entries.slice(-200)
    });
  }

  // 执行者管理(需 internal key 或 ops session):可靠分查询/建档/批量导入(129 名真实用户走 import 保留)
  if (request.method === 'GET' && request.url === '/internal/executors') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    return json(response, 200, { executors: [...executors.values()] });
  }
  if (request.method === 'POST' && request.url === '/internal/executors') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    try {
      const body = await readBody(request);
      const id = String(body.id || '').trim();
      if (!id) return json(response, 400, { error: 'id is required' });
      const executor = getExecutor(id);
      if (body.displayName != null) executor.displayName = String(body.displayName).trim() || null;
      if (body.reliabilityScore != null) {
        const score = Number(body.reliabilityScore);
        if (!Number.isFinite(score) || score < 0 || score > 120) return json(response, 400, { error: 'reliabilityScore must be between 0 and 120' });
        executor.reliabilityScore = score;
      }
      executor.updatedAt = new Date().toISOString();
      persistExecutors();
      return json(response, 200, { executor });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'POST' && request.url === '/internal/executors/import') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    try {
      const body = await readBody(request);
      const items = list(body.executors);
      let imported = 0;
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const id = String(raw.id || '').trim();
        if (!id) continue;
        const executor = getExecutor(id);
        if (raw.displayName != null) executor.displayName = String(raw.displayName).trim() || null;
        if (raw.reliabilityScore != null) {
          const score = Number(raw.reliabilityScore);
          if (Number.isFinite(score)) executor.reliabilityScore = Math.min(120, Math.max(0, score));
        }
        executor.updatedAt = new Date().toISOString();
        imported += 1;
      }
      persistExecutors();
      return json(response, 200, { imported, total: executors.size });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // 验收环节(需 internal key,即工头调用):DELIVERED -> VERIFIED / REWORK -> DELIVERED
  const verifyMatch = request.url.match(/^\/internal\/tasks\/([^/]+)\/verify$/);
  if (verifyMatch) {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' });
    const [, verifyId] = verifyMatch;
    const item = find(verifyId, response);
    if (!item) return;
    try {
      const body = await readBody(request);
      if (item.status !== 'DELIVERED') return json(response, 409, { error: `cannot verify from ${item.status}` });
      if (typeof body.passed !== 'boolean') return json(response, 400, { error: 'passed (boolean) is required' });
      const reasons = list(body.reasons).map((reason) => String(reason).trim()).filter(Boolean);
      const now = new Date().toISOString();
      const handlerId = item.assignment?.handlerId || null;
      const amount = item.frozenAmount || 0;
      if (body.passed) {
        item.status = 'VERIFIED';
        item.verification = { passed: true, reasons, verifiedAt: now, verifiedBy: 'foreman' };
        audit(item, 'VERIFY_PASSED', { actor: 'foreman', reasons });
        let settled = 0;
        if (handlerId && amount > 0) {
          settled = settleCredits(item.id, amount, handlerId);
          item.frozenAmount = 0;
        }
        let executorScore = null;
        if (handlerId) {
          const executor = getExecutor(handlerId);
          executor.completedTasks += 1;
          executorScore = adjustReliability(handlerId, 2);
        }
        persist();
        return json(response, 200, { requestId: item.id, status: item.status, settledAmount: settled, executorScore });
      }
      item.status = 'REWORK';
      item.verification = { passed: false, reasons, verifiedAt: now, verifiedBy: 'foreman' };
      audit(item, 'VERIFY_REJECTED', { actor: 'foreman', reasons });
      let refunded = 0;
      if (amount > 0) {
        refunded = unfreezeCredits(item.id, amount);
        item.frozenAmount = 0;
      }
      let executorScore = null;
      if (handlerId) {
        const executor = getExecutor(handlerId);
        executor.rejectedTasks += 1;
        executorScore = adjustReliability(handlerId, -10);
      }
      persist();
      return json(response, 200, { requestId: item.id, status: item.status, refundedAmount: refunded, executorScore });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // 包工头模式:策略管理(需 internal key 或 ops session)
  const policyMatch = request.url.match(/^\/internal\/policies(?:\/([^/]+))?$/);
  if (policyMatch) {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    const [, policyId] = policyMatch;
    if (request.method === 'GET' && !policyId) return json(response, 200, { policies: [...policies.values()] });
    if (request.method === 'POST' && !policyId) {
      try {
        const policy = normalizePolicy(await readBody(request));
        policies.set(policy.id, policy); persistPolicies();
        return json(response, 201, { policy });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (request.method === 'POST' && policyId) {
      const existing = policies.get(policyId);
      if (!existing) return json(response, 404, { error: 'policy not found' });
      try {
        const policy = normalizePolicy(await readBody(request), existing);
        policies.set(policy.id, policy); persistPolicies();
        return json(response, 200, { policy });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (request.method === 'DELETE' && policyId) {
      if (!policies.delete(policyId)) return json(response, 404, { error: 'policy not found' });
      persistPolicies();
      return json(response, 200, { deleted: policyId });
    }
    return json(response, 405, { error: 'method not allowed' });
  }

  const internalMatch = request.url.match(/^\/internal\/human-capability-requests(?:\/([^/]+)(?:\/(claim|deliver))?)?$/);
  if (internalMatch) {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    const [, id, action] = internalMatch;
    if (request.method === 'GET' && !id) return json(response, 200, { requests: [...requests.values()].filter((item) => ['MATCHING_CAPABILITY', 'IN_PROGRESS', 'DELIVERED', 'REWORK', 'VERIFIED'].includes(item.status)).map(internalRequestView) });
    const item = find(id, response);
    if (!item) return;
    if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' });
    try {
      const body = await readBody(request);
      if (action === 'claim') {
        if (item.status !== 'MATCHING_CAPABILITY') return json(response, 409, { error: `cannot claim from ${item.status}` });
        const handlerId = String(body.handler_id || '').trim();
        if (!handlerId) return json(response, 400, { error: 'handler_id is required' });
        item.status = 'IN_PROGRESS';
        item.assignment = { handlerId, handlerDisplayName: String(body.handler_display_name || '').trim() || null, claimedAt: new Date().toISOString() };
        const executor = getExecutor(handlerId);
        if (item.assignment.handlerDisplayName) executor.displayName = item.assignment.handlerDisplayName;
        persistExecutors();
        audit(item, 'CAPABILITY_CLAIMED', { actor: handlerId }); persist();
        return json(response, 201, { requestId: id, status: item.status, assignment: item.assignment });
      }
      if (action === 'deliver') {
        if (item.status !== 'IN_PROGRESS' && item.status !== 'REWORK') return json(response, 409, { error: `cannot deliver from ${item.status}` });
        const artifacts = list(body.artifacts); const evidence = list(body.evidence);
        if (!artifacts.length && !evidence.length) return json(response, 400, { error: 'artifacts or evidence is required' });
        // 打回后重新交付:重新冻结预算积分
        if (item.status === 'REWORK') {
          const amount = budgetAmountOf(item);
          if (amount != null && amount > 0) {
            try {
              freezeCredits(id, amount);
              item.frozenAmount = amount;
            } catch (error) { return json(response, 409, { error: `重新交付需要重新冻结积分:${error.message}` }); }
          }
          audit(item, 'REDELIVERED_AFTER_REWORK', { actor: item.assignment?.handlerId || 'hhba-internal' });
        }
        item.status = 'DELIVERED';
        item.deliverableBundle = { submittedAt: new Date().toISOString(), summary: String(body.summary || '').trim(), artifacts, evidence, structuredAnswers: body.structured_answers || {}, acceptanceNotes: String(body.acceptance_notes || '').trim() };
        audit(item, 'DELIVERABLE_SUBMITTED', { actor: item.assignment?.handlerId || 'hhba-internal' }); persist();
        return json(response, 201, { requestId: id, status: item.status });
      }
      return json(response, 404, { error: 'internal operation not found' });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  const match = request.url.match(/^\/api\/human-capability-requests\/([^/]+)(?:\/(approval-sessions(?:\/([^/]+)\/confirm)?|publish|result))?$/);
  if (match) {
    const [, id, action, approvalSessionId] = match;
    const item = find(id, response);
    if (!item) return;
    if (request.method === 'GET' && !action) return json(response, 200, serialize(item));
    if (request.method === 'GET' && action === 'result') {
      if (!item.deliverableBundle) return json(response, 409, { error: 'deliverables are not available yet', status: item.status });
      return json(response, 200, { requestId: id, status: item.status, deliverableBundle: item.deliverableBundle });
    }
    if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' });
    if (action === 'approval-sessions' && !approvalSessionId) {
      if (item.status !== 'DRAFT') return json(response, 409, { error: `cannot request approval from ${item.status}` });
      item.status = 'AWAITING_USER_APPROVAL';
      const sessionId = `hhba_browser_${randomUUID()}`;
      const sessionSecret = randomUUID();
      item.approval = {
        sessionId, sessionSecret, token: null,
        expiresAt: new Date(Date.now() + approvalLifetimeMs).toISOString(),
        browserConfirmedAt: null, consumedAt: null
      };
      audit(item, 'BROWSER_CONFIRMATION_STARTED', { actor: 'browser' }); persist();
      return jsonWithHeaders(response, 201, { approvalId: sessionId, expiresAt: item.approval.expiresAt, status: item.status }, {
        'Set-Cookie': `hhba_approval_session=${encodeURIComponent(`${sessionId}.${sessionSecret}`)}; HttpOnly; SameSite=Lax; Path=/api/human-capability-requests/${id}/approval-sessions/${sessionId}; Max-Age=${Math.floor(approvalLifetimeMs / 1000)}`
      });
    }
    if (approvalSessionId) {
      try {
        const body = await readBody(request);
        const approval = item.approval;
        const browserSession = cookies(request).hhba_approval_session;
        const expectedSession = approval && `${approval.sessionId}.${approval.sessionSecret}`;
        const valid = approval && item.status === 'AWAITING_USER_APPROVAL' && approval.sessionId === approvalSessionId &&
          new Date(approval.expiresAt) > new Date() && browserSession === expectedSession && body.consent === true;
        if (!valid) return json(response, 403, { error: 'a valid browser confirmation session and explicit consent are required' });
        approval.sessionSecret = null;
        approval.browserConfirmedAt = new Date().toISOString();
        approval.token = `hhba_appr_${randomUUID()}`;
        item.status = 'APPROVED_FOR_PUBLISH';
        audit(item, 'BROWSER_CONSENT_CONFIRMED', { actor: 'browser' }); persist();
        return json(response, 201, { approvalToken: approval.token, expiresAt: approval.expiresAt, status: item.status });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (action === 'publish') {
      const approval = item.approval;
      const manualValid = approval && !approval.consumedAt && new Date(approval.expiresAt) > new Date() && request.headers['x-hhba-approval-token'] === approval.token;
      if (manualValid) {
        // 人工审批发布:同样冻结预算积分(冻结失败则不消费 token)
        const amount = budgetAmountOf(item);
        if (amount != null && amount > 0) {
          try {
            freezeCredits(id, amount);
            item.frozenAmount = amount;
          } catch (error) { return json(response, 409, { error: error.message }); }
        }
        approval.consumedAt = new Date().toISOString(); item.status = 'MATCHING_CAPABILITY'; item.publishedAt = approval.consumedAt;
        audit(item, 'PUBLISHED_TO_INTERNAL_MATCHING', { actor: 'browser' }); persist();
        return json(response, 201, { requestId: id, status: item.status, dispatch: 'INTERNAL_HHBA_MATCHING' });
      }
      // 包工头模式:只有 DRAFT 可按策略自动发布;已进入人工审批流的仍需走完人工确认
      if (item.status !== 'DRAFT') return json(response, 403, { error: 'a valid, unexpired backend-issued approval token is required' });
      const decision = evaluatePolicy(item);
      if (!decision.eligible) return json(response, 403, { error: decision.reason, approvalRequired: true });
      const amount = budgetAmountOf(item);
      if (amount != null && amount > 0) {
        try {
          freezeCredits(id, amount);
          item.frozenAmount = amount;
        } catch (error) { return json(response, 409, { error: error.message }); }
      }
      const now = new Date().toISOString();
      item.approval = { autoApproved: true, policyId: decision.policy.id, policyName: decision.policy.name, consumedAt: now };
      item.status = 'MATCHING_CAPABILITY'; item.publishedAt = now;
      audit(item, 'POLICY_AUTO_APPROVED', { actor: 'policy', policyId: decision.policy.id, policyName: decision.policy.name, budgetAmount: budgetAmountOf(item) }); persist();
      return json(response, 201, { requestId: id, status: item.status, dispatch: 'INTERNAL_HHBA_MATCHING', autoApproved: true, policyId: decision.policy.id });
    }
  }
  return json(response, 404, { error: 'not found' });
}).listen(8787, '127.0.0.1', () => console.log('HHBA API listening at http://127.0.0.1:8787'));
