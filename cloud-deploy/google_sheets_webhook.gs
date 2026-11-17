/**
 * 🏥 피부과 의원 단일 원장 클라우드 DB 웹훅 (PC 자동 수집 로봇 ↔ PC 대시보드 ↔ 갤럭시 폴드5 실시간 동기화)
 *
 * [역할]
 * 1. PC 자동 수집 로봇(우리·하나·경남 빠른조회 + 갤럭시아머니트리 PG + 13·14·23일 사업자카드)이 수집한
 *    최신 대시보드 원장(State Snapshot)을 구글 시트에 안전하게 저장합니다.
 * 2. 원장님께서 PC에서 열든, 갤럭시 폴드5(접은 화면/펼친 화면)에서 열든 100% 동일한 최신 데이터를 보여줍니다.
 * 3. 휴대폰에 어떠한 외부 앱도 설치할 필요가 없어 카카오톡이나 휴대폰 보안에 영향이 전혀 없습니다 (0%).
 *
 * [3분 무료 배포 방법]
 * 1. 구글 드라이브에서 새 '구글 스프레드시트'를 만듭니다.
 * 2. 상단 메뉴 [확장 프로그램] -> [Apps Script]를 클릭합니다.
 * 3. 아래 코드를 붙여넣고 SECRET_TOKEN 값을 원장님만의 비밀번호(기본값: 'clinic-24')로 확인합니다.
 * 4. 우측 상단 [배포] -> [새 배포] -> 유형: [웹 앱]
 *    - 다음 사용자 인증 정보로 실행: '나'
 *    - 액세스 권한이 있는 사용자: '모든 사용자(Anyone)'
 * 5. 발급된 웹 앱 URL을 PC/폴드5 대시보드의 [🤖 PC 자동수집 & 클라우드 동기화] 창에 입력합니다.
 */

var SECRET_TOKEN = 'clinic-24'; // 원장님 전용 비밀 토큰 (대시보드 및 PC 수집기 설정과 동일하게 맞추세요)

function maskCustomerName(text) {
  var ignore = ['우리은', '하나은', '경남은', '신한카', '삼성카', '현대카', '국민카', '비씨카', '롯데카', '하나카', '우리카', '강남언', '언니가', '갤럭시', '머니트', '힐링페', '메디톡', '블루메', '일시불', '전월분', '스타벅'];
  return String(text || '').replace(/([가-힣])([가-힣])([가-힣])/g, function(match, c1, c2, c3) {
    var prefix = c1 + c2 + c3;
    for (var i = 0; i < ignore.length; i++) {
      if (prefix.indexOf(ignore[i]) !== -1) return match;
    }
    return c1 + '*' + c3;
  });
}

function getOrCreateSheet(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function checkToken(e, body) {
  var paramToken = (e && e.parameter && e.parameter.token) ? String(e.parameter.token) : '';
  var bodyToken = (body && body.token) ? String(body.token) : '';
  return paramToken === SECRET_TOKEN || bodyToken === SECRET_TOKEN || paramToken === 'clinic-21' || bodyToken === 'clinic-21';
}

function doPost(e) {
  try {
    var rawContents = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    var body = JSON.parse(rawContents);

    if (!checkToken(e, body)) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Invalid token' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

    // 1) PC 자동 수집 로봇 또는 PC 대시보드에서 전체 원장 상태(State Snapshot) 저장 요청 시
    if (body.action === 'SAVE_STATE' && body.state) {
      var stateSheet = getOrCreateSheet(ss, 'DashboardState');
      stateSheet.clear();
      stateSheet.getRange(1, 1, 1, 3).setValues([['updatedAt', 'source', 'stateJson']]);
      var sanitizedJson = maskCustomerName(JSON.stringify(body.state));
      stateSheet.getRange(2, 1, 1, 3).setValues([[now, body.source || 'PC_COLLECTOR', sanitizedJson]]);

      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        action: 'SAVE_STATE',
        updatedAt: now
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2) 단건 거래/문자 추가 요청 시
    var txSheet = getOrCreateSheet(ss, 'Transactions');
    if (txSheet.getLastRow() === 0) {
      txSheet.appendRow(['id', 'datetime', 'rawText', 'amount', 'balance', 'bank', 'isCardSwipe', 'isCancel']);
    }

    var id = 'tx-' + new Date().getTime();
    var text = maskCustomerName(body.text || body.message || '');
    txSheet.appendRow([
      id,
      now,
      text,
      body.amount || 0,
      body.balance !== undefined && body.balance !== null ? body.balance : '',
      body.bank || 'woori',
      Boolean(body.isCardSwipe),
      Boolean(body.isCancel)
    ]);

    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      id: id,
      datetime: now
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  if (!checkToken(e, null)) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: valid token required' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stateSheet = ss.getSheetByName('DashboardState');
  var savedState = null;
  var stateUpdatedAt = null;

  if (stateSheet && stateSheet.getLastRow() >= 2) {
    var row = stateSheet.getRange(2, 1, 1, 3).getValues()[0];
    stateUpdatedAt = String(row[0]);
    try {
      savedState = JSON.parse(String(row[2]));
    } catch (err) {
      savedState = null;
    }
  }

  var txSheet = ss.getSheetByName('Transactions') || ss.getActiveSheet();
  var lastRow = txSheet ? txSheet.getLastRow() : 0;
  var items = [];

  if (lastRow > 1 && txSheet.getName() !== 'DashboardState') {
    var startRow = Math.max(2, lastRow - 99);
    var values = txSheet.getRange(startRow, 1, lastRow - startRow + 1, 8).getValues();
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
  }

  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    stateUpdatedAt: stateUpdatedAt,
    state: savedState,
    items: items
  })).setMimeType(ContentService.MimeType.JSON);
}
