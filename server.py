import http.server
import json
import os
import re
from datetime import datetime
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", 3080))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_FILE = os.path.join(DATA_DIR, "db.json")
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(PUBLIC_DIR, exist_ok=True)

INITIAL_DB = {
    "settings": {
        "clinicName": "피부과 의원 자금·손익 관제",
        "officialCutoffDay": 21,
        "bepTarget": 108000000,
        "pgSplitRatio": {"card": 0.80, "naver": 0.12, "kakao": 0.08, "feeRate": 0.028},
        "taxReserveRate": 0.085,
    },
    "balances": {
        "woori": 52180000,
        "hana": 18900000,
        "kyongnam": 13440000,
        "updatedAt": "2026-11-16 12:30",
    },
    "pendingInflows": {
        "galaxiaPg": 12450000,
        "wirelessCard": 4600000,
        "platform": 2400000,
    },
    "cards": {
        "card14": {
            "name": "1차 일반 사업자카드 (14일 출금)",
            "withdrawDay": 14,
            "cycleDesc": "전월 1일 ~ 전월 말일 사용분",
            "confirmedNextWithdraw": 0,
            "lastWithdrawnAmount": 14800000,
            "lastWithdrawnDate": "2026-11-14",
            "currentMonthSwipes": 8920000,
        },
        "card20": {
            "name": "2차 경남은행 카드 (20일 출금)",
            "withdrawDay": 20,
            "cycleDesc": "전월 1일 ~ 전월 말일 사용분",
            "confirmedNextWithdraw": 11400000,
            "lastWithdrawnAmount": 10200000,
            "lastWithdrawnDate": "2026-10-20",
            "currentMonthSwipes": 9720000,
        },
        "scheduledSupplyTransfer20": 8000000,
    },
    "transactions": [
        {
            "id": "tx-101",
            "datetime": "2026-11-16 11:15",
            "type": "BANK_IN",
            "bank": "woori",
            "rawSender": "갤럭시아머니트리",
            "category": "PG_SETTLEMENT",
            "subBreakdown": {"card": 5360000, "naver": 804000, "kakao": 536000, "fee": 190000},
            "amount": 6700000,
            "balanceAfter": 52180000,
            "memo": "유선단말기 PG 정산 (카드·N페이·카카오페이 자동분해)",
        },
        {
            "id": "tx-102",
            "datetime": "2026-11-16 10:42",
            "type": "BANK_IN",
            "bank": "hana",
            "rawSender": "박지현 고객님",
            "category": "CASH_TRANSFER",
            "amount": 550000,
            "balanceAfter": 18900000,
            "memo": "하나은행 고객 계좌이체 현금수입",
        },
        {
            "id": "tx-103",
            "datetime": "2026-11-16 10:15",
            "type": "CARD_SWIPE",
            "cardType": "card14",
            "rawSender": "메타(인스타) 광고 자동결제",
            "category": "EXP_MARKETING",
            "amount": 900000,
            "withdrawSchedule": "12/14 출금예정",
            "memo": "카드 결제시점 지출 반영 (통장 미출금 · 12/14 출금예정)",
        },
        {
            "id": "tx-104",
            "datetime": "2026-11-15 16:40",
            "type": "CARD_SWIPE",
            "cardType": "card20",
            "rawSender": "(주)블루메디칼 소모품",
            "category": "EXP_SUPPLY_CARD",
            "amount": 1850000,
            "withdrawSchedule": "12/20 경남카드 출금",
            "memo": "경남은행 카드 결제시점 지출 반영 (12/20 출금예정)",
        },
        {
            "id": "tx-105",
            "datetime": "2026-11-15 14:10",
            "type": "BANK_IN",
            "bank": "kyongnam",
            "rawSender": "강남언니(힐링페이퍼)",
            "category": "PLATFORM_GANGNAM",
            "amount": 1890000,
            "balanceAfter": 13440000,
            "memo": "강남언니 플랫폼 정산 입금 (경남은행)",
        },
        {
            "id": "tx-106",
            "datetime": "2026-11-15 11:05",
            "type": "BANK_IN",
            "bank": "woori",
            "rawSender": "신한카드",
            "category": "WIRELESS_CARD",
            "amount": 1620000,
            "balanceAfter": 45480000,
            "memo": "무선단말기 카드사 정산 입금 (우리은행)",
        },
        {
            "id": "tx-107",
            "datetime": "2026-11-14 18:00",
            "type": "BANK_OUT",
            "bank": "woori",
            "rawSender": "1차사업자카드 (10월분)",
            "category": "CARD_BILL_SETTLEMENT",
            "amount": 14800000,
            "balanceAfter": 43860000,
            "memo": "14일 카드대금 출금 완료 (10월 1~31일 사용분)",
        },
        {
            "id": "tx-108",
            "datetime": "2026-11-12 15:30",
            "type": "INTERNAL_TRANSFER",
            "bank": "hana_to_woori",
            "rawSender": "하나 ➔ 우리 내부이체",
            "category": "INTERNAL_TRANSFER",
            "amount": 10000000,
            "balanceAfter": 58660000,
            "memo": "내부 자금이동 (수입·지출 중복 자동 제외)",
        },
    ],
}


