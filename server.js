'use strict';

/*
  BLACK RIDGE CITY CIA SYSTEM
  server.js (UPDATED FOR S.O.S & MAP SYNC)
*/

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'cia-data.json');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const candidates = ['index.html', 'index26-7.html', 'index(29).html', 'index (31).html', 'index (34).html'];
  for (const file of candidates) {
    const full = path.join(__dirname, file);
    if (fs.existsSync(full)) return res.sendFile(full);
  }
  res.status(404).send('BLACK RIDGE CIA: index.html not found.');
});

const now = () => new Date().toISOString();
const clean = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const lower = (value) => clean(value, 200).toLowerCase();
const makeId = (prefix = 'ID') => `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;

const SYSTEM = Object.freeze({
  chiefRegistrationCode: '1531',
  chiefSaveCode: '4139',
  memberRequestCode: '0012',
  defaultSalary: 580
});

const EMPTY_STATE = {
  cia_users: [],
  cia_queue: [],
  cia_character_queue: [],
  cia_accounts: [],
  cia_chats: { global: [], private: {} },
  cia_sos: [],
  cia_reports: [],
  cia_cases: [],
  cia_map_locations: {},
  cia_hq_locations: [],
  cia_audit_logs: [],
  cia_attendance: [],
  cia_operations: [],
  settings: {
    publicSalary: SYSTEM.defaultSalary,
    rankSalaries: {
      AGENT: SYSTEM.defaultSalary,
      'HIGH COMMANDER': SYSTEM.defaultSalary,
      'SUPREME COMMANDER': SYSTEM.defaultSalary,
      'CIA CHIEF': SYSTEM.defaultSalary
    }
  },
  systemConfig: {
    chiefRegistrationCode: SYSTEM.chiefRegistrationCode,
    chiefSaveCode: SYSTEM.chiefSaveCode
  }
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function loadState() {
  if (!fs.existsSync(DATA_FILE)) return clone(EMPTY_STATE);
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const base = clone(EMPTY_STATE);
    const state = {
      ...base,
      ...parsed,
      settings: {
        ...base.settings,
        ...(parsed.settings || {}),
        rankSalaries: {
          ...(base.settings.rankSalaries || {}),
          ...((parsed.settings && parsed.settings.rankSalaries) || {})
        }
      },
      systemConfig: { ...base.systemConfig, ...(parsed.systemConfig || {}) },
      cia_chats: {
        global: Array.isArray(parsed.cia_chats?.global) ? parsed.cia_chats.global : [],
        private: parsed.cia_chats?.private && typeof parsed.cia_chats.private === 'object' ? parsed.cia_chats.private : {}
      }
    };
    for (const key of [
      'cia_users', 'cia_queue', 'cia_character_queue', 'cia_accounts',
      'cia_sos', 'cia_reports', 'cia_cases', 'cia_hq_locations',
      'cia_audit_logs', 'cia_attendance', 'cia_operations'
    ]) {
      if (!Array.isArray(state[key])) state[key] = [];
    }
    if (!state.cia_map_locations || typeof state.cia_map_locations !== 'object') state.cia_map_locations = {};
    normalizeAllUsers(state);
    return state;
  } catch (error) {
    console.error('[BLACK RIDGE] Failed to load cia-data.json:', error.message);
    return clone(EMPTY_STATE);
  }
}

function saveState() {
  try {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (error) {
    console.error('[BLACK RIDGE] Failed to save state:', error.message);
  }
}

let state;
state = loadState();
const sessions = new Map();
const socketToUser = new Map();
const radioChannels = new Map();

function normalizeRank(rank) {
  const value = clean(rank, 100).toUpperCase();
  if (value === 'CIA CHIEF') return 'CIA CHIEF';
  if (value === 'SUPREME COMMANDER' || value === 'SENIOR COMMANDER CIA') return 'SUPREME COMMANDER';
  if (value === 'HIGH COMMANDER') return 'HIGH COMMANDER';
  return 'AGENT';
}

function rankLabel(rank) {
  switch (normalizeRank(rank)) {
    case 'CIA CHIEF': return 'CIA CHIEF';
    case 'SUPREME COMMANDER': return 'Senior Commander CIA';
    case 'HIGH COMMANDER': return 'High Commander';
    default: return 'Agent';
  }
}

function rankLevel(rank) {
  switch (normalizeRank(rank)) {
    case 'CIA CHIEF': return 4;
    case 'SUPREME COMMANDER': return 3;
    case 'HIGH COMMANDER': return 2;
    default: return 1;
  }
}

function defaultSalaryForRank(rank) {
  const normalized = normalizeRank(rank);
  const configured = Number(
    state && state.settings && state.settings.rankSalaries
      ? state.settings.rankSalaries[normalized]
      : NaN
  );
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : SYSTEM.defaultSalary;
}

function canManageBank(actor, target) {
  if (!actor || !target) return false;
  if (isChief(actor)) return true;
  if (isSenior(actor)) return target.id !== actor.id && !isChief(target) && !isSenior(target);
  if (isHighCommander(actor)) return normalizeRank(target.rank) === 'AGENT';
  return false;
}

function canSetRankSalary(actor, rank) {
  if (!actor) return false;
  const desired = normalizeRank(rank);
  if (isChief(actor)) return true;
  if (isSenior(actor)) return desired === 'AGENT' || desired === 'HIGH COMMANDER';
  if (isHighCommander(actor)) return desired === 'AGENT';
  return false;
}

const isChief = (user) => !!user && normalizeRank(user.rank) === 'CIA CHIEF';
const isSenior = (user) => !!user && normalizeRank(user.rank) === 'SUPREME COMMANDER';
const isHighCommander = (user) => !!user && normalizeRank(user.rank) === 'HIGH COMMANDER';
const isLeadership = (user) => isChief(user) || isSenior(user);

function ensureBank(user) {
  if (!user.bank || typeof user.bank !== 'object') user.bank = {};
  if (!Number.isFinite(Number(user.bank.balance))) user.bank.balance = 0;
  user.bankAccount = clean(user.bankAccount || '', 60);
  if (!Number.isFinite(Number(user.bank.salary))) user.bank.salary = defaultSalaryForRank(user.rank);
  if (!Object.prototype.hasOwnProperty.call(user.bank, 'lastSalaryAt')) user.bank.lastSalaryAt = null;
  if (!Object.prototype.hasOwnProperty.call(user.bank, 'salaryClaimedToday')) user.bank.salaryClaimedToday = false;
  user.bank.frozen = user.bank.frozen === true;
  user.bank.enabled = user.bank.enabled !== false;
  user.bank.salaryEnabled = user.bank.salaryEnabled !== false;
  if (!user.bank.bankCode) user.bank.bankCode = `BANK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  return user.bank;
}

function normalizeUser(user) {
  if (!user.id) user.id = makeId('USER');
  user.name = clean(user.name || 'Unnamed', 120);
  user.rank = normalizeRank(user.rank);
  user.publicCode = clean(user.publicCode || '', 100);
  user.secretCode = clean(user.secretCode || '', 100);
  user.status = clean(user.status || 'في الخدمة', 100);
  user.approved = user.approved !== false;
  user.activeService = user.activeService !== false;
  user.suspended = user.suspended === true;
  user.online = user.online === true;
  user.identity = user.identity || null;
  user.identityRequired = user.identityRequired !== false;
  user.loginCount = Number(user.loginCount || 0);
  user.lastLoginAt = user.lastLoginAt || null;
  user.lastLogoutAt = user.lastLogoutAt || null;
  user.radioChannel = clean(user.radioChannel || 'CH-1', 50);
  user.radioOnline = user.radioOnline === true;
  user.hobbies = clean(user.hobbies || '', 1000);
  user.accountId = user.accountId || null;
  user.characterOwnerId = user.characterOwnerId || user.accountId || user.id;
  user.characterType = user.characterType || 'main';
  user.separatedAt = user.separatedAt || null;
  user.separationReason = user.separationReason || '';
  ensureBank(user);
  return user;
}

function normalizeAllUsers(targetState) {
  for (const user of targetState.cia_users || []) normalizeUser(user);
}

function makePublicCode(rank) {
  const prefix = {
    'CIA CHIEF': 'CHIEF',
    'SUPREME COMMANDER': 'SC',
    'HIGH COMMANDER': 'HC',
    'AGENT': 'AG'
  }[normalizeRank(rank)] || 'AG';

  let value;
  do {
    value = `${prefix}-${Math.floor(100 + Math.random() * 900)}`;
  } while (state.cia_users.some((u) => u.publicCode === value));
  return value;
}

function makeSecretCode() {
  let value;
  do {
    value = String(Math.floor(1000 + Math.random() * 9000));
  } while (
    state.cia_users.some((u) => u.secretCode === value) ||
    value === SYSTEM.memberRequestCode ||
    value === SYSTEM.chiefRegistrationCode ||
    value === SYSTEM.chiefSaveCode
  );
  return value;
}

