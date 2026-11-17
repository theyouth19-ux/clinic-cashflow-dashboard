/**
 * 🤖 피부과 의원 PC 자동 수집 & 자동 분류 엔진 (auto_collector.js)
 *
 * - 휴대폰(갤럭시 폴드5)에는 아무런 앱도 설치하지 않고 PC에서 안전하게 데이터를 수집·분류합니다.
 * - 지원 대상:
 *   1) 3개 은행 (우리·하나·경남 개인사업자 빠른조회 및 거래내역 CSV/텍스트)
 *   2) 갤럭시아머니트리(빌게이트) 가맹점 관리자 정산 내역 (카드 / 네이버페이 / 카카오페이 / 수수료 실제값 분해)
 *   3) 사업자 신용카드 3그룹:
 *      - 13일 출금: 삼성카드 (전월 1일 ~ 말일)
 *      - 14일 출금: KB국민 · 우리 · 신한 · 롯데카드 (전월 1일 ~ 말일)
 *      - 23일 출금: BNK경남카드 (전월 1일 ~ 말일)
 *   4) 공식 손익 확정 및 현금 비교 기준일: 매월 24일 (23일 경남카드 최종 출금 완료 직후)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

function maskCustomerName(text) {
  const ignore = [
    '우리은', '하나은', '경남은', '신한카', '삼성카', '현대카', '국민카', '비씨카',
    '롯데카', '하나카', '우리카', '강남언', '언니가', '갤럭시', '머니트', '힐링페',
    '메디톡', '블루메', '일시불', '전월분', '스타벅', '빌게이', '네이', '카카오', '빠른조'
  ];
  return String(text || '').replace(/([가-힣])([가-힣])([가-힣])/g, function(m, c1, c2, c3) {
    const w = c1 + c2 + c3;
    for (let i = 0; i < ignore.length; i++) {
      if (w.indexOf(ignore[i]) !== -1) return m;
    }
    return c1 + '*' + c3;
  });
}

/**
 * 카드사명 기반 13일 / 14일 / 23일 출금 그룹 판별
 */
function detectCardGroup(text) {
  if (/경남|BC|비씨/i.test(text)) {
    return { key: 'card23', badge: '💳 경남카드(23일)', withdrawDay: 23, sched: '23일 출금분' };
  }
  if (/삼성/i.test(text)) {
    return { key: 'card13', badge: '💳 삼성카드(13일)', withdrawDay: 13, sched: '13일 출금분' };
  }
  // 기본: 국민, 우리, 신한, 롯데 (14일 출금)
  let issuer = '14일카드';
  const m = String(text).match(/(국민|우리|신한|롯데)/);
  if (m) issuer = m[1] + '카드';
  return { key: 'card14', badge: `💳 ${issuer}(14일)`, withdrawDay: 14, sched: '14일 출금분' };
}

/**
 * 갤럭시아머니트리 PG 정산 내역 / 은행 입출금 내역 / 홈택스·카드승인 내역 통합 파서
 */
