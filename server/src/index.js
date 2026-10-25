// CELESTA 온라인 서버
// Worker: HTTP API(/api)와 WebSocket(/ws) 입구
// Directory(전역 1개): 계정·세션·저장·친구·초대·개인 서버·접속 상태·순위
// Room(서버마다 1개): 접속자 위치 중계, 공유 월드(파낸 칸), 상자 선점, 채팅
import { DurableObject } from 'cloudflare:workers';

const W = 52, H = 340, TS = 32;
const PUB_MAX = 40, PUB_ROOMS = 9, MAX_OWN_SERVERS = 3;
const TOKEN_DAYS = 30, MAX_TOKENS = 5, PBKDF2_IT = 10000;
const NAME_RE = /^[A-Za-z0-9_가-힣]{3,16}$/;
const COLORS = ['#ff6b6b', '#ffb347', '#ffe066', '#7bd389', '#4ecdc4', '#5fa8ff', '#a78bfa', '#f78fb3', '#e0e0e0', '#c9a227'];
const BAD_WORDS = ['시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '개새끼', '좆', '존나', 'fuck', 'shit', 'bitch'];

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json;charset=utf-8', ...CORS } });
const fail = code => json({ ok: false, error: code });
const low = s => String(s || '').trim().toLowerCase();
const colorOf = name => { let h = 0; for (const ch of low(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
// 모든 서버의 지형은 10분마다 새로 생긴다(다 캐도 다시 놀 수 있게). 시각 기준이라 방마다 같은 때 바뀐다
const RESET_MS = 10 * 60000;
const epochNo = (t = Date.now()) => Math.floor(t / RESET_MS), nextReset = () => (epochNo() + 1) * RESET_MS;
function hashSeed(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) % 1e9; }
function cleanText(m) {
  let s = String(m || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  for (const w of BAD_WORDS) s = s.split(w).join('♡'.repeat(w.length));
  return s;
}
async function pbkdf2(pw, salt, pepper, it = PBKDF2_IT) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw + '\u0000' + pepper), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: it }, key, 256));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

// ───────────── Worker 입구 ─────────────
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const dir = env.DIR.get(env.DIR.idFromName('directory'));
    if (url.pathname === '/api' && req.method === 'POST') {
      const body = await req.text();
      if (body.length > 400000) return fail('SAVE_TOO_BIG');
      return dir.fetch('https://dir/api', { method: 'POST', body, headers: { 'X-IP': req.headers.get('CF-Connecting-IP') || '' } });
    }
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426, headers: CORS });
      const a = await (await dir.fetch('https://dir/authorize', { method: 'POST', body: JSON.stringify({ token: url.searchParams.get('token'), user: url.searchParams.get('user'), room: url.searchParams.get('room') }) })).json();
      if (!a.ok) {
        // 브라우저는 업그레이드 전 오류 내용을 읽지 못하므로, 연결을 받은 뒤 이유를 담아 닫는다
        const [c, s] = Object.values(new WebSocketPair()); s.accept(); s.send(JSON.stringify({ t: 'err', e: a.error })); s.close(4000, a.error);
        return new Response(null, { status: 101, webSocket: c });
      }
      const room = env.ROOM.get(env.ROOM.idFromName(a.room.id));
      const h = new Headers(req.headers); h.set('X-Join', JSON.stringify({ user: a.user, room: a.room }));
      return room.fetch(new Request('https://room/ws', { headers: h }));
    }
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, name: 'celesta-online', t: Date.now() });
    return new Response('not found', { status: 404, headers: CORS });
  },
};