function validateSecretCode(value, target = null) {
  const code = clean(value, 100);
  if (code.length < 4) return 'الكود يجب أن يكون 4 أحرف/أرقام على الأقل.';
  if (code === SYSTEM.memberRequestCode) return 'هذا الكود محجوز لطلبات القبول.';
  if (code === SYSTEM.chiefRegistrationCode) return 'هذا الكود محجوز لتأسيس القيادة.';
  if (code === SYSTEM.chiefSaveCode) return 'هذا الكود محجوز كرمز حماية القيادة.';
  if (state.cia_users.some((u) => u.id !== target?.id && u.secretCode === code)) {
    return 'كود الدخول مستخدم من شخصية أخرى.';
  }
  return null;
}

function getUserById(userId) {
  return state.cia_users.find((u) => u.id === userId) || null;
}

function getUserByPublicCode(publicCode) {
  const wanted = clean(publicCode, 100);
  return state.cia_users.find((u) => u.publicCode === wanted) || null;
}

function findUser(name, secretCode) {
  const n = lower(name);
  const c = clean(secretCode, 100);
  return state.cia_users.find((u) =>
    lower(u.name) === n &&
    u.secretCode === c &&
    u.approved !== false &&
    u.activeService !== false &&
    u.suspended !== true
  ) || null;
}

function publicUser(user, viewer = null) {
  if (!user) return null;
  const leadership = isLeadership(viewer);
  const self = !!viewer && viewer.id === user.id;
  const result = {
    id: user.id,
    publicCode: user.publicCode,
    name: self || leadership ? user.name : null,
    rank: normalizeRank(user.rank),
    rankLabel: rankLabel(user.rank),
    online: !!user.online,
    status: user.status || 'في الخدمة',
    loginCount: Number(user.loginCount || 0),
    lastLoginAt: user.lastLoginAt || null,
    lastLogoutAt: user.lastLogoutAt || null,
    identity: self || leadership ? (user.identity || null) : null,
    identityRequired: user.identityRequired !== false,
    characterOwnerId: user.characterOwnerId || user.accountId || user.id,
    characterType: user.characterType || 'main',
    accountId: self || leadership ? user.accountId || null : null,
    activeService: user.activeService !== false,
    suspended: user.suspended === true,
    bank: self || leadership ? {
      accountNumber: user.bankAccount || '',
      balance: ensureBank(user).balance,
      salary: ensureBank(user).salary,
      lastSalaryAt: ensureBank(user).lastSalaryAt,
      frozen: !!ensureBank(user).frozen,
      enabled: ensureBank(user).enabled !== false,
      salaryEnabled: ensureBank(user).salaryEnabled !== false,
      bankCode: ensureBank(user).bankCode || null
    } : null,
    radioChannel: user.radioChannel || 'CH-1',
    radioOnline: !!user.radioOnline
  };
  if (self) {
    result.secretCode = user.secretCode;
    result.hobbies = user.hobbies || '';
  } else if (leadership) {
    result.hobbies = user.hobbies || '';
  }
  return result;
}

function addAuditLog(action, actor = null, target = null, details = '') {
  state.cia_audit_logs.unshift({
    id: makeId('AUD'),
    action: clean(action, 120),
    actorId: actor?.id || null,
    actorName: actor?.name || '',
    actorCode: actor?.publicCode || '',
    targetId: target?.id || null,
    targetName: target?.name || '',
    targetCode: target?.publicCode || '',
    details: clean(details, 1000),
    at: now()
  });
  state.cia_audit_logs = state.cia_audit_logs.slice(0, 500);
}

function privateChatsFor(viewer) {
  if (!viewer?.publicCode) return {};
  if (isLeadership(viewer)) return state.cia_chats.private || {};
  const result = {};
  const own = viewer.publicCode;
  for (const [key, value] of Object.entries(state.cia_chats.private || {})) {
    if (key.split('::').includes(own)) result[key] = value;
  }
  return result;
}

function sanitizeShared(key, value) {
  const allowed = new Set([
    'cia_chats', 'cia_reports', 'cia_cases', 'cia_map_locations', 'cia_hq_locations'
  ]);
  if (!allowed.has(key)) return null;

  if (key === 'cia_chats') {
    const global = Array.isArray(value?.global)
      ? value.global.filter((m) => !m?.targetCode).slice(-1000)
      : [];
    const privateChats = {};
    const src = value?.private && typeof value.private === 'object' ? value.private : {};
    for (const [k, messages] of Object.entries(src)) {
      if (!Array.isArray(messages)) continue;
      privateChats[clean(k, 150)] = messages.slice(-500);
    }
    return { global, private: privateChats };
  }

  if (key === 'cia_map_locations') {
    return value && typeof value === 'object' ? value : {};
  }
  if (key === 'cia_hq_locations') {
    return Array.isArray(value) ? value.slice(-20) : [];
  }
  if (key === 'cia_reports') {
    const incoming = Array.isArray(value) ? value : [];
    const existing = Array.isArray(state.cia_reports) ? state.cia_reports : [];
    const byId = new Map(existing.map((r) => [String(r.id), r]));
    for (const report of incoming) {
      if (!report || report.id === undefined || report.id === null) continue;
      const id = String(report.id);
      if (!byId.has(id)) {
        byId.set(id, {
          ...report,
          id: report.id,
          immutable: true,
          createdAt: report.createdAt || report.date || now()
        });
      }
    }
    return [...byId.values()].slice(-1000);
  }
  return Array.isArray(value) ? value.slice(-1000) : [];
}

function snapshot(viewer = null) {
  return {
    cia_users: state.cia_users.map((u) => publicUser(u, viewer)),
    cia_queue: isChief(viewer) ? state.cia_queue : [],
    cia_character_queue: isChief(viewer) ? state.cia_character_queue : [],
    cia_chats: {
      global: state.cia_chats.global || [],
      private: privateChatsFor(viewer)
    },
    cia_sos: state.cia_sos || [],
    cia_reports: state.cia_reports || [],
    cia_cases: state.cia_cases || [],
    cia_map_locations: state.cia_map_locations || {},
    cia_hq_locations: state.cia_hq_locations || [],
    cia_audit_logs: isLeadership(viewer) ? state.cia_audit_logs : [],
    cia_attendance: isLeadership(viewer) ? (state.cia_attendance || []) : [],
    cia_operations: (state.cia_operations || []).map((op) => operationSanitize(op, viewer)).filter(Boolean)
  };
}

function emitState() {
  for (const socket of io.sockets.sockets.values()) {
    const user = socket.userId ? getUserById(socket.userId) : null;
    socket.emit('state:update', snapshot(user));
  }
}

function reply(cb, payload) {
  if (typeof cb === 'function') cb(payload);
  return payload;
}

function ok(cb, payload = {}) {
  return reply(cb, { ok: true, ...payload });
}

function no(cb, message) {
  return reply(cb, { ok: false, message: clean(message, 500) });
}

function sessionSet(userId) {
  if (!sessions.has(userId)) sessions.set(userId, new Set());
  return sessions.get(userId);
}

function markLogin(socket, user) {
  const set = sessionSet(user.id);
  const first = set.size === 0;
  set.add(socket.id);
  socket.userId = user.id;
  socketToUser.set(socket.id, user.id);
  user.online = true;
  user.activeService = true;
  user.status = 'في الخدمة';
  if (first) {
    user.loginCount += 1;
    user.lastLoginAt = now();
    addAuditLog('تسجيل الدخول', user, user, 'تم تسجيل دخول الشخصية.');
  }
  saveState();
  emitState();
}

function markLogout(socket) {
  const userId = socket.userId;
  if (!userId) return;
  const set = sessions.get(userId);
  if (set) {
    set.delete(socket.id);
    if (set.size > 0) {
      socket.userId = null;
      socketToUser.delete(socket.id);
      return;
    }
    sessions.delete(userId);
  }
  const user = getUserById(userId);
  if (user) {
    user.online = false;
    user.radioOnline = false;
    user.lastLogoutAt = now();
    addAuditLog('تسجيل الخروج', user, user, 'تم تسجيل خروج الشخصية.');
    saveState();
  }
  socket.userId = null;
  socketToUser.delete(socket.id);
  emitState();
}

function requireSocketUser(socket) {
  const user = socket.userId ? getUserById(socket.userId) : null;
  if (!user) return null;
  if (user.suspended || user.activeService === false) return null;
  return user;
}

function canManageMember(actor, target) {
  if (!actor || !target || actor.id === target.id) return false;
  if (isChief(actor)) return true;
  if (isSenior(actor)) {
    return !isChief(target) && !isSenior(target);
  }
  if (isHighCommander(actor)) {
    return normalizeRank(target.rank) === 'AGENT';
  }
  return false;
}

function canChangeRank(actor, target, newRank) {
  if (!actor || !target) return false;
  const desired = normalizeRank(newRank);
  if (desired === 'CIA CHIEF') return false;
  if (isChief(actor)) return !isChief(target);
  if (isSenior(actor)) return !isChief(target) && !isSenior(target) && desired !== 'SUPREME COMMANDER';
  return false;
}

function canChangeSecret(actor, target) {
  if (!actor || !target) return false;
  if (isChief(actor)) return !isChief(target);
  if (isSenior(actor)) return !isChief(target) && !isSenior(target);
  if (isHighCommander(actor)) return normalizeRank(target.rank) === 'AGENT';
  return false;
}

