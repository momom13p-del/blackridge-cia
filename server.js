'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'cia-data.json');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true, service: 'BLACK RIDGE CITY CIA SYSTEM', time: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'BLACK RIDGE CITY CIA SYSTEM', time: new Date().toISOString() }));

const now = () => new Date().toISOString();
const text = (v, n = 1000) => String(v ?? '').trim().slice(0, n);
const lower = v => text(v, 200).toLowerCase();
const id = p => `${p}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const hash = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const SYSTEM = { chiefRegistrationCode: '1531', chiefSaveCode: '4139', memberRequestCode: '0012', defaultSalary: 580 };
const empty = () => ({
  cia_users: [], cia_queue: [], cia_character_queue: [], cia_accounts: [],
  cia_chats: { global: [], private: {} }, cia_sos: [], cia_reports: [], cia_cases: [],
  cia_map_locations: {}, cia_hq_locations: [], cia_audit_logs: [], cia_operations: [],
  settings: { publicSalary: SYSTEM.defaultSalary }
});

function load() {
  if (!fs.existsSync(DATA_FILE)) return empty();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const s = { ...empty(), ...raw };
    for (const k of ['cia_users','cia_queue','cia_character_queue','cia_accounts','cia_sos','cia_reports','cia_cases','cia_hq_locations','cia_audit_logs','cia_operations']) if (!Array.isArray(s[k])) s[k] = [];
    if (!s.cia_chats || typeof s.cia_chats !== 'object') s.cia_chats = { global: [], private: {} };
    if (!Array.isArray(s.cia_chats.global)) s.cia_chats.global = [];
    if (!s.cia_chats.private || typeof s.cia_chats.private !== 'object') s.cia_chats.private = {};
    if (!s.cia_map_locations || typeof s.cia_map_locations !== 'object') s.cia_map_locations = {};
    s.cia_users.forEach(normalizeUser);
    return s;
  } catch (e) { console.error('[BLACK RIDGE] data load failed:', e.message); return empty(); }
}
function save() { try { const tmp = `${DATA_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, DATA_FILE); } catch (e) { console.error('[BLACK RIDGE] data save failed:', e.message); } }
let state = load();
const sessions = new Map();
const radio = new Map();

