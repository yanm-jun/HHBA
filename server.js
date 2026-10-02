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

// v1.3: 任务状态变更邮件通知 — SMTP 未配置或收件人无邮箱时静默跳过,发送失败不阻塞主流程
function getUserEmail(userId) {
  if (!userId) return null;
  const user = typeof getUser === 'function' ? getUser(userId) : users.get(String(userId).trim());
  if (!user || !Array.isArray(user.contacts)) return null;
  const email = user.contacts.find((c) => c && c.type === 'email' && c.value);
  return email ? String(email.value).trim().toLowerCase() : null;
}
function getBossEmail(item) {
  // 优先级:任务上的 bossEmail > foreman 留的联系方式 > 跳过
  if (item.bossEmail && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(item.bossEmail))) return String(item.bossEmail).trim().toLowerCase();
  const f = item.foreman || {};
  for (const key of ['email', 'contactEmail']) {
    if (f[key] && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(f[key]))) return String(f[key]).trim().toLowerCase();
  }
  return null;
}
const TASK_EVENT_MAIL = {
  CLAIMED: (item, extra) => ({
    subject: `【HHBA】你的任务已被认领: ${item.goal?.slice(0, 30)}`,
    text: [`你的任务已被执行者认领:`, ``, `任务: ${item.goal}`, `任务 ID: ${item.id}`, `认领人: ${extra.handlerName || extra.handlerId || '未知'}`, `认领时间: ${new Date().toLocaleString('zh-CN')}`, ``, `查看任务大厅: /tasks.html`].join('\n'),
  }),
  DELIVERED: (item) => ({
    subject: `【HHBA】任务已交付,请验收: ${item.goal?.slice(0, 30)}`,
    text: [`执行者已提交交付物,请尽快验收:`, ``, `任务: ${item.goal}`, `任务 ID: ${item.id}`, `交付时间: ${new Date().toLocaleString('zh-CN')}`, ``, `72 小时内未处理将自动验收通过。`, `查看任务大厅: /tasks.html`].join('\n'),
  }),
  VERIFIED: (item, extra) => ({
    subject: `【HHBA】验收通过,积分已结算: ${item.goal?.slice(0, 30)}`,
    text: [`恭喜!你的交付已通过验收:`, ``, `任务: ${item.goal}`, `任务 ID: ${item.id}`, extra.settledAmount > 0 ? `结算积分: ${extra.settledAmount}` : '', ``, `查看我的任务: /tasks.html`].filter(Boolean).join('\n'),
  }),
  REWORK: (item, extra) => ({
    subject: `【HHBA】交付被打回,请重做: ${item.goal?.slice(0, 30)}`,
    text: [`你的交付被打回,需要重做:`, ``, `任务: ${item.goal}`, `任务 ID: ${item.id}`, `打回理由: ${(extra.reasons || []).join('、') || '未注明'}`, ``, `请尽快重新交付。`, `查看我的任务: /tasks.html`].join('\n'),
  }),
  DISPUTE_OPENED: (item, extra) => ({
    subject: `【HHBA】纠纷已发起: ${item.goal?.slice(0, 30)}`,
    text: [`任务 ${item.id} 已发起纠纷,进入协商阶段:`, ``, `任务: ${item.goal}`, `发起方: ${extra.raisedBy || '未知'}`, `原因: ${extra.reason || '未注明'}`, ``, `48 小时内未解决将自动升级到平台仲裁。`].join('\n'),
  }),
  DISPUTE_RESOLVED: (item, extra) => ({
    subject: `【HHBA】纠纷已解决: ${item.goal?.slice(0, 30)}`,
    text: [`任务 ${item.id} 的纠纷已有结论:`, ``, `任务: ${item.goal}`, `结论: ${extra.resolution || '未知'}`, extra.note ? `备注: ${extra.note}` : '', ``, `如有异议请联系平台。`].filter(Boolean).join('\n'),
  }),
};
async function notifyTaskEvent(item, event, extra = {}) {
  try {
    if (!smtpConfig?.host || !smtpConfig?.user || !smtpConfig?.pass) return; // 未配置则静默跳过
    const tpl = TASK_EVENT_MAIL[event];
    if (!tpl) return;
    const { subject, text } = tpl(item, extra);
    const recipients = new Set();
    if (event === 'CLAIMED' || event === 'DELIVERED') {
      const boss = getBossEmail(item);
      if (boss) recipients.add(boss);
    } else if (event === 'VERIFIED' || event === 'REWORK') {
      const handlerId = item.assignment?.handlerId;
      const email = getUserEmail(handlerId);
      if (email) recipients.add(email);
    } else if (event === 'DISPUTE_OPENED' || event === 'DISPUTE_RESOLVED') {
      const boss = getBossEmail(item);
      if (boss) recipients.add(boss);
      const handlerId = item.assignment?.handlerId || extra.executorId;
      const email = getUserEmail(handlerId);
      if (email) recipients.add(email);
    }
    if (!recipients.size) return;
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host, port: Number(smtpConfig.port) || 465, secure: true,
      auth: { user: smtpConfig.user, pass: smtpConfig.pass },
    });
    for (const to of recipients) {
      await transporter.sendMail({ from: `"HHBA" <${smtpConfig.user}>`, to, subject, text });
    }
  } catch (error) {
    console.error(`[notify] ${event} 邮件发送失败:`, error.message); // 不阻塞主流程
  }
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
// 返回 { user, isNewUser }
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
      onboarded: false, // 新用户未完成引导;老用户无此字段视为 true(见 publicUser)
      createdAt: now, updatedAt: now,
    };
    users.set(userId, user);
    persistUsers();
    return { user, isNewUser: true };
  } else {
    // 同一用户换了联系方式登录,合并联系方式
    if (!user.contacts.some((c) => c.type === contact.type && c.value === contact.value)) {
      user.contacts.push({ type: contact.type, value: contact.value });
      user.updatedAt = new Date().toISOString();
      persistUsers();
    }
  }
  return { user, isNewUser: false };
}
function publicUser(user) {
  const executor = executors.get(user.id);
  return {
    id: user.id,
    displayName: user.displayName,
    roles: user.roles || ['executor'],
    onboarded: user.onboarded !== false, // 老用户无此字段视为已引导,不打扰
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

// ---- v1.2 真实能力测评:执行者能力画像 ----
// 内置技能标签,与三个任务模板一一对应
const SKILL_TAGS = {
  h5_walkthrough: { tag: 'h5_walkthrough', name: 'H5/落地页真机走查', description: '在真实手机上按检查清单走查页面并截图回传', templateId: 'tpl_h5_walkthrough' },
  miniprogram_smoke: { tag: 'miniprogram_smoke', name: '小程序/App 冒烟测试', description: '按用例在真机上跑核心流程并记录问题', templateId: 'tpl_miniprogram_smoke' },
  sandbox_payment: { tag: 'sandbox_payment', name: '沙箱表单/支付链路验证', description: '在沙箱环境走完表单到支付全链路', templateId: 'tpl_sandbox_payment' },
};
const SKILL_SOURCES = ['self', 'assessment', 'task']; // 自报 / 测评认证 / 实战积累
// 确保执行者有 skills 数组(向后兼容:老执行者自动初始化)
function ensureExecutorSkills(executor) {
  if (!Array.isArray(executor.skills)) executor.skills = [];
  return executor.skills;
}
// 获取或创建某技能记录
function getExecutorSkill(executor, tag) {
  ensureExecutorSkills(executor);
  let skill = executor.skills.find((s) => s.tag === tag);
  if (!skill) {
    skill = { tag, level: 1, verified: false, verifiedAt: null, source: 'self' };
    executor.skills.push(skill);
  }
  return skill;
}
// 设置/更新技能(自报或系统更新)
function upsertExecutorSkill(executorId, tag, { level, verified, source }) {
  if (!SKILL_TAGS[tag]) throw new Error(`未知的技能标签: ${tag},可选: ${Object.keys(SKILL_TAGS).join(', ')}`);
  const executor = getExecutor(executorId);
  const skill = getExecutorSkill(executor, tag);
  const now = new Date().toISOString();
  if (level != null) {
    const lv = Number(level);
    if (!Number.isInteger(lv) || lv < 1 || lv > 5) throw new Error('level 必须是 1-5 的整数');
    skill.level = lv;
  }
  if (source && SKILL_SOURCES.includes(source)) skill.source = source;
  if (verified === true) {
    skill.verified = true;
    skill.verifiedAt = now;
  } else if (verified === false) {
    skill.verified = false;
    skill.verifiedAt = null;
  }
  skill.updatedAt = now;
  executor.updatedAt = now;
  persistExecutors();
  return skill;
}
// 公开的技能画像(脱敏)
function publicExecutorSkills(executorId) {
  const executor = executors.get(String(executorId).trim());
  if (!executor) return null;
  ensureExecutorSkills(executor);
  return {
    executorId: executor.id,
    displayName: executor.displayName || null,
    reliabilityScore: executor.reliabilityScore ?? 100,
    skills: executor.skills.map((s) => ({
      tag: s.tag,
      name: SKILL_TAGS[s.tag]?.name || s.tag,
      level: s.level, verified: s.verified, verifiedAt: s.verifiedAt, source: s.source,
    })),
  };
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

// ---- v1.0 纠纷模块:三级纠纷处理(双方协商 -> 平台仲裁 -> 终审) ----
// 纠纷:{id, taskId, executorId, bossId, reason, description, evidence[], status, level,
//       messages[{id,authorId,authorRole,text,createdAt}], confirmations{executor,boss},
//       escalatedBy, prevOutcome, history[], level1Deadline,
//       resolution{outcome,note,decidedBy,decidedAt}, createdAt, updatedAt}
// status: OPEN(协商中) -> IN_REVIEW(仲裁中) -> RESOLVED(已解决) / ESCALATED(终审中)
// level: 1=双方协商, 2=平台仲裁, 3=终审
const DISPUTE_REASONS = {
  UNFAIR_REJECT: '无理打回',
  UNCLEAR_CRITERIA: '验收标准不清',
  PAYMENT_DISPUTE: '结算争议',
  OTHER: '其他',
};
// Level 1 协商时限,默认 48 小时;测试可用 HHBA_DISPUTE_L1_MS 覆盖
const DISPUTE_L1_MS = Number(process.env.HHBA_DISPUTE_L1_MS) > 0 ? Number(process.env.HHBA_DISPUTE_L1_MS) : 48 * 3600 * 1000;
const disputesFile = path.join(dataDirectory, 'disputes.json');
const disputes = new Map();
function loadDisputes() {
  try {
    const saved = JSON.parse(readFileSync(disputesFile, 'utf8'));
    for (const item of saved.disputes || []) disputes.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function persistDisputes() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${disputesFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, disputes: [...disputes.values()] }, null, 2));
  renameSync(temporaryFile, disputesFile);
}
// ---- v1.2 测评任务:标准化的能力考题,本质是特殊任务(isAssessment=true) ----
// 测评记录:{id, skillTag, title, description, checklist[], taskId(关联的任务), status, grade, createdAt, ...}
const assessmentsFile = path.join(dataDirectory, 'assessments.json');
const assessments = new Map();
function loadAssessments() {
  try {
    const saved = JSON.parse(readFileSync(assessmentsFile, 'utf8'));
    for (const item of saved.assessments || []) assessments.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function persistAssessments() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${assessmentsFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, assessments: [...assessments.values()] }, null, 2));
  renameSync(temporaryFile, assessmentsFile);
}
// 创建测评任务:生成一个 isAssessment=true 的任务 + 测评记录
function createAssessment({ skillTag, title, description, checklist, budget }, identity) {
  if (!SKILL_TAGS[skillTag]) throw new Error(`未知的技能标签: ${skillTag},可选: ${Object.keys(SKILL_TAGS).join(', ')}`);
  const tag = SKILL_TAGS[skillTag];
  const now = new Date().toISOString();
  const item = normalize({
    goal: String(title || `${tag.name}能力测评`).trim(),
    human_gap: { type: 'DIGITAL_EXECUTION', reason: String(description || tag.description).trim() },
    capability_requirements: checklist && checklist.length ? checklist : ['按测评检查清单完成并提交证据'],
    acceptance_criteria: checklist && checklist.length ? checklist : ['完成测评清单'],
    budget: budget || null,
  });
  item.isAssessment = true;
  item.assessmentSkillTag = skillTag;
  audit(item, 'ASSESSMENT_CREATED', { actor: 'platform', skillTag, ...auditActor(identity) });
  requests.set(item.id, item);
  const assessment = {
    id: `asm_${randomUUID().slice(0, 8)}`,
    skillTag, taskId: item.id,
    title: item.goal, description: String(description || tag.description).trim(),
    checklist: list(checklist),
    status: 'OPEN', // OPEN / CLAIMED / DELIVERED / GRADED
    grade: null, // {score, passed, feedback, gradedAt, gradedBy}
    createdAt: now, updatedAt: now,
  };
  assessments.set(assessment.id, assessment);
  persist(); persistAssessments();
  return { assessment, task: item };
}
// 测评打分:通过则给执行者该技能认证
function gradeAssessment(assessmentId, { score, passed, feedback }, identity) {
  const assessment = assessments.get(String(assessmentId).trim());
  if (!assessment) return { error: 404 };
  if (assessment.status === 'GRADED') return { error: 409, message: '该测评已打分' };
  const sc = Number(score);
  if (!Number.isInteger(sc) || sc < 1 || sc > 5) return { error: 400, message: 'score 必须是 1-5 的整数' };
  if (typeof passed !== 'boolean') return { error: 400, message: 'passed (boolean) is required' };
  const item = requests.get(assessment.taskId);
  const handlerId = item?.assignment?.handlerId || null;
  if (!handlerId) return { error: 409, message: '该测评任务还没有执行者认领' };
  const now = new Date().toISOString();
  assessment.grade = { score: sc, passed, feedback: String(feedback || '').trim(), gradedAt: now, gradedBy: identity?.keyName || 'platform' };
  assessment.status = 'GRADED';
  assessment.updatedAt = now;
  if (item) {
    audit(item, 'ASSESSMENT_GRADED', { actor: 'platform', score: sc, passed, ...auditActor(identity) });
    // 测评任务验收通过也算完成(不走资金结算)
    if (passed && item.status === 'DELIVERED') {
      item.status = 'VERIFIED';
      item.verification = { passed: true, reasons: [], verifiedAt: now, verifiedBy: 'assessment' };
    }
    persist();
  }
  let skill = null;
  if (passed) {
    skill = upsertExecutorSkill(handlerId, assessment.skillTag, { level: sc, verified: true, source: 'assessment' });
  }
  persistAssessments();
  return { assessment, skill, executorId: handlerId };
}
function disputeSystemMessage(d, text) {
  const now = new Date().toISOString();
  d.messages.push({ id: `msg_${randomUUID().slice(0, 8)}`, authorId: 'system', authorRole: 'system', text, createdAt: now });
  return now;
}
// 任务是否有关联的进行中纠纷(OPEN / IN_REVIEW / ESCALATED)
function activeDisputeForTask(taskId) {
  for (const d of disputes.values()) {
    if (d.taskId === taskId && ['OPEN', 'IN_REVIEW', 'ESCALATED'].includes(d.status)) return d;
  }
  return null;
}
// v1.0: Level 1 协商超时未解决,自动升级到 Level 2 平台仲裁
function checkDisputeEscalation() {
  const now = Date.now();
  let escalated = 0;
  for (const d of disputes.values()) {
    if (d.status !== 'OPEN' || d.level !== 1) continue;
    if (!d.level1Deadline || now < new Date(d.level1Deadline).getTime()) continue;
    d.level = 2;
    d.status = 'IN_REVIEW';
    d.updatedAt = disputeSystemMessage(d, 'Level 1 协商超时未达成一致,已自动升级到 Level 2 平台仲裁');
    escalated++;
  }
  if (escalated > 0) persistDisputes();
  return escalated;
}

// ---- v1.1: AI 工头独立 API Key ----
// 人类走 /api/auth 登录,AI 工头走 API Key:每个工头独立签发、可吊销、可限流、可审计。
// 旧的 X-HHBA-Internal-Key 继续有效(标记为 legacy,向后兼容)。
const API_KEY_SCOPES = ['draft', 'publish', 'claim', 'deliver', 'verify', 'feedback', 'dispute', 'admin', 'assessment'];
const DEFAULT_API_KEY_SCOPES = ['draft', 'publish', 'claim', 'deliver'];
const apiKeysFile = path.join(dataDirectory, 'api-keys.json');
const apiKeys = new Map(); // id -> record
function loadApiKeys() {
  try {
    const saved = JSON.parse(readFileSync(apiKeysFile, 'utf8'));
    for (const item of saved.apiKeys || []) apiKeys.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function persistApiKeys() {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${apiKeysFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, apiKeys: [...apiKeys.values()] }, null, 2));
  renameSync(temporaryFile, apiKeysFile);
}
function sha256Hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}
function findApiKeyByHash(keyHash) {
  for (const rec of apiKeys.values()) {
    if (!rec.deleted && rec.keyHash === keyHash) return rec;
  }
  return null;
}
// key 生命周期审计(签发/吊销/暂停/恢复/删除),记在 key 记录自身上
function keyAudit(rec, event, details = {}) {
  rec.keyAudit = [...(rec.keyAudit || []), { at: new Date().toISOString(), event, ...details }];
}
// 脱敏视图:永不返回 keyHash 与明文 key
function publicKeyView(rec) {
  const { keyHash, ...rest } = rec;
  return rest;
}
// v1.1: 每个 API Key 独立限流(内存计数,服务重启清零可接受)
const apiKeyUsage = new Map(); // keyId -> { minuteStart, minuteCount, dayStart, dayCount }
function checkApiKeyRateLimit(rec) {
  const now = Date.now();
  const rl = rec.rateLimit || {};
  const perMinute = Number(rl.perMinute) > 0 ? Math.floor(Number(rl.perMinute)) : 60;
  const perDay = Number(rl.perDay) > 0 ? Math.floor(Number(rl.perDay)) : 1000;
  let u = apiKeyUsage.get(rec.id);
  if (!u) { u = { minuteStart: now, minuteCount: 0, dayStart: now, dayCount: 0 }; apiKeyUsage.set(rec.id, u); }
  if (now - u.minuteStart >= 60000) { u.minuteStart = now; u.minuteCount = 0; }
  if (now - u.dayStart >= 86400000) { u.dayStart = now; u.dayCount = 0; }
  if (u.minuteCount >= perMinute || u.dayCount >= perDay) return false;
  u.minuteCount += 1;
  u.dayCount += 1;
  return true;
}
// v1.1: API Key 调用记录(内存环形缓冲,最近 1000 条,供审计)
const apiKeyCallLog = [];
function logApiKeyCall(identity, request, status) {
  if (!identity || identity.kind !== 'api-key') return;
  apiKeyCallLog.push({
    at: new Date().toISOString(),
    keyId: identity.keyId, keyName: identity.keyName, tool: identity.tool,
    method: request.method, endpoint: String(request.url).split('?')[0], status,
  });
  if (apiKeyCallLog.length > 1000) apiKeyCallLog.splice(0, apiKeyCallLog.length - 1000);
}
// v1.1: 解析调用方身份:新 API Key / 旧 internal key(legacy) / ops session / 未认证
function getApiKeyIdentity(request) {
  const presented = request.headers['x-hhba-api-key'];
  if (presented) {
    const rec = findApiKeyByHash(sha256Hex(presented));
    if (!rec) return { kind: 'api-key', invalid: true };
    if (rec.status !== 'active') {
      return { kind: 'api-key', keyId: rec.id, keyName: rec.name, tool: rec.tool, status: rec.status, inactive: true };
    }
    if (!checkApiKeyRateLimit(rec)) {
      return { kind: 'api-key', keyId: rec.id, keyName: rec.name, tool: rec.tool, status: rec.status, rateLimited: true };
    }
    rec.lastUsedAt = new Date().toISOString();
    persistApiKeys();
    return { kind: 'api-key', keyId: rec.id, keyName: rec.name, tool: rec.tool, scopes: rec.scopes || [], rateLimit: rec.rateLimit };
  }
  if (request.headers['x-hhba-internal-key'] === internalApiKey) {
    return { kind: 'legacy-key', legacy: true, keyName: 'legacy-internal-key' };
  }
  const sessionId = cookies(request).hhba_internal_session;
  const session = sessionId && internalSessions.get(sessionId);
  if (session && new Date(session.expiresAt) > new Date()) {
    return { kind: 'ops-session', keyName: 'ops-session' };
  }
  return null;
}
// v1.1: internal 接口统一鉴权入口。
// 返回 identity;鉴权失败时已写响应并返回 null。
// scope 为空表示不做 scope 检查;legacy key 与 ops session 拥有全部权限(向后兼容),
// 只有新签发的 API Key 受 scopes 约束。
function requireInternal(request, response, scope) {
  const identity = getApiKeyIdentity(request);
  // 无身份:保持与旧 hasInternalAccess 一致的 403(向后兼容)
  if (!identity) { json(response, 403, { error: 'HHBA internal access is required' }); return null; }
  if (identity.invalid) { json(response, 401, { error: 'invalid API key' }); return null; }
  if (identity.inactive) { logApiKeyCall(identity, request, 403); json(response, 403, { error: `API key is ${identity.status}` }); return null; }
  if (identity.rateLimited) { logApiKeyCall(identity, request, 429); json(response, 429, { error: 'API key rate limit exceeded' }); return null; }
  if (scope && identity.kind === 'api-key' && !(identity.scopes || []).includes(scope)) {
    logApiKeyCall(identity, request, 403);
    json(response, 403, { error: `missing required scope: ${scope}` });
    return null;
  }
  logApiKeyCall(identity, request, 200);
  return identity;
}
// v1.1: 把调用方身份塞进任务 audit,知道是哪台 AI 干的
function auditActor(identity) {
  if (!identity) return {};
  if (identity.kind === 'api-key') return { keyId: identity.keyId, keyName: identity.keyName, tool: identity.tool };
  if (identity.kind === 'legacy-key') return { keyName: 'legacy-internal-key', legacy: true };
  return { keyName: 'ops-session' };
}
// 仲裁支持执行者:任务 REWORK -> VERIFIED,从老板处重新冻结预算并结算给执行者
// 抛错时调用方负责转成 409(老板积分不足等)
function applyArbitrationExecutorWin(item, dispute, actorExtra = {}) {
  const handlerId = item.assignment?.handlerId || null;
  const amount = budgetAmountOf(item) || 0;
  const now = new Date().toISOString();
  if (handlerId && amount > 0) {
    freezeCredits(item.id, amount); // boss -> escrow,余额不足时抛错
    settleCredits(item.id, amount, handlerId); // escrow -> executor
    item.frozenAmount = 0;
    item.arbitrationSettled = amount;
  }
  item.status = 'VERIFIED';
  item.verification = { passed: true, reasons: [], verifiedAt: now, verifiedBy: 'dispute-arbitration', disputeId: dispute.id };
  audit(item, 'DISPUTE_ARBITRATED', { actor: 'platform', disputeId: dispute.id, decision: 'EXECUTOR', ...actorExtra });
  if (handlerId) {
    const executor = getExecutor(handlerId);
    executor.rejectedTasks = Math.max(0, (executor.rejectedTasks || 0) - 1); // 打回被推翻,撤销一次拒收计数
    executor.completedTasks += 1;
    adjustReliability(handlerId, 2);
    syncCompositeScore(handlerId); // v0.8:有反馈时用复合信誉分覆盖
  }
  persist();
  return amount;
}
// 终审改判(EXECUTOR -> BOSS):追回仲裁结算,任务 VERIFIED -> REWORK
function reverseArbitrationExecutorWin(item, dispute, actorExtra = {}) {
  const handlerId = item.assignment?.handlerId || null;
  const amount = item.arbitrationSettled || 0;
  const now = new Date().toISOString();
  if (handlerId && amount > 0) {
    const execAccount = `executor:${handlerId}`;
    const clawed = Math.min(amount, balanceOf(execAccount));
    ledger.balances[execAccount] = balanceOf(execAccount) - clawed;
    ledger.balances.boss = balanceOf('boss') + clawed;
    addLedgerEntry('DISPUTE_CLAWBACK', { requestId: item.id, amount: clawed, from: execAccount, to: 'boss', note: '终审改判,追回仲裁结算' });
    persistLedger();
    item.arbitrationSettled = 0;
  }
  item.status = 'REWORK';
  item.verification = { passed: false, reasons: [], verifiedAt: now, verifiedBy: 'dispute-final', disputeId: dispute.id, note: '终审改判,退回返工' };
  audit(item, 'DISPUTE_FINAL_REVERSED', { actor: 'platform', disputeId: dispute.id, decision: 'BOSS', ...actorExtra });
  if (handlerId) {
    const executor = getExecutor(handlerId);
    executor.completedTasks = Math.max(0, (executor.completedTasks || 0) - 1);
    executor.rejectedTasks = (executor.rejectedTasks || 0) + 1;
    adjustReliability(handlerId, -2);
    syncCompositeScore(handlerId);
  }
  persist();
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
  // v1.2:任务所需技能标签(用于能力匹配);只保留内置标签
  const requiredSkills = list(input.requiredSkills ?? input.required_skills)
    .map((s) => String(s).trim()).filter((s) => SKILL_TAGS[s]);
  return {
    id: `hcr_${randomUUID().slice(0, 8)}`, status: 'DRAFT', goal,
    foreman: normalizeForeman(input),
    agentContext: { sourceAgent: String(input.agent_context?.source_agent || 'unknown').trim(), completedWork: list(input.agent_context?.completed_work) },
    humanGap: { type, reason: String(input.human_gap?.reason || 'Agent identified a human capability gap.').trim() },
    capabilityRequirements: requirements.length ? requirements : [legacyCapability],
    requiredSkills,
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
// v1.3: 超时阈值常量(小时),方便调整
const TIMEOUT_HOURS = {
  DELIVERED_AUTO_APPROVE: 72,   // 交付后无人验收 → 自动通过
  MATCHING_NO_CLAIM: 48,        // 无人认领 → 自动取消
  IN_PROGRESS_NO_DELIVERY: 72,  // 执行者消失 → 标记过期
  AWAITING_APPROVAL: 24,        // 无人确认 → 自动取消
  REWORK_NO_REDELIVERY: 72,     // 打回后未重交 → 标记过期
};
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

// v1.3: 全状态超时回收 — 扫描卡在各状态超时的任务,自动取消/过期并解冻资金
// 测评任务(isAssessment=true)不适用(平台行为,不冻结真实资金)
function checkTimeouts() {
  const now = Date.now();
  const stats = { cancelledNoClaim: 0, expiredNoDelivery: 0, cancelledNoApproval: 0, expiredRework: 0 };
  let changed = false;
  for (const item of requests.values()) {
    if (item.isAssessment) continue;
    const elapsed = (since) => since && now - new Date(since).getTime();
    // MATCHING_CAPABILITY 48h 无人认领 → 取消 + 解冻
    if (item.status === 'MATCHING_CAPABILITY' && elapsed(item.publishedAt) > TIMEOUT_HOURS.MATCHING_NO_CLAIM * 3600 * 1000) {
      const amount = item.frozenAmount || 0;
      if (amount > 0) { try { unfreezeCredits(item.id, amount, '超时无人认领,自动取消解冻'); } catch (e) { console.error('[timeout] unfreeze failed:', e.message); } item.frozenAmount = 0; }
      item.status = 'CANCELLED';
      audit(item, 'AUTO_CANCELLED_NO_CLAIM', { actor: 'system', reason: `超过 ${TIMEOUT_HOURS.MATCHING_NO_CLAIM}h 无人认领,自动取消` });
      stats.cancelledNoClaim++; changed = true;
      continue;
    }
    // IN_PROGRESS 72h 无交付 → 过期 + 解冻 + 扣分
    if (item.status === 'IN_PROGRESS' && elapsed(item.assignment?.claimedAt) > TIMEOUT_HOURS.IN_PROGRESS_NO_DELIVERY * 3600 * 1000) {
      const amount = item.frozenAmount || 0;
      if (amount > 0) { try { unfreezeCredits(item.id, amount, '执行者超时未交付,自动过期解冻'); } catch (e) { console.error('[timeout] unfreeze failed:', e.message); } item.frozenAmount = 0; }
      const handlerId = item.assignment?.handlerId;
      if (handlerId) adjustReliability(handlerId, -5);
      item.status = 'EXPIRED';
      audit(item, 'AUTO_EXPIRED_NO_DELIVERY', { actor: 'system', reason: `超过 ${TIMEOUT_HOURS.IN_PROGRESS_NO_DELIVERY}h 未交付,自动过期`, handlerId });
      stats.expiredNoDelivery++; changed = true;
      continue;
    }
    // AWAITING_USER_APPROVAL 24h 无人确认 → 取消(此时未冻结,无需解冻)
    if (item.status === 'AWAITING_USER_APPROVAL' && elapsed(item.approval?.requestedAt || item.updatedAt) > TIMEOUT_HOURS.AWAITING_APPROVAL * 3600 * 1000) {
      item.status = 'CANCELLED';
      audit(item, 'AUTO_CANCELLED_NO_APPROVAL', { actor: 'system', reason: `超过 ${TIMEOUT_HOURS.AWAITING_APPROVAL}h 无人确认,自动取消` });
      stats.cancelledNoApproval++; changed = true;
      continue;
    }
    // REWORK 72h 未重新交付 → 过期 + 解冻 + 扣分
    if (item.status === 'REWORK' && elapsed(item.verification?.verifiedAt) > TIMEOUT_HOURS.REWORK_NO_REDELIVERY * 3600 * 1000) {
      const amount = item.frozenAmount || 0;
      if (amount > 0) { try { unfreezeCredits(item.id, amount, '打回后超时未重交,自动过期解冻'); } catch (e) { console.error('[timeout] unfreeze failed:', e.message); } item.frozenAmount = 0; }
      const handlerId = item.assignment?.handlerId;
      if (handlerId) adjustReliability(handlerId, -5);
      item.status = 'EXPIRED';
      audit(item, 'AUTO_EXPIRED_REWORK_TIMEOUT', { actor: 'system', reason: `打回后超过 ${TIMEOUT_HOURS.REWORK_NO_REDELIVERY}h 未重新交付,自动过期`, handlerId });
      stats.expiredRework++; changed = true;
    }
  }
  if (changed) persist();
  return stats;
}
function hasInternalAccess(request) {
  if (request.headers['x-hhba-internal-key'] === internalApiKey) return true;
  // v1.1: 有效的(未删除、active 的)API Key 同样拥有 internal 访问权;scope 约束由 requireInternal 做
  const presented = request.headers['x-hhba-api-key'];
  if (presented) {
    const rec = findApiKeyByHash(sha256Hex(presented));
    return Boolean(rec && rec.status === 'active');
  }
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
loadDisputes();
loadApiKeys(); // v1.1
loadAssessments(); // v1.2
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
      // v1.1: 用 API Key 发起的草案,在 audit 里记下是哪台 AI 干的(匿名调用保持原样)
      const draftIdentity = getApiKeyIdentity(request);
      if (draftIdentity && draftIdentity.kind === 'api-key' && !draftIdentity.invalid) {
        const created = (item.audit || []).find((e) => e.event === 'DRAFT_CREATED');
        if (created) Object.assign(created, auditActor(draftIdentity));
        else audit(item, 'DRAFT_CREATED', { ...auditActor(draftIdentity) });
      }
      // v1.3: 如果是登录用户创建的草案,记录老板邮箱用于任务通知
      const draftSession = getUserSession(request);
      if (draftSession) {
        const bossEmail = getUserEmail(draftSession.userId);
        if (bossEmail) item.bossEmail = bossEmail;
      }
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

  // v0.9:创建/更新任务模板(需 internal key;v1.1: API Key 需 admin scope)
  if (request.method === 'POST' && request.url === '/api/task-templates') {
    const tplIdentity = requireInternal(request, response, 'admin');
    if (!tplIdentity) return;
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

  // v0.9:禁用任务模板(需 internal key,软删除:保留数据,列表不再展示;v1.1: API Key 需 admin scope)
  const templateDisableMatch = request.url.match(/^\/api\/task-templates\/([^/]+)$/);
  if (templateDisableMatch && request.method === 'DELETE') {
    const tplDelIdentity = requireInternal(request, response, 'admin');
    if (!tplDelIdentity) return;
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
        // v1.2:调用方可指定 requiredSkills;不指定时用模板对应的技能标签
        requiredSkills: body.requiredSkills ?? body.required_skills ?? null,
      };
      const item = normalize(merged);
      item.templateId = tpl.id;
      item.templateName = tpl.name;
      if (!item.requiredSkills.length) {
        const tplSkillTag = Object.keys(SKILL_TAGS).find((tag) => SKILL_TAGS[tag].templateId === tpl.id);
        if (tplSkillTag) item.requiredSkills = [tplSkillTag];
      }
      // 预算超出模板建议范围:给出 warning,不阻止
      let budgetWarning = null;
      const amount = budgetAmountOf(item);
      const { min, max } = tpl.suggestedBudget || {};
      if (amount != null && min != null && max != null && (amount < min || amount > max)) {
        budgetWarning = `预算 ${amount} 超出模板建议范围 ${min}-${max}`;
      }
      audit(item, 'CREATED_FROM_TEMPLATE', { actor: session ? session.userId : 'internal', templateId: tpl.id, templateName: tpl.name, ...auditActor(getApiKeyIdentity(request)) });
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
      const { user, isNewUser } = getOrCreateUser(contact);
      const sessionId = `hhba_user_${randomUUID()}`;
      const expiresAt = new Date(now + userSessionLifetimeMs).toISOString();
      userSessions.set(sessionId, { userId: user.id, contactKey: key, displayName: user.displayName, expiresAt });
      return jsonWithHeaders(response, 200, { user: publicUser(user), isNewUser }, {
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

  // 新用户引导完成(需用户登录):设置昵称/角色/自报技能
  if (request.method === 'POST' && request.url === '/api/users/me/onboard') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录' });
    const user = getUser(session.userId);
    if (!user) return json(response, 401, { error: '用户不存在,请重新登录' });
    try {
      const body = await readBody(request);
      const displayName = String(body.displayName ?? '').trim();
      if (!displayName) return json(response, 400, { error: '昵称不能为空' });
      if (displayName.length > 24) return json(response, 400, { error: '昵称最多 24 个字符' });
      const role = String(body.role ?? '').trim();
      if (!['executor', 'boss', 'both'].includes(role)) return json(response, 400, { error: "role 必须是 executor / boss / both 之一" });
      user.displayName = displayName;
      user.roles = role === 'both' ? ['executor', 'boss'] : [role];
      user.onboarded = true;
      user.updatedAt = new Date().toISOString();
      // 执行者申报技能:走自报技能逻辑(source='self',verified=false)
      const skills = Array.isArray(body.skills) ? body.skills : [];
      const addedSkills = [];
      if (role !== 'boss' && skills.length) {
        for (const tag of skills) {
          const t = String(tag ?? '').trim();
          if (!SKILL_TAGS[t]) continue;
          const executor = getExecutor(user.id);
          const existing = executor.skills?.find((s) => s.tag === t);
          if (existing?.verified) continue; // 已认证的不覆盖
          addedSkills.push(upsertExecutorSkill(user.id, t, { level: 3, verified: false, source: 'self' }));
        }
      }
      persistUsers();
      persistExecutors();
      // 同步 session 中的展示名
      session.displayName = displayName;
      return json(response, 200, { user: publicUser(user), addedSkills });
    } catch (error) { return json(response, 400, { error: error.message }); }
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
    notifyTaskEvent(item, 'CLAIMED', { handlerId: session.userId, handlerName: executor.displayName }); // v1.3: 通知老板
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
    if (activeDisputeForTask(item.id)) return json(response, 409, { error: '该任务有进行中的纠纷,纠纷结束前不可重新交付' }); // v1.0
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
      notifyTaskEvent(item, 'DELIVERED', {}); // v1.3: 通知老板验收
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
  // v1.1: API Key 需 verify scope
  const verifyMatch = request.url.match(/^\/internal\/tasks\/([^/]+)\/verify$/);
  if (verifyMatch) {
    const verifyIdentity = requireInternal(request, response, 'verify');
    if (!verifyIdentity) return;
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
        audit(item, 'VERIFY_PASSED', { actor: 'foreman', reasons, ...auditActor(verifyIdentity) });
        let settled = 0;
        if (handlerId && amount > 0) {
          settled = settleCredits(item.id, amount, handlerId);          item.frozenAmount = 0;
        }
        let executorScore = null;
        if (handlerId) {
          const executor = getExecutor(handlerId);
          executor.completedTasks += 1;
          executorScore = adjustReliability(handlerId, 2);
          syncCompositeScore(handlerId); // v0.8:有反馈时用复合信誉分覆盖增量分
          executorScore = getExecutor(handlerId).reliabilityScore;
          // v1.2:实战积累 — 完成含 requiredSkills 的真实任务且验收通过,source 升级为 task(已认证的不降级)
          for (const tag of item.requiredSkills || []) {
            try {
              const skill = getExecutorSkill(executor, tag);
              if (!skill.verified && skill.source === 'self') {
                skill.source = 'task';
                skill.updatedAt = new Date().toISOString();
              }
            } catch { /* 未知标签跳过 */ }
          }
          persistExecutors();
        }
        persist();
        notifyTaskEvent(item, 'VERIFIED', { settledAmount: settled }); // v1.3: 通知执行者
        return json(response, 200, { requestId: item.id, status: item.status, settledAmount: settled, executorScore });
      }
      item.status = 'REWORK';
      item.verification = { passed: false, reasons, verifiedAt: now, verifiedBy: 'foreman' };
      audit(item, 'VERIFY_REJECTED', { actor: 'foreman', reasons, ...auditActor(verifyIdentity) });
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
      notifyTaskEvent(item, 'REWORK', { reasons }); // v1.3: 通知执行者重做
      return json(response, 200, { requestId: item.id, status: item.status, refundedAmount: refunded, executorScore });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // v0.8:任务反馈(需 internal key,即工头/老板调用):公开评价 + 私有反馈一次提交
  // 私有反馈不对执行者公开,仅用于复合信誉分计算
  // v1.1: API Key 需 feedback scope
  const feedbackMatch = request.url.match(/^\/api\/tasks\/([^/]+)\/feedback$/);
  if (feedbackMatch && request.method === 'POST') {
    const feedbackIdentity = requireInternal(request, response, 'feedback');
    if (!feedbackIdentity) return;
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
      audit(item, 'FEEDBACK_SUBMITTED', { actor: bossId, hasPublic: publicScore != null, hasPrivate: privateScore != null, ...auditActor(feedbackIdentity) });
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

  // 包工头模式:策略管理(需 internal key 或 ops session;v1.1: API Key 需 admin scope)
  const policyMatch = request.url.match(/^\/internal\/policies(?:\/([^/]+))?$/);
  if (policyMatch) {
    const policyIdentity = requireInternal(request, response, 'admin');
    if (!policyIdentity) return;
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
    const [, id, action] = internalMatch;
    if (request.method === 'GET' && !id) {
      if (!hasInternalAccess(request)) return json(response, 403, { error: 'HHBA internal access is required' });
      return json(response, 200, { requests: [...requests.values()].filter((item) => ['MATCHING_CAPABILITY', 'IN_PROGRESS', 'DELIVERED', 'REWORK', 'VERIFIED'].includes(item.status)).map(internalRequestView) });
    }
    // v1.1: claim / deliver 按 scope 鉴权(action 名即 scope 名);无 action 时只做基础鉴权
    const opIdentity = requireInternal(request, response, action || undefined);
    if (!opIdentity) return;
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
        audit(item, 'CAPABILITY_CLAIMED', { actor: handlerId, ...auditActor(opIdentity) }); persist();
        notifyTaskEvent(item, 'CLAIMED', { handlerId, handlerName: item.assignment.handlerDisplayName }); // v1.3: 通知老板
        return json(response, 201, { requestId: id, status: item.status, assignment: item.assignment });
      }
      if (action === 'deliver') {
        if (item.status !== 'IN_PROGRESS' && item.status !== 'REWORK') return json(response, 409, { error: `cannot deliver from ${item.status}` });
        if (activeDisputeForTask(item.id)) return json(response, 409, { error: '该任务有进行中的纠纷,纠纷结束前不可重新交付' }); // v1.0
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
          audit(item, 'REDELIVERED_AFTER_REWORK', { actor: item.assignment?.handlerId || 'hhba-internal', ...auditActor(opIdentity) });
        }
        item.status = 'DELIVERED';
        item.deliveredAt = new Date().toISOString();
        item.deliverableBundle = { submittedAt: new Date().toISOString(), summary: String(body.summary || '').trim(), artifacts, evidence, structuredAnswers: body.structured_answers || {}, acceptanceNotes: String(body.acceptance_notes || '').trim() };
        audit(item, 'DELIVERABLE_SUBMITTED', { actor: item.assignment?.handlerId || 'hhba-internal', ...auditActor(opIdentity) }); persist();
        notifyTaskEvent(item, 'DELIVERED', {}); // v1.3: 通知老板验收
        return json(response, 201, { requestId: id, status: item.status });
      }
      return json(response, 404, { error: 'internal operation not found' });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // ---- v1.1: AI 工头 API Key 管理(需 admin scope;legacy key / ops session 向后兼容) ----
  // v1.3: 手动触发维护任务(超时检查等),需 admin scope
  if (request.method === 'POST' && request.url === '/internal/maintenance/run') {
    const identity = requireInternal(request, response, 'admin');
    if (!identity) return;
    const autoApproved = checkAutoApprove();
    const timeouts = checkTimeouts();
    const disputesEscalated = typeof checkDisputeEscalation === 'function' ? checkDisputeEscalation() : 0;
    console.log(`[maintenance] manual run by ${identity.kind || 'internal'}: autoApproved=${autoApproved}, timeouts=${JSON.stringify(timeouts)}, disputesEscalated=${disputesEscalated}`);
    return json(response, 200, { autoApproved, timeouts, disputesEscalated, at: new Date().toISOString() });
  }
  // 签发新 key:明文 key 只在本次响应返回,服务端只存 SHA256 哈希
  if (request.method === 'POST' && request.url === '/internal/api-keys') {
    const identity = requireInternal(request, response, 'admin');
    if (!identity) return;
    try {
      const body = await readBody(request);
      const name = String(body.name || '').trim();
      if (!name) return json(response, 400, { error: 'name is required' });
      if ([...apiKeys.values()].some((k) => !k.deleted && k.name === name)) {
        return json(response, 409, { error: '同名 key 已存在' });
      }
      const tool = String(body.tool || 'other').trim();
      if (!['codex-cloud', 'cursor', 'openclaw', 'other'].includes(tool)) {
        return json(response, 400, { error: 'tool 必须是 codex-cloud / cursor / openclaw / other 之一' });
      }
      const scopes = Array.isArray(body.scopes)
        ? [...new Set(body.scopes.map((s) => String(s).trim()).filter((s) => API_KEY_SCOPES.includes(s)))]
        : [...DEFAULT_API_KEY_SCOPES];
      if (!scopes.length) return json(response, 400, { error: 'scopes 不能为空' });
      const rlBody = body.rateLimit || {};
      const rateLimit = {
        perMinute: Number(rlBody.perMinute) > 0 ? Math.floor(Number(rlBody.perMinute)) : 60,
        perDay: Number(rlBody.perDay) > 0 ? Math.floor(Number(rlBody.perDay)) : 1000,
      };
      const plaintext = 'hhba_sk_' + randomBytes(16).toString('hex');
      const now = new Date().toISOString();
      const rec = {
        id: 'hk_' + randomBytes(6).toString('hex'),
        name, tool, scopes, rateLimit,
        keyHash: sha256Hex(plaintext),
        keyPrefix: plaintext.slice(0, 16), // 识别用前缀,不含完整密钥,不可反推明文
        status: 'active',
        note: String(body.note || '').trim() || null,
        createdAt: now, updatedAt: now, lastUsedAt: null, revokedAt: null,
        createdBy: identity.keyName || identity.kind,
        keyAudit: [],
      };
      keyAudit(rec, 'ISSUED', { actor: identity.keyName || identity.kind, scopes, tool, rateLimit });
      apiKeys.set(rec.id, rec);
      persistApiKeys();
      return json(response, 201, {
        id: rec.id, name, key: plaintext, keyPrefix: rec.keyPrefix,
        tool, scopes, rateLimit, status: 'active', createdAt: now, note: rec.note,
        warning: 'key 明文仅返回一次,请妥善保存,服务端不存储明文',
      });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // 列出所有 key(脱敏:无明文、无哈希,只有识别前缀)
  if (request.method === 'GET' && request.url === '/internal/api-keys') {
    const identity = requireInternal(request, response, 'admin');
    if (!identity) return;
    const list = [...apiKeys.values()].filter((k) => !k.deleted).map(publicKeyView);
    return json(response, 200, { keys: list, total: list.length });
  }

  // key 详情:含用量统计与最近调用记录(审计)
  const apiKeyDetailMatch = request.url.match(/^\/internal\/api-keys\/([^/]+)$/);
  if (apiKeyDetailMatch && request.method === 'GET') {
    const identity = requireInternal(request, response, 'admin');
    if (!identity) return;
    const rec = apiKeys.get(decodeURIComponent(apiKeyDetailMatch[1]).trim());
    if (!rec || rec.deleted) return json(response, 404, { error: 'api key not found' });
    const u = apiKeyUsage.get(rec.id);
    const recentCalls = apiKeyCallLog.filter((c) => c.keyId === rec.id).slice(-50);
    return json(response, 200, {
      key: publicKeyView(rec),
      usage: u ? { minuteCount: u.minuteCount, dayCount: u.dayCount } : { minuteCount: 0, dayCount: 0 },
      recentCalls,
    });
  }

  // 吊销 / 暂停 / 恢复
  const apiKeyActionMatch = request.url.match(/^\/internal\/api-keys\/([^/]+)\/(revoke|suspend|activate)$/);
  if (apiKeyActionMatch && request.method === 'POST') {
    const identity = requireInternal(request, response, 'admin');
    if (!identity) return;
    const rec = apiKeys.get(decodeURIComponent(apiKeyActionMatch[1]).trim());
    if (!rec || rec.deleted) return json(response, 404, { error: 'api key not found' });
    const action = apiKeyActionMatch[2];
    const now = new Date().toISOString();
    const actor = identity.keyName || identity.kind;
    if (action === 'revoke') {
      if (rec.status === 'revoked') return json(response, 409, { error: 'key already revoked' });
      rec.status = 'revoked';
      rec.revokedAt = now;
      keyAudit(rec, 'REVOKED', { actor });
    } else if (action === 'suspend') {
      if (rec.status !== 'active') return json(response, 409, { error: `cannot suspend from ${rec.status}` });
      rec.status = 'suspended';
      keyAudit(rec, 'SUSPENDED', { actor });
    } else {
      if (rec.status !== 'suspended') return json(response, 409, { error: `cannot activate from ${rec.status}` });
      rec.status = 'active';
      keyAudit(rec, 'ACTIVATED', { actor });
    }
    rec.updatedAt = now;
    persistApiKeys();
    return json(response, 200, { key: publicKeyView(rec) });
  }

  // 删除 key(软删除:保留记录供审计,密钥立即失效)
  if (apiKeyDetailMatch && request.method === 'DELETE') {
    const identity = requireInternal(request, response, 'admin');
    if (!identity) return;
    const rec = apiKeys.get(decodeURIComponent(apiKeyDetailMatch[1]).trim());
    if (!rec || rec.deleted) return json(response, 404, { error: 'api key not found' });
    rec.deleted = true;
    rec.status = 'revoked';
    rec.revokedAt = new Date().toISOString();
    rec.updatedAt = rec.revokedAt;
    keyAudit(rec, 'DELETED', { actor: identity.keyName || identity.kind });
    persistApiKeys();
    return json(response, 200, { deleted: rec.id });
  }

  // ---- v1.2 真实能力测评 ----
  // 技能标签列表(公开)
  if (request.method === 'GET' && request.url === '/api/skill-tags') {
    return json(response, 200, { tags: Object.values(SKILL_TAGS), total: Object.keys(SKILL_TAGS).length });
  }
  // 老板积分余额查询(需用户登录):发单页显示余额用
  if (request.method === 'GET' && request.url === '/api/boss/balance') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录' });
    return json(response, 200, { balance: balanceOf('boss'), escrow: balanceOf('escrow') });
  }
  // 创建测评任务(需 admin 或 assessment scope;legacy/ops 向后兼容)
  if (request.method === 'POST' && request.url === '/internal/assessments') {
    const identity = requireInternal(request, response);
    if (!identity) return;
    if (identity.kind === 'api-key') {
      const scopes = identity.scopes || [];
      if (!scopes.includes('admin') && !scopes.includes('assessment')) {
        return json(response, 403, { error: 'missing required scope: admin or assessment' });
      }
    }
    try {
      const body = await readBody(request);
      const { assessment, task } = createAssessment({
        skillTag: String(body.skillTag ?? body.skill_tag ?? '').trim(),
        title: body.title,
        description: body.description,
        checklist: body.checklist,
        budget: body.budget,
      }, identity);
      return json(response, 201, { assessment, taskId: task.id, taskStatus: task.status });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  // 测评任务列表(需 internal;api-key 需 admin 或 assessment scope)
  if (request.method === 'GET' && request.url === '/internal/assessments') {
    const identity = requireInternal(request, response);
    if (!identity) return;
    if (identity.kind === 'api-key') {
      const scopes = identity.scopes || [];
      if (!scopes.includes('admin') && !scopes.includes('assessment')) {
        return json(response, 403, { error: 'missing required scope: admin or assessment' });
      }
    }
    const list = [...assessments.values()].map((a) => ({ ...a }));
    return json(response, 200, { assessments: list, total: list.length });
  }
  // 测评打分(需 admin 或 assessment scope;legacy/ops 向后兼容)
  const gradeMatch = request.url.match(/^\/internal\/assessments\/([^/]+)\/grade$/);
  if (gradeMatch && request.method === 'POST') {
    const identity = requireInternal(request, response);
    if (!identity) return;
    if (identity.kind === 'api-key') {
      const scopes = identity.scopes || [];
      if (!scopes.includes('admin') && !scopes.includes('assessment')) {
        return json(response, 403, { error: 'missing required scope: admin or assessment' });
      }
    }
    try {
      const body = await readBody(request);
      const result = gradeAssessment(gradeMatch[1], {
        score: body.score,
        passed: body.passed,
        feedback: body.feedback,
      }, identity);
      if (result.error) return json(response, result.error, { error: result.message || 'grade failed' });
      return json(response, 200, {
        assessment: result.assessment,
        executorId: result.executorId,
        skill: result.skill,
        certified: Boolean(result.skill),
      });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  // 任务候选人推荐:按技能匹配度排序(需 internal)
  const candidatesMatch = request.url.match(/^\/internal\/tasks\/([^/]+)\/candidates$/);
  if (candidatesMatch && request.method === 'GET') {
    const identity = requireInternal(request, response);
    if (!identity) return;
    const item = find(candidatesMatch[1], response);
    if (!item) return;
    const required = item.requiredSkills || [];
    const candidates = [...executors.values()].map((ex) => {
      ensureExecutorSkills(ex);
      const matchedSkills = required.filter((tag) => ex.skills.some((s) => s.tag === tag));
      const verifiedCount = matchedSkills.filter((tag) => ex.skills.find((s) => s.tag === tag)?.verified).length;
      const matchScore = required.length
        ? Math.round((matchedSkills.length / required.length) * 100)
        : 100;
      return {
        executorId: ex.id,
        displayName: ex.displayName || null,
        reliabilityScore: ex.reliabilityScore ?? 100,
        completedTasks: ex.completedTasks ?? 0,
        matchedSkills,
        verifiedCount,
        matchScore,
        skills: ex.skills.map((s) => ({ tag: s.tag, level: s.level, verified: s.verified, source: s.source })),
      };
    });
    // 排序:verified 认证数 > 匹配度 > 可靠分 > 完成数
    candidates.sort((a, b) =>
      (b.verifiedCount - a.verifiedCount) ||
      (b.matchScore - a.matchScore) ||
      ((b.reliabilityScore ?? 100) - (a.reliabilityScore ?? 100)) ||
      ((b.completedTasks ?? 0) - (a.completedTasks ?? 0)));
    return json(response, 200, { taskId: item.id, requiredSkills: required, candidates, total: candidates.length });
  }
  // 查看某执行者的技能画像(公开)
  const execSkillsMatch = request.url.match(/^\/api\/executors\/([^/]+)\/skills$/);
  if (execSkillsMatch && request.method === 'GET') {
    const profile = publicExecutorSkills(decodeURIComponent(execSkillsMatch[1]).trim());
    if (!profile) return json(response, 404, { error: 'executor not found' });
    return json(response, 200, profile);
  }
  // 执行者自报技能(需用户登录)
  if (request.method === 'POST' && request.url === '/api/executors/me/skills') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录' });
    try {
      const body = await readBody(request);
      const tag = String(body.tag ?? '').trim();
      if (!SKILL_TAGS[tag]) return json(response, 400, { error: `未知的技能标签: ${tag || '(空)'},可选: ${Object.keys(SKILL_TAGS).join(', ')}` });
      const level = Number(body.level);
      if (!Number.isInteger(level) || level < 1 || level > 5) return json(response, 400, { error: 'level 必须是 1-5 的整数' });
      const executor = getExecutor(session.userId);
      const existing = executor.skills?.find((s) => s.tag === tag);
      // 已有认证的不允许自报覆盖
      if (existing?.verified) return json(response, 409, { error: '该技能已通过认证,无需自报' });
      const skill = upsertExecutorSkill(session.userId, tag, { level, verified: false, source: 'self' });
      return json(response, 200, { skill, note: '自报技能需通过测评或实战积累才能获得认证' });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // ---- v1.0 纠纷模块:三级纠纷处理(双方协商 -> 平台仲裁 -> 终审) ----
  // 发起纠纷(需用户登录):仅执行者可对 REWORK 状态的任务发起
  if (request.method === 'POST' && request.url === '/api/disputes') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录' });
    try {
      const body = await readBody(request);
      const taskId = String(body.taskId ?? body.task_id ?? '').trim();
      const item = requests.get(taskId);
      if (!item) return json(response, 404, { error: 'human capability request not found' });
      if (item.status !== 'REWORK') return json(response, 409, { error: `只能对被打回(REWORK)的任务发起纠纷(当前状态:${item.status})` });
      if (item.assignment?.handlerId !== session.userId) return json(response, 403, { error: '只能对自己执行的任务发起纠纷' });
      if (activeDisputeForTask(item.id)) return json(response, 409, { error: '该任务已有进行中的纠纷' });
      const reason = String(body.reason || '').trim();
      if (!DISPUTE_REASONS[reason]) return json(response, 400, { error: `reason 必须是以下之一: ${Object.keys(DISPUTE_REASONS).join(', ')}` });
      const description = String(body.description || '').trim();
      if (!description) return json(response, 400, { error: 'description is required' });
      const now = new Date().toISOString();
      const dispute = {
        id: `dsp_${randomUUID().slice(0, 8)}`,
        taskId: item.id,
        executorId: session.userId,
        bossId: 'boss',
        reason, description,
        evidence: list(body.evidence).map((e) => String(e).trim()).filter(Boolean),
        status: 'OPEN', level: 1,
        messages: [],
        confirmations: { executor: false, boss: false },
        escalatedBy: null, prevOutcome: null, history: [],
        level1Deadline: new Date(Date.now() + DISPUTE_L1_MS).toISOString(),
        resolution: null,
        createdAt: now, updatedAt: now,
      };
      disputes.set(dispute.id, dispute);
      persistDisputes();
      audit(item, 'DISPUTE_FILED', { actor: session.userId, disputeId: dispute.id, reason });
      persist();
      notifyTaskEvent(item, 'DISPUTE_OPENED', { raisedBy: session.userId, reason }); // v1.3: 通知双方
      return json(response, 201, { dispute });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // 我的纠纷列表(需用户登录)
  if (request.method === 'GET' && request.url === '/api/disputes/mine') {
    const session = getUserSession(request);
    if (!session) return json(response, 401, { error: '请先登录' });
    checkDisputeEscalation();
    const mine = [...disputes.values()].filter((d) => d.executorId === session.userId);
    return json(response, 200, { disputes: mine, total: mine.length });
  }

  // 纠纷详情(需用户登录或 internal key):含留言与关联任务摘要
  const disputeDetailMatch = request.url.match(/^\/api\/disputes\/([^/]+)$/);
  if (disputeDetailMatch && request.method === 'GET') {
    checkDisputeEscalation();
    const d = disputes.get(decodeURIComponent(disputeDetailMatch[1]).trim());
    if (!d) return json(response, 404, { error: 'dispute not found' });
    const session = getUserSession(request);
    if (!hasInternalAccess(request) && (!session || session.userId !== d.executorId)) {
      return json(response, 403, { error: '无权查看该纠纷' });
    }
    const item = requests.get(d.taskId);
    return json(response, 200, { dispute: d, task: item ? serialize(item) : null });
  }

  // 纠纷留言(需用户登录或 internal key):Level 1 协商期双方可留言;internal key 代表老板/平台方
  const disputeMsgMatch = request.url.match(/^\/api\/disputes\/([^/]+)\/messages$/);
  if (disputeMsgMatch && request.method === 'POST') {
    checkDisputeEscalation();
    const d = disputes.get(decodeURIComponent(disputeMsgMatch[1]).trim());
    if (!d) return json(response, 404, { error: 'dispute not found' });
    const session = getUserSession(request);
    const internal = hasInternalAccess(request);
    if (!internal && (!session || session.userId !== d.executorId)) {
      return json(response, 403, { error: '无权参与该纠纷' });
    }
    if (d.status !== 'OPEN') return json(response, 409, { error: `当前纠纷状态不可留言:${d.status}` });
    try {
      const body = await readBody(request);
      const text = String(body.text || '').trim();
      if (!text) return json(response, 400, { error: 'text is required' });
      if (text.length > 2000) return json(response, 400, { error: '留言过长(最多 2000 字)' });
      const msg = {
        id: `msg_${randomUUID().slice(0, 8)}`,
        authorId: internal ? 'boss' : session.userId,
        authorRole: internal ? 'boss' : 'executor',
        text,
        createdAt: new Date().toISOString(),
      };
      d.messages.push(msg);
      d.updatedAt = msg.createdAt;
      persistDisputes();
      return json(response, 201, { message: msg });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }

  // 协商解决(需用户登录或 internal key):Level 1 双方都确认后关闭纠纷
  const disputeResolveMatch = request.url.match(/^\/api\/disputes\/([^/]+)\/resolve$/);
  if (disputeResolveMatch && request.method === 'POST') {
    checkDisputeEscalation();
    const d = disputes.get(decodeURIComponent(disputeResolveMatch[1]).trim());
    if (!d) return json(response, 404, { error: 'dispute not found' });
    const session = getUserSession(request);
    const internal = hasInternalAccess(request);
    if (!internal && (!session || session.userId !== d.executorId)) {
      return json(response, 403, { error: '无权操作该纠纷' });
    }
    if (d.level !== 1 || d.status !== 'OPEN') return json(response, 409, { error: `当前纠纷不可协商解决:${d.level}/${d.status}` });
    const side = internal ? 'boss' : 'executor';
    d.confirmations[side] = true;
    const now = new Date().toISOString();
    if (d.confirmations.executor && d.confirmations.boss) {
      d.status = 'RESOLVED';
      d.resolution = { outcome: 'MUTUAL', note: '双方协商一致', decidedBy: 'mutual', decidedAt: now };
      d.updatedAt = now;
      persistDisputes();
      const item = requests.get(d.taskId);
      if (item) { audit(item, 'DISPUTE_RESOLVED_MUTUAL', { actor: 'mutual', disputeId: d.id }); persist(); notifyTaskEvent(item, 'DISPUTE_RESOLVED', { resolution: '双方协商一致', executorId: d.executorId }); }
      return json(response, 200, { dispute: d, resolved: true });
    }
    d.updatedAt = now;
    persistDisputes();
    return json(response, 200, { dispute: d, resolved: false, waitingFor: side === 'executor' ? 'boss' : 'executor' });
  }

  // 升级/申请终审(需用户登录或 internal key):Level 1 -> Level 2;对 Level 2 仲裁不满 -> Level 3
  const disputeEscalateMatch = request.url.match(/^\/api\/disputes\/([^/]+)\/escalate$/);
  if (disputeEscalateMatch && request.method === 'POST') {
    checkDisputeEscalation();
    const d = disputes.get(decodeURIComponent(disputeEscalateMatch[1]).trim());
    if (!d) return json(response, 404, { error: 'dispute not found' });
    const session = getUserSession(request);
    const internal = hasInternalAccess(request);
    if (!internal && (!session || session.userId !== d.executorId)) {
      return json(response, 403, { error: '无权操作该纠纷' });
    }
    const now = new Date().toISOString();
    const by = internal ? 'boss' : 'executor';
    if (d.level === 1 && d.status === 'OPEN') {
      d.level = 2;
      d.status = 'IN_REVIEW';
      d.updatedAt = disputeSystemMessage(d, `一方(${by === 'boss' ? '老板' : '执行者'})申请升级,纠纷进入 Level 2 平台仲裁`);
      persistDisputes();
      return json(response, 200, { dispute: d });
    }
    if (d.level === 2 && d.status === 'RESOLVED' && d.resolution) {
      d.history.push({ level: 2, resolution: d.resolution, escalatedAt: now, escalatedBy: by });
      d.prevOutcome = d.resolution.outcome; // 'BOSS' 或 'EXECUTOR'
      d.resolution = null;
      d.level = 3;
      d.status = 'ESCALATED';
      d.escalatedBy = by;
      d.updatedAt = disputeSystemMessage(d, `一方(${by === 'boss' ? '老板' : '执行者'})对仲裁不满,已申请 Level 3 终审`);
      persistDisputes();
      return json(response, 200, { dispute: d });
    }
    return json(response, 409, { error: `当前纠纷不可升级:${d.level}/${d.status}` });
  }

  // 所有纠纷列表(需 internal key)
  if (request.method === 'GET' && request.url === '/internal/disputes') {
    const dspListIdentity = requireInternal(request, response, 'dispute');
    if (!dspListIdentity) return;
    checkDisputeEscalation();
    return json(response, 200, { disputes: [...disputes.values()], total: disputes.size });
  }

  // 平台仲裁(需 internal key):Level 2 仲裁 / Level 3 终审(可改判)
  // v1.1: API Key 需 dispute scope
  const disputeArbitrateMatch = request.url.match(/^\/internal\/disputes\/([^/]+)\/arbitrate$/);
  if (disputeArbitrateMatch && request.method === 'POST') {
    const arbIdentity = requireInternal(request, response, 'dispute');
    if (!arbIdentity) return;
    checkDisputeEscalation();
    const d = disputes.get(decodeURIComponent(disputeArbitrateMatch[1]).trim());
    if (!d) return json(response, 404, { error: 'dispute not found' });
    try {
      const body = await readBody(request);
      const decision = String(body.decision || '').trim();
      if (!['BOSS', 'EXECUTOR'].includes(decision)) return json(response, 400, { error: "decision 必须是 'BOSS' 或 'EXECUTOR'" });
      const note = String(body.note || '').trim();
      const now = new Date().toISOString();
      const item = requests.get(d.taskId);
      if (d.level === 2 && d.status === 'IN_REVIEW') {
        // ---- Level 2 平台仲裁 ----
        if (decision === 'EXECUTOR') {
          if (!item) return json(response, 409, { error: '关联任务不存在,无法仲裁' });
          if (item.status !== 'REWORK') return json(response, 409, { error: `任务状态已变化,无法仲裁:${item.status}` });
          try {
            applyArbitrationExecutorWin(item, d, auditActor(arbIdentity));
          } catch (error) {
            return json(response, 409, { error: `仲裁结算失败:${error.message}` });
          }
          d.resolution = { outcome: 'EXECUTOR', note: note || '仲裁支持执行者,打回不成立,已结算', decidedBy: 'platform', decidedAt: now };
        } else {
          // 维持打回:执行者可重新交付;无理纠纷扣执行者 5 分
          adjustReliability(d.executorId, -5);
          if (item) { audit(item, 'DISPUTE_ARBITRATED', { actor: 'platform', disputeId: d.id, decision: 'BOSS', ...auditActor(arbIdentity) }); persist(); }
          d.resolution = { outcome: 'BOSS', note: note || '仲裁支持老板,维持打回', decidedBy: 'platform', decidedAt: now };
        }
        d.status = 'RESOLVED';
        d.updatedAt = now;
        persistDisputes();
        { const item2 = requests.get(d.taskId); if (item2) notifyTaskEvent(item2, 'DISPUTE_RESOLVED', { resolution: d.resolution?.outcome, note: d.resolution?.note, executorId: d.executorId }); }
        return json(response, 200, { dispute: d });
      }
      if (d.level === 3 && d.status === 'ESCALATED') {
        // ---- Level 3 终审:可维持或改判上一轮结果,为最终结果 ----
        const prev = d.prevOutcome; // 'BOSS' | 'EXECUTOR'
        if (decision === 'EXECUTOR' && prev === 'BOSS') {
          if (!item) return json(response, 409, { error: '关联任务不存在,无法终审' });
          if (item.status !== 'REWORK') return json(response, 409, { error: `任务状态已变化,无法终审:${item.status}` });
          try {
            applyArbitrationExecutorWin(item, d, auditActor(arbIdentity));
          } catch (error) {
            return json(response, 409, { error: `终审结算失败:${error.message}` });
          }
        } else if (decision === 'BOSS' && prev === 'EXECUTOR') {
          if (!item) return json(response, 409, { error: '关联任务不存在,无法终审' });
          if (item.status !== 'VERIFIED') return json(response, 409, { error: `任务状态已变化,无法终审改判:${item.status}` });
          reverseArbitrationExecutorWin(item, d, auditActor(arbIdentity));
        }
        // 终审败诉的升级方:执行者升级又败诉则再扣 5 分(老板方无信誉分可扣)
        const loser = decision === 'EXECUTOR' ? 'boss' : 'executor';
        if (d.escalatedBy === loser && loser === 'executor') adjustReliability(d.executorId, -5);
        d.status = 'RESOLVED';
        d.resolution = { outcome: decision === 'EXECUTOR' ? 'FINAL_EXECUTOR' : 'FINAL_BOSS', note: note || '终审裁决(最终结果)', decidedBy: 'platform-final', decidedAt: now };
        d.updatedAt = now;
        persistDisputes();
        { const item3 = requests.get(d.taskId); if (item3) notifyTaskEvent(item3, 'DISPUTE_RESOLVED', { resolution: d.resolution.outcome, note: d.resolution.note, executorId: d.executorId }); }
        return json(response, 200, { dispute: d });
      }
      return json(response, 409, { error: `当前纠纷不可仲裁:${d.level}/${d.status}` });
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
        requestedAt: new Date().toISOString(), // v1.3: 人工确认请求时间,用于超时回收
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
// v1.0: 顺带检查 Level 1 协商超时的纠纷，自动升级到平台仲裁
// v1.3: 顺带检查全状态超时(无人认领/执行者消失/无人确认/打回未重交),自动回收
setInterval(() => {
  try {
    const n = checkAutoApprove();
    if (n > 0) console.log(`[auto-approve] ${n} 个超时任务已自动验收`);
    const t = checkTimeouts();
    const tTotal = t.cancelledNoClaim + t.expiredNoDelivery + t.cancelledNoApproval + t.expiredRework;
    if (tTotal > 0) console.log(`[timeout] 超时回收:`, JSON.stringify(t));
    const m = checkDisputeEscalation();
    if (m > 0) console.log(`[dispute] ${m} 个协商超时纠纷已升级到平台仲裁`);
  } catch (e) { console.error('[auto-approve] error:', e.message); }
}, 5 * 60 * 1000);