function addRadioMember(channel, socketId) {
  if (!radioChannels.has(channel)) radioChannels.set(channel, new Set());
  radioChannels.get(channel).add(socketId);
}

function removeRadioMember(socketId) {
  for (const members of radioChannels.values()) members.delete(socketId);
}

function radioTargets(channel) {
  const members = radioChannels.get(channel);
  return members ? [...members] : [];
}

function dailySalary(user) {
  ensureBank(user);
  if (!user.approved || user.activeService === false || user.suspended) return null;
  if (user.bank.enabled === false || user.bank.frozen || user.bank.salaryEnabled === false) return null;
  if (!user.online || !user.lastLoginAt) return null;
  const lastSalary = user.bank.lastSalaryAt ? new Date(user.bank.lastSalaryAt).getTime() : 0;
  const dayMs = 24 * 60 * 60 * 1000;
  if (lastSalary && Date.now() - lastSalary < dayMs) {
    user.bank.salaryClaimedToday = true;
    return null;
  }
  const amount = Math.max(0, Math.floor(Number(user.bank.salary) || 0));
  user.bank.balance += amount;
  user.bank.lastSalaryAt = now();
  user.bank.salaryClaimedToday = true;
  addAuditLog('صرف راتب', null, user, `تم إيداع ${amount} في الحساب البنكي.`);
  return amount;
}

function characterListForUser(user) {
  return state.cia_users.filter((u) =>
    (u.accountId && u.accountId === user.accountId) ||
    u.characterOwnerId === (user.characterOwnerId || user.id)
  );
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'BLACK RIDGE CITY CIA SYSTEM', time: now(), personnel: state.cia_users.length });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'BLACK RIDGE CITY CIA SYSTEM', time: now(), personnel: state.cia_users.length });
});

app.get('/api/state', (req, res) => {
  res.json({ ok: true, state: snapshot(null) });
});

function parseMoney(value) {
  const amount = Math.floor(Number(value));
  return Number.isFinite(amount) ? amount : NaN;
}

function bankView(user, viewer = user) {
  ensureBank(user);
  const leadership = isLeadership(viewer);
  const self = !!viewer && viewer.id === user.id;
  const managerAccess = canManageBank(viewer, user);
  const visible = self || leadership || managerAccess;
  const showName = isChief(viewer) || self;

  return {
    id: user.id,
    code: user.publicCode,
    accountNumber: visible ? (user.bankAccount || '') : '',
    name: showName ? user.name : user.publicCode,
    rank: normalizeRank(user.rank),
    balance: visible ? user.bank.balance : null,
    salary: visible ? user.bank.salary : null,
    online: !!user.online,
    lastSalaryAt: user.bank.lastSalaryAt || null,
    salaryClaimedToday: !!user.bank.salaryClaimedToday,
    frozen: !!user.bank.frozen,
    enabled: user.bank.enabled !== false,
    salaryEnabled: user.bank.salaryEnabled !== false,
    bankCode: visible ? (user.bank.bankCode || null) : null
  };
}

function canSetSalary(actor, target) {
  if (!actor || !target) return false;
  if (isChief(actor)) return true;
  if (isSenior(actor)) return target.id !== actor.id && !isChief(target) && !isSenior(target);
  if (isHighCommander(actor)) return normalizeRank(target.rank) === 'AGENT';
  return false;
}

function operationSanitize(op, viewer) {
  if (!op) return null;
  const leadership = isLeadership(viewer);
  const isAgent = normalizeRank(viewer?.rank) === 'AGENT';

  const crews = (Array.isArray(op.memberCodes) ? op.memberCodes : []).map((code) => {
    const member = getUserByPublicCode(code);
    return leadership && member ? { code, name: member.name } : { code };
  });

  if (isAgent) {
    return {
      id: op.id,
      missionNumber: op.missionNumber || op.id,
      title: op.title,
      type: op.type,
      risk: op.risk,
      objective: op.objective,
      status: op.status,
      startLocation: op.startLocation || null,
      endLocation: op.endLocation || null,
      commanderCode: op.commanderCode || '',
      crew: crews,
      createdAt: op.createdAt
    };
  }

  return {
    id: op.id,
    missionNumber: op.missionNumber || op.id,
    title: op.title,
    type: op.type,
    risk: op.risk,
    objective: op.objective,
    status: op.status,
    startLocation: op.startLocation || null,
    endLocation: op.endLocation || null,
    commanderCode: op.commanderCode || '',
    battalionLeaderCode: op.commanderCode || '',
    commanderName: leadership ? (op.commanderName || '') : '',
    crew: crews,
    battalionCount: Array.isArray(op.memberCodes) ? op.memberCodes.length : 0,
    notes: (Array.isArray(op.notes) ? op.notes : []).map((n) => ({
      at: n.at,
      authorCode: n.authorCode || '',
      authorName: leadership ? (n.authorName || '') : '',
      text: n.text || ''
    })),
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    createdByCode: op.createdByCode || '',
    createdByName: leadership ? (op.createdByName || '') : ''
  };
}

function emitOperationState() {
  for (const socket of io.sockets.sockets.values()) {
    const viewer = socket.userId ? getUserById(socket.userId) : null;
    if (!viewer) continue;
    socket.emit('operation:list:result', {
      ok: true,
      operations: (state.cia_operations || []).map((op) => operationSanitize(op, viewer)).filter(Boolean)
    });
  }
}

/* ---------------------------------------------------------
   SOCKET.IO
--------------------------------------------------------- */