function parseBatchRecords(rawContent, db) {
  const lines = String(rawContent || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  let addedCount = 0;
  let pgActualCount = 0;

  for (const line of lines) {
    // 헤더 행 건너뛰기
    if (/^(거래일시|승인일시|결제일자|일자|번호|구분|은행명),/.test(line)) continue;

    // 1) 갤럭시아머니트리 PG 정산 상세 행 감지 (예: "갤럭시아정산,신용카드,6200000,수수료,173600" 또는 네이버페이/카카오페이 포함)
    if (line.includes('갤럭시아') && (line.includes('네이버페이') || line.includes('카카오페이') || line.includes('PG정산명세'))) {
      const cardM = line.match(/카드[:\s,]*([0-9,]+)/);
      const naverM = line.match(/네이버페이?[:\s,]*([0-9,]+)/);
      const kakaoM = line.match(/카카오페이?[:\s,]*([0-9,]+)/);
      const pendingM = line.match(/(?:미정산|입금예정)[:\s,]*([0-9,]+)/);

      const cAmt = cardM ? parseInt(cardM[1].replace(/,/g, ''), 10) : 0;
      const nAmt = naverM ? parseInt(naverM[1].replace(/,/g, ''), 10) : 0;
      const kAmt = kakaoM ? parseInt(kakaoM[1].replace(/,/g, ''), 10) : 0;
      const totalPg = cAmt + nAmt + kAmt;

      if (totalPg > 0) {
        db.inflowTotals.pgCard += cAmt;
        db.inflowTotals.naverPay += nAmt;
        db.inflowTotals.kakaoPay += kAmt;
        db.settings.pgIsActual = true;
        if (pendingM) {
          db.pendingInflowsTotal = parseInt(pendingM[1].replace(/,/g, ''), 10);
        } else {
          db.pendingInflowsTotal = Math.max(0, db.pendingInflowsTotal - totalPg);
        }
        db.transactions.unshift({
          id: 'pg-' + Date.now() + '-' + addedCount,
          datetime: new Date().toTimeString().slice(0, 5),
          type: 'BANK_IN',
          badge: '🟦 갤럭시아실제분해',
          title: '갤럭시아머니트리 정산명세 연동',
          sub: `[실데이터] 카드 ${Math.round(cAmt/10000)}만 · N페이 ${Math.round(nAmt/10000)}만 · 카카오 ${Math.round(kAmt/10000)}만`,
          amount: totalPg
        });
        addedCount++;
        pgActualCount++;
        continue;
      }
    }

    // 일반 단건 텍스트/CSV 라인 파싱
    const result = parseSingleTextLine(line, db);
    if (result && result.ok) {
      addedCount++;
    }
  }

  return { ok: true, addedCount, pgActualCount };
}

function parseSingleTextLine(rawText, db) {
  const text = String(rawText || '').trim();
  if (!text) return { ok: false };

  const balMatch = text.match(/잔액[:\s,]*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원?/);
  const parsedBalance = balMatch ? parseInt(balMatch[1].replace(/,/g, ''), 10) : null;

  const textCleanedForAmt = text
    .replace(/잔액[:\s,]*[0-9,]+\s*원?/g, '')
    .replace(/누적[:\s,]*[0-9,]+\s*원?/g, '');
  const amtMatch = textCleanedForAmt.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원/);
  const rawAmount = amtMatch ? parseInt(amtMatch[1].replace(/,/g, ''), 10) : 0;
  if (rawAmount === 0) return { ok: false };

  const isCancel = text.includes('취소') || text.includes('환불');
  const signedAmount = isCancel ? -rawAmount : rawAmount;
  const nowTime = new Date().toTimeString().slice(0, 5);

  const isCardMsg = text.includes('승인') || (text.includes('카드') && !text.includes('입금') && !text.includes('출금'));
  if (isCardMsg) {
    const cg = detectCardGroup(text);
    if (!db.cards[cg.key]) {
      db.cards[cg.key] = { currentMonthSwipes: 0, confirmedNextWithdraw: 0 };
    }
    db.cards[cg.key].currentMonthSwipes = Math.max(0, db.cards[cg.key].currentMonthSwipes + signedAmount);

    if (/메디|제약|소모품|보톡스|필러|재료/.test(text)) {
      db.outflowTotals.supplyCard = Math.max(0, db.outflowTotals.supplyCard + signedAmount);
    } else if (/메타|광고|네이버|카카오|마케팅|파워링크/.test(text)) {
      db.outflowTotals.marketingCard = Math.max(0, db.outflowTotals.marketingCard + signedAmount);
    } else {
      db.outflowTotals.welfareOtherCard = Math.max(0, db.outflowTotals.welfareOtherCard + signedAmount);
    }

    const cleanTitle = maskCustomerName(
      text.replace(/\[.*?\]/g, '').replace(/[0-9,]+\s*원/g, '').replace(/일시불|승인취소|승인/g, '').trim()
    ).slice(0, 20);

    const tx = {
      id: 'tx-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      datetime: '오늘 ' + nowTime,
      type: 'CARD_SWIPE',
      badge: cg.badge + (isCancel ? '(취소)' : ''),
      title: cleanTitle || '사업자카드 결제',
      sub: isCancel ? `승인취소 차감 (${cg.sched})` : `통장 미출금 (${cg.sched} · 전월1~말일 기준)`,
      amount: signedAmount
    };
    db.transactions.unshift(tx);
    db.balances.updatedAt = 'PC로봇 수집 (' + nowTime + ')';
    return { ok: true, tx };
  }

  // 은행 입출금 처리 (카드사명 제거 후 은행 판별)
  const textWithoutCardNames = text.replace(/(신한|삼성|현대|국민|비씨|롯데|하나|우리)카드/g, '');
  let bank = 'woori';
  let bankLabel = '우리은행';
  if (/\[하나|하나은행/.test(textWithoutCardNames)) {
    bank = 'hana';
    bankLabel = '하나은행';
  } else if (/\[경남|경남은행/.test(textWithoutCardNames)) {
    bank = 'kyongnam';
    bankLabel = '경남은행';
  }

  const isWithdrawal = text.includes('출금') || text.includes('지급');
  const kwList = String(db.settings.internalKeywords || '집금,내통장,내부,피부과')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const isInternal = kwList.some(kw => text.includes(kw));

  if (isInternal) {
    if (parsedBalance !== null) {
      db.balances[bank] = parsedBalance;
    } else {
      db.balances[bank] = Math.max(0, db.balances[bank] + (isWithdrawal ? -rawAmount : rawAmount));
    }
    const tx = {
      id: 'tx-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      datetime: '오늘 ' + nowTime,
      type: 'INTERNAL',
      badge: '🔄 내부이체',
      title: bankLabel + (isWithdrawal ? ' 출금(내부이동)' : ' 입금(내부이동)'),
      sub: '해당 통장 잔액만 반영 · 매출/비용 합산 제외',
      amount: isWithdrawal ? -rawAmount : rawAmount
    };
    db.transactions.unshift(tx);
    db.balances.updatedAt = 'PC로봇 수집 (' + nowTime + ')';
    return { ok: true, tx };
  }

  if (!isWithdrawal) {
    if (parsedBalance !== null) {
      db.balances[bank] = parsedBalance;
    } else {
      db.balances[bank] += rawAmount;
    }

    const badge = bank === 'woori' ? '🟦 우리입금' : (bank === 'hana' ? '🟩 하나입금' : '🟧 경남입금');
    let title = '계좌 입금';
    let sub = parsedBalance !== null ? `잔액(${Math.round(parsedBalance / 10000)}만) 자동동기화` : '입금 반영';

    if (text.includes('갤럭시아')) {
      const r = db.settings.pgSplitRatio || { card: 0.8, naver: 0.12, kakao: 0.08 };
      const c = Math.round(rawAmount * r.card);
      const n = Math.round(rawAmount * r.naver);
      const k = rawAmount - c - n;
      db.inflowTotals.pgCard += c;
      db.inflowTotals.naverPay += n;
      db.inflowTotals.kakaoPay += k;
      db.pendingInflowsTotal = Math.max(0, db.pendingInflowsTotal - rawAmount);
      title = '갤럭시아머니트리';
      sub = `카드 ${Math.round(c / 10000)}만·N페이 ${Math.round(n / 10000)}만·카카오 ${Math.round(k / 10000)}만`;
    } else if (/신한카드|삼성카드|현대카드|국민카드|비씨카드|롯데카드|하나카드|우리카드/.test(text)) {
      const m = text.match(/(신한카드|삼성카드|현대카드|국민카드|비씨카드|롯데카드|하나카드|우리카드)/);
      const cardCo = m ? m[1] : '카드사';
      db.inflowTotals.wirelessCard += rawAmount;
      db.pendingInflowsTotal = Math.max(0, db.pendingInflowsTotal - rawAmount);
      title = cardCo + ' (무선단말기)';
      sub = bankLabel + ' 무선단말기 카드정산 입금';
    } else if (/강남언니|힐링페이퍼|언니가이드/.test(text)) {
      db.inflowTotals.platformKyongnam += rawAmount;
      db.pendingInflowsTotal = Math.max(0, db.pendingInflowsTotal - rawAmount);
      title = text.includes('언니가이드') ? '언니가이드 정산' : '강남언니 정산';
      sub = '경남은행 플랫폼 정산 입금';
    } else {
      db.inflowTotals.cashHana += rawAmount;
      const masked = maskCustomerName(
        text.replace(/\[.*?\]/g, '').replace(/[0-9,/:\s]+/g, ' ').replace(/빠른조회|입금|원|잔액/g, '').trim()
      );
      title = (masked || '고객') + '님 현금이체';
      sub = '하나은행 현금수입 (실명 자동마스킹)';
    }

    const tx = {
      id: 'tx-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      datetime: '오늘 ' + nowTime,
      type: 'BANK_IN',
      badge,
      title,
      sub,
      amount: rawAmount
    };
    db.transactions.unshift(tx);
    db.balances.updatedAt = 'PC로봇 수집 (' + nowTime + ')';
    return { ok: true, tx };
  } else {
    if (parsedBalance !== null) {
      db.balances[bank] = parsedBalance;
    } else {
      db.balances[bank] = Math.max(0, db.balances[bank] - rawAmount);
    }
    const tx = {
      id: 'tx-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      datetime: '오늘 ' + nowTime,
      type: 'BANK_OUT',
      badge: '📤 우리출금',
      title: maskCustomerName(text.replace(/\[.*?\]/g, '').slice(0, 18)),
      sub: '우리은행 지출 출금 반영',
      amount: -rawAmount
    };
    db.transactions.unshift(tx);
    db.balances.updatedAt = 'PC로봇 수집 (' + nowTime + ')';
    return { ok: true, tx };
  }
}

/**
 * 구글 시트 단일 원장 웹훅으로 현재 대시보드 상태(State Snapshot) 자동 업로드 (폴드5 실시간 열람용)
 */
function pushStateToGoogleSheet(db) {
  return new Promise((resolve) => {
    const webhookUrl = (db.settings && db.settings.webhookUrl) ? db.settings.webhookUrl.trim() : '';
    const secretToken = (db.settings && db.settings.secretToken) ? db.settings.secretToken.trim() : 'clinic-24';

    if (!webhookUrl || !webhookUrl.startsWith('https://')) {
      return resolve({ ok: false, skipped: true, reason: 'No webhookUrl configured' });
    }

    const payload = JSON.stringify({
      action: 'SAVE_STATE',
      token: secretToken,
      source: 'PC_AUTO_COLLECTOR',
      state: db
    });

    try {
      const urlObj = new URL(webhookUrl);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        // Google Apps Script 302 Redirect 처리
        if (res.statusCode === 302 && res.headers.location) {
          https.get(res.headers.location, (res2) => {
            let body = '';
            res2.on('data', chunk => { body += chunk; });
            res2.on('end', () => resolve({ ok: true, status: res2.statusCode, body }));
          }).on('error', err => resolve({ ok: false, error: err.message }));
          return;
        }
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
      });

      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.write(payload);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  maskCustomerName,
  detectCardGroup,
  parseBatchRecords,
  parseSingleTextLine,
  pushStateToGoogleSheet
};
