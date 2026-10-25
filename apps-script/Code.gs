/**
 * CELESTA — 계정 · 클라우드 저장 서버 (Google Apps Script + Google Sheets)
 *
 * 1) 새 구글 시트를 만들고  확장 프로그램 → Apps Script  를 엽니다.
 * 2) 이 파일 내용을 Code.gs 에 그대로 붙여 넣고 저장합니다.
 * 3) 배포 → 새 배포 → 유형: 웹 앱
 *      실행 사용자: 나 / 액세스 권한: 모든 사용자
 * 4) 나온 웹 앱 URL(https://script.google.com/macros/s/…/exec)을
 *    게임의 계정 창 → "서버 설정" 에 붙여 넣으면 끝입니다.
 *
 * 시트 "Users" 는 첫 요청 때 자동으로 만들어집니다.
 * 비밀번호는 사용자별 무작위 솔트 + SHA-256 500회 반복 해시로만 저장됩니다.
 */
const SHEET_NAME = 'Users';
const HEADERS = ['username', 'salt', 'hash', 'createdAt', 'lastLogin', 'token', 'tokenExp', 'save', 'savedAt', 'gold', 'opened', 'deepest'];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i + 1]));
const TOKEN_DAYS = 30;
const MAX_SAVE = 49000; // 셀 하나의 한도(50,000자) 안쪽
const ID_RE = /^[A-Za-z0-9_가-힣]{3,16}$/;

function doGet() {
  return json_({ ok: true, service: 'celesta-accounts', version: 1 });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = route_(req);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return json_(out);
}

function route_(r) {
  switch (r.action) {
    case 'signup': return signup_(r);
    case 'login': return login_(r);
    case 'save': return save_(r);
    case 'load': return load_(r);
    case 'logout': return logout_(r);
    case 'ping': return { ok: true };
    default: throw new Error('UNKNOWN_ACTION');
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('B:C').setNumberFormat('@');
  }
  return sh;
}

function findRow_(sh, username) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const key = String(username).toLowerCase();
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]).toLowerCase() === key) return i + 2;
  return 0;
}

function hash_(salt, pw) {
  let h = salt + ':' + pw;
  for (let i = 0; i < 500; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return h;
}

function checkCreds_(r) {
  const id = String(r.username || '').trim(), pw = String(r.password || '');
  if (!ID_RE.test(id)) throw new Error('INVALID_ID');
  if (pw.length < 6 || pw.length > 64) throw new Error('WEAK_PW');
  return { id, pw };
}

// 기기마다 토큰을 하나씩 준다. 계정당 최근 5개 기기까지 동시에 로그인해 둘 수 있다.
const MAX_DEVICES = 5;
function tokens_(sh, row) {
  const raw = String(sh.getRange(row, COL.token).getValue() || '');
  const now = Date.now();
  return raw ? raw.split(',').map(x => x.split('|')).filter(([t, e]) => t && Number(e) > now) : [];
}
function writeTokens_(sh, row, list) {
  const keep = list.slice(-MAX_DEVICES);
  sh.getRange(row, COL.token, 1, 2).setValues([[keep.map(x => x.join('|')).join(','), keep.length ? Math.max(...keep.map(x => Number(x[1]))) : '']]);
}
function newToken_(sh, row) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().slice(0, 8);
  const list = tokens_(sh, row);
  list.push([token, String(Date.now() + TOKEN_DAYS * 864e5)]);
  sh.getRange(row, COL.lastLogin).setValue(new Date());
  writeTokens_(sh, row, list);
  return token;
}

function signup_(r) {
  const { id, pw } = checkCreds_(r);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    if (findRow_(sh, id)) throw new Error('USER_EXISTS');
    const salt = Utilities.getUuid();
    sh.appendRow([id, salt, hash_(salt, pw), new Date(), '', '', '', '', '', 0, 0, 0]);
    const row = sh.getLastRow();
    return { ok: true, username: id, token: newToken_(sh, row) };
  } finally {
    lock.releaseLock();
  }
}

function login_(r) {
  const { id, pw } = checkCreds_(r);
  const cache = CacheService.getScriptCache(), key = 'fail:' + id.toLowerCase();
  const fails = Number(cache.get(key) || 0);
  if (fails >= 5) throw new Error('TOO_MANY');
  const sh = sheet_(), row = findRow_(sh, id);
  const rec = row ? sh.getRange(row, 1, 1, 3).getValues()[0] : null;
  if (!rec || hash_(String(rec[1]), pw) !== String(rec[2])) {
    cache.put(key, String(fails + 1), 600);
    throw new Error('BAD_LOGIN');
  }
  cache.remove(key);
  const savedAt = sh.getRange(row, COL.savedAt).getValue();
  return { ok: true, username: String(rec[0]), token: newToken_(sh, row), savedAt: savedAt ? Number(savedAt) : 0 };
}

function auth_(r) {
  const sh = sheet_(), row = findRow_(sh, r.username || '');
  if (!row) throw new Error('BAD_TOKEN');
  const tok = String(r.token || '');
  if (!tok || !tokens_(sh, row).some(([t]) => t === tok)) throw new Error('BAD_TOKEN');
  return { sh, row };
}

function save_(r) {
  const { sh, row } = auth_(r);
  const data = String(r.data || '');
  if (data.length > MAX_SAVE) throw new Error('SAVE_TOO_BIG');
  const now = Date.now(), m = r.meta || {};
  sh.getRange(row, COL.save, 1, 5).setValues([[data, now, Number(m.gold) || 0, Number(m.opened) || 0, Number(m.deepest) || 0]]);
  return { ok: true, savedAt: now };
}

function load_(r) {
  const { sh, row } = auth_(r);
  const [data, savedAt] = sh.getRange(row, COL.save, 1, 2).getValues()[0];
  return { ok: true, data: data ? String(data) : '', savedAt: savedAt ? Number(savedAt) : 0 };
}

function logout_(r) {
  const { sh, row } = auth_(r);
  writeTokens_(sh, row, tokens_(sh, row).filter(([t]) => t !== String(r.token)));
  return { ok: true };
}