io.on('connection', (socket) => {
  socket.emit('state:update', snapshot(null));

  socket.on('shared:data:seed', (seed, cb) => {
    try {
      const object = seed && typeof seed === 'object' ? seed : {};
      for (const [key, value] of Object.entries(object)) {
        const safe = sanitizeShared(key, value);
        if (safe === null) continue;
        state[key] = safe;
      }
      saveState();
      if (typeof cb === 'function') cb({ ok: true });
      emitState();
    } catch (error) {
      no(cb, error.message || 'تعذر حفظ البيانات المشتركة.');
    }
  });

  socket.on('shared:data:set', (payload, cb) => {
    try {
      const key = clean(payload?.key, 100);
      const safe = sanitizeShared(key, payload?.value);
      if (safe === null) return no(cb, 'نوع البيانات غير مسموح.');
      state[key] = safe;
      saveState();
      io.emit('shared:data:update', { key, value: safe });
      if (typeof cb === 'function') cb({ ok: true });
    } catch (error) {
      no(cb, error.message || 'تعذر حفظ البيانات.');
    }
  });

  socket.on('account:create', (payload, cb) => {
    try {
      const loginName = clean(payload?.loginName, 100);
      const password = String(payload?.password || '');
      const characterName = clean(payload?.characterName, 120);
      const characterCode = clean(payload?.characterCode, 100);

      if (!loginName || password.length < 4 || !characterName || !characterCode) {
        return no(cb, 'أكمل بيانات إنشاء الحساب.');
      }
      if (state.cia_accounts.some((a) => lower(a.loginName) === lower(loginName))) {
        return no(cb, 'اسم تسجيل الدخول مستخدم بالفعل.');
      }
      if (state.cia_users.some((u) => lower(u.name) === lower(characterName))) {
        return no(cb, 'اسم الشخصية مستخدم بالفعل.');
      }

      const account = {
        id: makeId('ACCT'),
        loginName,
        passwordHash: crypto.createHash('sha256').update(password).digest('hex'),
        createdAt: now(),
        status: 'PENDING_APPROVAL',
        pendingPrimary: {
          name: characterName,
          initialCode: characterCode,
          createdAt: now()
        }
      };

      state.cia_accounts.push(account);
      addAuditLog('إنشاء حساب', null, null, `تم إنشاء حساب ${loginName} مع الشخصية ${characterName}.`);
      saveState();
      emitState();

      return ok(cb, {
        account: { id: account.id, loginName: account.loginName },
        pending: true,
        message: 'تم إنشاء الحساب بنجاح. الخطوة التالية: استخدم الكود 0012 من شاشة الدخول لإرسال طلب القبول إلى القيادة.'
      });
    } catch (error) {
      return no(cb, error.message || 'تعذر إنشاء الحساب.');
    }
  });

  socket.on('auth:claimChief', (payload, cb) => {
    try {
      if (state.cia_users.some(isChief)) {
        const result = no(cb, 'يوجد CIA CHIEF بالفعل.');
        socket.emit('auth:chief:result', result);
        return;
      }

      const name = clean(payload?.name, 120);
      const personalCode = clean(payload?.code, 100);
      const officialCode = clean(payload?.officialCode, 100);
      const registrationCode = clean(payload?.registrationCode, 100);
      const hobbies = clean(payload?.hobbies, 1000);

      if (!name || !personalCode || !officialCode || !registrationCode) {
        const result = no(cb, 'أكمل بيانات تأسيس القيادة.');
        socket.emit('auth:chief:result', result);
        return;
      }
      if (registrationCode !== SYSTEM.chiefRegistrationCode) {
        const result = no(cb, 'رمز تأسيس القيادة غير صحيح.');
        socket.emit('auth:chief:result', result);
        return;
      }
      if (officialCode !== SYSTEM.chiefSaveCode) {
        const result = no(cb, 'رمز الحفظ السري للقيادة غير صحيح.');
        socket.emit('auth:chief:result', result);
        return;
      }
      const codeError = validateSecretCode(personalCode);
      if (codeError) {
        const result = no(cb, codeError);
        socket.emit('auth:chief:result', result);
        return;
      }

      const chief = normalizeUser({
        id: makeId('CHIEF'),
        accountId: null,
        characterOwnerId: null,
        characterType: 'main',
        name,
        secretCode: personalCode,
        publicCode: 'CHIEF-01',
        rank: 'CIA CHIEF',
        online: false,
        approved: true,
        activeService: true,
        status: 'في الخدمة',
        loginCount: 0,
        lastLoginAt: null,
        lastLogoutAt: null,
        identity: null,
        identityRequired: true,
        hobbies,
        bank: {
          balance: 0,
          salary: SYSTEM.defaultSalary,
          lastSalaryAt: null,
          salaryClaimedToday: false
        }
      });

      chief.characterOwnerId = chief.id;
      state.cia_users.push(chief);
      addAuditLog('تأسيس القيادة', chief, chief, 'تم إنشاء CIA CHIEF لأول مرة.');
      markLogin(socket, chief);

      const result = ok(cb, {
        user: publicUser(chief, chief),
        needsIdentity: true
      });
      socket.emit('auth:chief:result', result);
      emitState();
    } catch (error) {
      const result = no(cb, error.message || 'تعذر تأسيس القيادة.');
      socket.emit('auth:chief:result', result);
    }
  });

  socket.on('auth:login', (payload, cb) => {
    try {
      const name = clean(payload?.name, 120);
      const code = clean(payload?.code, 100);
      const user = findUser(name, code);

      if (!user) {
        const pending = state.cia_accounts.some((a) => lower(a.pendingPrimary?.name) === lower(name));
        const message = pending
          ? 'هذه الشخصية بانتظار قبول CIA CHIEF. كود التسجيل الأولي لا يمنح صلاحية دخول.'
          : 'الاسم أو كود الدخول غير متطابقين.';
        const result = no(cb, message);
        socket.emit('auth:login:result', result);
        return;
      }

      markLogin(socket, user);
      const salary = dailySalary(user);
      if (salary !== null) saveState();

      const result = ok(cb, {
        user: publicUser(user, user),
        needsIdentity: user.identityRequired !== false && !user.identity
      });
      socket.emit('auth:login:result', result);
      emitState();
    } catch (error) {
      const result = no(cb, error.message || 'تعذر تسجيل الدخول.');
      socket.emit('auth:login:result', result);
    }
  });

  socket.on('join:request', (payload, cb) => {
    try {
      const name = clean(payload?.name, 120);
      if (!name) return no(cb, 'اكتب اسم الشخصية.');

      const account = state.cia_accounts.find((a) => lower(a.pendingPrimary?.name) === lower(name));
      if (!account) return no(cb, 'لا يوجد حساب بهذه الشخصية. أنشئ الحساب أولاً.');

      if (state.cia_queue.some((q) => lower(q.name) === lower(name))) {
        return ok(cb, { message: 'يوجد طلب قبول معلق بالفعل.' });
      }

      const queueItem = {
        id: makeId('REQ'),
        accountId: account.id,
        name,
        initialCode: account.pendingPrimary.initialCode,
        createdAt: now(),
        status: 'PENDING'
      };

      state.cia_queue.push(queueItem);
      account.status = 'PENDING_APPROVAL';
      account.pendingPrimary.requestedAt = queueItem.createdAt;

      addAuditLog('طلب قبول', null, null, `طلب قبول الشخصية ${name}.`);
      saveState();

      socket.emit('join:request:result', ok(null, { request: queueItem }));

      for (const currentSocket of io.sockets.sockets.values()) {
        const currentUser = currentSocket.userId ? getUserById(currentSocket.userId) : null;
        if (isChief(currentUser)) currentSocket.emit('join:request:new', queueItem);
      }

      emitState();
      return ok(cb, { request: queueItem });
    } catch (error) {
      return no(cb, error.message || 'تعذر إرسال طلب القبول.');
    }
  });

  socket.on('admin:action', (payload, cb) => {
    try {
      const actor = requireSocketUser(socket);
      if (!actor || !isChief(actor)) return no(cb, 'هذه الصلاحية متاحة لـ CIA CHIEF فقط.');

      const action = clean(payload?.action, 30).toLowerCase();
      const requestId = clean(payload?.requestId, 120);
      const request = state.cia_queue.find((q) => q.id === requestId);

      if (!request) return no(cb, 'طلب القبول غير موجود.');

      if (action === 'reject') {
        request.status = 'REJECTED';
        state.cia_queue = state.cia_queue.filter((q) => q.id !== requestId);
        const account = state.cia_accounts.find((a) => a.id === request.accountId);
        if (account) account.status = 'REJECTED';
        addAuditLog('رفض طلب قبول', actor, null, `تم رفض طلب ${request.name}.`);
        saveState();
        const result = ok(cb, { action: 'reject' });
        socket.emit('admin:action:result', result);
        emitState();
        return;
      }

      if (action !== 'approve') return no(cb, 'عملية إدارية غير معروفة.');

      const account = state.cia_accounts.find((a) => a.id === request.accountId);
      if (!account) return no(cb, 'الحساب المرتبط بالطلب غير موجود.');

      let secretCode = makeSecretCode();
      const existing = state.cia_users.find((u) => u.accountId === account.id && u.characterType === 'main');
      const approvedUser = existing || normalizeUser({
        id: makeId('AGENT'),
        accountId: account.id,
        characterOwnerId: account.id,
        characterType: 'main',
        name: request.name,
        secretCode,
        publicCode: makePublicCode('AGENT'),
        rank: 'AGENT',
        approved: true,
        activeService: true,
        status: 'في الخدمة',
        identityRequired: true,
        identity: null,
        bank: {
          balance: 0,
          salary: defaultSalaryForRank('AGENT'),
          lastSalaryAt: null,
          salaryClaimedToday: false
        }
      });

      if (existing) {
        existing.approved = true;
        existing.activeService = true;
        existing.suspended = false;
        existing.status = 'في الخدمة';
        if (!existing.secretCode) existing.secretCode = secretCode;
        else secretCode = existing.secretCode;
      } else {
        state.cia_users.push(approvedUser);
      }

      account.status = 'APPROVED';
      account.pendingPrimary.approvedAt = now();
      account.pendingPrimary.secretCode = secretCode;
      state.cia_queue = state.cia_queue.filter((q) => q.id !== requestId);

      addAuditLog('اعتماد عضو', actor, approvedUser, `تم اعتماد ${approvedUser.name}.`);
      saveState();

      const result = ok(cb, {
        action: 'approve',
        user: publicUser(approvedUser, actor),
        secretCode
      });
      socket.emit('admin:action:result', result);

      for (const currentSocket of io.sockets.sockets.values()) {
        if (currentSocket.userId === approvedUser.id) {
          currentSocket.emit('member:approved', {
            ok: true,
            user: publicUser(approvedUser, approvedUser),
            secretCode
          });
        }
      }

      emitState();
    } catch (error) {
      no(cb, error.message || 'تعذر تنفيذ العملية الإدارية.');
    }
  });

  socket.on('member:saveIdentity', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');

    const identity = payload?.identity || {};
    if (!clean(identity.fullName, 200) || !clean(identity.birthDate, 50) || !clean(identity.nationality, 100)) {
      return no(cb, 'الاسم الكامل وتاريخ الميلاد والجنسية إلزامية.');
    }

    user.identity = {
      fullName: clean(identity.fullName, 200),
      birthDate: clean(identity.birthDate, 50),
      nationality: clean(identity.nationality, 100),
      height: clean(identity.height, 50),
      bloodType: clean(identity.bloodType, 50),
      occupation: clean(identity.occupation, 150),
      notes: clean(identity.notes, 2000)
    };
    user.identityRequired = false;

    addAuditLog('حفظ الهوية', user, user, 'تم حفظ الهوية الشخصية.');
    saveState();
    const result = ok(cb, { user: publicUser(user, user), identity: user.identity });
    socket.emit('identity:result', result);
    emitState();
  });

  socket.on('character:list', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');
    return ok(cb, {
      characters: characterListForUser(user).map((u) => publicUser(u, user))
    });
  });

  socket.on('character:request', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');

    const name = clean(payload?.name, 120);
    if (!name) return no(cb, 'اكتب اسم الشخصية الجديدة.');

    const queueItem = {
      id: makeId('CHARREQ'),
      accountId: user.accountId || user.id,
      ownerId: user.accountId || user.id,
      name,
      createdAt: now(),
      status: 'PENDING'
    };

    if (isChief(user)) {
      const newUser = normalizeUser({
        id: makeId('AGENT'),
        accountId: user.accountId || user.id,
        characterOwnerId: user.accountId || user.id,
        characterType: 'secondary',
        name,
        secretCode: makeSecretCode(),
        publicCode: makePublicCode('AGENT'),
        rank: 'AGENT',
        approved: true,
        activeService: true,
        identityRequired: true,
        bank: {
          balance: 0,
          salary: defaultSalaryForRank('AGENT'),
          lastSalaryAt: null,
          salaryClaimedToday: false
        }
      });
      state.cia_users.push(newUser);
      addAuditLog('إنشاء شخصية', user, newUser, 'تم إنشاء شخصية جديدة مباشرة للقيادة.');
      saveState();
      const result = ok(cb, { direct: true, user: publicUser(newUser, user), secretCode: newUser.secretCode, message: 'تم إنشاء الشخصية الجديدة بنجاح.' });
      socket.emit('character:request:result', result);
      emitState();
      return;
    }

    state.cia_character_queue.push(queueItem);
    addAuditLog('طلب شخصية', user, null, `طلب ${user.name} إنشاء شخصية إضافية ${name}.`);
    saveState();

    socket.emit('character:request:result', ok(null, { request: queueItem, message: 'تم إرسال طلب إنشاء الشخصية الجديدة بنجاح. يرجى انتظار الموافقة من القيادة.' }));
    for (const currentSocket of io.sockets.sockets.values()) {
      const currentUser = currentSocket.userId ? getUserById(currentSocket.userId) : null;
      if (isChief(currentUser)) currentSocket.emit('character:request:new', queueItem);
    }
    emitState();
    return ok(cb, { request: queueItem });
  });

  socket.on('character:admin:action', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || !isChief(actor)) return no(cb, 'هذه الصلاحية متاحة لـ CIA CHIEF فقط.');

    const action = clean(payload?.action, 30).toLowerCase();
    const requestId = clean(payload?.requestId, 120);
    const request = state.cia_character_queue.find((q) => q.id === requestId);
    if (!request) return no(cb, 'طلب الشخصية غير موجود.');

    if (action === 'reject') {
      state.cia_character_queue = state.cia_character_queue.filter((q) => q.id !== requestId);
      addAuditLog('رفض طلب شخصية', actor, null, request.name);
      saveState();
      const result = ok(cb, { action: 'reject' });
      socket.emit('character:admin:result', result);
      emitState();
      return;
    }

    if (action !== 'approve') return no(cb, 'عملية شخصية غير معروفة.');

    const newUser = normalizeUser({
      id: makeId('AGENT'),
      accountId: request.accountId,
      characterOwnerId: request.ownerId,
      characterType: 'secondary',
      name: request.name,
      secretCode: makeSecretCode(),
      publicCode: makePublicCode('AGENT'),
      rank: 'AGENT',
      approved: true,
      activeService: true,
      identityRequired: true,
      bank: {
        balance: 0,
        salary: defaultSalaryForRank('AGENT'),
        lastSalaryAt: null,
        salaryClaimedToday: false
      }
    });

    state.cia_users.push(newUser);
    state.cia_character_queue = state.cia_character_queue.filter((q) => q.id !== requestId);
    addAuditLog('اعتماد شخصية', actor, newUser, 'تم اعتماد الشخصية الجديدة.');
    saveState();

    const result = ok(cb, { action: 'approve', user: publicUser(newUser, actor), secretCode: newUser.secretCode });
    socket.emit('character:admin:result', result);
    emitState();
  });

  socket.on('character:login', (payload, cb) => {
    const name = clean(payload?.name, 120);
    const secretCode = clean(payload?.code || payload?.secretCode, 100);
    const user = findUser(name, secretCode);
    if (!user) return no(cb, 'اسم الشخصية أو كود الدخول غير صحيح.');
    markLogin(socket, user);
    const salary = dailySalary(user);
    if (salary !== null) saveState();
    const result = ok(cb, {
      user: publicUser(user, user),
      needsIdentity: user.identityRequired !== false && !user.identity
    });
    socket.emit('auth:login:result', result);
  });

  socket.on('leader:updateProfile', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || !isLeadership(actor)) return no(cb, 'هذه الصلاحية متاحة للقيادة فقط.');
    const name = clean(payload?.name, 120);
    if (!name) return no(cb, 'الاسم غير صالح.');
    actor.name = name;
    addAuditLog('تعديل بيانات القيادة', actor, actor, 'تم تعديل اسم القائد/القيادي.');
    saveState();
    const result = ok(cb, { user: publicUser(actor, actor) });
    socket.emit('leader:profile:result', result);
    emitState();
  });

  socket.on('admin:updateChiefProfile', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || !isChief(actor)) return no(cb, 'هذه الصلاحية متاحة لـ CIA CHIEF فقط.');
    actor.hobbies = clean(payload?.hobbies, 2000);
    addAuditLog('تحديث ملف القائد', actor, actor, 'تم تعديل البيانات الإضافية للقيادة.');
    saveState();
    const result = ok(cb, { user: publicUser(actor, actor) });
    socket.emit('admin:chief-profile:result', result);
    emitState();
  });

  socket.on('admin:changeChiefSecret', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || !isChief(actor)) return no(cb, 'هذه الصلاحية متاحة لـ CIA CHIEF فقط.');
    const newSecret = clean(payload?.newSecretCode || payload?.secretCode, 100);
    const error = validateSecretCode(newSecret, actor);
    if (error) return no(cb, error);
    actor.secretCode = newSecret;
    addAuditLog('تغيير كود القائد', actor, actor, 'تم تغيير كود دخول القائد.');
    saveState();
    const result = ok(cb, { user: publicUser(actor, actor), success: true, message: 'تم تغيير كود الدخول العسكري بنجاح.' });
    socket.emit('admin:chief-secret:result', result);
    emitState();
    return result;
  });

  socket.on('admin:updateSelf', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || !isLeadership(actor)) return no(cb, 'هذه الصلاحية متاحة للقيادة فقط.');
    let changed = false;
    if (payload?.secretCode !== undefined) {
      const newSecret = clean(payload.secretCode, 100);
      const error = validateSecretCode(newSecret, actor);
      if (error) return no(cb, error);
      actor.secretCode = newSecret;
      addAuditLog('تغيير كود القائد', actor, actor, 'تم تغيير كود الدخول الشخصي للقيادة.');
      changed = true;
    }
    if (payload?.publicCode !== undefined) {
      const newPublic = clean(payload.publicCode, 100).toUpperCase();
      if (!newPublic || newPublic === 'PENDING') return no(cb, 'اكتب كوداً عسكرياً صالحاً.');
      if (state.cia_users.some((u) => u.id !== actor.id && u.publicCode === newPublic)) return no(cb, 'الكود العسكري مستخدم بالفعل.');
      actor.publicCode = newPublic;
      addAuditLog('تغيير كود الظهور للقيادة', actor, actor, 'تم تغيير الكود العسكري/العلني الشخصي للقيادة.');
      changed = true;
    }
    if (!changed) return no(cb, 'لم يتم إجراء أي تغيير.');
    saveState();
    const result = ok(cb, { user: publicUser(actor, actor) });
    socket.emit('admin:self:result', result);
    emitState();
    return result;
  });

  socket.on('leadership:handover', (payload, cb) => {
    try {
      const actor = requireSocketUser(socket);
      if (!actor || !isChief(actor)) return no(cb, 'تسليم القيادة متاح لـ CIA CHIEF فقط.');
      const target = getUserByPublicCode(clean(payload?.targetCode, 100));
      if (!target || target.id === actor.id) return no(cb, 'الشخصية الجديدة غير موجودة.');
      if (target.suspended || target.activeService === false) return no(cb, 'لا يمكن تسليم القيادة لشخص مفصول.');
      if (isChief(target) || isSenior(target)) return no(cb, 'هذه الشخصية لا تصلح لتسلم القيادة بهذه الطريقة.');
      target.rank = 'CIA CHIEF';
      actor.rank = 'SUPREME COMMANDER';
      addAuditLog('تسليم القيادة', actor, target, 'تم تحويل منصب CIA CHIEF إلى الشخصية المحددة.');
      saveState();
      const result = ok(cb, { user: publicUser(target, target), previousChief: publicUser(actor, actor) });
      socket.emit('leader:handover:result', result);
      emitState();
      return result;
    } catch (error) {
      return no(cb, error.message || 'تعذر تسليم القيادة.');
    }
  });

  socket.on('admin:updateMember', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || (!isLeadership(actor) && !isHighCommander(actor))) return no(cb, 'ليست لديك صلاحية إدارة الأعضاء.');

    const target = getUserById(clean(payload?.memberId, 120));
    if (!target) return no(cb, 'العضو غير موجود.');
    if (!canManageMember(actor, target)) return no(cb, 'ليست لديك صلاحية إدارة هذا العضو.');

    let changed = false;
    let action = '';

    if (payload?.rank !== undefined) {
      if (!canChangeRank(actor, target, payload.rank)) return no(cb, 'لا يمكنك تغيير هذه الرتبة.');
      const newRank = normalizeRank(payload.rank);
      if (normalizeRank(target.rank) !== newRank) {
        const oldRank = target.rank;
        target.rank = newRank;
        if (!clean(target.publicCode, 100) || target.publicCode === 'PENDING') target.publicCode = makePublicCode(newRank);
        action = rankLevel(newRank) > rankLevel(oldRank) ? 'ترقية' : 'تنزيل';
        addAuditLog(action, actor, target, `تم تغيير الرتبة من ${rankLabel(oldRank)} إلى ${rankLabel(newRank)}.`);
        changed = true;
      }
    }

    if (payload?.secretCode !== undefined) {
      if (!canChangeSecret(actor, target)) return no(cb, 'لا يمكنك تغيير كود دخول هذا العضو.');
      const newSecret = clean(payload.secretCode, 100);
      const error = validateSecretCode(newSecret, target);
      if (error) return no(cb, error);
      target.secretCode = newSecret;
      addAuditLog('تغيير كود الدخول', actor, target, 'تم تغيير كود الدخول العسكري للشخصية.');
      changed = true;
      action = action || 'code';
    }

    if (payload?.publicCode !== undefined) {
      if (!canChangeSecret(actor, target)) return no(cb, 'لا يمكنك تغيير كود الظهور لهذا العضو.');
      const newPublic = clean(payload.publicCode, 100).toUpperCase();
      if (!newPublic || newPublic === 'PENDING') return no(cb, 'اكتب كود ظهور صالحاً.');
      if (state.cia_users.some((u) => u.id !== target.id && u.publicCode === newPublic)) return no(cb, 'كود الظهور مستخدم بالفعل.');
      target.publicCode = newPublic;
      addAuditLog('تغيير كود الظهور', actor, target, 'تم تغيير الكود العسكري الظاهر.');
      changed = true;
      action = action || 'code';
    }

    if (!changed) return no(cb, 'لم يتم إجراء أي تغيير.');
    saveState();
    const result = ok(cb, { action, user: publicUser(target, actor) });
    socket.emit('admin:member:result', result);
    emitState();
  });

  socket.on('admin:kickMember', (payload, cb) => {
    const actor = requireSocketUser(socket);
    const target = getUserById(clean(payload?.memberId, 120));
    if (!actor || !target) return no(cb, 'العضو غير موجود.');
    if (!canManageMember(actor, target)) return no(cb, 'ليست لديك صلاحية فصل هذا العضو.');

    target.approved = false;
    target.activeService = false;
    target.suspended = true;
    target.status = 'مفصول من الخدمة';
    target.separatedAt = now();
    target.separationReason = clean(payload?.reason || 'فصل إداري', 300);
    target.online = false;
    target.radioOnline = false;

    const set = sessions.get(target.id);
    if (set) {
      for (const sid of set) {
        const targetSocket = io.sockets.sockets.get(sid);
        if (targetSocket) {
          targetSocket.emit('member:kicked', { ok: true, message: 'تم فصلك من الخدمة.' });
          targetSocket.disconnect(true);
        }
      }
      sessions.delete(target.id);
    }

    addAuditLog('فصل عضو', actor, target, 'تم فصل العضو من الخدمة مع الاحتفاظ بسجله.');
    saveState();
    const result = ok(cb, { action: 'kick', user: publicUser(target, actor) });
    socket.emit('admin:member:result', result);
    emitState();
  });

  socket.on('admin:reactivateMember', (payload, cb) => {
    const actor = requireSocketUser(socket);
    const target = getUserById(clean(payload?.memberId, 120));
    if (!actor || !target) return no(cb, 'العضو غير موجود.');
    if (!canManageMember(actor, target)) return no(cb, 'ليست لديك صلاحية إعادة هذا العضو.');

    target.approved = true;
    target.activeService = true;
    target.suspended = false;
    target.status = 'في الخدمة';
    target.separatedAt = null;
    target.separationReason = '';

    addAuditLog('إعادة عضو للخدمة', actor, target, 'تمت إعادة العضو للخدمة.');
    saveState();
    const result = ok(cb, { action: 'reactivate', user: publicUser(target, actor) });
    socket.emit('admin:member:result', result);
    emitState();
  });

  socket.on('admin:kickUser', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || !isChief(actor)) return no(cb, 'هذه الصلاحية متاحة للقائد فقط.');
    const accountId = clean(payload?.userId, 120);
    state.cia_accounts = state.cia_accounts.filter((a) => a.id !== accountId);
    state.cia_users = state.cia_users.filter((u) => u.accountId !== accountId);
    addAuditLog('حذف حساب', actor, null, `تم إنهاء الحساب ${accountId}.`);
    saveState();
    return ok(cb, { action: 'kickUser', userId: accountId });
  });

  /* =====================================================
     BANK SYSTEM
  ===================================================== */
  socket.on('bank:get', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const code = clean(payload?.code, 100);
    if (code && code !== actor.publicCode) {
      const target = getUserByPublicCode(code);
      if (!target) return no(cb, 'الشخصية غير موجودة.');
      if (!canManageBank(actor, target)) return no(cb, 'لا تملك صلاحية عرض هذا الحساب البنكي.');
      return ok(cb, { target: bankView(target, actor) });
    }
    const users = state.cia_users
      .filter((u) => u.activeService !== false || u.id === actor.id)
      .filter((u) => u.id === actor.id || canManageBank(actor, u) || isLeadership(actor))
      .map((u) => bankView(u, actor));
    return ok(cb, { self: bankView(actor, actor), users });
  });

  socket.on('bank:setAccount', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const accountNumber = clean(payload?.accountNumber, 60).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9-]{4,60}$/.test(accountNumber)) return no(cb, 'رقم الحساب البنكي يجب أن يكون 4 رموز على الأقل ويحتوي على أرقام/أحرف فقط.');
    if (state.cia_users.some((u) => u.id !== actor.id && u.bankAccount === accountNumber)) return no(cb, 'رقم الحساب البنكي مستخدم من شخصية أخرى.');
    actor.bankAccount = accountNumber;
    addAuditLog('تحديث الحساب البنكي', actor, actor, 'تم تحديث رقم الحساب البنكي.');
    saveState();
    const result = ok(cb, { self: bankView(actor, actor) });
    socket.emit('bank:setAccount:result', result);
    emitState();
    return result;
  });

  socket.on('bank:setSalary', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const target = getUserByPublicCode(clean(payload?.targetCode || actor.publicCode, 100));
    const amount = parseMoney(payload?.amount);
    if (!target) return no(cb, 'الشخصية غير موجودة.');
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) return no(cb, 'قيمة الراتب غير صالحة.');
    if (!canSetSalary(actor, target)) return no(cb, 'لا تملك صلاحية تعديل راتب هذه الشخصية.');
    ensureBank(target).salary = amount;
    addAuditLog('تعديل راتب', actor, target, `تم تحديد راتب ${rankLabel(target.rank)} إلى ${amount} للشخصية ${target.publicCode}.`);
    saveState();
    const result = ok(cb, { target: bankView(target, actor), amount });
    socket.emit('bank:setSalary:result', result);
    emitState();
    return result;
  });

  socket.on('bank:setRankSalary', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const rank = normalizeRank(payload?.rank);
    const amount = parseMoney(payload?.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) return no(cb, 'قيمة الراتب غير صالحة.');
    if (!canSetRankSalary(actor, rank)) return no(cb, 'لا تملك صلاحية تعديل راتب هذه الرتبة.');
    if (!state.settings.rankSalaries || typeof state.settings.rankSalaries !== 'object') state.settings.rankSalaries = {};
    state.settings.rankSalaries[rank] = amount;
    if (rank === 'AGENT') state.settings.publicSalary = amount;
    let updated = 0;
    for (const target of state.cia_users) {
      if (normalizeRank(target.rank) !== rank) continue;
      ensureBank(target).salary = amount;
      updated += 1;
    }
    addAuditLog('تعديل راتب رتبة', actor, null, `تم تغيير وتحديد راتب رتبة ${rankLabel(rank)} إلى ${amount}.`);
    saveState();
    const successMsg = `تم تغيير وتحديد راتب الرتبة (${rankLabel(rank)}) إلى ${amount} بنجاح، وتطبيق التعديل على جميع أعضاء الرتبة.`;
    const result = ok(cb, { rank, label: rankLabel(rank), amount, updated, message: successMsg, success: true });
    socket.emit('bank:setRankSalary:result', result);
    emitState();
    return result;
  });

  socket.on('bank:setBalance', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const target = getUserById(clean(payload?.memberId, 120));
    const amount = parseMoney(payload?.amount);
    if (!target) return no(cb, 'الشخصية غير موجودة.');
    if (!canManageBank(actor, target)) return no(cb, 'لا تملك صلاحية تعديل رصيد هذا الحساب.');
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) return no(cb, 'الرصيد غير صالح.');
    ensureBank(target).balance = amount;
    addAuditLog('تعديل رصيد بنكي', actor, target, `تم ضبط الرصيد إلى ${amount}.`);
    saveState();
    const result = ok(cb, { target: bankView(target, actor), amount });
    socket.emit('bank:setBalance:result', result);
    emitState();
    return result;
  });

  socket.on('bank:withdraw', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const amount = parseMoney(payload?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return no(cb, 'قيمة السحب غير صالحة.');
    ensureBank(actor);
    if (actor.bank.enabled === false) return no(cb, 'الحساب البنكي موقوف.');
    if (actor.bank.frozen) return no(cb, 'الحساب البنكي مجمد ولا يمكن السحب منه.');
    if (amount > actor.bank.balance) return no(cb, 'الرصيد غير كافٍ.');
    actor.bank.balance -= amount;
    addAuditLog('سحب من البنك', actor, actor, `تم سحب ${amount} من الحساب الشخصي.`);
    saveState();
    const result = ok(cb, { self: bankView(actor, actor), amount });
    socket.emit('bank:withdraw:result', result);
    emitState();
    return result;
  });

  socket.on('bank:addBalance', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || (!isChief(actor) && !isSenior(actor))) {
      return no(cb, 'إضافة المبالغ الحرة للأشخاص متاحة للقائد (CIA Chief) والسينيور كوماندر (Supreme Commander) فقط.');
    }
    const targetCode = clean(payload?.targetCode || payload?.code || payload?.memberId, 100);
    const target = getUserByPublicCode(targetCode) || getUserById(targetCode);
    const amount = parseMoney(payload?.amount);
    if (!target) return no(cb, 'الشخصية المستهدفة غير موجودة.');
    if (!Number.isFinite(amount) || amount <= 0) return no(cb, 'المبلغ المراد إضافته غير صالح.');
    
    ensureBank(target);
    target.bank.balance += amount;
    addAuditLog('إضافة مبلغ مالي', actor, target, `تمت إضافة مبلغ ${amount} إلى حساب الشخصية ${target.publicCode}.`);
    saveState();
    
    const successMsg = `تمت إضافة مبلغ ${amount} بنجاح إلى حساب الشخصية (${target.publicCode}).`;
    const result = ok(cb, { target: bankView(target, actor), amount, message: successMsg, success: true });
    socket.emit('bank:addBalance:result', result);
    emitState();
    return result;
  });

  socket.on('bank:manage', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const targetCode = clean(payload?.targetCode, 100);
    const target = getUserByPublicCode(targetCode);
    if (!target) return no(cb, 'الشخصية غير موجودة.');
    if (!canManageBank(actor, target)) return no(cb, 'لا تملك صلاحية إدارة هذا الحساب البنكي.');
    const action = clean(payload?.action, 50).toLowerCase();
    ensureBank(target);
    if (action === 'freeze') target.bank.frozen = true;
    else if (action === 'unfreeze') target.bank.frozen = false;
    else if (action === 'stop-account' || action === 'stop') target.bank.enabled = false;
    else if (action === 'start-account' || action === 'start') target.bank.enabled = true;
    else if (action === 'stop-salary') target.bank.salaryEnabled = false;
    else if (action === 'start-salary') target.bank.salaryEnabled = true;
    else if (action === 'deduct' || action === 'withdraw') {
      const amount = parseMoney(payload?.amount);
      if (!Number.isFinite(amount) || amount <= 0) return no(cb, 'قيمة المبلغ غير صالحة.');
      if (amount > target.bank.balance) return no(cb, 'رصيد الشخص غير كافٍ.');
      target.bank.balance -= amount;
    } else return no(cb, 'الإجراء البنكي غير معروف.');
    const amountValue = ['deduct','withdraw'].includes(action) ? parseMoney(payload?.amount) : 0;
    addAuditLog('إدارة حساب بنكي', actor, target, `تم تنفيذ الإجراء ${action}${amountValue ? ` بمبلغ ${amountValue}` : ''} على الحساب البنكي.`);
    saveState();
    const result = ok(cb, { action, target: bankView(target, actor) });
    socket.emit('bank:manage:result', result);
    emitState();
    return result;
  });

  socket.on('bank:paySalary', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || (!isChief(actor) && !isSenior(actor) && !isHighCommander(actor))) return no(cb, 'صرف راتب فوري متاح للقيادة.');
    const target = getUserByPublicCode(clean(payload?.targetCode, 100));
    if (!target) return no(cb, 'الشخصية غير موجودة.');
    if (!canSetSalary(actor, target)) return no(cb, 'لا تملك صلاحية صرف راتب هذه الشخصية.');
    const paid = dailySalary(target);
    if (paid === null) return no(cb, 'لا يمكن الصرف الآن.');
    addAuditLog('صرف راتب فوري', actor, target, `تم صرف ${paid} فورياً.`);
    saveState();
    const result = ok(cb, { target: bankView(target, actor), amount: paid });
    socket.emit('bank:paySalary:result', result);
    emitState();
    return result;
  });

  /* =====================================================
     TACTICAL OPERATIONS & MAP LOCATIONS
  ===================================================== */
  socket.on('operation:list', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    return ok(cb, { operations: state.cia_operations.map((op) => operationSanitize(op, actor)).filter(Boolean) });
  });

  socket.on('operation:create', (payload, cb) => {
    try {
      const actor = requireSocketUser(socket);
      if (!actor || (!isChief(actor) && !isSenior(actor) && !isHighCommander(actor))) return no(cb, 'إنشاء المهام متاح للقيادة.');
      const title = clean(payload?.title, 160);
      const objective = clean(payload?.objective, 2000);
      const type = clean(payload?.type || 'surveillance', 50).toLowerCase();
      const risk = clean(payload?.risk || 'MEDIUM', 50).toUpperCase();
      const allowedTypes = new Set(['surveillance','raid','protection','evidence']);
      const allowedRisks = new Set(['LOW','MEDIUM','HIGH','CRITICAL']);
      if (!title || !objective) return no(cb, 'اسم العملية والهدف مطلوبان.');
      if (!allowedTypes.has(type)) return no(cb, 'نوع العملية غير صالح.');
      if (!allowedRisks.has(risk)) return no(cb, 'درجة الخطورة غير صالحة.');
      const commanderCode = clean(payload?.commanderCode || actor.publicCode, 100);
      const commander = getUserByPublicCode(commanderCode);
      if (!commander || commander.suspended || commander.activeService === false) return no(cb, 'كود قائد العملية غير صالح.');
      const memberCodes = [...new Set((Array.isArray(payload?.memberCodes) ? payload.memberCodes : []).map((x) => clean(x,100)).filter(Boolean))];
      
      const loc = (v) => v && typeof v === 'object' ? {
        lat: Number.isFinite(Number(v.lat)) ? Number(v.lat) : null,
        lng: Number.isFinite(Number(v.lng)) ? Number(v.lng) : null,
        label: clean(v.label || '', 200)
      } : null;

      const op = {
        id: makeId('OP'), title, type, risk, objective,
        status: 'PLANNED', startLocation: loc(payload?.startLocation), endLocation: loc(payload?.endLocation),
        commanderCode, commanderName: commander.name, memberCodes,
        notes: [], createdAt: now(), updatedAt: now(), createdByCode: actor.publicCode, createdByName: actor.name
      };

      state.cia_operations.unshift(op);
      state.cia_operations = state.cia_operations.slice(0, 500);
      addAuditLog('إنشاء عملية ميدانية', actor, commander, `تم إنشاء ${title}`);
      saveState();
      
      const result = ok(cb, { operation: operationSanitize(op, actor) });
      socket.emit('operation:create:result', result);
      emitOperationState();
      emitState();
      return result;
    } catch (error) {
      return no(cb, error.message || 'تعذر إنشاء العملية.');
    }
  });

  socket.on('operation:updateStatus', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const op = state.cia_operations.find((x) => x.id === clean(payload?.operationId, 120));
    if (!op) return no(cb, 'العملية غير موجودة.');
    const rawStatus = clean(payload?.status, 50).toUpperCase();
    const statusMap = { 'قيد التنفيذ':'IN_PROGRESS', 'تمت':'COMPLETED', 'مكتملة':'COMPLETED', 'فشلت':'FAILED', 'فشل':'FAILED', 'مخططة':'PLANNED', 'ملغاة':'CANCELLED' };
    const status = statusMap[rawStatus] || rawStatus;
    if (!['PLANNED','IN_PROGRESS','COMPLETED','FAILED','CANCELLED'].includes(status)) return no(cb, 'الحالة غير صالحة.');
    op.status = status; op.updatedAt = now();
    saveState();
    const result = ok(cb, { operation: operationSanitize(op, actor) });
    socket.emit('operation:status:result', result);
    emitOperationState();
    return result;
  });

  socket.on('operation:addNote', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const op = state.cia_operations.find((x) => x.id === clean(payload?.operationId, 120));
    const text = clean(payload?.text, 2000);
    if (!op || !text) return no(cb, 'العملية أو الملاحظة غير صالحة.');
    op.notes.push({ at: now(), authorCode: actor.publicCode, authorName: actor.name, text });
    saveState();
    const result = ok(cb, { operation: operationSanitize(op, actor) });
    socket.emit('operation:note:result', result);
    emitOperationState();
    return result;
  });

  socket.on('operation:updateCrew', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || (!isChief(actor) && !isSenior(actor) && !isHighCommander(actor))) return no(cb, 'إدارة الطاقم متاحة للقيادة.');
    const op = state.cia_operations.find((x) => x.id === clean(payload?.operationId, 120));
    if (!op) return no(cb, 'العملية غير موجودة.');
    const codes = [...new Set((Array.isArray(payload?.memberCodes) ? payload.memberCodes : []).map((x) => clean(x,100)).filter(Boolean))];
    op.memberCodes = codes; op.updatedAt = now();
    saveState();
    const result = ok(cb, { operation: operationSanitize(op, actor) });
    socket.emit('operation:crew:result', result); emitOperationState(); return result;
  });

  socket.on('operation:delete', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || !isChief(actor)) return no(cb, 'حذف العمليات متاح لـ CIA CHIEF فقط.');
    const id = clean(payload?.operationId || payload?.id, 120);
    const i = state.cia_operations.findIndex((x) => x.id === id);
    if (i < 0) return no(cb, 'العملية غير موجودة.');
    state.cia_operations.splice(i, 1);
    saveState();
    const result = ok(cb, { operationId: id }); socket.emit('operation:delete:result', result); emitOperationState(); emitState(); return result;
  });

  socket.on('map:location:delete', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || (!isChief(actor) && !isSenior(actor) && !isHighCommander(actor))) {
      return no(cb, 'حذف أماكن الأشخاص من الخريطة متاح فقط للقائد، السينيور كوماندر، والهاي كوماندر.');
    }
    const locId = clean(payload?.id || payload?.locationId, 120);
    if (state.cia_map_locations && state.cia_map_locations[locId]) {
      delete state.cia_map_locations[locId];
    } else if (Array.isArray(state.cia_hq_locations)) {
      state.cia_hq_locations = state.cia_hq_locations.filter((l) => l.id !== locId);
    }
    saveState();
    io.emit('map:location:deleted', { ok: true, id: locId });
    emitState();
    return ok(cb, { id: locId, success: true });
  });

  /* =====================================================
     RADIO SYSTEM
  ===================================================== */
  socket.on('radio:join', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const channel = clean(payload?.channel || 'CH-1', 50);
    removeRadioMember(socket.id);
    addRadioMember(channel, socket.id);
    user.radioChannel = channel;
    user.radioOnline = true;
    saveState();
    socket.emit('radio:state', { ok: true, channel, online: true });
    io.emit('radio:channel', { userCode: user.publicCode, channel, online: true });
    if (typeof cb === 'function') cb({ ok: true, channel });
  });

  socket.on('radio:text', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const channel = clean(payload?.channel || user.radioChannel || 'CH-1', 50);
    const message = clean(payload?.text, 1500);
    if (!message) return no(cb, 'اكتب رسالة.');
    const data = {
      channel,
      text: message,
      userCode: user.publicCode,
      userName: user.name,
      at: now()
    };
    for (const sid of radioTargets(channel)) {
      const targetSocket = io.sockets.sockets.get(sid);
      if (targetSocket) targetSocket.emit('radio:text', data);
    }
    return ok(cb, { message: data });
  });

  socket.on('radio:code', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const channel = clean(payload?.channel || user.radioChannel || 'CH-1', 50);
    const data = {
      channel,
      code: clean(payload?.code, 100),
      meaning: clean(payload?.meaning, 300),
      userCode: user.publicCode,
      userName: user.name,
      at: now()
    };
    for (const sid of radioTargets(channel)) {
      const targetSocket = io.sockets.sockets.get(sid);
      if (targetSocket) targetSocket.emit('radio:code', data);
    }
    return ok(cb, { message: data });
  });

  socket.on('radio:ptt:start', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const channel = clean(payload?.channel || user.radioChannel || 'CH-1', 50);
    const data = { channel, userCode: user.publicCode, userName: user.name, speaking: true };
    for (const sid of radioTargets(channel)) {
      const targetSocket = io.sockets.sockets.get(sid);
      if (targetSocket) targetSocket.emit('radio:state', data);
    }
    return ok(cb, data);
  });

  socket.on('radio:ptt:stop', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');
    const channel = clean(payload?.channel || user.radioChannel || 'CH-1', 50);
    const data = { channel, userCode: user.publicCode, userName: user.name, speaking: false };
    for (const sid of radioTargets(channel)) {
      const targetSocket = io.sockets.sockets.get(sid);
      if (targetSocket) targetSocket.emit('radio:state', data);
    }
    return ok(cb, data);
  });

  /* =====================================================
     SOS SYSTEM (UPDATED WITH CORRECT RANK, CODE, CREW, & MAP PIN)
  ===================================================== */
  socket.on('sos:broadcast', (payload, cb) => {
    const user = requireSocketUser(socket);
    if (!user) return no(cb, 'يجب تسجيل الدخول أولاً.');

    const message = clean(payload?.text || payload?.message, 3000);
    const crewCount = payload?.crewCount !== undefined ? Number(payload.crewCount) : (payload?.membersCount !== undefined ? Number(payload.membersCount) : null);
    
    // استلام الموقع الجغرافي للبلاغ (إذا أرسله المستخدم من واجهة الخريطة/البلاغ)
    const rawLoc = payload?.location || payload?.mapLocation || null;
    let locationInfo = null;
    if (rawLoc && typeof rawLoc === 'object') {
      locationInfo = {
        lat: Number.isFinite(Number(rawLoc.lat)) ? Number(rawLoc.lat) : null,
        lng: Number.isFinite(Number(rawLoc.lng)) ? Number(rawLoc.lng) : null,
        label: clean(rawLoc.label || message || 'موقع بلاغ الطوارئ', 250)
      };
    }

    const sosId = makeId('SOS');

    // إذا تم تحديد إحداثيات، نقوم بحفظها تلقائياً في خريطة النظام (cia_map_locations) ليتم عرضها على الخريطة مباشرة
    if (locationInfo && locationInfo.lat !== null && locationInfo.lng !== null) {
      if (!state.cia_map_locations || typeof state.cia_map_locations !== 'object') {
        state.cia_map_locations = {};
      }
      state.cia_map_locations[sosId] = {
        id: sosId,
        type: 'sos',
        title: `بلاغ طوارئ: ${user.name} (${user.publicCode})`,
        lat: locationInfo.lat,
        lng: locationInfo.lng,
        label: locationInfo.label,
        userCode: user.publicCode,
        at: now()
      };
    }

    const alert = {
      id: sosId,
      userCode: user.publicCode, // كود العسكري الصحيح للمرسل
      userName: user.name,
      rank: normalizeRank(user.rank), // الرتبة البرمجية
      rankLabel: rankLabel(user.rank), // الرتبة الحقيقية المكتوبة
      text: message,
      crewCount: Number.isFinite(crewCount) ? crewCount : 'غير محدد',
      location: locationInfo,
      at: now(),
      status: 'OPEN'
    };

    state.cia_sos.push(alert);
    state.cia_sos = state.cia_sos.slice(-300);
    
    addAuditLog('إرسال S.O.S', user, null, `بلاغ طوارئ من العضو ${user.name} برتبة ${rankLabel(user.rank)} بالكود العسكري #${user.publicCode}.`);
    saveState();

    io.emit('sos:alert', alert);
    io.emit('shared:data:update', { key: 'cia_map_locations', value: state.cia_map_locations });
    emitState();
    return ok(cb, { alert });
  });

  socket.on('sos:delete', (payload, cb) => {
    const actor = requireSocketUser(socket);
    if (!actor || (!isLeadership(actor) && !isHighCommander(actor))) {
      return no(cb, 'حذف بلاغات الـ SOS متاح للقيادة وصلاحيات الإدارة العليا فقط.');
    }
    const alertId = clean(payload?.id || payload?.sosId, 120);
    const initialLen = state.cia_sos.length;
    
    // إزالة البلاغ من القائمة
    state.cia_sos = state.cia_sos.filter((s) => s.id !== alertId);
    if (state.cia_sos.length === initialLen) {
      return no(cb, 'بلاغ الطوارئ غير موجود.');
    }

    // حذف علامة الموقع المقترنة بهذا البلاغ من الخريطة فوراً بشكل دائم
    if (state.cia_map_locations && state.cia_map_locations[alertId]) {
      delete state.cia_map_locations[alertId];
    }

    saveState();
    
    // بث أحداث الحذف لجميع المتصلين لتحديث الشاشة والخريطة فوراً
    io.emit('sos:deleted', { ok: true, id: alertId });
    io.emit('map:location:deleted', { ok: true, id: alertId });
    io.emit('shared:data:update', { key: 'cia_map_locations', value: state.cia_map_locations });
    emitState();
    
    return ok(cb, { id: alertId, success: true });
  });

  /* =====================================================
     LOGOUT & DISCONNECT
  ===================================================== */
  socket.on('logout', (cb) => {
    markLogout(socket);
    const result = { ok: true };
    if (typeof cb === 'function') cb(result);
    socket.emit('auth:logout:result', result);
  });

  socket.on('disconnect', () => {
    removeRadioMember(socket.id);
    markLogout(socket);
  });
});

setInterval(() => {
  let changed = false;
  for (const user of state.cia_users) {
    if (!user.online) continue;
    const before = ensureBank(user).lastSalaryAt;
    const paid = dailySalary(user);
    if (paid !== null && before !== ensureBank(user).lastSalaryAt) changed = true;
  }
  if (changed) {
    saveState();
    emitState();
  }
}, 60 * 1000);

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  }
  res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
  console.error('[BLACK RIDGE] Express error:', err?.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'INTERNAL_SERVER_ERROR' });
});

saveState();

httpServer.listen(PORT, () => {
  console.log('=================================================');
  console.log(' BLACK RIDGE CITY CIA SYSTEM (S.O.S & MAP FIXED)');
  console.log(` SERVER: http://localhost:${PORT}`);
  console.log(' SOCKET.IO: READY');
  console.log('=================================================');
});
