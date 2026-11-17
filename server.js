const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  parseBatchRecords,
  parseSingleTextLine,
  pushStateToGoogleSheet
} = require('./auto_collector');

const PORT = process.env.PORT || 3080;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const INBOX_DIR = path.join(DATA_DIR, 'inbox');
const PROCESSED_DIR = path.join(INBOX_DIR, 'processed');
const CONFIG_DIR = path.join(__dirname, 'config');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'collector_config.json');
const CONFIG_EXAMPLE_FILE = path.join(CONFIG_DIR, 'collector_config.example.json');

[DATA_DIR, INBOX_DIR, PROCESSED_DIR, CONFIG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// 초기 데이터: 우리·하나·경남 개인사업자 통장 + 13일(삼성)·14일(국민/우리/신한/롯데)·23일(경남) 카드 + 매월 24일 공식 기준일
const INITIAL_DB = {
  settings: {
    officialCutoffDay: 24,
    day24BaseBalance: 81200000,
    wooriAccount: '1005-104-863854',
    realDataMode: false,
    pgSplitRatio: { card: 0.80, naver: 0.12, kakao: 0.08, feeRate: 0.028 },
    pgIsActual: false,
    taxReserveRate: 0.085,
    internalKeywords: '집금,내통장,내부,피부과',
    webhookUrl: '',
    secretToken: 'clinic-24'
  },
  balances: {
    woori: 52180000,
    hana: 18900000,
    kyongnam: 13440000,
    updatedAt: 'PC 자동수집 대기중'
  },
  pendingInflowsTotal: 19450000,
  cards: {
    card13: {
      name: '삼성카드 (13일 출금)',
      withdrawDay: 13,
      currentMonthSwipes: 3420000,
      confirmedNextWithdraw: 0
    },
    card14: {
      name: '국민·우리·신한·롯데 (14일 출금)',
      withdrawDay: 14,
      currentMonthSwipes: 5500000,
      confirmedNextWithdraw: 0
    },
    card23: {
      name: 'BNK경남카드 (23일 출금)',
      withdrawDay: 23,
      currentMonthSwipes: 9720000,
      confirmedNextWithdraw: 11400000
    },
    scheduledSupplyTransfer20: 8000000
  },
  inflowTotals: {
    pgCard: 44200000,
    wirelessCard: 16800000,
    cashHana: 14500000,
    platformKyongnam: 9840000,
    naverPay: 6460000,
    kakaoPay: 4600000
  },
  outflowTotals: {
    payroll: 28500000,
    taxInsRent: 16900000,
    supplyCard: 7940000,
    marketingCard: 7800000,
    welfareOtherCard: 2900000
  },
  processedIds: [],
  transactions: [
    { id: '1', datetime: '11/16 11:15', type: 'BANK_IN', badge: '🟦 우리입금', title: '갤럭시아머니트리', sub: '카드 536만·N페이 80만·카카오 54만', amount: 6700000 },
    { id: '2', datetime: '11/16 10:42', type: 'BANK_IN', badge: '🟩 하나입금', title: '박*현 고객님', sub: '시술비 계좌이체 (실명자동마스킹)', amount: 550000 },
    { id: '3', datetime: '11/16 10:15', type: 'CARD_SWIPE', badge: '💳 신한카드(14일)', title: '메타(인스타) 광고비', sub: '아직 미출금 (14일 출금예정)', amount: 900000 },
    { id: '4', datetime: '11/15 16:40', type: 'CARD_SWIPE', badge: '💳 경남카드(23일)', title: '(주)블루메디칼 소모품', sub: '아직 미출금 (23일 출금예정)', amount: 1850000 },
    { id: '5', datetime: '11/15 14:10', type: 'BANK_IN', badge: '🟧 경남입금', title: '강남언니 정산금', sub: '플랫폼 정산 입금', amount: 1890000 },
    { id: '6', datetime: '11/13 18:00', type: 'CARD_SWIPE', badge: '💳 삼성카드(13일)', title: '메디톡스 의약품결제', sub: '아직 미출금 (13일 출금예정)', amount: 1200000 }
  ]
};

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(INITIAL_DB, null, 2), 'utf8');
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.cards.card13) {
      db.cards = JSON.parse(JSON.stringify(INITIAL_DB.cards));
      db.settings.officialCutoffDay = 24;
    }
    if (!db.settings.wooriAccount) {
      db.settings.wooriAccount = '1005-104-863854';
    }
    return db;
  } catch (e) {
    return JSON.parse(JSON.stringify(INITIAL_DB));
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    if (fs.existsSync(CONFIG_EXAMPLE_FILE)) {
      fs.copyFileSync(CONFIG_EXAMPLE_FILE, CONFIG_FILE);
    } else {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2), 'utf8');
    }
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// 스마트 자동수집 폴더(data/inbox) 감시: 은행 빠른조회/갤럭시아/홈택스 파일이 들어오면 자동 파싱 & 클라우드 동기화
function scanInboxFolder() {
  try {
    const files = fs.readdirSync(INBOX_DIR).filter(f => {
      const full = path.join(INBOX_DIR, f);
      return fs.statSync(full).isFile() && /\.(csv|txt|tsv)$/i.test(f);
    });
    if (files.length === 0) return { processedFiles: 0, addedRecords: 0 };

    const db = loadDb();
    let totalAdded = 0;
    for (const file of files) {
      const fullPath = path.join(INBOX_DIR, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const res = parseBatchRecords(content, db);
      totalAdded += res.addedCount;
      const destPath = path.join(PROCESSED_DIR, `${Date.now()}_${file}`);
      fs.renameSync(fullPath, destPath);
    }

    if (totalAdded > 0) {
      saveDb(db);
      pushStateToGoogleSheet(db);
    }
    return { processedFiles: files.length, addedRecords: totalAdded };
  } catch (err) {
    return { processedFiles: 0, addedRecords: 0, error: err.message };
  }
}

setInterval(scanInboxFolder, 3000);

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // API 1: 현재 대시보드 상태 조회
  if (req.method === 'GET' && req.url.startsWith('/api/state')) {
    const inboxRes = scanInboxFolder();
    const db = loadDb();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, inboxRes, state: db }));
  }

  // API 2: 대시보드 상태 저장 & 구글 시트(폴드5 열람용) 자동 동기화
  if (req.method === 'POST' && req.url === '/api/state') {
    try {
      const payload = await readJsonBody(req);
      if (payload && payload.state) {
        saveDb(payload.state);
        const cloudRes = await pushStateToGoogleSheet(payload.state);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, cloudRes, state: payload.state }));
      }
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'Missing state object' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // API 3: PC 자동 수집 로봇 배치 파싱 & 클라우드 동기화
  if (req.method === 'POST' && req.url === '/api/collect/batch') {
    try {
      const payload = await readJsonBody(req);
      const db = loadDb();
      const inboxRes = scanInboxFolder();
      let batchRes = { addedCount: 0, pgActualCount: 0, excludedOtherWooriCount: 0 };
      if (payload.content) {
        batchRes = parseBatchRecords(payload.content, db);
      }
      saveDb(db);
      const cloudRes = await pushStateToGoogleSheet(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        addedCount: batchRes.addedCount + inboxRes.addedRecords,
        pgActualCount: batchRes.pgActualCount,
        excludedOtherWooriCount: batchRes.excludedOtherWooriCount || 0,
        cloudRes,
        state: db
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // API 4: 단건 텍스트/문자 파싱
  if (req.method === 'POST' && req.url === '/api/webhook/sms') {
    try {
      const payload = await readJsonBody(req);
      const db = loadDb();
      const result = parseSingleTextLine(payload.text || payload.message || '', db);
      saveDb(db);
      const cloudRes = await pushStateToGoogleSheet(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ...result, cloudRes, state: db }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // API 5: PC 수집기 설정 조회/저장 (Git 추적 제외 로컬 파일)
  if (req.method === 'GET' && req.url === '/api/config') {
    const cfg = loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, config: cfg }));
  }

  if (req.method === 'POST' && req.url === '/api/config') {
    try {
      const payload = await readJsonBody(req);
      const cfg = loadConfig();
      if (payload && payload.wooriStep1) {
        if (!cfg.banks) cfg.banks = {};
        if (!cfg.banks.woori) cfg.banks.woori = { enabled: true, accountNumber: '1005-104-863854', onlyThisAccount: true };
        if (payload.wooriStep1.birthDate6 !== undefined) {
          cfg.banks.birthDate6 = String(payload.wooriStep1.birthDate6).trim();
        }
        if (payload.wooriStep1.queryPassword4 !== undefined) {
          cfg.banks.woori.queryPassword4 = String(payload.wooriStep1.queryPassword4).trim();
        }
        cfg.banks.woori.accountNumber = '1005-104-863854';
        cfg.banks.woori.onlyThisAccount = true;
        saveConfig(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, savedToFile: CONFIG_FILE }));
      }
      const updated = Object.assign({}, cfg, payload);
      saveConfig(updated);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, config: updated }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // API 6: 초기 데이터 리셋
  if (req.method === 'POST' && req.url === '/api/reset') {
    saveDb(INITIAL_DB);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, state: INITIAL_DB }));
  }

  // 정적 파일 서빙 (루트 index.html 우선, 없으면 public/)
  let reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  let fullPath = path.join(__dirname, reqPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    fullPath = path.join(__dirname, 'public', reqPath);
  }

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[PC 자동수집 서버 가동] http://${HOST}:${PORT}`);
  console.log(`[스마트 자동수집 폴더] ${INBOX_DIR}`);
});