def load_db():
    if not os.path.exists(DB_FILE):
        save_db(INITIAL_DB)
    with open(DB_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_db(db):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)


def parse_incoming_sms(raw_text, db):
    text = (raw_text or "").strip()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    amounts = re.findall(r"([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원", text)
    primary_amount = int(amounts[0].replace(",", "")) if amounts else 0

    bal_match = re.search(r"잔액\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원?", text)
    parsed_balance = int(bal_match.group(1).replace(",", "")) if bal_match else None

    # 1) 신용카드 승인 문자 (아직 통장 미출금 · 결제시점 대시보드 즉시 반영)
    if "승인" in text or ("카드" in text and "입금" not in text and "출금" not in text):
        is_kyongnam = any(k in text for k in ["경남", "BC", "비씨"])
        card_key = "card20" if is_kyongnam else "card14"

        if re.search(r"메타|광고|네이버|카카오|강남언니|마케팅|파워링크", text, re.I):
            category = "EXP_MARKETING"
            label = "마케팅·광고비"
        elif re.search(r"메디|제약|약품|소모품|보톡스|필러|니들|재료", text, re.I):
            category = "EXP_SUPPLY_CARD"
            label = "의약품·소모품 재료비"
        elif re.search(r"식당|배달|식대|카페|스타벅스|편의점|마트", text, re.I):
            category = "EXP_WELFARE"
            label = "직원 식대·복리후생"
        else:
            category = "EXP_OTHER_CARD"
            label = "원내 비품·기타"

        db["cards"][card_key]["currentMonthSwipes"] += primary_amount
        schedule = "익월 20일 경남카드 출금" if is_kyongnam else "익월 14일 1차카드 출금"

        tx = {
            "id": f"tx-{int(datetime.now().timestamp() * 1000)}",
            "datetime": now_str,
            "type": "CARD_SWIPE",
            "cardType": card_key,
            "rawSender": text[:28],
            "category": category,
            "amount": primary_amount,
            "withdrawSchedule": schedule,
            "memo": f"{label} · 미출금 ({schedule})",
        }
        db["transactions"].insert(0, tx)
        db["balances"]["updatedAt"] = now_str
        return {"ok": True, "parsedType": "CARD_SWIPE", "tx": tx}

    # 2) 은행 입출금 문자 (우리 / 하나 / 경남)
    bank = "woori"
    if "하나" in text:
        bank = "hana"
    elif "경남" in text:
        bank = "kyongnam"

    is_deposit = "입금" in text or ("출금" not in text and "지급" not in text)

    # 내부 통장 간 이체 자동 감지
    if (bank == "woori" and is_deposit and re.search(r"하나|경남|내통장|집금", text)) or (
        bank in ("hana", "kyongnam") and not is_deposit and re.search(r"우리|내통장|집금", text)
    ):
        if parsed_balance is not None:
            db["balances"][bank] = parsed_balance
        tx = {
            "id": f"tx-{int(datetime.now().timestamp() * 1000)}",
            "datetime": now_str,
            "type": "INTERNAL_TRANSFER",
            "bank": bank,
            "rawSender": "통장 간 내부이체",
            "category": "INTERNAL_TRANSFER",
            "amount": primary_amount,
            "balanceAfter": db["balances"][bank],
            "memo": "내부 자금이동 (수입·지출 중복 자동 제외)",
        }
        db["transactions"].insert(0, tx)
        db["balances"]["updatedAt"] = now_str
        return {"ok": True, "parsedType": "INTERNAL_TRANSFER", "tx": tx}

    if is_deposit:
        if parsed_balance is not None:
            db["balances"][bank] = parsed_balance
        else:
            db["balances"][bank] += primary_amount

        sub_breakdown = None
        if "갤럭시아" in text:
            category = "PG_SETTLEMENT"
            raw_sender = "갤럭시아머니트리"
            r = db["settings"]["pgSplitRatio"]
            c_amt = round(primary_amount * r["card"])
            n_amt = round(primary_amount * r["naver"])
            k_amt = primary_amount - c_amt - n_amt
            sub_breakdown = {
                "card": c_amt,
                "naver": n_amt,
                "kakao": k_amt,
                "fee": round(primary_amount * r["feeRate"]),
            }
            memo = f"갤럭시아PG 정산 (카드 {c_amt//10000}만 / N페이 {n_amt//10000}만 / 카카오 {k_amt//10000}만)"
        elif re.search(r"신한카드|삼성카드|현대카드|국민카드|비씨카드|롯데카드|하나카드", text):
            category = "WIRELESS_CARD"
            m = re.search(r"(신한카드|삼성카드|현대카드|국민카드|비씨카드|롯데카드|하나카드)", text)
            raw_sender = m.group(1) if m else "무선단말기 카드"
            memo = "무선단말기 카드사 정산 입금"
        elif re.search(r"강남언니|힐링페이퍼", text):
            category = "PLATFORM_GANGNAM"
            raw_sender = "강남언니 정산"
            memo = "강남언니 플랫폼 정산 입금 (경남)"
        elif "언니가이드" in text:
            category = "PLATFORM_UNNI"
            raw_sender = "언니가이드 정산"
            memo = "언니가이드 플랫폼 정산 입금 (경남)"
        else:
            category = "CASH_TRANSFER"
            raw_sender = "고객 현금이체" if bank == "hana" else "기타 입금"
            memo = "하나은행 고객 계좌이체 현금수입"

        tx = {
            "id": f"tx-{int(datetime.now().timestamp() * 1000)}",
            "datetime": now_str,
            "type": "BANK_IN",
            "bank": bank,
            "rawSender": raw_sender,
            "category": category,
            "subBreakdown": sub_breakdown,
            "amount": primary_amount,
            "balanceAfter": db["balances"][bank],
            "memo": memo,
        }
        db["transactions"].insert(0, tx)
        db["balances"]["updatedAt"] = now_str
        return {"ok": True, "parsedType": "BANK_IN", "tx": tx}
    else:
        if parsed_balance is not None:
            db["balances"][bank] = parsed_balance
        else:
            db["balances"][bank] -= primary_amount

        if re.search(r"급여|월급|인건비", text):
            category = "EXP_PAYROLL"
            raw_sender = "직원 급여 (5일)"
            memo = "매월 5일 직원 급여 출금"
        elif re.search(r"리스|캐피탈|렌탈", text):
            category = "EXP_LEASE"
            raw_sender = "장비 리스료 (5일)"
            memo = "매월 5일 장비 리스료 출금"
        elif re.search(r"원천세|4대보험|건강보험|국민연금|세금", text):
            category = "EXP_TAX_INS"
            raw_sender = "원천세·4대보험 (10일)"
            memo = "매월 10일 원천세·4대보험 출금"
        elif re.search(r"경남카드|경남BC|카드대금", text):
            category = "CARD_BILL_SETTLEMENT"
            raw_sender = "사업자카드 출금 (14·20일)"
            memo = "사업자 신용카드 대금 출금 완료"
        else:
            category = "EXP_SUPPLY_CASH"
            raw_sender = "재료비·운영 출금"
            memo = "우리은행 재료비 이체 및 운영 출금"

        tx = {
            "id": f"tx-{int(datetime.now().timestamp() * 1000)}",
            "datetime": now_str,
            "type": "BANK_OUT",
            "bank": bank,
            "rawSender": raw_sender,
            "category": category,
            "amount": primary_amount,
            "balanceAfter": db["balances"][bank],
            "memo": memo,
        }
        db["transactions"].insert(0, tx)
        db["balances"]["updatedAt"] = now_str
        return {"ok": True, "parsedType": "BANK_OUT", "tx": tx}


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            db = load_db()
            payload = json.dumps(db, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(payload)
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"

        if parsed.path == "/api/webhook/sms":
            data = json.loads(raw_body or "{}")
            db = load_db()
            res = parse_incoming_sms(data.get("text") or data.get("message") or "", db)
            save_db(db)
            out = json.dumps({**res, "state": db}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(out)
            return

        if parsed.path == "/api/reset":
            save_db(INITIAL_DB)
            out = json.dumps({"ok": True, "state": INITIAL_DB}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(out)
            return

        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    print(f"Clinic Cashflow Dashboard running on http://localhost:{PORT}")
    with http.server.ThreadingHTTPServer(("0.0.0.0", PORT), DashboardHandler) as httpd:
        httpd.serve_forever()
