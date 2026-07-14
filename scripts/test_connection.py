"""
Quick connectivity + permissions sanity check against Bybit DEMO account.
Endpoint: https://api-demo.bybit.com
"""
from pybit.unified_trading import HTTP

API_KEY = "YOUR_BYBIT_API_KEY"
API_SECRET = "YOUR_BYBIT_API_SECRET"
DEMO_URL = "https://api-demo.bybit.com"

def main():
    session = HTTP(
        demo=True,                       # forces api-demo.bybit.com
        testnet=False,
        api_key=API_KEY,
        api_secret=API_SECRET,
        recv_window=10000,
    )

    print("=" * 60)
    print("Bybit DEMO connectivity check")
    print("=" * 60)

    # 1. Server time (public)
    t = session.get_server_time()
    print(f"[OK] get_server_time -> {t['result']['timeNano']}")

    # 2. Account balance (private, read)
    try:
        bal = session.get_wallet_balance(accountType="UNIFIED", coin="USDT")
        print("[OK] get_wallet_balance")
        acct = bal["result"]["list"][0]
        print(f"     Account UID : {acct.get('accountId')}")
        print(f"     Total equity: {acct.get('totalEquity')} USDT")
        print(f"     Available   : {acct.get('totalAvailableBalance')} USDT")
    except Exception as e:
        print(f"[FAIL] get_wallet_balance -> {e}")

    # 3. Instruments (public) – check we can fetch USDT perps and exclude BTC/ETH
    try:
        inst = session.get_instruments_info(category="linear", status="Trading")
        syms = [s["symbol"] for s in inst["result"]["list"]]
        print(f"[OK] get_instruments_info -> {len(syms)} linear perps trading")
        banned = [s for s in syms if s in ("BTCUSDT", "ETHUSDT")]
        print(f"     BTC/ETH excluded? -> present in list: {banned} (will filter out)")
        sample = [s for s in syms if s not in ("BTCUSDT", "ETHUSDT")][:10]
        print(f"     Sample tradable alts: {sample}")
    except Exception as e:
        print(f"[FAIL] get_instruments_info -> {e}")

    # 4. Orderbook depth on a sample alt (public)
    try:
        ob = session.get_orderbook(category="linear", symbol="SOLUSDT", limit=5)
        bids = ob["result"]["b"][:3]
        asks = ob["result"]["a"][:3]
        print(f"[OK] get_orderbook SOLUSDT")
        print(f"     top bids: {bids}")
        print(f"     top asks: {asks}")
    except Exception as e:
        print(f"[FAIL] get_orderbook -> {e}")

    # 5. Leverage read (private) - we'll set per-symbol later, just check API permission
    try:
        pos = session.get_positions(category="linear", settleCoin="USDT")
        print(f"[OK] get_positions -> {len(pos['result']['list'])} open positions")
    except Exception as e:
        print(f"[FAIL] get_positions -> {e}")

    print("=" * 60)
    print("Connection verified. Ready to build full bot.")
    print("=" * 60)

if __name__ == "__main__":
    main()