// ───────────── Directory ─────────────
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map(); // roomId → { n, names:[low], at }
    this.topCache = null;
    ctx.blockConcurrencyWhile(async () => {
      const rc = await ctx.storage.list({ prefix: 'rc:' });
      for (const [k, v] of rc) this.rooms.set(k.slice(3), v);
    });
  }
  get pepper() { return this.env.PEPPER || ''; }
  async user(name) { return name ? await this.ctx.storage.get('u:' + low(name)) : null; }
  async putUser(u) { await this.ctx.storage.put('u:' + low(u.name), u); }
  roomLive(id) { const r = this.rooms.get(id); return r && Date.now() - r.at < 180000 ? r : null; }
  whereIs(lname) { for (const [id, r] of this.rooms) if (Date.now() - r.at < 180000 && r.names.includes(lname)) return id; return null; }

  async fetch(req) {
    const p = new URL(req.url).pathname;
    try {
      if (p === '/api') return await this.api(JSON.parse(await req.text() || '{}'), req.headers.get('X-IP'));
      if (p === '/authorize') return json(await this.authorize(await req.json()));
      if (p === '/presence') { const b = await req.json(); this.rooms.set(b.room, { n: b.names.length, names: b.names, at: Date.now() }); await this.ctx.storage.put('rc:' + b.room, this.rooms.get(b.room)); return json({ ok: true }); }
      return json({ ok: false }, 404);
    } catch (e) { return json({ ok: false, error: 'SERVER', detail: String(e && e.message || e) }); }
  }

  async session(username, token) {
    if (!token) throw new Error('BAD_TOKEN');
    const t = await this.ctx.storage.get('t:' + token);
    if (!t || t.exp < Date.now() || (username && t.u !== low(username))) throw new Error('BAD_TOKEN');
    const u = await this.user(t.u); if (!u) throw new Error('BAD_TOKEN');
    return u;
  }
  async issueToken(u) {
    const token = randHex(24);
    u.tokens = (u.tokens || []).filter(x => x.exp > Date.now());
    while (u.tokens.length >= MAX_TOKENS) { const old = u.tokens.shift(); await this.ctx.storage.delete('t:' + old.t); }
    const exp = Date.now() + TOKEN_DAYS * 864e5;
    u.tokens.push({ t: token, exp }); await this.ctx.storage.put('t:' + token, { u: low(u.name), exp });
    return token;
  }
  async newUser(name, pw) {
    const salt = randHex(16);
    return { name, salt, hash: await pbkdf2(pw, salt, this.pepper), it: PBKDF2_IT, created: Date.now(), last: Date.now(), color: colorOf(name),
      friends: [], reqIn: [], reqOut: [], invites: [], servers: [], tokens: [], fails: [], gold: 0, opened: 0, deepest: 0 };
  }
  async sheets(action, payload) {
    if (!this.env.SHEETS_API) return null;
    try {
      const r = await fetch(this.env.SHEETS_API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...payload }), redirect: 'follow' });
      return await r.json();
    } catch (e) { return null; }
  }
  async push(lname, msg) {
    const room = this.whereIs(lname); if (!room) return;
    try { await this.env.ROOM.get(this.env.ROOM.idFromName(room)).fetch('https://room/push', { method: 'POST', body: JSON.stringify({ to: lname, msg }) }); } catch (e) { }
  }
  roomInfo(id, srv) {
    const r = this.roomLive(id);
    if (id.startsWith('pub-')) return { id, kind: 'pub', name: `공개 ${id.slice(4)}`, n: r ? r.n : 0, max: PUB_MAX };
    if (id.startsWith('d-')) return { id, kind: 'dun', name: srv ? srv.name : '토벌대', owner: srv ? srv.owner : '', boss: srv ? srv.boss : 0, size: srv ? srv.size : 1, n: r ? r.n : 0, max: 8 };
    return { id, kind: 'prv', name: srv ? srv.name : '개인 서버', owner: srv ? srv.ownerName : '', n: r ? r.n : 0, max: PUB_MAX };
  }

  async authorize({ token, user, room }) {
    let u; try { u = await this.session(user, token); } catch (e) { return { ok: false, error: 'BAD_TOKEN' }; }
    const me = { name: u.name, color: u.color || colorOf(u.name) };
    const prev = this.whereIs(low(u.name));
    if (prev) { try { await this.env.ROOM.get(this.env.ROOM.idFromName(prev)).fetch('https://room/push', { method: 'POST', body: JSON.stringify({ drop: low(u.name) }) }); } catch (e) { } }
    if (!room || room === 'pub') {
      for (let i = 1; i <= PUB_ROOMS; i++) { const id = 'pub-' + i, r = this.roomLive(id); if (!r || r.n < PUB_MAX || r.names.includes(low(u.name))) return { ok: true, user: me, room: this.roomInfo(id) }; }
      return { ok: false, error: 'FULL' };
    }
    if (/^pub-[1-9]$/.test(room)) { const r = this.roomLive(room); if (r && r.n >= PUB_MAX && !r.names.includes(low(u.name))) return { ok: false, error: 'FULL' }; return { ok: true, user: me, room: this.roomInfo(room) }; }
    const srv = await this.ctx.storage.get('srv:' + room);
    if (!srv) return { ok: false, error: 'NO_SERVER' };
    if (srv.owner !== low(u.name) && !srv.members.includes(low(u.name))) return { ok: false, error: 'NOT_INVITED' };
    const r = this.roomLive(room); if (r && r.n >= PUB_MAX && !r.names.includes(low(u.name))) return { ok: false, error: 'FULL' };
    return { ok: true, user: me, room: { ...this.roomInfo(room, srv), owner: srv.owner, seed: srv.seed } };
  }

  async api(b, ip) {
    const A = b.action;
    if (A === 'ping') { let n = 0; for (const [, r] of this.rooms) if (Date.now() - r.at < 180000) n += r.n; return json({ ok: true, server: 'celesta-online', online: n }); }

    if (A === 'signup') {
      const name = String(b.username || '').trim(), pw = String(b.password || '');
      if (!NAME_RE.test(name)) return fail('INVALID_ID');
      if (pw.length < 6 || pw.length > 64) return fail('WEAK_PW');
      if (await this.user(name)) return fail('USER_EXISTS');
      const u = await this.newUser(name, pw); const token = await this.issueToken(u); await this.putUser(u);
      return json({ ok: true, username: u.name, token });
    }

    if (A === 'login') {
      const name = String(b.username || '').trim(), pw = String(b.password || '');
      let u = await this.user(name);
      if (!u) {
        // 처음 보는 아이디 → 예전 구글 시트 서버에 물어보고 맞으면 옮겨 온다
        const r = await this.sheets('login', { username: name, password: pw });
        if (!r || !r.ok) return fail(r && r.error === 'TOO_MANY' ? 'TOO_MANY' : 'BAD_LOGIN');
        u = await this.newUser(r.username || name, pw);
        const l = await this.sheets('load', { username: r.username || name, token: r.token });
        if (l && l.ok && l.data) await this.ctx.storage.put('save:' + low(u.name), { data: l.data, at: l.savedAt || Date.now() });
        await this.sheets('logout', { username: r.username || name, token: r.token });
        const token = await this.issueToken(u); await this.putUser(u);
        const sv = await this.ctx.storage.get('save:' + low(u.name));
        return json({ ok: true, username: u.name, token, savedAt: sv ? sv.at : 0, migrated: true });
      }
      u.fails = (u.fails || []).filter(t => Date.now() - t < 600000);
      if (u.fails.length >= 5) return fail('TOO_MANY');
      const h = await pbkdf2(pw, u.salt, this.pepper, u.it || PBKDF2_IT);
      if (!same(h, u.hash)) { u.fails.push(Date.now()); await this.putUser(u); return fail('BAD_LOGIN'); }
      u.fails = []; u.last = Date.now();
      const token = await this.issueToken(u); await this.putUser(u);
      const sv = await this.ctx.storage.get('save:' + low(u.name));
      return json({ ok: true, username: u.name, token, savedAt: sv ? sv.at : 0 });
    }

    // 여기부터는 로그인한 사람만
    let u; try { u = await this.session(b.username, b.token); } catch (e) { return fail('BAD_TOKEN'); }
    const me = low(u.name);

    if (A === 'logout') { u.tokens = (u.tokens || []).filter(x => x.t !== b.token); await this.ctx.storage.delete('t:' + b.token); await this.putUser(u); return json({ ok: true }); }
    if (A === 'save') {
      const data = String(b.data || ''); if (data.length > 300000) return fail('SAVE_TOO_BIG');
      const at = Date.now(); await this.ctx.storage.put('save:' + me, { data, at });
      const m = b.meta || {}; u.gold = Math.max(0, +m.gold || 0); u.opened = Math.max(0, +m.opened || 0); u.deepest = Math.max(u.deepest || 0, +m.deepest || 0);
      await this.putUser(u); return json({ ok: true, savedAt: at });
    }
    if (A === 'load') { const sv = await this.ctx.storage.get('save:' + me); return json({ ok: true, data: sv ? sv.data : null, savedAt: sv ? sv.at : 0 }); }

    if (A === 'social') return json({ ok: true, ...(await this.social(u)) });

    if (A === 'friend_req') {
      const to = await this.user(b.to); if (!to) return fail('NO_USER');
      const t = low(to.name); if (t === me) return fail('SELF');
      if (u.friends.includes(t)) return fail('ALREADY');
      if (u.reqIn.includes(t)) return this.befriend(u, to); // 서로 신청하면 바로 친구
      if (!u.reqOut.includes(t)) u.reqOut.push(t);
      if (!to.reqIn.includes(me)) to.reqIn.push(me);
      to.reqIn = to.reqIn.slice(-50); await this.putUser(u); await this.putUser(to);
      await this.push(t, { t: 'note', k: 'freq', from: u.name });
      return json({ ok: true, ...(await this.social(u)) });
    }
    if (A === 'friend_accept') { const f = await this.user(b.from); if (!f || !u.reqIn.includes(low(f.name))) return fail('NO_REQUEST'); return this.befriend(u, f); }
    if (A === 'friend_decline' || A === 'friend_cancel' || A === 'friend_remove') {
      const o = await this.user(b.name); if (!o) return fail('NO_USER'); const t = low(o.name);
      const rm = (a, x) => a.filter(y => y !== x);
      u.reqIn = rm(u.reqIn, t); u.reqOut = rm(u.reqOut, t); o.reqIn = rm(o.reqIn, me); o.reqOut = rm(o.reqOut, me);
      if (A === 'friend_remove') { u.friends = rm(u.friends, t); o.friends = rm(o.friends, me); }
      await this.putUser(u); await this.putUser(o); return json({ ok: true, ...(await this.social(u)) });
    }

    if (A === 'servers') {
      const pub = []; for (let i = 1; i <= PUB_ROOMS; i++) { const info = this.roomInfo('pub-' + i); if (i <= 2 || info.n) pub.push(info); }
      if (pub.every(r => r.n >= PUB_MAX) && pub.length < PUB_ROOMS) pub.push(this.roomInfo('pub-' + (pub.length + 1)));
      const mine = [], shared = [];
      for (const id of u.servers) { const s = await this.ctx.storage.get('srv:' + id); if (s) mine.push({ ...this.roomInfo(id, s), code: s.code, members: s.members.length }); }
      for (const id of (u.joined || [])) { const s = await this.ctx.storage.get('srv:' + id); if (s && s.members.includes(me)) shared.push(this.roomInfo(id, s)); }
      return json({ ok: true, pub, mine, shared });
    }
    if (A === 'create_server') {
      const name = cleanText(b.name).slice(0, 20) || `${u.name}의 발굴지`;
      u.servers = u.servers || []; if (u.servers.length >= MAX_OWN_SERVERS) return fail('TOO_MANY_SERVERS');
      const id = 'p-' + randHex(6), code = await this.newCode();
      const srv = { id, name, owner: me, ownerName: u.name, members: [], code, seed: Math.floor(Math.random() * 1e9), created: Date.now() };
      await this.ctx.storage.put('srv:' + id, srv); await this.ctx.storage.put('code:' + code, id);
      u.servers.push(id); await this.putUser(u);
      return json({ ok: true, server: { ...this.roomInfo(id, srv), code } });
    }
    if (['rename_server', 'delete_server', 'regen_code', 'kick'].includes(A)) {
      const srv = await this.ctx.storage.get('srv:' + b.room); if (!srv || srv.owner !== me) return fail('NOT_OWNER');
      if (A === 'rename_server') { srv.name = cleanText(b.name).slice(0, 20) || srv.name; await this.ctx.storage.put('srv:' + srv.id, srv); }
      if (A === 'regen_code') { await this.ctx.storage.delete('code:' + srv.code); srv.code = await this.newCode(); await this.ctx.storage.put('code:' + srv.code, srv.id); await this.ctx.storage.put('srv:' + srv.id, srv); }
      if (A === 'kick') {
        const t = low(b.name); srv.members = srv.members.filter(x => x !== t); await this.ctx.storage.put('srv:' + srv.id, srv);
        try { await this.env.ROOM.get(this.env.ROOM.idFromName(srv.id)).fetch('https://room/push', { method: 'POST', body: JSON.stringify({ kick: t }) }); } catch (e) { }
      }
      if (A === 'delete_server') {
        try { await this.env.ROOM.get(this.env.ROOM.idFromName(srv.id)).fetch('https://room/push', { method: 'POST', body: JSON.stringify({ wipe: 1 }) }); } catch (e) { }
        await this.ctx.storage.delete(['srv:' + srv.id, 'code:' + srv.code, 'rc:' + srv.id]); this.rooms.delete(srv.id);
        u.servers = u.servers.filter(x => x !== srv.id); await this.putUser(u);
      }
      return json({ ok: true, server: A === 'delete_server' ? null : { ...this.roomInfo(srv.id, srv), code: srv.code, members: srv.members.length } });
    }
    if (A === 'invite') {
      const srv = await this.ctx.storage.get('srv:' + b.room); if (!srv) return fail('NO_SERVER');
      if (srv.owner !== me && !srv.members.includes(me)) return fail('NOT_OWNER');
      const to = await this.user(b.to); if (!to) return fail('NO_USER'); const t = low(to.name);
      if (t !== srv.owner && !srv.members.includes(t)) srv.members.push(t);
      await this.ctx.storage.put('srv:' + srv.id, srv);
      to.joined = [...new Set([...(to.joined || []), srv.id])].slice(-20);
      to.invites = [{ room: srv.id, name: srv.name, from: u.name, at: Date.now() }, ...(to.invites || []).filter(i => i.room !== srv.id)].slice(0, 20);
      await this.putUser(to);
      await this.push(t, { t: 'note', k: 'invite', from: u.name, room: srv.id, name: srv.name });
      return json({ ok: true });
    }
    if (A === 'join_code') {
      const id = await this.ctx.storage.get('code:' + String(b.code || '').trim().toUpperCase()); if (!id) return fail('BAD_CODE');
      const srv = await this.ctx.storage.get('srv:' + id); if (!srv) return fail('BAD_CODE');
      if (srv.owner !== me && !srv.members.includes(me)) { srv.members.push(me); await this.ctx.storage.put('srv:' + id, srv); }
      u.joined = [...new Set([...(u.joined || []), id])].slice(-20); await this.putUser(u);
      return json({ ok: true, server: this.roomInfo(id, srv) });
    }
    if (A === 'dismiss_invite') { u.invites = (u.invites || []).filter(i => i.room !== b.room); await this.putUser(u); return json({ ok: true }); }
    if (A === 'top') return json({ ok: true, top: await this.top() });
    if (A === 'party_create') {
      // 보스 토벌대: 파티장 + 초대한 사람만 들어오는 임시 방. 초대받은 사람에게는 바로 알림이 간다
      const boss = Math.max(0, Math.min(9, b.boss | 0)), names = [...new Set((b.invite || []).map(low))].filter(x => x && x !== me).slice(0, 7);
      const id = 'd-' + randHex(6), bossName = String(b.bossName || '').slice(0, 20);
      const srv = { id, kind: 'dun', boss, name: `${u.name}의 토벌대`, owner: me, ownerName: u.name, members: names, size: names.length + 1, seed: Math.floor(Math.random() * 1e9), created: Date.now() };
      await this.ctx.storage.put('srv:' + id, srv);
      for (const t of names) await this.push(t, { t: 'note', k: 'party', from: u.name, room: id, boss });
      return json({ ok: true, room: id, size: srv.size });
    }
    if (A === 'delete_account') {
      if (!same(await pbkdf2(String(b.password || ''), u.salt, this.pepper, u.it || PBKDF2_IT), u.hash)) return fail('BAD_LOGIN');
      for (const id of u.servers || []) { const srv = await this.ctx.storage.get('srv:' + id); if (srv) await this.ctx.storage.delete(['srv:' + id, 'code:' + srv.code, 'rc:' + id]); try { await this.env.ROOM.get(this.env.ROOM.idFromName(id)).fetch('https://room/push', { method: 'POST', body: JSON.stringify({ wipe: 1 }) }); } catch (e) { } }
      for (const ln of new Set([...u.friends, ...u.reqIn, ...u.reqOut])) { const o = await this.user(ln); if (!o) continue; const rm = x => x.filter(y => y !== me); o.friends = rm(o.friends); o.reqIn = rm(o.reqIn); o.reqOut = rm(o.reqOut); await this.putUser(o); }
      await this.ctx.storage.delete([...(u.tokens || []).map(x => 't:' + x.t), 'u:' + me, 'save:' + me]);
      this.topCache = null; return json({ ok: true });
    }
    return fail('UNKNOWN_ACTION');
  }
  async newCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) { const c = [...crypto.getRandomValues(new Uint8Array(6))].map(x => abc[x % abc.length]).join(''); if (!(await this.ctx.storage.get('code:' + c))) return c; }
  }
  async befriend(u, f) {
    const a = low(u.name), b = low(f.name), rm = (x, y) => x.filter(z => z !== y);
    u.reqIn = rm(u.reqIn, b); u.reqOut = rm(u.reqOut, b); f.reqIn = rm(f.reqIn, a); f.reqOut = rm(f.reqOut, a);
    if (!u.friends.includes(b)) u.friends.push(b); if (!f.friends.includes(a)) f.friends.push(a);
    await this.putUser(u); await this.putUser(f);
    await this.push(b, { t: 'note', k: 'friend', from: u.name });
    return json({ ok: true, ...(await this.social(u)) });
  }
  async social(u) {
    const view = async ln => {
      const o = await this.user(ln); if (!o) return null;
      const room = this.whereIs(ln); let roomInfo = null;
      if (room) { const srv = room.startsWith('p-') ? await this.ctx.storage.get('srv:' + room) : null; roomInfo = this.roomInfo(room, srv); roomInfo.canJoin = room.startsWith('pub-') || !!(srv && (srv.owner === low(u.name) || srv.members.includes(low(u.name)))); }
      return { name: o.name, color: o.color || colorOf(o.name), online: !!room, room: roomInfo, last: o.last, deepest: o.deepest || 0 };
    };
    const friends = (await Promise.all(u.friends.map(view))).filter(Boolean).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    const names = async arr => (await Promise.all(arr.map(async x => { const o = await this.user(x); return o && o.name; }))).filter(Boolean);
    return { me: u.name, color: u.color || colorOf(u.name), friends, reqIn: await names(u.reqIn), reqOut: await names(u.reqOut), invites: u.invites || [] };
  }
  async top() {
    if (this.topCache && Date.now() - this.topCache.at < 60000) return this.topCache.list;
    const all = []; for (const [, u] of await this.ctx.storage.list({ prefix: 'u:' })) all.push({ name: u.name, color: u.color || colorOf(u.name), gold: u.gold || 0, opened: u.opened || 0, deepest: u.deepest || 0 });
    const by = k => [...all].sort((a, b) => b[k] - a[k]).slice(0, 20);
    const list = { gold: by('gold'), opened: by('opened'), deepest: by('deepest') };
    this.topCache = { at: Date.now(), list }; return list;
  }
}

