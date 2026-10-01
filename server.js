import http from 'node:http';
import https from 'node:https';
import { randomUUID, createHash, createHmac, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

const requests = new Map();
const capabilityTypes = new Set(['DIGITAL_EXECUTION', 'EXPERT_JUDGMENT', 'REALITY_EXECUTION']);
const approvalLifetimeMs = 15 * 60 * 1000;
const dataDirectory = path.join(process.cwd(), 'data');
const dataFile = path.join(dataDirectory, 'human-capability-requests.json');
const policiesFile = path.join(dataDirectory, 'policies.json');
const ledgerFile = path.join(dataDirectory, 'ledger.json');
const executorsFile = path.join(dataDirectory, 'executors.json');
const usersFile = path.join(dataDirectory, 'users.json');
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

// ---- v0.4 用户验证码登录(执行者侧):QQ 邮箱先行,手机短信二期 ----
const smtpFile = path.join(dataDirectory, 'smtp.json');
let smtpConfig = null; // {host, port, user, pass}
function loadSmtp() {
  try { smtpConfig = JSON.parse(readFileSync(smtpFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; smtpConfig = null; }
}
function persistSmtp() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${smtpFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(smtpConfig, null, 2));
  chmodSync(temporaryFile, 0o600);
  renameSync(temporaryFile, smtpFile);
}

// ---- v0.6 短信通道(阿里云短信,老板在后台自配,不经手他人) ----
const smsFile = path.join(dataDirectory, 'sms.json');
let smsConfig = null; // {provider:'aliyun', accessKeyId, accessKeySecret, signName, templateCode}
function loadSms() {
  try { smsConfig = JSON.parse(readFileSync(smsFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; smsConfig = null; }
}
function persistSms() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${smsFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(smsConfig, null, 2));
  chmodSync(temporaryFile, 0o600);
  renameSync(temporaryFile, smsFile);
}
function smsConfigured() {
  return Boolean(smsConfig?.accessKeyId && smsConfig?.accessKeySecret && smsConfig?.signName && smsConfig?.templateCode);
}
// 阿里云 SendSms 签名(仅用内置 crypto/https,无新增依赖)
function aliyunPercentEncode(s) {
  return encodeURIComponent(s).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}
function sendOtpSms(phone, code) {
  if (!smsConfigured()) throw new Error('短信通道未配置,请先在后台「通知设置」里填写阿里云短信');
  const params = {
    AccessKeyId: smsConfig.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    SignName: smsConfig.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: smsConfig.templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    Version: '2017-05-25',
  };
  const sorted = Object.keys(params).sort().map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k])}`).join('&');
  const stringToSign = `GET&${aliyunPercentEncode('/')}&${aliyunPercentEncode(sorted)}`;
  const sig = createHmac('sha1', smsConfig.accessKeySecret + '&').update(stringToSign).digest('base64');
  const query = `${sorted}&${aliyunPercentEncode('Signature')}=${aliyunPercentEncode(sig)}`;
  return new Promise((resolve, reject) => {
    const req = https.get(`https://dysmsapi.aliyuncs.com/?${query}`, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.Code === 'OK') return resolve(data);
          reject(new Error(data.Message || data.Code || '短信发送失败'));
        } catch (error) { reject(new Error(`短信接口返回异常:${body.slice(0, 120)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('短信接口超时')); });
    req.on('error', reject);
  });
}
const otpStore = new Map(); // contactKey -> {code, expiresAt, attempts, lastSentAt, hourlySent:[ts]}
const userSessions = new Map(); // sessionId -> {userId, contactKey, displayName, expiresAt}
const userSessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_DEBUG = process.env.HHBA_OTP_DEBUG === '1'; // 仅本地联调:request-code 会在响应里带上验证码,生产环境绝不开启

function normalizeContact(raw) {
  const s = String(raw || '').trim();
  if (/^1\d{10}$/.test(s)) return { type: 'phone', value: s };
  const email = s.toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { type: 'email', value: email };
  return null;
}
function maskContact(contact) {
  if (contact.type === 'phone') return contact.value.slice(0, 3) + '****' + contact.value.slice(7);
  const [name, domain] = contact.value.split('@');
  return (name.length <= 3 ? name[0] + '****' : name.slice(0, 3) + '****') + '@' + domain;
}
function userIdFor(contact) {
  return 'usr_' + createHash('sha256').update(contact.type + ':' + contact.value).digest('hex').slice(0, 12);
}
function getUserSession(request) {
  const sessionId = cookies(request).hhba_user_session;
  const session = sessionId && userSessions.get(sessionId);
  if (!session || new Date(session.expiresAt) <= new Date()) {
    if (sessionId) userSessions.delete(sessionId);
    return null;
  }
  return { sessionId, ...session };
}
async function sendOtpEmail(to, code) {
  if (!smtpConfig?.host || !smtpConfig?.user || !smtpConfig?.pass) {
    throw new Error('邮件通知通道未配置,请先在后台「通知设置」里填写 QQ 邮箱 SMTP');
  }
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host, port: Number(smtpConfig.port) || 465, secure: true,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });
  await transporter.sendMail({
    from: `"HHBA" <${smtpConfig.user}>`, to,
    subject: '【HHBA】登录验证码',
    text: `您的 HHBA 登录验证码是 ${code},5 分钟内有效。如非本人操作请忽略。`,
  });
}

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

// ---- v0.9 任务模板化:预设模板快速发单,减少每次手填 ----
// 模板:{id, name, description, category, humanGapType, capabilityRequirements[], acceptanceCriteria[],
//       deliverables[], evidenceRequirements[], suggestedBudget:{min,max}, estimatedHours, tags[],
//       enabled, createdAt, updatedAt}
const taskTemplatesFile = path.join(dataDirectory, 'task-templates.json');
const taskTemplates = new Map();
function defaultTaskTemplates() {
  const now = new Date().toISOString();
  return [
    {
      id: 'tpl_h5_walkthrough',
      name: 'H5/落地页真机走查',
      description: '在真实手机上打开指定 H5 页面或落地页,按检查清单逐项走查并截图回传',
      category: 'H5走查',
      humanGapType: 'DIGITAL_EXECUTION',
      capabilityRequirements: ['拥有可正常上网的真实手机(Android 或 iOS)', '能在手机浏览器或微信内打开指定链接', '会按检查清单逐项验证并截图'],
      acceptanceCriteria: ['在真机上完整打开目标页面,加载无白屏/报错', '按检查清单逐项验证并给出通过/不通过结论', '每个检查项附带真机截图证据', '发现的问题附复现步骤说明'],
      deliverables: ['走查结论(通过/不通过 + 问题清单)', '真机截图包(按检查项命名)', '问题复现说明(如有)'],
      evidenceRequirements: ['真机截图(带手机状态栏,不得用模拟器)', '页面加载录屏(可选)'],
      suggestedBudget: { min: 20, max: 80 },
      estimatedHours: 1,
      tags: ['真机', 'H5', '走查', '截图'],
      enabled: true, createdAt: now, updatedAt: now,
    },
    {
      id: 'tpl_miniprogram_smoke',
      name: '小程序/App 冒烟测试',
      description: '按给定冒烟用例,在真机上对小程序或 App 做核心流程冒烟,记录问题截图',
      category: '小程序冒烟',
      humanGapType: 'DIGITAL_EXECUTION',
      capabilityRequirements: ['拥有可正常上网的真实手机', '已安装目标小程序/App 或可扫码进入', '理解冒烟测试用例并能严格执行'],
      acceptanceCriteria: ['按给定冒烟用例在真机上走完核心流程', '每个用例标记通过/失败', '失败用例附真机截图与复现步骤', '无阻塞性问题方可判通过'],
      deliverables: ['冒烟测试报告(用例 × 通过/失败)', '失败用例真机截图', '阻塞性问题说明(如有)'],
      evidenceRequirements: ['真机截图(带手机状态栏)', '关键步骤录屏(可选)'],
      suggestedBudget: { min: 30, max: 120 },
      estimatedHours: 2,
      tags: ['真机', '小程序', '冒烟测试', '截图'],
      enabled: true, createdAt: now, updatedAt: now,
    },
    {
      id: 'tpl_sandbox_payment',
      name: '沙箱表单/支付链路验证',
      description: '在沙箱/测试环境走完表单填写到支付全链路,截图留证(不涉及真实资金)',
      category: '表单支付验证',
      humanGapType: 'DIGITAL_EXECUTION',
      capabilityRequirements: ['拥有可正常上网的真实手机', '可进入指定的沙箱/测试环境(不涉及真实资金)', '能按步骤完成表单填写到支付全链路'],
      acceptanceCriteria: ['在沙箱环境走完表单填写→提交→支付全链路', '每个环节截图留证', '异常环节记录错误信息与复现步骤', '确认全程未使用真实资金/真实支付'],
      deliverables: ['全链路验证报告(环节 × 通过/失败)', '各环节截图证据包', '异常记录(如有)'],
      evidenceRequirements: ['各环节真机截图', '沙箱环境标识截图(证明非生产环境)'],
      suggestedBudget: { min: 40, max: 150 },
      estimatedHours: 2,
      tags: ['沙箱', '表单', '支付链路', '真机'],
      enabled: true, createdAt: now, updatedAt: now,
    },
  ];
}
function loadTaskTemplates() {
  try {
    const saved = JSON.parse(readFileSync(taskTemplatesFile, 'utf8'));
    for (const item of saved.templates || []) taskTemplates.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // 首次启动:写入 3 个内置首发模板
  if (taskTemplates.size === 0) {
    for (const tpl of defaultTaskTemplates()) taskTemplates.set(tpl.id, tpl);
    persistTaskTemplates();
  }
}
function persistTaskTemplates() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${taskTemplatesFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, templates: [...taskTemplates.values()] }, null, 2));
  renameSync(temporaryFile, taskTemplatesFile);
}
// 创建/更新模板的字段校验(风格与 normalizePolicy 一致)
function normalizeTaskTemplate(input, existing) {
  const now = new Date().toISOString();
  const rawId = input.id ?? existing?.id;
  const id = rawId != null && String(rawId).trim() ? String(rawId).trim() : `tpl_${randomUUID().slice(0, 8)}`;
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('name is required');
  const description = String(input.description ?? existing?.description ?? '').trim();
  const category = String(input.category ?? existing?.category ?? '').trim();
  if (!category) throw new Error('category is required');
  const humanGapType = String(input.humanGapType ?? input.human_gap_type ?? existing?.humanGapType ?? 'DIGITAL_EXECUTION').trim();
  if (!capabilityTypes.has(humanGapType)) throw new Error(`humanGapType must be one of: ${[...capabilityTypes].join(', ')}`);
  const capabilityRequirements = list(input.capabilityRequirements ?? input.capability_requirements ?? existing?.capabilityRequirements).map((s) => String(s).trim()).filter(Boolean);
  if (!capabilityRequirements.length) throw new Error('capabilityRequirements is required');
  const acceptanceCriteria = list(input.acceptanceCriteria ?? input.acceptance_criteria ?? existing?.acceptanceCriteria).map((s) => String(s).trim()).filter(Boolean);
  if (!acceptanceCriteria.length) throw new Error('acceptanceCriteria is required');
  const sb = input.suggestedBudget ?? input.suggested_budget ?? existing?.suggestedBudget ?? null;
  let suggestedBudget = null;
  if (sb != null) {
    const min = Number(sb.min), max = Number(sb.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      throw new Error('suggestedBudget must be {min, max} with 0 <= min <= max');
    }
    suggestedBudget = { min, max };
  }
  const hoursRaw = input.estimatedHours ?? input.estimated_hours ?? existing?.estimatedHours ?? null;
  let estimatedHours = null;
  if (hoursRaw != null && hoursRaw !== '') {
    estimatedHours = Number(hoursRaw);
    if (!Number.isFinite(estimatedHours) || estimatedHours <= 0) throw new Error('estimatedHours must be a positive number');
  }
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : (existing?.enabled ?? true);
  return {
    id, name, description, category, humanGapType,
    capabilityRequirements,
    acceptanceCriteria,
    deliverables: list(input.deliverables ?? existing?.deliverables).map((s) => String(s).trim()).filter(Boolean),
    evidenceRequirements: list(input.evidenceRequirements ?? input.evidence_requirements ?? existing?.evidenceRequirements).map((s) => String(s).trim()).filter(Boolean),
    suggestedBudget, estimatedHours,
    tags: list(input.tags ?? existing?.tags).map((t) => String(t).trim()).filter(Boolean),
    enabled,
    createdAt: existing?.createdAt || now, updatedAt: now,
  };
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
// ---- v0.6 通用用户模型:邮箱/手机登录归属用户,角色区分执行者与老板 ----
const users = new Map(); // userId -> {id, displayName, roles, contacts:[{type,value}], passwordHash, createdAt, updatedAt}
function loadUsers() {
  try {
    const saved = JSON.parse(readFileSync(usersFile, 'utf8'));
    for (const item of saved.users || []) users.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function persistUsers() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${usersFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, users: [...users.values()] }, null, 2));
  renameSync(temporaryFile, usersFile);
}
function getUser(id) {
  return users.get(String(id).trim()) || null;
}
// 登录即建档:按联系方式找用户,找不到则新建(默认执行者角色);老执行者档案自动迁移展示名
function getOrCreateUser(contact) {
  const userId = userIdFor(contact);
  let user = users.get(userId);
  if (!user) {
    const now = new Date().toISOString();
    const legacy = executors.get(userId);
    user = {
      id: userId,
      displayName: legacy?.displayName || maskContact(contact),
      roles: ['executor'],
      contacts: [{ type: contact.type, value: contact.value }],
      passwordHash: null,
      createdAt: now, updatedAt: now,
    };
    users.set(userId, user);
    persistUsers();
  } else {
    // 同一用户换了联系方式登录,合并联系方式
    if (!user.contacts.some((c) => c.type === contact.type && c.value === contact.value)) {
      user.contacts.push({ type: contact.type, value: contact.value });
      user.updatedAt = new Date().toISOString();
      persistUsers();
    }
  }
  return user;
}
function publicUser(user) {
  const executor = executors.get(user.id);
  return {
    id: user.id,
    displayName: user.displayName,
    roles: user.roles || ['executor'],
    hasPassword: Boolean(user.passwordHash),
    reliabilityScore: executor?.reliabilityScore ?? 100,
    completedTasks: executor?.completedTasks ?? 0,
    rejectedTasks: executor?.rejectedTasks ?? 0,
  };
}
// ---- 密码:scrypt 哈希(内置 crypto,无新增依赖) ----
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  const derived = scryptSync(String(password), salt, 64);
  const expectedBuf = Buffer.from(expected, 'hex');
  return derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf);
}
// 找不到则按基准分 100 建档(老执行者自动保留);展示名优先取用户档案
function getExecutor(id) {
  const key = String(id).trim();
  let executor = executors.get(key);
  if (!executor) {
    const now = new Date().toISOString();
    executor = { id: key, displayName: users.get(key)?.displayName || null, reliabilityScore: 100, completedTasks: 0, rejectedTasks: 0, createdAt: now, updatedAt: now };
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

// ---- v0.8 复合信誉分:公开评价 30% + 私有反馈 50% + 履约数据 20%(借鉴 Upwork JSS) ----
// 反馈记录:{id, taskId, executorId, bossId, publicScore, publicComment, privateScore, privateNote, taskAmount, createdAt}
// 私有反馈不对执行者公开,仅用于复合分计算;公开评价对执行者可见
const feedbackFile = path.join(dataDirectory, 'feedback.json');
const feedbacks = [];
function loadFeedbacks() {
  try {
    const saved = JSON.parse(readFileSync(feedbackFile, 'utf8'));
    for (const item of saved.feedbacks || []) feedbacks.push(item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function persistFeedbacks() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${feedbackFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, feedbacks }, null, 2));
  renameSync(temporaryFile, feedbackFile);
}
const DAY_MS = 24 * 3600 * 1000;
// 多时间窗口权重:近30天 60%,30-90天 30%,90天以上 10%
function timeWindowWeight(createdAt) {
  const age = Date.now() - new Date(createdAt).getTime();
  if (age <= 30 * DAY_MS) return 0.6;
  if (age <= 90 * DAY_MS) return 0.3;
  return 0.1;
}
// 1-5星映射到 0-100分
function starsToScore(stars) { return ((Number(stars) - 1) / 4) * 100; }
// 金额加权平均:权重 = 任务积分 × 时间窗口权重(大额任务反馈权重更高)
function weightedScore(entries) {
  let weightedSum = 0, weightSum = 0;
  for (const entry of entries) {
    const amountWeight = entry.amount > 0 ? entry.amount : 1;
    const weight = amountWeight * timeWindowWeight(entry.createdAt);
    weightedSum += starsToScore(entry.stars) * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : null;
}
// 恶意发单方剔除:某老板给所有执行者的评分均值<2且方差小(>=3条才判定),其反馈不计入
function findMaliciousBosses() {
  const scoresByBoss = new Map();
  for (const fb of feedbacks) {
    for (const score of [fb.publicScore, fb.privateScore]) {
      if (score == null) continue;
      if (!scoresByBoss.has(fb.bossId)) scoresByBoss.set(fb.bossId, []);
      scoresByBoss.get(fb.bossId).push(Number(score));
    }
  }
  const malicious = new Set();
  for (const [bossId, scores] of scoresByBoss) {
    if (scores.length < 3) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    if (mean < 2 && variance < 0.5) malicious.add(bossId);
  }
  return malicious;
}
// 履约数据分(0-100):完成率 50% + 准时交付率 30% + (1-拒收率) 20%
function computeFulfillmentScore(executorId) {
  const executor = getExecutor(executorId);
  const completed = executor.completedTasks || 0;
  const rejected = executor.rejectedTasks || 0;
  const total = completed + rejected;
  const completionRate = total > 0 ? completed / total : 1;
  const rejectionRate = total > 0 ? rejected / total : 0;
  let onTime = 0, withDeadline = 0;
  for (const item of requests.values()) {
    if (item.assignment?.handlerId !== executorId) continue;
    if (!['VERIFIED', 'DELIVERED'].includes(item.status)) continue;
    if (!item.deadline || !item.deliveredAt) continue;
    withDeadline += 1;
    if (new Date(item.deliveredAt) <= new Date(item.deadline)) onTime += 1;
  }
  const onTimeRate = withDeadline > 0 ? onTime / withDeadline : completionRate;
  const score = 100 * (0.5 * completionRate + 0.3 * onTimeRate + 0.2 * (1 - rejectionRate));
  return { score, completed, rejected, completionRate, onTimeRate, rejectionRate, withDeadline };
}
// 复合信誉分:公开评价均值×30% + 私有反馈均值×50% + 履约数据分×20%
// 某维度无数据时权重按比例分给有数据的维度;无任何反馈时保持原有分数不变
function computeReputation(executorId) {
  const maliciousBosses = findMaliciousBosses();
  const usable = feedbacks.filter((fb) => fb.executorId === executorId && !maliciousBosses.has(fb.bossId));
  const excludedCount = feedbacks.filter((fb) => fb.executorId === executorId && maliciousBosses.has(fb.bossId)).length;
  const publicEntries = usable.filter((fb) => fb.publicScore != null)
    .map((fb) => ({ stars: fb.publicScore, amount: fb.taskAmount, createdAt: fb.createdAt }));
  const privateEntries = usable.filter((fb) => fb.privateScore != null)
    .map((fb) => ({ stars: fb.privateScore, amount: fb.taskAmount, createdAt: fb.createdAt }));
  const publicAvg = weightedScore(publicEntries);
  const privateAvg = weightedScore(privateEntries);
  const fulfillment = computeFulfillmentScore(executorId);
  const parts = [];
  if (publicAvg != null) parts.push({ avg: publicAvg, weight: 0.3 });
  if (privateAvg != null) parts.push({ avg: privateAvg, weight: 0.5 });
  parts.push({ avg: fulfillment.score, weight: 0.2 });
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const composite = parts.reduce((sum, part) => sum + part.avg * (part.weight / totalWeight), 0);
  return {
    executorId,
    composite,
    hasFeedback: publicEntries.length + privateEntries.length > 0,
    public: { average: publicAvg, count: publicEntries.length, weight: 0.3 },
    private: { average: privateAvg, count: privateEntries.length, weight: 0.5 },
    fulfillment: { ...fulfillment, weight: 0.2 },
    excludedFeedbacks: excludedCount,
    maliciousBossCount: [...maliciousBosses].filter((bossId) =>
      feedbacks.some((fb) => fb.executorId === executorId && fb.bossId === bossId)).length,
  };
}
// 同步复合分到 reliabilityScore:有反馈时用复合分覆盖,无反馈时保留原有增量逻辑
function syncCompositeScore(executorId) {
  const reputation = computeReputation(executorId);
  if (!reputation.hasFeedback) return reputation;
  const executor = getExecutor(executorId);
  executor.reliabilityScore = Math.min(120, Math.max(0, Math.round(reputation.composite)));
  executor.updatedAt = new Date().toISOString();
  persistExecutors();
  return reputation;
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
    frozenAmount: 0, verification: null, deliveredAt: null,
    autoApproveHours: Number(input.auto_approve_hours ?? input.autoApproveHours) > 0 ? Number(input.auto_approve_hours ?? input.autoApproveHours) : 72,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), publishedAt: null, approval: null, assignment: null, deliverableBundle: null,
    audit: [{ at: new Date().toISOString(), event: 'DRAFT_CREATED', actor: 'agent' }]
  };
}
function find(id, response) {
  const item = requests.get(id);
  if (!item) json(response, 404, { error: 'human capability request not found' });
  return item;
}
// v0.7: 拒收理由枚举（防恶意拒收，拒收必须选理由）
const REJECT_REASONS = {
  INCOMPLETE: '交付不完整',
  QUALITY_FAIL: '质量不达验收标准',
  LATE: '超时交付',
  SPAM: '明显零付出/灌水',
};
// v0.7: 超时自动批准 — 扫描 DELIVERED 超时的任务，自动验收通过
function checkAutoApprove() {
  const now = Date.now();
  let autoApproved = 0;
  for (const item of requests.values()) {
    if (item.status !== 'DELIVERED' || !item.deliveredAt) continue;
    const hours = item.autoApproveHours ?? 72;
    if (now - new Date(item.deliveredAt).getTime() < hours * 3600 * 1000) continue;
    // 超时未验收，自动通过（MTurk 经验：不作为的默认后果应对执行方有利）
    const verifiedAt = new Date().toISOString();
    item.status = 'VERIFIED';
    item.verification = { passed: true, reasons: [], verifiedAt, verifiedBy: 'auto-approve', autoApproved: true };
    audit(item, 'VERIFY_AUTO_APPROVED', { actor: 'system', reason: `验收超时 ${hours}h 未处理，自动通过` });
    const handlerId = item.assignment?.handlerId || null;
    const amount = item.frozenAmount || 0;
    if (handlerId && amount > 0) {
      settleCredits(item.id, amount, handlerId);
      item.frozenAmount = 0;
    }
    if (handlerId) {
      const executor = getExecutor(handlerId);
      executor.completedTasks += 1;
      adjustReliability(handlerId, 2);
      syncCompositeScore(handlerId); // v0.8:有反馈时用复合信誉分覆盖增量分
    }
    autoApproved++;
  }
  if (autoApproved > 0) persist();
  return autoApproved;
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
loadTaskTemplates();
loadLedger();
loadExecutors();
loadFeedbacks();
loadUsers();
loadSmtp();
loadSms();

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

  // v0.9:任务模板列表(公开):只返回启用的模板
  if (request.method === 'GET' && request.url === '/api/task-templates') {
    const templates = [...taskTemplates.values()].filter((t) => t.enabled);
    return json(response, 200, { templates, total: templates.length });
  }

  // v0.9:任务模板详情(公开)
  const templateDetailMatch = request.url.match(/^\/api\/task-templates\/([^/]+)$/);
  if (templateDetailMatch && request.method === 'GET') {
    const tpl = taskTemplates.get(decodeURIComponent(templateDetailMatch[1]).trim());
    if (!tpl || !tpl.enabled) return json(response, 404, { error: 'task template not found' });
    return json(response, 200, { template: tpl });
  }

  // v0.9:创建/更新任务模板(需 internal key)
  if (request.method === 'POST' && request.url === '/api/task-templates') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    try {
      const body = await readBody(request);
      const existing = body.id ? taskTemplates.get(String(body.id).trim()) : null;
      if (body.id && !existing) return json(response, 404, { error: 'task template not found' });
      const tpl = normalizeTaskTemplate(body, existing);
      taskTemplates.set(tpl.id, tpl);
      persistTaskTemplates();
      return json(response, existing ? 200 : 201, { template: tpl });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // v0.9:禁用任务模板(需 internal key,软删除:保留数据,列表不再展示)
  const templateDisableMatch = request.url.match(/^\/api\/task-templates\/([^/]+)$/);
  if (templateDisableMatch && request.method === 'DELETE') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    const tpl = taskTemplates.get(decodeURIComponent(templateDisableMatch[1]).trim());
    if (!tpl) return json(response, 404, { error: 'task template not found' });
    tpl.enabled = false;
    tpl.updatedAt = new Date().toISOString();
    persistTaskTemplates();
    return json(response, 200, { disabled: tpl.id });
  }

  // v0.9:从模板创建任务(公开,需用户登录或 internal key)
  // 注意:必须放在 /api/human-capability-requests/:id 通配路由之前,否则会被当成任务 id
  if (request.method === 'POST' && request.url === '/api/human-capability-requests/from-template') {
    const session = getUserSession(request);
    if (!session && !hasInternalAccess(request)) return json(response, 401, { error: '请先登录或使用 internal key' });
    try {
      const body = await readBody(request);
      const templateId = String(body.templateId ?? body.template_id ?? '').trim();
      const tpl = taskTemplates.get(templateId);
      if (!tpl || !tpl.enabled) return json(response, 404, { error: 'task template not found' });
      // 模板字段做默认值,调用方可覆盖(goal/budget/deadline/preferredExecutor/location 等)
      const merged = {
        goal: String(body.goal ?? `${tpl.name}: ${tpl.description}`).trim(),
        human_gap: { type: tpl.humanGapType, reason: String(body.humanGapReason ?? body.human_gap_reason ?? tpl.description).trim() },
        capability_requirements: body.capabilityRequirements ?? body.capability_requirements ?? tpl.capabilityRequirements,
        acceptance_criteria: body.acceptanceCriteria ?? body.acceptance_criteria ?? tpl.acceptanceCriteria,
        deliverables: body.deliverables ?? tpl.deliverables,
        evidence_requirements: body.evidenceRequirements ?? body.evidence_requirements ?? tpl.evidenceRequirements,
        budget: body.budget ?? (tpl.suggestedBudget ? tpl.suggestedBudget.min : null),
        deadline: body.deadline ?? null,
        location: body.location ?? null,
        preferredExecutor: body.preferredExecutor ?? body.preferred_executor ?? null,
        autoApproveHours: body.autoApproveHours ?? body.auto_approve_hours,
        foreman: body.foreman,
        agent_context: body.agent_context,
      };
      const item = normalize(merged);
      item.templateId = tpl.id;
      item.templateName = tpl.name;
      // 预算超出模板建议范围:给出 warning,不阻止
      let budgetWarning = null;
      const amount = budgetAmountOf(item);
      const { min, max } = tpl.suggestedBudget || {};
      if (amount != null && min != null && max != null && (amount < min || amount > max)) {
        budgetWarning = `预算 ${amount} 超出模板建议范围 ${min}-${max}`;
      }
      audit(item, 'CREATED_FROM_TEMPLATE', { actor: session ? session.userId : 'internal', templateId: tpl.id, templateName: tpl.name });
      requests.set(item.id, item);
      persist();
      const policyCheck = evaluatePolicy(item);
      return json(response, 201, {
        id: item.id, status: item.status, templateId: tpl.id, templateName: tpl.name,
        budgetWarning, approvalRequired: true,
        autoApproval: policyCheck.eligible
          ? { eligible: true, policyId: policyCheck.policy.id, policyName: policyCheck.policy.name }
          : { eligible: false, reason: policyCheck.reason },
      });
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

  // ---- v0.6 用户验证码登录:QQ 邮箱 + 手机短信,归属通用用户 ----
  if (request.method === 'POST' && request.url === '/api/auth/request-code') {
    try {
      const body = await readBody(request);
      const contact = normalizeContact(body.contact);
      if (!contact) return json(response, 400, { error: '请输入正确的手机号或邮箱' });
      const key = contact.type + ':' + contact.value;
      const now = Date.now();
      const prev = otpStore.get(key);
      if (prev && now - prev.lastSentAt < 60 * 1000) {
        return json(response, 429, { error: '发送太频繁,请 60 秒后再试' });
      }
      const hourly = (prev?.hourlySent || []).filter((ts) => now - ts < 60 * 60 * 1000);
      const channelName = contact.type === 'phone' ? '该手机号' : '该邮箱';
      if (hourly.length >= 5) return json(response, 429, { error: `${channelName}一小时内发送已达上限,请稍后再试` });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      otpStore.set(key, { code, expiresAt: now + OTP_TTL_MS, attempts: 0, lastSentAt: now, hourlySent: [...hourly, now] });
      const out = { sentTo: maskContact(contact), expiresIn: OTP_TTL_MS / 1000 };
      const channelReady = contact.type === 'phone' ? smsConfigured() : Boolean(smtpConfig?.host && smtpConfig?.user && smtpConfig?.pass);
      if (OTP_DEBUG && !channelReady) {
        out.debugCode = code; // 本地联调桩:未配通道时跳过真实发送,生产环境绝不开启
        out.stubbed = true;
        return json(response, 200, out);
      }
      try {
        if (contact.type === 'phone') await sendOtpSms(contact.value, code);
        else await sendOtpEmail(contact.value, code);
      } catch (error) {
        otpStore.delete(key);
        return json(response, 502, { error: `验证码发送失败:${error.message}` });
      }
      if (OTP_DEBUG) out.debugCode = code;
      return json(response, 200, out);
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  if (request.method === 'POST' && request.url === '/api/auth/verify') {
    try {
      const body = await readBody(request);
      const contact = normalizeContact(body.contact);
      const code = String(body.code || '').trim();
      if (!contact || !/^\d{6}$/.test(code)) return json(response, 400, { error: '邮箱或验证码格式不正确' });
      const key = contact.type + ':' + contact.value;
      const record = otpStore.get(key);
      const now = Date.now();
      if (!record || now > record.expiresAt) {
        otpStore.delete(key);
        return json(response, 400, { error: '验证码已失效,请重新获取' });
      }
      if (record.attempts >= 5) {
        otpStore.delete(key);
        return json(response, 400, { error: '尝试次数过多,请重新获取验证码' });
      }
      if (record.code !== code) {
        record.attempts += 1;
        return json(response, 400, { error: `验证码不正确(还剩 ${5 - record.attempts} 次)` });
      }
      otpStore.delete(key);
      const user = getOrCreateUser(contact);
      const sessionId = `hhba_user_${randomUUID()}`;
      const expiresAt = new Date(now + userSessionLifetimeMs).toISOString();
      userSessions.set(sessionId, { userId: user.id, contactKey: key, displayName: user.displayName, expiresAt });
      return jsonWithHeaders(response, 200, { user: publicUser(user) }, {
        'Set-Cookie': `hhba_user_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(userSessionLifetimeMs / 1000)}`,
      });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // 账号密码登录(需先通过验证码登录并设置过密码)
  if (request.method === 'POST' && request.url === '/api/auth/login-password') {
    try {
      const body = await readBody(request);
      const contact = normalizeContact(body.contact);
      const password = String(body.password || '');
      if (!contact || !password) return json(response, 400, { error: '请输入账号与密码' });
      const user = getUser(userIdFor(contact));
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json(response, 401, { error: '账号或密码不正确' });
      }
      // 密码登录顺带合并本次联系方式
      getOrCreateUser(contact);
      const now = Date.now();
      const sessionId = `hhba_user_${randomUUID()}`;
      const expiresAt = new Date(now + userSessionLifetimeMs).toISOString();
      userSessions.set(sessionId, { userId: user.id, contactKey: contact.type + ':' + contact.value, displayName: user.displayName, expiresAt });
      return jsonWithHeaders(response, 200, { user: publicUser(user) }, {
        'Set-Cookie': `hhba_user_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(userSessionLifetimeMs / 1000)}`,
      });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // 已登录用户设置/修改登录密码(需先通过验证码证明归属)
  if (request.method === 'POST' && request.url === '/api/auth/set-password') {
    try {
      const session = getUserSession(request);
      if (!session) return json(response, 401, { error: '请先登录' });
      const body = await readBody(request);
      const password = String(body.password || '');
      if (password.length < 6) return json(response, 400, { error: '密码至少 6 位' });
      if (password.length > 72) return json(response, 400, { error: '密码过长' });
      const user = getUser(session.userId);
      if (!user) return json(response, 401, { error: '用户不存在,请重新登录' });
      user.passwordHash = hashPassword(password);
      user.updatedAt = new Date().toISOString();
      persistUsers();
      return json(response, 200, { status: 'password_set', hasPassword: true });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  if (request.method === 'GET' && request.url === '/api/auth/me') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '尚未登录' });
    const user = getUser(session.userId);
    if (!user) return json(response, 401, { error: '用户不存在,请重新登录' });
    return json(response, 200, { user: publicUser(user) });
  }

  if (request.method === 'POST' && request.url === '/api/auth/logout') {
    const session = getUserSession(request);
    if (session) userSessions.delete(session.sessionId);
    return jsonWithHeaders(response, 200, { status: 'logged_out' }, {
      'Set-Cookie': 'hhba_user_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    });
  }

  // 执行者用自己的登录态认领任务(用户侧,无需 internal key)
  const claimUserMatch = request.url.match(/^\/api\/human-capability-requests\/([^/]+)\/claim-user$/);
  if (claimUserMatch && request.method === 'POST') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录后再认领任务' });
    const item = find(claimUserMatch[1], response);
    if (!item) return;
    if (item.status !== 'MATCHING_CAPABILITY') return json(response, 409, { error: `该任务当前不可认领(状态:${item.status})` });
    const executor = getExecutor(session.userId);
    item.status = 'IN_PROGRESS';
    item.assignment = { handlerId: session.userId, handlerDisplayName: executor.displayName, claimedAt: new Date().toISOString() };
    audit(item, 'CAPABILITY_CLAIMED', { actor: session.userId, via: 'user_login' });
    persist();
    return json(response, 200, { requestId: item.id, status: item.status, assignment: item.assignment });
  }

  // 执行者浏览与交付(用户侧)
  if (request.method === 'GET' && request.url === '/api/human-capability-requests/open') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录' });
    const open = [...requests.values()].filter((i) => i.status === 'MATCHING_CAPABILITY').map(serialize);
    return json(response, 200, { requests: open });
  }
  if (request.method === 'GET' && request.url === '/api/human-capability-requests/mine') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录' });
    const mine = [...requests.values()]
      .filter((i) => i.assignment?.handlerId === session.userId && ['IN_PROGRESS', 'DELIVERED', 'REWORK', 'VERIFIED'].includes(i.status))
      .map((i) => ({ ...serialize(i), assignment: i.assignment }));
    return json(response, 200, { requests: mine });
  }
  const deliverUserMatch = request.url.match(/^\/api\/human-capability-requests\/([^/]+)\/deliver-user$/);
  if (deliverUserMatch && request.method === 'POST') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录' });
    const item = find(deliverUserMatch[1], response);
    if (!item) return;
    if (item.assignment?.handlerId !== session.userId) return json(response, 403, { error: '只能交付自己认领的任务' });
    if (item.status !== 'IN_PROGRESS' && item.status !== 'REWORK') return json(response, 409, { error: `当前状态不可交付:${item.status}` });
    try {
      const body = await readBody(request);
      const artifacts = list(body.artifacts); const evidence = list(body.evidence);
      if (!artifacts.length && !evidence.length) return json(response, 400, { error: '请填写交付物或证据' });
      if (item.status === 'REWORK') {
        const amount = budgetAmountOf(item);
        if (amount != null && amount > 0) {
          try { freezeCredits(item.id, amount); item.frozenAmount = amount; }
          catch (error) { return json(response, 409, { error: `重新交付需要重新冻结积分:${error.message}` }); }
        }
        audit(item, 'REDELIVERED_AFTER_REWORK', { actor: session.userId });
      }
      item.status = 'DELIVERED';
      item.deliveredAt = new Date().toISOString();
      item.deliverableBundle = { submittedAt: new Date().toISOString(), summary: String(body.summary || '').trim(), artifacts, evidence, structuredAnswers: body.structured_answers || {}, acceptanceNotes: String(body.acceptance_notes || '').trim() };
      audit(item, 'DELIVERABLE_SUBMITTED', { actor: session.userId }); persist();
      return json(response, 201, { requestId: item.id, status: item.status });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // 通知通道设置(需 internal key,即老板在后台自己配,授权码不经手他人)
  if (request.url === '/internal/settings/smtp') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    if (request.method === 'GET') {
      return json(response, 200, {
        configured: Boolean(smtpConfig?.host && smtpConfig?.user && smtpConfig?.pass),
        host: smtpConfig?.host || 'smtp.qq.com', port: smtpConfig?.port || 465, user: smtpConfig?.user || '',
      });
    }
    if (request.method === 'POST') {
      try {
        const body = await readBody(request);
        const host = String(body.host || 'smtp.qq.com').trim();
        const port = Number(body.port) || 465;
        const user = String(body.user || '').trim();
        const pass = String(body.pass || '');
        if (!host || !user || !pass) return json(response, 400, { error: 'host / user / pass 均不能为空' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return json(response, 400, { error: 'user 需为邮箱地址' });
        smtpConfig = { host, port, user, pass };
        persistSmtp();
        return json(response, 200, { configured: true, host, port, user });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    return json(response, 405, { error: 'method not allowed' });
  }
  if (request.method === 'POST' && request.url === '/internal/settings/smtp/test') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    try {
      const body = await readBody(request);
      const to = String(body.to || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json(response, 400, { error: 'to 需为邮箱地址' });
      await sendOtpEmail(to, '123456');
      return json(response, 200, { sentTo: to });
    } catch (error) { return json(response, 502, { error: `测试发送失败:${error.message}` }); }
  }

  // 短信通道设置(阿里云短信,需 internal key;密钥不回传页面)
  if (request.url === '/internal/settings/sms') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    if (request.method === 'GET') {
      return json(response, 200, {
        configured: smsConfigured(),
        provider: 'aliyun',
        signName: smsConfig?.signName || '',
        templateCode: smsConfig?.templateCode || '',
        accessKeyIdMasked: smsConfig?.accessKeyId ? smsConfig.accessKeyId.slice(0, 4) + '****' : '',
      });
    }
    if (request.method === 'POST') {
      try {
        const body = await readBody(request);
        const accessKeyId = String(body.accessKeyId || '').trim();
        const accessKeySecret = String(body.accessKeySecret || '');
        const signName = String(body.signName || '').trim();
        const templateCode = String(body.templateCode || '').trim();
        if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
          return json(response, 400, { error: 'AccessKeyId / AccessKeySecret / 短信签名 / 模板 Code 均不能为空' });
        }
        smsConfig = { provider: 'aliyun', accessKeyId, accessKeySecret, signName, templateCode };
        persistSms();
        return json(response, 200, { configured: true, provider: 'aliyun', signName, templateCode });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    return json(response, 405, { error: 'method not allowed' });
  }
  if (request.method === 'POST' && request.url === '/internal/settings/sms/test') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    try {
      const body = await readBody(request);
      const to = String(body.to || '').trim();
      if (!/^1\d{10}$/.test(to)) return json(response, 400, { error: 'to 需为手机号' });
      await sendOtpSms(to, '123456');
      return json(response, 200, { sentTo: to });
    } catch (error) { return json(response, 502, { error: `测试发送失败:${error.message}` }); }
  }

  // 用户管理(需 internal key):列表与角色授予
  if (request.method === 'GET' && request.url === '/internal/users') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    return json(response, 200, {
      users: [...users.values()].map((u) => ({
        id: u.id, displayName: u.displayName, roles: u.roles || ['executor'],
        contacts: (u.contacts || []).map((c) => ({ type: c.type, value: maskContact(c) })),
        hasPassword: Boolean(u.passwordHash), createdAt: u.createdAt,
      })),
    });
  }
  const userRolesMatch = request.url.match(/^\/internal\/users\/([^/]+)\/roles$/);
  if (userRolesMatch && request.method === 'POST') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    try {
      const user = getUser(decodeURIComponent(userRolesMatch[1]));
      if (!user) return json(response, 404, { error: '用户不存在' });
      const body = await readBody(request);
      const roles = [...new Set((Array.isArray(body.roles) ? body.roles : []).map((r) => String(r).trim()).filter((r) => ['executor', 'boss'].includes(r)))];
      if (!roles.length) return json(response, 400, { error: 'roles 至少包含 executor 或 boss 之一' });
      user.roles = roles;
      user.updatedAt = new Date().toISOString();
      persistUsers();
      return json(response, 200, { user: publicUser(user) });
    } catch (error) { return json(response, 400, { error: error.message }); }
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
  // v0.7: 拒收理由必须从枚举中选择；每次验收前先跑一遍超时自动批准
  const verifyMatch = request.url.match(/^\/internal\/tasks\/([^/]+)\/verify$/);
  if (verifyMatch) {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' });
    checkAutoApprove(); // 顺手处理超时的任务
    const [, verifyId] = verifyMatch;
    const item = find(verifyId, response);
    if (!item) return;
    try {
      const body = await readBody(request);
      if (item.status !== 'DELIVERED') return json(response, 409, { error: `cannot verify from ${item.status}` });
      if (typeof body.passed !== 'boolean') return json(response, 400, { error: 'passed (boolean) is required' });
      const reasons = list(body.reasons).map((reason) => String(reason).trim()).filter(Boolean);
      // v0.7: 拒收时理由必须从枚举中选，防恶意拒收
      if (!body.passed) {
        const invalid = reasons.filter((r) => !REJECT_REASONS[r]);
        if (invalid.length) return json(response, 400, { error: `拒收理由必须是以下之一: ${Object.keys(REJECT_REASONS).join(', ')}；非法值: ${invalid.join(', ')}` });
        if (!reasons.length) return json(response, 400, { error: `拒收必须选择理由: ${Object.keys(REJECT_REASONS).join(', ')}` });
      }
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
          syncCompositeScore(handlerId); // v0.8:有反馈时用复合信誉分覆盖增量分
          executorScore = getExecutor(handlerId).reliabilityScore;
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
        syncCompositeScore(handlerId); // v0.8:有反馈时用复合信誉分覆盖增量分
        executorScore = getExecutor(handlerId).reliabilityScore;
      }
      persist();
      return json(response, 200, { requestId: item.id, status: item.status, refundedAmount: refunded, executorScore });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // v0.8:任务反馈(需 internal key,即工头/老板调用):公开评价 + 私有反馈一次提交
  // 私有反馈不对执行者公开,仅用于复合信誉分计算
  const feedbackMatch = request.url.match(/^\/api\/tasks\/([^/]+)\/feedback$/);
  if (feedbackMatch && request.method === 'POST') {
    if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
    const item = find(feedbackMatch[1], response);
    if (!item) return;
    try {
      const body = await readBody(request);
      if (item.status !== 'VERIFIED') return json(response, 409, { error: `只能对已验收的任务提交反馈(当前状态:${item.status})` });
      const handlerId = item.assignment?.handlerId || null;
      if (!handlerId) return json(response, 409, { error: '该任务没有执行者,无法提交反馈' });
      if (feedbacks.some((fb) => fb.taskId === item.id)) return json(response, 409, { error: '该任务已提交过反馈' });
      const pickScore = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const num = Number(value);
        if (!Number.isInteger(num) || num < 1 || num > 5) return 'invalid';
        return num;
      };
      const publicScore = pickScore(body.publicScore ?? body.public_score);
      const privateScore = pickScore(body.privateScore ?? body.private_score);
      if (publicScore === 'invalid' || privateScore === 'invalid') {
        return json(response, 400, { error: '评分必须是 1-5 的整数' });
      }
      if (publicScore == null && privateScore == null) {
        return json(response, 400, { error: '公开评价与私有反馈至少提交一项' });
      }
      const bossId = String(body.bossId || body.boss_id || 'boss').trim() || 'boss';
      const feedback = {
        id: `fb_${randomUUID().slice(0, 8)}`,
        taskId: item.id,
        executorId: handlerId,
        bossId,
        publicScore,
        publicComment: String(body.publicComment ?? body.public_comment ?? '').trim() || null,
        privateScore,
        privateNote: String(body.privateNote ?? body.private_note ?? '').trim() || null,
        taskAmount: budgetAmountOf(item) ?? 0,
        createdAt: new Date().toISOString(),
      };
      feedbacks.push(feedback);
      persistFeedbacks();
      audit(item, 'FEEDBACK_SUBMITTED', { actor: bossId, hasPublic: publicScore != null, hasPrivate: privateScore != null });
      persist();
      const reputation = syncCompositeScore(handlerId);
      return json(response, 201, {
        feedbackId: feedback.id,
        taskId: item.id,
        executorId: handlerId,
        reliabilityScore: getExecutor(handlerId).reliabilityScore,
        composite: Math.round(reputation.composite * 10) / 10,
      });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // v0.8:执行者信誉分详情(公开):复合分 = 公开评价均值×30% + 私有反馈均值×50% + 履约数据分×20%
  // 私有反馈仅展示聚合均值,不暴露单条私有评分
  const reputationMatch = request.url.match(/^\/api\/executors\/([^/]+)\/reputation$/);
  if (reputationMatch && request.method === 'GET') {
    const executorId = decodeURIComponent(reputationMatch[1]).trim();
    const executor = executors.get(executorId);
    if (!executor) return json(response, 404, { error: 'executor not found' });
    const reputation = computeReputation(executorId);
    const round1 = (n) => n == null ? null : Math.round(n * 10) / 10;
    const maliciousBosses = findMaliciousBosses();
    const publicFeedbacks = feedbacks
      .filter((fb) => fb.executorId === executorId && !maliciousBosses.has(fb.bossId) && fb.publicScore != null)
      .map((fb) => ({
        taskId: fb.taskId, publicScore: fb.publicScore, publicComment: fb.publicComment,
        taskAmount: fb.taskAmount, createdAt: fb.createdAt,
      }));
    return json(response, 200, {
      executorId,
      displayName: executor.displayName,
      reliabilityScore: executor.reliabilityScore ?? 100,
      composite: {
        score: round1(reputation.composite),
        hasFeedback: reputation.hasFeedback,
        public: { average: round1(reputation.public.average), count: reputation.public.count, weight: 0.3 },
        private: { average: round1(reputation.private.average), count: reputation.private.count, weight: 0.5 },
        fulfillment: {
          score: round1(reputation.fulfillment.score), weight: 0.2,
          completedTasks: reputation.fulfillment.completed,
          rejectedTasks: reputation.fulfillment.rejected,
          completionRate: round1(reputation.fulfillment.completionRate * 100),
          onTimeRate: round1(reputation.fulfillment.onTimeRate * 100),
          rejectionRate: round1(reputation.fulfillment.rejectionRate * 100),
        },
        excludedFeedbacks: reputation.excludedFeedbacks,
        maliciousBossCount: reputation.maliciousBossCount,
      },
      publicFeedbacks, // 公开评价对执行者可见;私有反馈不返回单条
      updatedAt: executor.updatedAt,
    });
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
        item.deliveredAt = new Date().toISOString();
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

// v0.7: 每 5 分钟检查一次超时未验收的任务，自动批准
setInterval(() => {
  try {
    const n = checkAutoApprove();
    if (n > 0) console.log(`[auto-approve] ${n} 个超时任务已自动验收`);
  } catch (e) { console.error('[auto-approve] error:', e.message); }
}, 5 * 60 * 1000);