function rank(v) { const r = text(v, 100).toUpperCase(); if (r === 'CIA CHIEF') return r; if (r === 'SUPREME COMMANDER' || r === 'SENIOR COMMANDER CIA') return 'SUPREME COMMANDER'; if (r === 'HIGH COMMANDER') return r; return 'AGENT'; }
const chief = u => !!u && rank(u.rank) === 'CIA CHIEF';
const senior = u => !!u && rank(u.rank) === 'SUPREME COMMANDER';
const high = u => !!u && rank(u.rank) === 'HIGH COMMANDER';
const leadership = u => chief(u) || senior(u);
function bank(u) { u.bank = u.bank && typeof u.bank === 'object' ? u.bank : {}; if (!Number.isFinite(Number(u.bank.balance))) u.bank.balance = 0; if (!Number.isFinite(Number(u.bank.salary))) u.bank.salary = Number(state.settings.publicSalary) || SYSTEM.defaultSalary; u.bank.salaryEnabled = u.bank.salaryEnabled !== false; u.bank.frozen = u.bank.frozen === true; u.bank.bankCode = u.bank.bankCode || `BANK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; u.bank.lastSalaryAt = u.bank.lastSalaryAt || null; return u.bank; }
function normalizeUser(u) { u.id = u.id || id('USER'); u.name = text(u.name || 'Unnamed', 120); u.rank = rank(u.rank); u.publicCode = text(u.publicCode || '', 100); u.secretCode = text(u.secretCode || '', 100); u.status = text(u.status || 'في الخدمة', 100); u.approved = u.approved !== false; u.activeService = u.activeService !== false; u.suspended = u.suspended === true; u.online = u.online === true; u.identity = u.identity || null; u.identityRequired = u.identityRequired !== false; u.loginCount = Number(u.loginCount || 0); u.lastLoginAt = u.lastLoginAt || null; u.lastLogoutAt = u.lastLogoutAt || null; u.radioChannel = text(u.radioChannel || 'CH-1', 50); u.radioOnline = u.radioOnline === true; u.accountId = u.accountId || null; u.characterOwnerId = u.characterOwnerId || u.accountId || u.id; u.characterType = u.characterType || 'main'; bank(u); return u; }
function findUser(name, code) { return state.cia_users.find(u => lower(u.name) === lower(name) && u.secretCode === text(code, 100) && u.approved && u.activeService && !u.suspended) || null; }
function byId(v) { return state.cia_users.find(u => u.id === text(v, 120)) || null; }
function byCode(v) { return state.cia_users.find(u => u.publicCode === text(v, 100)) || null; }
function publicUser(u, viewer) { if (!u) return null; const self = viewer && viewer.id === u.id; const lead = leadership(viewer); const r = { id:u.id, publicCode:u.publicCode, name:self || lead ? u.name : null, rank:rank(u.rank), rankLabel:rank(u.rank), online:!!u.online, status:u.status, identity:self || lead ? u.identity : null, identityRequired:u.identityRequired !== false, activeService:u.activeService !== false, suspended:!!u.suspended, characterOwnerId:u.characterOwnerId, characterType:u.characterType, accountId:self || lead ? u.accountId : null, radioChannel:u.radioChannel, radioOnline:!!u.radioOnline, bank:self || lead ? { accountNumber:u.bankAccount || '', balance:bank(u).balance, salary:bank(u).salary, lastSalaryAt:bank(u).lastSalaryAt } : null }; if (self) { r.secretCode=u.secretCode; r.hobbies=u.hobbies || ''; } return r; }
function audit(action, actor, target, details) { state.cia_audit_logs.unshift({ id:id('AUD'), action:text(action,120), actorId:actor?.id || null, actorName:actor?.name || '', targetId:target?.id || null, targetName:target?.name || '', details:text(details,1000), at:now() }); state.cia_audit_logs = state.cia_audit_logs.slice(0, 500); }
function snapshot(viewer) { return { cia_users:state.cia_users.map(u => publicUser(u, viewer)), cia_queue:chief(viewer) ? state.cia_queue : [], cia_character_queue:chief(viewer) ? state.cia_character_queue : [], cia_chats:state.cia_chats, cia_sos:state.cia_sos, cia_reports:state.cia_reports, cia_cases:state.cia_cases, cia_map_locations:state.cia_map_locations, cia_hq_locations:state.cia_hq_locations, cia_audit_logs:leadership(viewer) ? state.cia_audit_logs : [], cia_operations:state.cia_operations }; }
function emitState() { for (const s of io.sockets.sockets.values()) s.emit('state:update', snapshot(s.userId ? byId(s.userId) : null)); }
function reply(cb, v) { if (typeof cb === 'function') cb(v); return v; }
function ok(cb, v={}) { return reply(cb, { ok:true, ...v }); }
function no(cb, message) { return reply(cb, { ok:false, message:text(message,500) }); }
function logged(socket) { const u = socket.userId ? byId(socket.userId) : null; return u && !u.suspended && u.activeService !== false ? u : null; }
function login(socket, u) { socket.userId=u.id; if (!sessions.has(u.id)) sessions.set(u.id, new Set()); sessions.get(u.id).add(socket.id); if (!u.online) { u.loginCount++; u.lastLoginAt=now(); audit('تسجيل الدخول',u,u,'تم تسجيل الدخول.'); } u.online=true; u.status='في الخدمة'; save(); emitState(); }
function logout(socket) { const uid=socket.userId; if (!uid) return; const set=sessions.get(uid); if (set) { set.delete(socket.id); if (set.size) { socket.userId=null; return; } sessions.delete(uid); } const u=byId(uid); if (u) { u.online=false; u.radioOnline=false; u.lastLogoutAt=now(); audit('تسجيل الخروج',u,u,'تم تسجيل الخروج.'); save(); } socket.userId=null; emitState(); }
function secretCode() { let v; do { v=String(Math.floor(1000+Math.random()*9000)); } while (state.cia_users.some(u=>u.secretCode===v) || Object.values(SYSTEM).includes(v)); return v; }
function publicCode(r) { const p=rank(r)==='CIA CHIEF'?'CHIEF':rank(r)==='SUPREME COMMANDER'?'SC':rank(r)==='HIGH COMMANDER'?'HC':'AG'; let v; do v=`${p}-${Math.floor(100+Math.random()*900)}`; while(state.cia_users.some(u=>u.publicCode===v)); return v; }
function salary(u) { const b=bank(u); if (b.frozen || b.salaryEnabled === false || !u.online || !u.lastLoginAt) return null; if (b.lastSalaryAt && Date.now()-new Date(b.lastSalaryAt).getTime() < 86400000) return null; b.balance += Math.max(0, Math.floor(Number(b.salary)||0)); b.lastSalaryAt=now(); save(); return b.salary; }

app.get('/api/state', (req,res)=>res.json({ok:true,state:snapshot(null)}));

io.on('connection', socket => {
  socket.emit('state:update', snapshot(null));
  socket.on('shared:data:seed', (data, cb) => { if (!data || typeof data !== 'object') return no(cb,'بيانات غير صالحة.'); for (const k of ['cia_chats','cia_reports','cia_cases','cia_map_locations','cia_hq_locations']) if (data[k] !== undefined) state[k]=data[k]; save(); emitState(); return ok(cb); });
  socket.on('shared:data:set', (p, cb) => { const allowed=['cia_chats','cia_reports','cia_cases','cia_map_locations','cia_hq_locations']; if (!allowed.includes(p?.key)) return no(cb,'نوع البيانات غير مسموح.'); state[p.key]=p.value; save(); io.emit('shared:data:update',{key:p.key,value:p.value}); emitState(); return ok(cb); });

  socket.on('account:create', (p, cb) => { const loginName=text(p?.loginName,100), password=String(p?.password||''), name=text(p?.characterName,120), initialCode=text(p?.characterCode||SYSTEM.memberRequestCode,100); if (!loginName || password.length<4 || !name) return no(cb,'أكمل بيانات إنشاء الحساب.'); if (state.cia_accounts.some(a=>lower(a.loginName)===lower(loginName))) return no(cb,'اسم تسجيل الدخول مستخدم بالفعل.'); if (state.cia_accounts.some(a=>lower(a.pendingPrimary?.name)===lower(name)) || state.cia_users.some(u=>lower(u.name)===lower(name))) return no(cb,'اسم الشخصية مستخدم بالفعل.'); const account={id:id('ACCT'),loginName,passwordHash:hash(password),createdAt:now(),status:'PENDING_APPROVAL',pendingPrimary:{name,initialCode,createdAt:now()}}; state.cia_accounts.push(account); const q={id:id('REQ'),accountId:account.id,name,initialCode,createdAt:now(),status:'PENDING'}; state.cia_queue.push(q); audit('إنشاء حساب',null,null,`تم إنشاء الحساب ${loginName}.`); save(); emitState(); for (const s of io.sockets.sockets.values()) if (chief(s.userId?byId(s.userId):null)) s.emit('join:request:new',q); return ok(cb,{account:{id:account.id,loginName},pending:true,message:'تم إرسال الطلب إلى CIA CHIEF.'}); });
  socket.on('auth:claimChief',(p,cb)=>{ if (state.cia_users.some(chief)) return no(cb,'يوجد CIA CHIEF بالفعل.'); if (text(p?.registrationCode)!==SYSTEM.chiefRegistrationCode || text(p?.officialCode)!==SYSTEM.chiefSaveCode) return no(cb,'رمز تأسيس القيادة غير صحيح.'); const code=text(p?.code,100); if (code.length<4 || code===SYSTEM.memberRequestCode) return no(cb,'كود القيادة غير صالح.'); const u=normalizeUser({id:id('CHIEF'),name:text(p?.name,120),secretCode:code,publicCode:'CHIEF-01',rank:'CIA CHIEF',identityRequired:true,hobbies:text(p?.hobbies,1000),bank:{balance:0,salary:SYSTEM.defaultSalary}}); state.cia_users.push(u); login(socket,u); return ok(cb,{user:publicUser(u,u),needsIdentity:true}); });
  socket.on('auth:login',(p,cb)=>{ const u=findUser(p?.name,p?.code); if (!u) return no(cb,'الاسم أو كود الدخول غير متطابقين.'); login(socket,u); salary(u); return ok(cb,{user:publicUser(u,u),needsIdentity:u.identityRequired!==false&&!u.identity}); });
  socket.on('character:login',(p,cb)=>{ const u=findUser(p?.name,p?.code||p?.secretCode); if (!u) return no(cb,'اسم الشخصية أو كود الدخول غير صحيح.'); login(socket,u); salary(u); return ok(cb,{user:publicUser(u,u),needsIdentity:u.identityRequired!==false&&!u.identity}); });
  socket.on('join:request',(p,cb)=>{ const a=state.cia_accounts.find(x=>lower(x.pendingPrimary?.name)===lower(p?.name)); if (!a) return no(cb,'لا يوجد حساب بهذه الشخصية.'); if (state.cia_queue.some(q=>q.accountId===a.id)) return ok(cb,{message:'يوجد طلب معلق بالفعل.'}); const q={id:id('REQ'),accountId:a.id,name:a.pendingPrimary.name,initialCode:a.pendingPrimary.initialCode,createdAt:now(),status:'PENDING'}; state.cia_queue.push(q); save(); emitState(); return ok(cb,{request:q}); });
  socket.on('admin:action',(p,cb)=>{ const actor=logged(socket); if (!chief(actor)) return no(cb,'هذه الصلاحية متاحة للقائد فقط.'); const q=state.cia_queue.find(x=>x.id===text(p?.requestId,120)); if (!q) return no(cb,'طلب القبول غير موجود.'); if (text(p?.action).toLowerCase()==='reject') { state.cia_queue=state.cia_queue.filter(x=>x.id!==q.id); save(); emitState(); return ok(cb,{action:'reject'}); } const a=state.cia_accounts.find(x=>x.id===q.accountId); if (!a) return no(cb,'الحساب غير موجود.'); let u=state.cia_users.find(x=>x.accountId===a.id&&x.characterType==='main'); const sc=u?.secretCode||secretCode(); if (!u) { u=normalizeUser({id:id('AGENT'),accountId:a.id,characterOwnerId:a.id,name:q.name,secretCode:sc,publicCode:publicCode('AGENT'),rank:'AGENT',identityRequired:true}); state.cia_users.push(u); } a.status='APPROVED'; a.pendingPrimary.secretCode=sc; state.cia_queue=state.cia_queue.filter(x=>x.id!==q.id); audit('اعتماد عضو',actor,u,'تم اعتماد العضو.'); save(); emitState(); return ok(cb,{action:'approve',user:publicUser(u,actor),secretCode:sc}); });
  socket.on('member:saveIdentity',(p,cb)=>{ const u=logged(socket), x=p?.identity||{}; if (!u) return no(cb,'يجب تسجيل الدخول أولاً.'); if (!text(x.fullName)||!text(x.birthDate)||!text(x.nationality)) return no(cb,'الاسم وتاريخ الميلاد والجنسية إلزامية.'); u.identity={fullName:text(x.fullName,200),birthDate:text(x.birthDate,50),nationality:text(x.nationality,100),height:text(x.height,50),bloodType:text(x.bloodType,50),occupation:text(x.occupation,150),notes:text(x.notes,2000)}; u.identityRequired=false; save(); emitState(); return ok(cb,{user:publicUser(u,u),identity:u.identity}); });
  socket.on('character:list',(p,cb)=>{ const u=logged(socket); if (!u) return no(cb,'يجب تسجيل الدخول أولاً.'); return ok(cb,{characters:state.cia_users.filter(x=>x.accountId===u.accountId||x.characterOwnerId===u.characterOwnerId).map(x=>publicUser(x,u))}); });
  socket.on('character:request',(p,cb)=>{ const u=logged(socket); if(!u) return no(cb,'يجب تسجيل الدخول أولاً.'); const q={id:id('CHARREQ'),accountId:u.accountId||u.id,ownerId:u.accountId||u.id,name:text(p?.name,120),createdAt:now(),status:'PENDING'}; if(!q.name)return no(cb,'اكتب اسم الشخصية الجديدة.'); if(chief(u)){const n=normalizeUser({id:id('AGENT'),accountId:q.accountId,characterOwnerId:q.ownerId,characterType:'secondary',name:q.name,secretCode:secretCode(),publicCode:publicCode('AGENT'),rank:'AGENT',identityRequired:true});state.cia_users.push(n);save();emitState();return ok(cb,{direct:true,user:publicUser(n,u),secretCode:n.secretCode});} state.cia_character_queue.push(q);save();emitState();return ok(cb,{request:q}); });
  socket.on('bank:get',(p,cb)=>{const u=logged(socket);if(!u)return no(cb,'يجب تسجيل الدخول أولاً.');const target=p?.code&&p.code!==u.publicCode?byCode(p.code):u;if(!target||(!chief(u)&&target.id!==u.id))return no(cb,'لا تملك الصلاحية.');return ok(cb,{self:publicUser(u,u),target:publicUser(target,u),users:chief(u)?state.cia_users.map(x=>publicUser(x,u)):[]});});
  socket.on('bank:setAccount',(p,cb)=>{const u=logged(socket);if(!u)return no(cb,'يجب تسجيل الدخول أولاً.');const n=text(p?.accountNumber,60).replace(/\s/g,'');if(!/^[A-Za-z0-9-]{4,60}$/.test(n))return no(cb,'رقم الحساب غير صالح.');if(state.cia_users.some(x=>x.id!==u.id&&x.bankAccount===n))return no(cb,'رقم الحساب مستخدم.');u.bankAccount=n;save();emitState();return ok(cb,{self:publicUser(u,u)});});
  socket.on('bank:setSalary',(p,cb)=>{const a=logged(socket),t=byCode(p?.targetCode||a?.publicCode),amount=Math.floor(Number(p?.amount));if(!a||!t||!chief(a)||!Number.isFinite(amount)||amount<0)return no(cb,'لا تملك الصلاحية أو المبلغ غير صالح.');bank(t).salary=amount;save();emitState();return ok(cb,{target:publicUser(t,a),amount});});
  socket.on('bank:setRankSalary',(p,cb)=>{const a=logged(socket),amount=Math.floor(Number(p?.amount)),r=rank(p?.rank);if(!a||(!chief(a)&&!senior(a)&&!high(a))||!Number.isFinite(amount)||amount<0)return no(cb,'لا تملك الصلاحية أو المبلغ غير صالح.');if(!chief(a)&&r!=='AGENT')return no(cb,'يمكن تعديل راتب Agent فقط.');state.cia_users.filter(x=>rank(x.rank)===r).forEach(x=>bank(x).salary=amount);save();emitState();return ok(cb,{rank:r,amount});});
  socket.on('bank:manage',(p,cb)=>{const a=logged(socket),t=byCode(p?.targetCode);if(!a||!chief(a)||!t)return no(cb,'لا تملك الصلاحية أو العضو غير موجود.');const b=bank(t),action=text(p?.action,50);if(action==='freeze')b.frozen=true;else if(action==='unfreeze')b.frozen=false;else if(action==='stop-salary')b.salaryEnabled=false;else if(action==='start-salary')b.salaryEnabled=true;else if(action==='deduct'){const n=Math.floor(Number(p?.amount));if(!Number.isFinite(n)||n<=0)return no(cb,'قيمة الخصم غير صالحة.');b.balance=Math.max(0,b.balance-n);}else return no(cb,'الإجراء غير معروف.');save();emitState();return ok(cb,{action,target:publicUser(t,a)});});
  socket.on('bank:withdraw',(p,cb)=>{const u=logged(socket),n=Math.floor(Number(p?.amount));if(!u||!Number.isFinite(n)||n<=0)return no(cb,'قيمة السحب غير صالحة.');const b=bank(u);if(b.frozen)return no(cb,'الحساب مجمد.');if(n>b.balance)return no(cb,'الرصيد غير كافٍ.');b.balance-=n;save();emitState();return ok(cb,{self:publicUser(u,u),amount:n});});
  socket.on('bank:paySalary',(p,cb)=>{const a=logged(socket),t=byCode(p?.targetCode);if(!a||(!chief(a)&&!senior(a))||!t)return no(cb,'لا تملك الصلاحية.');const n=salary(t);if(n===null)return no(cb,'لا يمكن صرف الراتب الآن.');save();emitState();return ok(cb,{amount:n,target:publicUser(t,a)});});
  socket.on('radio:join',(p,cb)=>{const u=logged(socket);if(!u)return no(cb,'يجب تسجيل الدخول أولاً.');const c=text(p?.channel||'CH-1',50);for(const set of radio.values())set.delete(socket.id);if(!radio.has(c))radio.set(c,new Set());radio.get(c).add(socket.id);u.radioChannel=c;u.radioOnline=true;save();return ok(cb,{channel:c,online:true});});
  for (const event of ['radio:text','radio:code']) socket.on(event,(p,cb)=>{const u=logged(socket);if(!u)return no(cb,'يجب تسجيل الدخول أولاً.');const c=text(p?.channel||u.radioChannel||'CH-1',50),data={...p,channel:c,userCode:u.publicCode,userName:'',at:now()};for(const sid of radio.get(c)||[])io.sockets.sockets.get(sid)?.emit(event,data);return ok(cb,{message:data});});
  for (const event of ['radio:ptt:start','radio:ptt:stop']) socket.on(event,(p,cb)=>{const u=logged(socket);if(!u)return no(cb,'يجب تسجيل الدخول أولاً.');const data={channel:text(p?.channel||u.radioChannel||'CH-1',50),userCode:u.publicCode,speaking:event.endsWith('start')};for(const sid of radio.get(data.channel)||[])io.sockets.sockets.get(sid)?.emit('radio:state',data);return ok(cb,data);});
  socket.on('sos:broadcast',(p,cb)=>{const u=logged(socket);if(!u)return no(cb,'يجب تسجيل الدخول أولاً.');const alert={id:id('SOS'),userCode:u.publicCode,text:text(p?.text,3000),at:now(),status:'OPEN'};state.cia_sos.push(alert);state.cia_sos=state.cia_sos.slice(-300);save();io.emit('sos:alert',alert);emitState();return ok(cb,{alert});});
  socket.on('logout',cb=>{logout(socket);return ok(cb);});
  socket.on('disconnect',()=>{for(const set of radio.values())set.delete(socket.id);logout(socket);});
});

setInterval(()=>{let changed=false;for(const u of state.cia_users)if(u.online&&salary(u)!==null)changed=true;if(changed){save();emitState();}},60000);
app.use((req,res)=>res.status(404).json({ok:false,error:'NOT_FOUND'}));
app.use((err,req,res,next)=>{console.error(err);if(!res.headersSent)res.status(500).json({ok:false,error:'INTERNAL_SERVER_ERROR'});else next(err);});
save();
server.listen(PORT,()=>console.log(`BLACK RIDGE CIA listening on port ${PORT}`));
