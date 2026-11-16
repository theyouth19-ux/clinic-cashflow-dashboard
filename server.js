const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3080;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 초기 샘플 데이터 (우리은행, 하나은행, 경남은행 + 14일/20일 카드 + 매월 21일 공식 기준일)
const INITIAL_DB = {
  settings: {
    clinicName: '피부과 의원 자금·손익 관제',
    officialCutoffDay: 21,
    bepTarget: 108000000,
    pgSplitRatio: { card: 0.8, naver: 0.12, kakao: 0.08, feeRate: 0.028 },
    taxReserveRate: 0.085
  },
  balances: {
    woori: 52180000,
    hana: 18900000,
    kyongnam: 13440000,
    updatedAt: '2026-11-16 12:30'
  },
  pendingInflows: {
    galaxiaPg: 12450000,
    wirelessCard: 4600000,
    platform: 2400000
  },
  cards: {
    card14: {
      name: '1차 일반 사업자카드 (14일 출금)',
      withdrawDay: 14,
      cycleDesc: '전월 1일 ~ 전월 말일 사용분',
      confirmedNextWithdraw: 0, // 11/14 이미 출금 완료
      lastWithdrawnAmount: 14800000,
      lastWithdrawnDate: '2026-11-14',
      currentMonthSwipes: 8920000
    },
    card20: {
      name: '2차 경남은행 카드 (20일 출금)',
      withdrawDay: 20,
      cycleDesc: '전월 1일 ~ 전월 말일 사용분',
      confirmedNextWithdraw: 11400000, // 11/20 출금 확정 (10/1~10/31 사용분)
      lastWithdrawnAmount: 10200000,
      lastWithdrawnDate: '2026-10-20',
      currentMonthSwipes: 9720000
    },
    scheduledSupplyTransfer20: 8000000 // 11/20 거래처 현금이체 예정 재료비
  },
  transactions: [
    {
      id: 'tx-101',
      datetime: '2026-11-16 11:15',
      type: 'BANK_IN',
      bank: 'woori',
      rawSender: '갤럭시아머니트리',
      category: 'PG_SETTLEMENT',
      subBreakdown: { card: 5360000, naver: 804000, kakao: 536000, fee: 190000 },
      amount: 6700000,
      balanceAfter: 52180000,
      memo: '유선단말기 PG 정산 (카드·N페이·카카오페이 자동분해)'
    },
    {
      id: 'tx-102',
      datetime: '2026-11-16 10:42',
      type: 'BANK_IN',
      bank: 'hana',
      rawSender: '박지현',
      category: 'CASH_TRANSFER',
      amount: 550000,
      balanceAfter: 18900000,
      memo: '고객 시술비 계좌이체 현금수입'
    },
    {
      id: 'tx-103',
      datetime: '2026-11-16 10:15',
      type: 'CARD_SWIPE',
      cardType: 'card14',
      rawSender: '메타(Facebook/Insta) 광고',
      category: 'EXP_MARKETING',
      amount: 900000,
      withdrawSchedule: '2026-12-14',
      memo: '카드 결제시점 지출 반영 (통장 미출금 · 12/14 출금예정)'
    },
    {
      id: 'tx-104',
      datetime: '2026-11-15 16:40',
      type: 'CARD_SWIPE',
      cardType: 'card20',
      rawSender: '(주)블루메디칼 소모품',
      category: 'EXP_SUPPLY_CARD',
      amount: 1850000,
      withdrawSchedule: '2026-12-20',
      memo: '경남은행 카드 결제시점 지출 반영 (12/20 출금예정)'
    },
    {
      id: 'tx-105',
      datetime: '2026-11-15 14:10',
      type: 'BANK_IN',
      bank: 'kyongnam',
      rawSender: '(주)힐링페이퍼(강남언니)',
      category: 'PLATFORM_GANGNAM',
      amount: 1890000,
      balanceAfter: 13440000,
      memo: '강남언니 플랫폼 정산 입금'
    },
    {
      id: 'tx-106',
      datetime: '2026-11-15 11:05',
      type: 'BANK_IN',
      bank: 'woori',
      rawSender: '신한카드',
      category: 'WIRELESS_CARD',
      amount: 1620000,
      balanceAfter: 45480000,
      memo: '무선단말기 카드사 직접 정산 입금'
    },
    {
      id: 'tx-107',
      datetime: '2026-11-14 18:00',
      type: 'BANK_OUT',
      bank: 'woori',
      rawSender: '1차사업자카드대금(10월분)',
      category: 'CARD_BILL_SETTLEMENT',
      amount: 14800000,
      balanceAfter: 43860000,
      memo: '14일 카드대금 출금 완료 (10월 귀속분 부채 소멸)'
    },
    {
      id: 'tx-108',
      datetime: '2026-11-12 15:30',
      type: 'INTERNAL_TRANSFER',
      bank: 'hana_to_woori',
      rawSender: '하나 ➔ 우리 내부이체',
      category: 'INTERNAL_TRANSFER',
      amount: 10000000,
      balanceAfter: 58660000,
      memo: '통장 간 내부 자금이동 (수입·지출 중복 자동 제외)'
    }
  ]
};

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(INITIAL_DB, null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// 한국 은행 입출금 문자 & 신용카드 승인 문자 자동 파서 (갤럭시 폴드5 SMS 포워더 호환)
function parseIncomingSms(rawText, db) {
  const text = (rawText || '').trim();
  const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // 금액 추출 (예: 6,700,000원)
  const amountMatches = [...text.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원/g)];
  const primaryAmount = amountMatches.length > 0
    ? parseInt(amountMatches[0][1].replace(/,/g, ''), 10)
    : 0;

  // 잔액 추출 (예: 잔액 52,180,000원)
  const balMatch = text.match(/잔액\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원?/);
  const parsedBalance = balMatch ? parseInt(balMatch[1].replace(/,/g, ''), 10) : null;

  // 1) 신용카드 승인 문자 판별 (결제시점 대시보드용 - 아직 통장 미출금)
  if (text.includes('승인') || (text.includes('카드') && !text.includes('입금') && !text.includes('출금'))) {
    const isKyongnamCard = text.includes('경남') || text.includes('BC') || text.includes('비씨');
    const cardKey = isKyongnamCard ? 'card20' : 'card14';

    let category = 'EXP_OTHER_CARD';
    let label = '기타 운영비 카드결제';
    if (/메타|광고|네이버|카카오|강남언니|마케팅|파워링크/i.test(text)) {
      category = 'EXP_MARKETING';
      label = '마케팅·광고비 (카드 결제시점)';
    } else if (/메디|제약|약품|소모품|보톡스|필러|니들|재료/i.test(text)) {
      category = 'EXP_SUPPLY_CARD';
      label = '의약품·소모품 재료비 (카드 결제시점)';
    } else if (/식당|배달|식대|카페|스타벅스|편의점|마트/i.test(text)) {
      category = 'EXP_WELFARE';
      label = '직원 식대·복리후생 (카드 결제시점)';
    }

    db.cards[cardKey].currentMonthSwipes += primaryAmount;
    const withdrawSchedule = isKyongnamCard ? '익월 20일 (경남카드)' : '익월 14일 (1차카드)';

    const tx = {
      id: 'tx-' + Date.now(),
      datetime: nowStr,
      type: 'CARD_SWIPE',
      cardType: cardKey,
      rawSender: text.slice(0, 32),
      category,
      amount: primaryAmount,
      withdrawSchedule,
      memo: `${label} · 아직 통장 미출금 (${withdrawSchedule} 출금예정)`
    };
    db.transactions.unshift(tx);
    db.balances.updatedAt = nowStr;
    return { ok: true, parsedType: 'CARD_SWIPE', tx };
  }

  // 2) 은행 입출금 문자 판별 (우리은행 / 하나은행 / 경남은행)
  let bank = 'woori';
  if (text.includes('하나')) bank = 'hana';
  else if (text.includes('경남')) bank = 'kyongnam';
  else if (text.includes('우리')) bank = 'woori';

  const isDeposit = text.includes('입금') || (!text.includes('출금') && !text.includes('지급'));

  // 내부 통장 간 이체 자동 감지
  if ((bank === 'woori' && isDeposit && /하나|경남|내통장|집금/.test(text)) ||
      ((bank === 'hana' || bank === 'kyongnam') && !isDeposit && /우리|내통장|집금/.test(text))) {
    if (parsedBalance !== null) db.balances[bank] = parsedBalance;
    const tx = {
      id: 'tx-' + Date.now(),
      datetime: nowStr,
      type: 'INTERNAL_TRANSFER',
      bank,
      rawSender: '통장 간 내부이체',
      category: 'INTERNAL_TRANSFER',
      amount: primaryAmount,
      balanceAfter: db.balances[bank],
      memo: '내부 자금이동 (수입·지출 중복 합산에서 자동 제외됨)'
    };
    db.transactions.unshift(tx);
    db.balances.updatedAt = nowStr;
    return { ok: true, parsedType: 'INTERNAL_TRANSFER', tx };
  }

  if (isDeposit) {
    // 입금 처리
    if (parsedBalance !== null) {
      db.balances[bank] = parsedBalance;
    } else {
      db.balances[bank] += primaryAmount;
    }

    let category = 'CASH_TRANSFER';
    let memo = '고객 계좌이체 현금수입';
    let subBreakdown = null;
    let rawSender = '입금';

    if (text.includes('갤럭시아')) {
      category = 'PG_SETTLEMENT';
      rawSender = '갤럭시아머니트리';
      const r = db.settings.pgSplitRatio;
      subBreakdown = {
        card: Math.round(primaryAmount * r.card),
        naver: Math.round(primaryAmount * r.naver),
        kakao: primaryAmount - Math.round(primaryAmount * r.card) - Math.round(primaryAmount * r.naver),
        fee: Math.round(primaryAmount * r.feeRate)
      };
      memo = `갤럭시아PG 정산 (카드 ${(subBreakdown.card/10000).toFixed(0)}만 / N페이 ${(subBreakdown.naver/10000).toFixed(0)}만 / 카카오 ${(subBreakdown.kakao/10000).toFixed(0)}만)`;
    } else if (/신한카드|삼성카드|현대카드|국민카드|비씨카드|롯데카드|하나카드/.test(text)) {
      category = 'WIRELESS_CARD';
      const m = text.match(/(신한카드|삼성카드|현대카드|국민카드|비씨카드|롯데카드|하나카드)/);
      rawSender = m ? m[1] : '카드사정산';
      memo = '무선단말기 카드사 정산금 입금';
    } else if (/강남언니|힐링페이퍼/.test(text)) {
      category = 'PLATFORM_GANGNAM';
      rawSender = '강남언니(힐링페이퍼)';
      memo = '강남언니 플랫폼 정산금 (경남은행)';
    } else if (/언니가이드/.test(text)) {
      category = 'PLATFORM_UNNI';
      rawSender = '언니가이드';
      memo = '언니가이드 플랫폼 정산금 (경남은행)';
    } else {
      category = 'CASH_TRANSFER';
      rawSender = bank === 'hana' ? '고객 현금이체' : '기타 입금';
      memo = '하나은행 고객 직접 계좌이체 (현금수입)';
    }

    const tx = {
      id: 'tx-' + Date.now(),
      datetime: nowStr,
      type: 'BANK_IN',
      bank,
      rawSender,
      category,
      subBreakdown,
      amount: primaryAmount,
      balanceAfter: db.balances[bank],
      memo
    };
    db.transactions.unshift(tx);
    db.balances.updatedAt = nowStr;
    return { ok: true, parsedType: 'BANK_IN', tx };
  } else {
    // 출금 처리 (주로 우리은행)
    if (parsedBalance !== null) {
      db.balances[bank] = parsedBalance;
    } else {
      db.balances[bank] -= primaryAmount;
    }

    let category = 'EXP_OTHER';
    let rawSender = '우리은행 출금';
    let memo = '병원 운영 지출 출금';

    if (/급여|월급|인건비/.test(text)) {
      category = 'EXP_PAYROLL';
      rawSender = '직원 급여 (5일)';
      memo = '매월 5일 직원 급여 출금 (전월 귀속 인건비)';
    } else if (/리스|캐피탈|렌탈/.test(text)) {
      category = 'EXP_LEASE';
      rawSender = '장비 리스료 (5일)';
      memo = '매월 5일 의료장비 리스료 출금';
    } else if (/원천세|4대보험|건강보험|국민연금|세금/.test(text)) {
      category = 'EXP_TAX_INS';
      rawSender = '원천세·4대보험 (10일)';
      memo = '매월 10일 원천세·4대보험 출금';
    } else if (/경남카드|경남BC|카드대금/.test(text)) {
      category = 'CARD_BILL_SETTLEMENT';
      rawSender = '사업자카드 출금 (14·20일)';
      memo = '사업자 신용카드 대금 자동출금 완료';
    } else if (/메디|제약|약품|재료|도매/.test(text)) {
      category = 'EXP_SUPPLY_CASH';
      rawSender = '재료비 현금이체 (20일)';
      memo = '거래처 의약품·소모품 현금이체 결제';
    }

    const tx = {
      id: 'tx-' + Date.now(),
      datetime: nowStr,
      type: 'BANK_OUT',
      bank,
      rawSender,
      category,
      amount: primaryAmount,
      balanceAfter: db.balances[bank],
      memo
    };
    db.transactions.unshift(tx);
    db.balances.updatedAt = nowStr;
    return { ok: true, parsedType: 'BANK_OUT', tx };
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // API: 대시보드 전체 데이터 조회
  if (req.method === 'GET' && req.url === '/api/state') {
    const db = loadDb();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(db));
  }

  // API: 실시간 문자(SMS/알림) 수신 웹훅 (갤럭시 폴드5 앱 & 웹 시뮬레이터 공용)
  if (req.method === 'POST' && req.url === '/api/webhook/sms') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const db = loadDb();
        const result = parseIncomingSms(payload.text || payload.message || '', db);
        saveDb(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...result, state: db }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // API: 초기 데이터 리셋
  if (req.method === 'POST' && req.url === '/api/reset') {
    saveDb(INITIAL_DB);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, state: INITIAL_DB }));
  }

  // 정적 파일 서빙 (public/index.html 등)
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const fullPath = path.join(__dirname, 'public', filePath);

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

server.listen(PORT, () => {
  console.log(`Clinic Cashflow Dashboard Server running at http://localhost:${PORT}`);
});