// ───────────── Room ─────────────
// 위치는 받는 즉시 같은 방 사람들에게 그대로 돌려보낸다(서버 틱 대기 없음 → 지연 최소)
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pos = new Map();    // 접속 id → 마지막 위치 배열
    this.rate = new Map();   // 접속 id → 채팅 제한 상태
    this.mods = new Set();   // 비어 버린 칸 번호(파낸 흙, 열린 상자)
    this.dirty = new Set();  // 저장 안 된 묶음 번호
    ctx.blockConcurrencyWhile(async () => {
      this.meta = await ctx.storage.get('meta') || null;
      this.seed = await ctx.storage.get('seed');
      this.epoch = await ctx.storage.get('epoch'); this.base = await ctx.storage.get('base'); this.warned = '';
      this.chat = await ctx.storage.get('chat') || [];
      for (const [, arr] of await ctx.storage.list({ prefix: 'm:' })) for (const i of arr) this.mods.add(i);
      this.nextId = 1; for (const ws of ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.id >= this.nextId) this.nextId = a.id + 1; }
    });
  }
  sockets() { return this.ctx.getWebSockets().filter(ws => { if (ws.readyState !== 1) return false; const a = ws.deserializeAttachment(); return a && !a.gone; }); }
  send(ws, o) { try { ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) { } }
  bcast(o, except) { const s = typeof o === 'string' ? o : JSON.stringify(o); for (const ws of this.sockets()) if (ws !== except) this.send(ws, s); }
  players() { return this.sockets().map(ws => { const a = ws.deserializeAttachment(); return { id: a.id, name: a.name, color: a.color, d: this.pos.get(a.id) || null }; }); }
  async ensureWorld(info) {
    if (!this.meta || (info && (this.meta.name !== info.name || this.meta.owner !== info.owner || this.meta.size !== info.size))) { this.meta = { id: info.id, kind: info.kind, name: info.name, owner: info.owner || null, ...(info.kind === 'dun' ? { boss: info.boss | 0, size: info.size | 0 } : {}) }; await this.ctx.storage.put('meta', this.meta); }
    if (this.base == null) { this.base = this.meta.kind === 'pub' ? hashSeed(this.meta.id) : info && info.seed != null ? info.seed : Math.floor(Math.random() * 1e9); await this.ctx.storage.put('base', this.base); }
    const ep = epochNo();
    if (this.epoch !== ep) { this.epoch = ep; this.seed = hashSeed(this.base + ':' + ep); await this.resetMods(); await this.ctx.storage.put({ epoch: ep, seed: this.seed }); return true; }
    return false;
  }
  // 다음 알람: 1분마다 접속 상태 갱신 · 리셋 1분 전/10초 전 예고 · 리셋 시각
  async schedule() {
    const now = Date.now(), nr = nextReset(), c = [now + 60000, nr - 60000, nr - 10000, nr + 200].filter(x => x > now + 300);
    await this.ctx.storage.setAlarm(Math.min(...c));
  }
  async resetMods() { this.mods.clear(); this.dirty.clear(); const keys = [...(await this.ctx.storage.list({ prefix: 'm:' })).keys()]; for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128)); }
  markMod(i) { this.mods.add(i); this.dirty.add(Math.floor(i / 512)); this.ctx.storage.getAlarm().then(a => { if (!a || a > Date.now() + 5000) this.ctx.storage.setAlarm(Date.now() + 3000); }); }
  async flush() {
    if (!this.dirty.size) return;
    const out = {}; for (const c of this.dirty) out['m:' + c] = [...this.mods].filter(i => Math.floor(i / 512) === c);
    this.dirty.clear(); await this.ctx.storage.put(out);
  }
  async report() {
    if (!this.meta) return;
    const names = [...new Set(this.sockets().map(ws => low(ws.deserializeAttachment().name)))];
    try { await this.env.DIR.get(this.env.DIR.idFromName('directory')).fetch('https://dir/presence', { method: 'POST', body: JSON.stringify({ room: this.meta.id, names }) }); } catch (e) { }
  }
  async alarm() {
    await this.flush();
    if (this.meta) {
      if (await this.ensureWorld()) this.bcast({ t: 'world', seed: this.seed, mods: [], resetAt: nextReset(), msg: '10분이 지나 지형이 새로 생겨났어요!' });
      else {
        const left = nextReset() - Date.now();
        for (const s2 of [60, 10]) { const key = this.epoch + ':' + s2; if (left <= s2 * 1000 + 1500 && left > (s2 === 60 ? 11000 : 0) && !this.warned.includes(key)) { this.warned += key + ','; this.bcast({ t: 'sys', k: 'reset', s: Math.round(left / 1000) }); } }
      }
    }
    await this.report();
    if (this.sockets().length) await this.schedule();
  }


  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === '/push') {
      const b = await req.json();
      if (b.wipe) { for (const ws of this.sockets()) { this.send(ws, { t: 'kicked', why: 'deleted' }); ws.close(4004, 'deleted'); } await this.ctx.storage.deleteAll(); this.mods.clear(); this.meta = null; this.seed = null; return json({ ok: true }); }
      for (const ws of this.sockets()) {
        const a = ws.deserializeAttachment();
        if (b.kick && low(a.name) === b.kick) { this.send(ws, { t: 'kicked', why: 'kick' }); ws.close(4001, 'kicked'); await this.leave(ws); }
        if (b.drop && low(a.name) === b.drop) { this.send(ws, { t: 'kicked', why: 'elsewhere' }); ws.close(4002, 'elsewhere'); await this.leave(ws); }
        if (b.to && low(a.name) === b.to) this.send(ws, b.msg);
      }
      if (b.kick || b.drop) await this.report();
      return json({ ok: true });
    }
    if (p !== '/ws') return json({ ok: false }, 404);
    const j = JSON.parse(req.headers.get('X-Join') || '{}');
    if (!j.user || !j.room) return new Response('bad', { status: 400 });
    await this.ensureWorld(j.room);
    // 같은 계정이 다른 곳에서 들어오면 예전 연결을 닫는다
    for (const ws of this.sockets()) if (low(ws.deserializeAttachment().name) === low(j.user.name)) { this.send(ws, { t: 'kicked', why: 'elsewhere' }); ws.close(4002, 'elsewhere'); await this.leave(ws); }
    if (this.sockets().length >= PUB_MAX) { const [c, s] = Object.values(new WebSocketPair()); s.accept(); s.send(JSON.stringify({ t: 'err', e: 'FULL' })); s.close(4003, 'full'); return new Response(null, { status: 101, webSocket: c }); }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const a = { id: this.nextId++, name: j.user.name, color: j.user.color, at: Date.now() };
    server.serializeAttachment(a);
    this.send(server, { t: 'init', me: a.id, room: { ...this.meta, n: this.sockets().length }, seed: this.seed, resetAt: nextReset(), mods: [...this.mods], players: this.players().filter(x => x.id !== a.id), chat: this.chat.slice(-30), now: Date.now() });
    this.bcast({ t: 'join', p: { id: a.id, name: a.name, color: a.color, d: null } }, server);
    await this.report();
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment(); if (!a || typeof raw !== 'string' || raw.length > 2000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    // 위치: [0, x, y, vx, vy, flags, pick] → 그대로 다른 사람에게 [0, id, ...]
    if (Array.isArray(m)) {
      if (m[0] !== 0 || m.length !== 7) return;
      const d = m.slice(1).map(v => Math.round(+v || 0));
      d[0] = Math.max(0, Math.min(W * TS, d[0])); d[1] = Math.max(-200, Math.min(H * TS, d[1]));
      d[2] = Math.max(-2000, Math.min(2000, d[2])); d[3] = Math.max(-3000, Math.min(3000, d[3]));
      this.pos.set(a.id, d);
      this.bcast(JSON.stringify([0, a.id, ...d]), ws);
      return;
    }
    const t = m.t;
    if (t === 'ping') return this.send(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (t === 'dig' || t === 'claim') {
      const i = m.i | 0; if (i < 0 || i >= W * H) return;
      const me = this.pos.get(a.id);
      if (me) { const tx = i % W, ty = Math.floor(i / W), px = (me[0] + 9) / TS, py = (me[1] + 13) / TS; if (Math.abs(tx - px) > 16 || Math.abs(ty - py) > 16) { if (t === 'claim') this.send(ws, { t: 'claim', i, ok: 0 }); return; } }
      if (this.mods.has(i)) { if (t === 'claim') this.send(ws, { t: 'claim', i, ok: 0 }); else this.send(ws, { t: 'dig', i, by: 0 }); return; }
      this.markMod(i);
      if (t === 'claim') this.send(ws, { t: 'claim', i, ok: 1, seed: Math.floor(Math.random() * 2 ** 31) });
      this.bcast({ t: 'dig', i, by: a.id, chest: t === 'claim' ? 1 : 0 }, ws);
      return;
    }
    if (t === 'bs' || t === 'bp' || t === 'bd' || t === 'bx') {
      // 보스 토벌대 중계: 보스 상태·패턴 시작은 파티장만, 피해 알림은 누구나
      if (!this.meta || this.meta.kind !== 'dun') return;
      if ((t === 'bs' || t === 'bp') && this.meta.owner !== low(a.name)) return;
      m.id = a.id; return this.bcast(m, ws);
    }
    if (t === 'fx') {
      const now = Date.now(); if (now - (a.fxAt || 0) < 400) return; a.fxAt = now; ws.serializeAttachment(a);
      return this.bcast({ t: 'fx', id: a.id, c: Math.max(0, Math.min(31, m.c | 0)), d: Math.max(1, Math.min(3, m.d | 0)), f: m.f > 0 ? 1 : -1 }, ws);
    }
    if (t === 'open') {
      const type = String(m.type || '').slice(0, 16), best = Math.max(0, Math.min(10, m.best | 0));
      this.bcast({ t: 'open', i: m.i | 0, by: a.id, name: a.name, type, best });
      return;
    }
    if (t === 'chat' || t === 'emote') {
      const key = t === 'emote' ? -a.id : a.id, r = this.rate.get(key) || { last: 0, burst: [] }, now = Date.now();
      r.burst = r.burst.filter(x => now - x < 10000);
      if (now - r.last < 700 || r.burst.length >= 6) return this.send(ws, { t: 'sys', k: 'slow' });
      r.last = now; r.burst.push(now); this.rate.set(key, r);
      if (t === 'emote') return this.bcast({ t: 'emote', id: a.id, e: Math.max(0, Math.min(7, m.e | 0)) });
      const text = cleanText(m.m); if (!text) return;
      const msg = { t: 'chat', id: a.id, name: a.name, color: a.color, m: text, ts: now };
      this.chat.push(msg); if (this.chat.length > 40) this.chat = this.chat.slice(-30);
      this.bcast(msg); await this.ctx.storage.put('chat', this.chat);
      return;
    }
    if (t === 'kick' && this.meta && this.meta.owner === low(a.name)) {
      for (const s of this.sockets()) { const b = s.deserializeAttachment(); if (b.id === (m.id | 0) && b.id !== a.id) { this.send(s, { t: 'kicked', why: 'kick' }); s.close(4001, 'kicked'); await this.leave(s); } }
    }
  }
  async webSocketClose(ws) { await this.leave(ws); }
  async webSocketError(ws) { await this.leave(ws); }
  async leave(ws) {
    const a = ws.deserializeAttachment(); if (!a || a.gone) return;
    try { ws.serializeAttachment({ ...a, gone: 1 }); } catch (e) { }
    try { ws.close(1000, 'bye'); } catch (e) { }
    this.pos.delete(a.id); this.rate.delete(a.id); this.rate.delete(-a.id);
    this.bcast({ t: 'leave', id: a.id });
    await this.flush(); await this.report();
  }
}
