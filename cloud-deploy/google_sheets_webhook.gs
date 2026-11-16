/**
 * 🏥 피부과 의원 24시간 무인 클라우드 문자(SMS) 수신 & 대시보드 동기화 웹훅 (보안·파서 검증 완료 버전)
 *
 * [3분 무료 배포 방법]
 * 1. 구글 드라이브에서 새 '구글 스프레드시트'를 만듭니다.
 * 2. 상단 메뉴 [확장 프로그램] -> [Apps Script]를 클릭합니다.
 * 3. 아래 코드에서 SECRET_TOKEN 값을 원장님만의 비밀번호(예: 'my-clinic-2026')로 바꿉니다.
 * 4. 우측 상단 [배포] -> [새 배포] -> 유형: [웹 앱]
 *    - 다음 사용자 인증 정보로 실행: '나'
 *    - 액세스 권한이 있는 사용자: '모든 사용자(Anyone)'
 * 5. 발급된 URL을 대시보드의 [☁️ 폴드5 클라우드 연결] 창과 폴드5 SMS Forwarder 앱에 등록합니다.
 */

var SECRET_TOKEN = 'clinic-21'; // 원장님 전용 비밀 토큰 (대시보드 설정창의 토큰과 동일하게 맞추세요)

function maskCustomerName(text) {
  // 한글 3글자 실명 패턴 마스킹 (예: 박지현 -> 박*현), 단 은행/카드/플랫폼 키워드 제외
  var ignore = ['우리은', '하나은', '경남은', '신한카', '삼성카', '현대카', '국민카', '비씨카', '롯데카', '하나카', '강남언', '언니가', '갤럭시', '머니트', '힐링페', '메디톡', '블루메', '일시불', '전월분'];
  return text.replace(/([가-힣])([가-힣])([가-힣])/g, function(match, c1, c2, c3) {
    var prefix = c1 + c2 + c3;
    for (var i = 0; i < ignore.length; i++) {
      if (prefix.indexOf(ignore[i]) !== -1) return match;
    }
    return c1 + '*' + c3;
  });
}

function parseSmsPayload(rawText) {
  var text = (rawText || '').trim();
  var isCancel = text.indexOf('취소') !== -1 || text.indexOf('환불') !== -1;

  // 1) '잔액 OO원' 분리 추출
  var balMatch = text.match(/잔액\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원?/);
  var balance = balMatch ? parseInt(balMatch[1].replace(/,/g, ''), 10) : null;

  // 잔액/누적 부분을 제거한 텍스트에서 반드시 '원'이 붙은 거래 금액만 추출 (카드번호 4자리 오인식 방지)
  var textWithoutBal = text.replace(/잔액\s*[0-9,]+\s*원?/g, '').replace(/누적\s*[0-9,]+\s*원?/g, '');
  var amtMatch = textWithoutBal.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원/);
  var amount = amtMatch ? parseInt(amtMatch[1].replace(/,/g, ''), 10) : 0;
  if (isCancel && amount > 0) {
    amount = -amount;
  }

  // 2) 은행/카드 말머리 우선 판별 ('하나카드'를 하나은행으로 오인식하지 않도록 카드사명 제거 후 은행 판별)
  var headerText = text.replace(/(신한|삼성|현대|국민|비씨|롯데|하나|우리)카드/g, '');
  var bank = 'woori';
  if (/\[하나|하나은행/.test(headerText)) bank = 'hana';
  else if (/\[경남은행|경남은행/.test(headerText)) bank = 'kyongnam';
  else if (/\[우리|우리은행/.test(headerText)) bank = 'woori';

  var isCardSwipe = text.indexOf('승인') !== -1 || (text.indexOf('카드') !== -1 && text.indexOf('입금') === -1 && text.indexOf('출금') === -1);

  return {
    text: maskCustomerName(text),
    amount: amount,
    balance: balance,
    bank: bank,
    isCardSwipe: isCardSwipe,
    isCancel: isCancel
  };
}

function checkAuth(e) {
  var paramToken = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';
  return paramToken === SECRET_TOKEN;
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : '{}');
    var token = (e.parameter && e.parameter.token) || body.token || '';
    if (token !== SECRET_TOKEN) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Invalid token' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['id', 'datetime', 'rawSms', 'amount', 'balance', 'bank', 'isCardSwipe', 'isCancel']);
    }

    var parsed = parseSmsPayload(body.text || body.message || '');
    var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    var id = 'tx-' + new Date().getTime();

    sheet.appendRow([
      id,
      now,
      parsed.text,
      parsed.amount,
      parsed.balance !== null ? parsed.balance : '',
      parsed.bank,
      parsed.isCardSwipe,
      parsed.isCancel
    ]);

    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      id: id,
      datetime: now,
      parsed: parsed
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  if (!checkAuth(e)) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: token required' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, items: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var startRow = Math.max(2, lastRow - 99);
  var values = sheet.getRange(startRow, 1, lastRow - startRow + 1, 8).getValues();
  var items = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var r = values[i];
    items.push({
      id: String(r[0]),
      datetime: String(r[1]),
      text: String(r[2]),
      amount: Number(r[3]) || 0,
      balance: r[4] === '' ? null : Number(r[4]),
      bank: String(r[5]),
      isCardSwipe: Boolean(r[6]),
      isCancel: Boolean(r[7])
    });
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true, items: items }))
    .setMimeType(ContentService.MimeType.JSON);
}
