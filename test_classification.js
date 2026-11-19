const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 1. Verify JS syntax in all <script> blocks and zero missing getElementById targets
const scriptMatches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const inlineScripts = scriptMatches
  .filter(m => !/\bsrc=/i.test(m[1]))
  .map(m => m[2])
  .filter(s => s.trim());

assert(inlineScripts.length > 0, 'No inline <script> blocks found in index.html');
inlineScripts.forEach((src, idx) => {
  new Function(src);
});

const domIds = new Set([...html.matchAll(/\bid=['"]([^'"]+)['"]/g)].map(m => m[1]));
const usedIds = [...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
const missingIds = [...new Set(usedIds.filter(id => !domIds.has(id)))];
assert.deepStrictEqual(missingIds, [], 'Missing DOM IDs found: ' + missingIds.join(', '));

// 2. Extract live classification & tax functions directly from index.html
const mainScript = inlineScripts[inlineScripts.length - 1];

function extractFn(src, fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  if (start === -1) throw new Error('Function not found: ' + fnName);
  let depth = 0;
  let inBrace = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      depth++;
      inBrace = true;
    } else if (ch === '}') {
      depth--;
      if (inBrace && depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error('Unclosed function: ' + fnName);
}

const sandbox = {
  appState: {},
  Math,
  Date,
  RegExp,
  Array,
  Object,
  String,
  Number,
  Boolean,
  parseInt,
  parseFloat,
  isNaN
};
vm.createContext(sandbox);

const fnNames = [
  'applyBucketTarget',
  'applyCustomRuleToTx',
  'classifyBankTransaction',
  'calcKoreanIncomeTax',
  'parseTxTimestampMinutes',
  'reconcileCrossBankTransfers'
];
for (const name of fnNames) {
  vm.runInContext(extractFn(mainScript, name), sandbox);
}

const kwList = ['집금', '내통장', '내부'];
const results = [];

function runCase(name, fn) {
  fn();
  results.push(name);
}

function classify(ctx) {
  return sandbox.classifyBankTransaction(Object.assign({
    bank: 'woori',
    dtNorm: '2026-08-15 10:00',
    ym: '2026-08',
    summary: '모바일',
    desc: '',
    memo: '',
    branch: '',
    outAmt: 0,
    inAmt: 0,
    kwList: kwList,
    atMaxByYm: { '2026-08': 50000000 },
    cancelled: false
  }, ctx));
}

// 22+ core clinic regression tests
runCase('1. 문혜연 생활비 (경비 제외)', () => {
  const r = classify({ bank: 'kyongnam', dtNorm: '2026-05-05 10:02', desc: '문혜연', outAmt: 2000000 });
  assert.strictEqual(r.bucketTarget, null);
  assert.ok(r.badge.includes('생활비'));
});

runCase('2. 개인 주택 재산세 (경비 제외)', () => {
  const r = classify({ desc: '경기파주시(김대', memo: '재산세주택2기분', outAmt: 216980 });
  assert.strictEqual(r.bucketTarget, null);
  assert.ok(r.badge.includes('개인세금'));
});

runCase('3. 최해연 입금 (급여 오류 반환 상계)', () => {
  const r = classify({ desc: '최해연', inAmt: 517103 });
  assert.strictEqual(r.bucketTarget, 'outflow.payroll');
  assert.strictEqual(r.bucketDelta, -517103);
});

runCase('4. +1원 계좌인증 입금 (매출 제외)', () => {
  const r = classify({ desc: '1121삼성', inAmt: 1 });
  assert.strictEqual(r.bucketTarget, null);
  assert.ok(r.badge.includes('계좌인증'));
});

runCase('5. 후불교통캐쉬백 +3,000원 (카드정산)', () => {
  const r = classify({ desc: '후불교통캐쉬백', inAmt: 3000 });
  assert.strictEqual(r.bucketTarget, 'inflow.wirelessCard');
  assert.strictEqual(r.isUncertain, false);
});

runCase('6. 직원 명찰 (병원 운영비)', () => {
  const r = classify({ desc: '국민유픽의원', memo: '은지팀장 명찰', outAmt: 9100 });
  assert.strictEqual(r.bucketTarget, 'outflow.welfareOtherCard');
  assert.strictEqual(r.isUncertain, false);
});

runCase('7. (주)케이비국민카드 14일 카드대금출금', () => {
  const r = classify({ summary: '펌뱅킹', desc: '(주)케이비국민카드', outAmt: 10835349 });
  assert.strictEqual(r.bucketTarget, 'cards.card14');
  assert.strictEqual(r.isUncertain, false);
});

runCase('8. 삼성카드 13일 카드대금출금', () => {
  const r = classify({ summary: 'F/B출금', desc: '삼성카드(주)', outAmt: 29087907 });
  assert.strictEqual(r.bucketTarget, 'cards.card13');
});

runCase('9. 경남비씨카드 23일 카드대금출금', () => {
  const r = classify({ summary: 'F/B출금', desc: '경남비씨카드', outAmt: 8988042 });
  assert.strictEqual(r.bucketTarget, 'cards.card23');
});

runCase('10. 김대윤 명의 퇴직금 메모 예외 (내부이체 아님 -> 급여)', () => {
  const r = classify({ desc: '하나김대윤(유픽의원', memo: '직원퇴직금', outAmt: 9500000 });
  assert.strictEqual(r.bucketTarget, 'outflow.payroll');
  assert.ok(r.badge.includes('퇴직금'));
});

runCase('11. 경남 -> 우리 내부이체 (취급기관 경남Bank -> 매출 제외)', () => {
  const r = classify({ bank: 'woori', desc: '김대윤(유픽의원)', branch: '경남은행', inAmt: 100000000 });
  assert.strictEqual(r.bucketTarget, null);
  assert.ok(r.badge.includes('내부/본인이체'));
});

runCase('12. 하나 -> 우리 현금매출 입금 (취급기관 하나은행)', () => {
  const r = classify({ bank: 'woori', desc: '김대윤(유픽의원)', branch: '하나은행', inAmt: 59882054 });
  assert.strictEqual(r.bucketTarget, 'inflow.cashHana');
});

runCase('13. 보유현금 통장입금 메모 (매출 중복 제외)', () => {
  const r = classify({ bank: 'woori', desc: '김대윤(유픽의원)', branch: '하나은행', memo: '보유현금입금', inAmt: 49000000 });
  assert.strictEqual(r.bucketTarget, null);
  assert.ok(r.badge.includes('매출제외'));
});

runCase('14. 에이티움 EMR사용료 55만원 (운영비)', () => {
  const r = classify({ desc: '하나주식회사 에이티', memo: '2608EMR사용료', outAmt: 550000 });
  assert.strictEqual(r.bucketTarget, 'outflow.welfareOtherCard');
});

runCase('15. 에이티움 재료비 vs 해외수수료 분리', () => {
  const mat = classify({ desc: '하나주식회사 에이티', memo: '2608물품대재료비', outAmt: 36302240 });
  const fee = classify({ desc: '하나주식회사 에이티', memo: '2608해외수수료', outAmt: 13728407 });
  assert.strictEqual(mat.bucketTarget, 'cards.scheduledSupplyTransfer20');
  assert.strictEqual(fee.bucketTarget, 'outflow.marketingCard');
});

runCase('16. 마케팅/유치 플랫폼 (씨유이·힐링페이퍼·한차오·메디차이)', () => {
  assert.strictEqual(classify({ desc: '하나주식회사 씨유이', memo: '메이투안수수료', outAmt: 536236 }).bucketTarget, 'outflow.marketingCard');
  assert.strictEqual(classify({ desc: '신한주식회사 힐링페', outAmt: 5500000 }).bucketTarget, 'outflow.marketingCard');
  assert.strictEqual(classify({ desc: '하나주식회사 한차오', memo: '코네스트한차오6개월연장', outAmt: 4950000 }).bucketTarget, 'outflow.marketingCard');
  assert.strictEqual(classify({ desc: '농협이세한(메디차이', memo: '메디차이나수수료', outAmt: 1078654 }).bucketTarget, 'outflow.marketingCard');
});

runCase('17. 골드테라피 (재료비) & 제이앤씨 (무전기 운영비)', () => {
  assert.strictEqual(classify({ desc: '정구형', memo: '골드테라피5세트', outAmt: 1325000 }).bucketTarget, 'cards.scheduledSupplyTransfer20');
  assert.strictEqual(classify({ desc: '신한주대식(제이앤씨', memo: '무전기이어폰', outAmt: 53250 }).bucketTarget, 'outflow.welfareOtherCard');
});

runCase('18. 부가세 확정 vs 부가세 선납 vs 종소세 선납 분리', () => {
  const h1Vat = classify({ desc: '국고_유픽의원', memo: '26년상반기부가세', outAmt: 92961670 });
  const advVat = classify({ desc: '국고_유픽의원', memo: '26년후반기절반선납', outAmt: 46480000 });
  const advInc = classify({ desc: '국고_김대윤', memo: '종합소득세 선납', outAmt: 4357000 });
  assert.strictEqual(h1Vat.bucketTarget, 'outflow.vatH1Settle');
  assert.strictEqual(advVat.bucketTarget, 'outflow.vatLumpSum');
  assert.strictEqual(advInc.bucketTarget, 'outflow.incAdvance');
});

runCase('19. 피부과 단어 포함 메모 비용 누락 방지 (피부과 제거 확인)', () => {
  const r = classify({ desc: '대한학회', memo: '피부과 학회비', outAmt: 500000 });
  assert.notStrictEqual(r.badge, '🔄 내부/본인이체');
  assert.strictEqual(r.bucketTarget, 'outflow.welfareOtherCard');
});

runCase('20. 부원장님·알바원장님 급여 & 소액 식대 분리', () => {
  assert.strictEqual(classify({ desc: '신한박득남', outAmt: 15000000 }).bucketTarget, 'outflow.payroll');
  assert.strictEqual(classify({ desc: '신한박득남', memo: '2609식대', outAmt: 44000 }).bucketTarget, 'outflow.welfareOtherCard');
  assert.strictEqual(classify({ desc: '신한이유준', outAmt: 920000 }).bucketTarget, 'outflow.payroll');
});

runCase('21. 국내 종합소득세 누진세율(지방세 10% 포함) 검증', () => {
  const k1 = sandbox.calcKoreanIncomeTax(100000000); // 1억 -> 35% 구간: (1억*0.35 - 1544만)=1956만 + 지방세 195.6만 = 2151.6만
  assert.strictEqual(k1.topRatePct, 35);
  assert.strictEqual(k1.nationalTax, 19560000);
  assert.strictEqual(k1.localTax, 1956000);
  assert.strictEqual(k1.totalTax, 21516000);
});

runCase('22. 교차 통장 이체 자동 대조 상계 (reconcileCrossBankTransfers)', () => {
  sandbox.appState = {
    monthlyData: {
      '2026-07': {
        inflowTotals: { pgCard: 0, wirelessCard: 0, cashHana: 100000000, platformKyongnam: 0, naverPay: 0, kakaoPay: 0 },
        outflowTotals: {},
        cards: {},
        transactions: [
          {
            id: 'kyongnam|207-0172-8715-04|2026-07-24 16:35|100000000|0|59219430|인터넷|#020김대윤',
            datetime: '07/24 16:35',
            sortDt: '2026-07-24 16:35',
            type: 'BANK_OUT',
            badge: '🔄 내부/본인이체',
            title: '#020김*윤',
            bucketTarget: null,
            amount: 100000000
          },
          {
            id: 'woori|1005-104-863854|2026-07-24 16:35|0|100000000|121889451|모바일|김대윤(유픽의원)',
            datetime: '07/24 16:35',
            sortDt: '2026-07-24 16:35',
            type: 'BANK_IN',
            badge: '💵 현금입금',
            title: '김*윤(유*의원)',
            bucketTarget: 'inflow.cashHana',
            amount: 100000000
          }
        ]
      }
    }
  };
  const changed = sandbox.reconcileCrossBankTransfers();
  assert.strictEqual(changed, true);
  assert.strictEqual(sandbox.appState.monthlyData['2026-07'].inflowTotals.cashHana, 0);
  assert.strictEqual(sandbox.appState.monthlyData['2026-07'].transactions[1].bucketTarget, null);
});

runCase('23. 화면 직접 분류 규칙(customRules) 거래처 단위 오버라이드', () => {
  sandbox.appState = {
    settings: {
      customRules: {
        'desc:OUT:신규제약(주)': 'cards.scheduledSupplyTransfer20',
        'desc:OUT:생활비계좌': 'exclude.living'
      }
    }
  };
  const rSupply = classify({ desc: '신규제약(주)', outAmt: 350000 });
  assert.strictEqual(rSupply.bucketTarget, 'cards.scheduledSupplyTransfer20');
  assert.strictEqual(rSupply.bucketDelta, 350000);
  assert.strictEqual(rSupply.isUncertain, false);
  const rLiving = classify({ desc: '생활비계좌', outAmt: 1200000 });
  assert.strictEqual(rLiving.bucketTarget, null);
  assert.strictEqual(rLiving.bucketDelta, 0);
  assert.strictEqual(rLiving.isUncertain, false);
});

runCase('24. 화면 직접 분류 규칙(customRules) 개별 거래 ID 우선순위 오버라이드', () => {
  const customTxId = 'woori|1005-104-863854|2025-11-10 09:30|500000|0|1000000|모바일|알수없는거래처';
  sandbox.appState = {
    settings: {
      customRules: {
        'desc:OUT:알수없는거래처': 'outflow.welfareOtherCard',
        ['tx:' + customTxId]: 'outflow.marketingCard'
      }
    }
  };
  const rTxSpecific = classify({ txId: customTxId, desc: '알수없는거래처', outAmt: 500000 });
  assert.strictEqual(rTxSpecific.bucketTarget, 'outflow.marketingCard');
  assert.strictEqual(rTxSpecific.isUncertain, false);
  sandbox.appState = {};
});

console.log(`ALL PASSED: ${results.length}/${results.length} regression checks OK (JS syntax & DOM IDs verified)`);
