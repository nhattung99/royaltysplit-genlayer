import json
import re
import pytest

CONTRACT_PATH = "contracts/royalty_split.py"

REF1 = "https://artists.spotify.com/c/royaltysplit-demo/stats"
REF2 = "https://www.youtube.com/watch/royaltysplitdemo"
REF3 = "https://charts.example.com/track/royaltysplit-demo"

# Hand check: 1000 * 6000 // 10000 = 600; payor keeps 1000 - 600 = 400.
DECLARED = 1000
BPS = 6000
ARTIST_AMT = 600
PAYOR_AMT = 400

# Hand check: 10001 * 6000 = 60006000; 60006000 // 10000 = 6000; payor = 4001.
DECLARED_REMAINDER = 10001
REMAINDER_ARTIST = 6000
REMAINDER_PAYOR = 4001


def _set_value(vm, amount):
    if hasattr(vm, "value"):
        try:
            vm.value = amount
        except Exception:
            pass
    if hasattr(vm, "_value"):
        vm._value = amount
    if hasattr(vm, "_refresh_gl_message"):
        vm._refresh_gl_message()


def _clear_value(vm):
    _set_value(vm, 0)


def _active_vm(direct_vm):
    try:
        from gltest.direct.loader import _get_active_vm
        return _get_active_vm() or direct_vm
    except Exception:
        return direct_vm


def sim_installMocks(vm, web=None, llm=None):
    """Install nondet mocks before every AI tx."""
    web = web or {}
    llm_payload = llm if isinstance(llm, str) or llm is None else json.dumps(llm)

    if hasattr(vm, "sim_installMocks"):
        vm.sim_installMocks({"web": web, "llm": llm_payload})
        return
    if hasattr(vm, "sim_install_mocks"):
        vm.sim_install_mocks({"web": web, "llm": llm_payload})
        return

    if hasattr(vm, "clear_mocks"):
        try:
            vm.clear_mocks()
        except Exception:
            pass
    for url, body in web.items():
        payload = body if isinstance(body, dict) else {"status": 200, "body": body}
        vm.mock_web(re.escape(url), payload)
    if llm_payload is not None:
        vm.mock_llm(".*", llm_payload)


def _parse(raw):
    if isinstance(raw, str):
        return json.loads(raw or "{}")
    return raw or {}


def _parse_list(raw):
    if isinstance(raw, str):
        return json.loads(raw or "[]")
    return raw or []


def _agreement(contract, agreement_id):
    return _parse(contract.get_agreement(agreement_id))


def _addr(account):
    if hasattr(account, "address"):
        return account.address
    if hasattr(account, "as_hex"):
        return account.as_hex
    return account


def _as_hex_addr(val):
    if val is None:
        return ""
    if isinstance(val, (bytes, bytearray)):
        return "0x" + bytes(val).hex()
    if hasattr(val, "as_hex"):
        try:
            return str(val.as_hex).lower()
        except Exception:
            pass
    if hasattr(val, "as_bytes"):
        try:
            return "0x" + bytes(val.as_bytes).hex()
        except Exception:
            pass
    s = str(val).strip().lower()
    if not s.startswith("0x") and len(s) == 40:
        return "0x" + s
    return s


def _account_addr(account):
    if hasattr(account, "as_hex"):
        return _as_hex_addr(account)
    if hasattr(account, "address"):
        return _as_hex_addr(account.address)
    return _as_hex_addr(account)


def _proxy_addr(proxy):
    for attr in ("address", "addr", "_address", "account"):
        if hasattr(proxy, attr):
            val = getattr(proxy, attr)
            if val is not None:
                return _as_hex_addr(val)
    return _as_hex_addr(proxy)


def _create(contract, vm, payor, artist, bps=BPS, urls=None, desc="Track XYZ streaming royalties — Q3 2026", period="Q3 2026"):
    vm.sender = payor
    _clear_value(vm)
    agreement_id = contract.create_agreement(
        _addr(artist),
        desc,
        bps,
        period,
        [REF1, REF2] if urls is None else urls,
    )
    return agreement_id


def _deposit(contract, vm, payor, agreement_id, amount=DECLARED):
    vm.sender = payor
    _set_value(vm, amount)
    contract.deposit_revenue(agreement_id)
    _clear_value(vm)


def _default_web():
    return {
        REF1: "Spotify public stats: 1.2M streams this quarter, steady week-over-week",
        REF2: "YouTube public page: 400k views, regular upload cadence",
        REF3: "Chart page: track held top 40 for 6 weeks this period",
    }


def _resolve(contract, vm, agreement_id, verdict, confidence=90, reason="Declared revenue matches public engagement", web=None, sender=None):
    if sender is not None:
        vm.sender = sender
    sim_installMocks(
        vm,
        web=web or _default_web(),
        llm={"verdict": verdict, "confidence": confidence, "reason": reason},
    )
    contract.resolve_agreement(agreement_id)


def _loaded_contract_mod(contract=None):
    import sys
    for _name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        if callable(getattr(mod, "_split_amounts", None)) and hasattr(mod, "RoyaltyAgreement"):
            return mod
    if contract is not None:
        inner = getattr(contract, "_contract", None) or getattr(contract, "__wrapped__", None)
        target = inner or contract
        meth = getattr(target, "resolve_agreement", None)
        func = getattr(meth, "__func__", meth) if meth is not None else None
        g = getattr(func, "__globals__", None) if func is not None else None
        if g is not None and callable(g.get("_split_amounts")):
            class _NS:
                pass
            ns = _NS()
            ns._split_amounts = g["_split_amounts"]
            ns._validator_agrees = g.get("_validator_agrees")
            ns._parse_verdict = g.get("_parse_verdict")
            return ns
    return None


def _install_selective_fail(monkeypatch, fail_when, payments):
    import gltest.direct.loader

    original_emit = gltest.direct.loader._EOAProxy.emit_transfer

    def wrapped(self, value=None, **kwargs):
        dest = _proxy_addr(self)
        amount = int(value or 0)
        if fail_when(dest, amount, payments):
            raise Exception("Simulated native transfer execution failure")
        payments.append({"to": dest, "amount": amount})
        return original_emit(self, value, **kwargs)

    monkeypatch.setattr(gltest.direct.loader._EOAProxy, "emit_transfer", wrapped)
    return original_emit


def _install_recorder(monkeypatch, payments):
    return _install_selective_fail(monkeypatch, lambda dest, amount, paid: False, payments)


def test_split_amounts_hand_calc_and_validator_is_binary(direct_vm, direct_deploy, direct_accounts):
    contract = direct_deploy(CONTRACT_PATH)
    mod = _loaded_contract_mod(contract)
    assert mod is not None, "royalty_split helpers not loaded"

    artist, payor = mod._split_amounts(DECLARED, BPS)
    assert int(artist) == ARTIST_AMT
    assert int(payor) == PAYOR_AMT
    assert int(artist) + int(payor) == DECLARED

    artist, payor = mod._split_amounts(DECLARED_REMAINDER, BPS)
    assert int(artist) == REMAINDER_ARTIST
    assert int(payor) == REMAINDER_PAYOR
    assert int(artist) + int(payor) == DECLARED_REMAINDER

    agrees = mod._validator_agrees
    plausible_high = {"verdict": "DATA_PLAUSIBLE", "confidence": 90, "reason": "ok"}
    plausible_low = {"verdict": "DATA_PLAUSIBLE", "confidence": 40, "reason": "thin"}
    disputed_high = {"verdict": "DATA_DISPUTED", "confidence": 88, "reason": "low"}
    assert agrees(plausible_high, {"verdict": "DATA_PLAUSIBLE", "confidence": 77, "reason": "x"}) is True
    assert agrees(plausible_high, plausible_low) is False
    assert agrees(plausible_high, disputed_high) is False
    assert agrees({"verdict": "", "confidence": 0}, {"verdict": "", "confidence": 10}) is True
    assert agrees({"verdict": "", "confidence": 0}, plausible_high) is False

    parsed = mod._parse_verdict('{"verdict":"DATA_PLAUSIBLE","confidence":91,"reason":"ok","revenue":999999}')
    assert parsed["verdict"] == "DATA_PLAUSIBLE"
    assert "revenue" not in parsed
    assert parsed["confidence"] == 91


def test_happy_path_plausible_pays_exact_split(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    assert agreement_id == "0"
    row = _agreement(contract, agreement_id)
    assert row["status"] == "AWAITING_DEPOSIT"
    assert row["artist_split_bps"] == BPS
    assert row["declared_revenue_amount"] == "0"
    assert row["artist_amount"] == "0"
    assert row["payor_share"] == "0"

    _deposit(contract, vm, payor, agreement_id, DECLARED)
    row = _agreement(contract, agreement_id)
    assert row["status"] == "DEPOSITED"
    assert row["declared_revenue_amount"] == str(DECLARED)
    assert row["artist_amount"] == str(ARTIST_AMT)
    assert row["payor_share"] == str(PAYOR_AMT)

    payments = []
    _install_recorder(monkeypatch, payments)
    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 95, "Streams support the declared total", sender=payor)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "RESOLVED"
    assert row["verdict"] == "DATA_PLAUSIBLE"
    assert row["confidence"] == 95
    assert row["artist_paid"] is True
    assert row["payor_share_returned"] is True
    assert row["disputed_refunded"] is False
    assert row["settled"] is True
    assert row["artist_amount"] == str(ARTIST_AMT)
    assert row["payor_share"] == str(PAYOR_AMT)
    assert [p["amount"] for p in payments] == [ARTIST_AMT, PAYOR_AMT]
    assert payments[0]["to"] == _account_addr(artist)
    assert payments[1]["to"] == _account_addr(payor)
    assert sum(p["amount"] for p in payments) == DECLARED


def test_remainder_split_is_exact(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    _deposit(contract, vm, payor, agreement_id, DECLARED_REMAINDER)
    row = _agreement(contract, agreement_id)
    assert row["artist_amount"] == str(REMAINDER_ARTIST)
    assert row["payor_share"] == str(REMAINDER_PAYOR)

    payments = []
    _install_recorder(monkeypatch, payments)
    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 91, "Plausible", sender=artist)

    assert [p["amount"] for p in payments] == [REMAINDER_ARTIST, REMAINDER_PAYOR]
    assert sum(p["amount"] for p in payments) == DECLARED_REMAINDER
    row = _agreement(contract, agreement_id)
    assert row["status"] == "RESOLVED"
    assert row["artist_paid"] is True
    assert row["payor_share_returned"] is True


def test_happy_path_disputed_refunds_payor_in_full(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    _deposit(contract, vm, payor, agreement_id, DECLARED)

    payments = []
    _install_recorder(monkeypatch, payments)
    _resolve(contract, vm, agreement_id, "DATA_DISPUTED", 92, "Public streams are far above the declared total", sender=artist)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "DATA_DISPUTED_REFUNDED"
    assert row["verdict"] == "DATA_DISPUTED"
    assert row["disputed_refunded"] is True
    assert row["artist_paid"] is False
    assert row["payor_share_returned"] is False
    assert row["settled"] is True
    assert [p["amount"] for p in payments] == [DECLARED]
    assert payments[0]["to"] == _account_addr(payor)


def test_low_confidence_holds_escrow_then_reresolve(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    _deposit(contract, vm, payor, agreement_id, DECLARED)

    payments = []
    _install_recorder(monkeypatch, payments)
    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 42, "Not enough public detail", sender=payor)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "LOW_CONFIDENCE_DISPUTED"
    assert row["verdict"] == "DATA_PLAUSIBLE"
    assert row["confidence"] == 42
    assert row["declared_revenue_amount"] == str(DECLARED)
    assert row["artist_paid"] is False
    assert row["payor_share_returned"] is False
    assert row["disputed_refunded"] is False
    assert row["settled"] is False
    assert payments == []

    vm.sender = artist
    _clear_value(vm)
    contract.add_more_evidence(agreement_id, [REF3])
    row = _agreement(contract, agreement_id)
    assert REF3 in row["reference_urls"]
    assert row["declared_revenue_amount"] == str(DECLARED)
    assert row["status"] == "LOW_CONFIDENCE_DISPUTED"

    monkeypatch.undo()
    payments = []
    _install_recorder(monkeypatch, payments)
    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 93, "Chart page confirms the quarter", sender=payor)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "RESOLVED"
    assert row["confidence"] == 93
    assert [p["amount"] for p in payments] == [ARTIST_AMT, PAYOR_AMT]


def test_bps_and_reference_and_same_party_blocked(direct_vm, direct_deploy, direct_accounts):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    for bad_bps in (0, 10000, 10001, -1):
        with pytest.raises(Exception):
            _create(contract, vm, payor, artist, bps=bad_bps)

    with pytest.raises(Exception):
        _create(contract, vm, payor, artist, urls=[REF1])

    with pytest.raises(Exception):
        _create(contract, vm, payor, artist, urls=[])

    with pytest.raises(Exception):
        _create(contract, vm, payor, payor)

    with pytest.raises(Exception):
        _create(contract, vm, payor, artist, desc="   ")

    with pytest.raises(Exception):
        _create(contract, vm, payor, artist, period="  ")

    agreement_id = _create(contract, vm, payor, artist)
    assert agreement_id == "0"


def test_deposit_guards_and_double_deposit_double_resolve(direct_vm, direct_deploy, direct_accounts):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    stranger = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)

    vm.sender = artist
    _set_value(vm, DECLARED)
    with pytest.raises(Exception):
        contract.deposit_revenue(agreement_id)
    _clear_value(vm)

    vm.sender = payor
    _set_value(vm, 0)
    with pytest.raises(Exception):
        contract.deposit_revenue(agreement_id)

    # 1 * 6000 // 10000 = 0, so the artist side would be a zero transfer.
    _set_value(vm, 1)
    with pytest.raises(Exception):
        contract.deposit_revenue(agreement_id)
    _clear_value(vm)
    assert _agreement(contract, agreement_id)["status"] == "AWAITING_DEPOSIT"

    _deposit(contract, vm, payor, agreement_id, DECLARED)
    vm.sender = payor
    _set_value(vm, DECLARED)
    with pytest.raises(Exception):
        contract.deposit_revenue(agreement_id)
    _clear_value(vm)

    vm.sender = stranger
    _clear_value(vm)
    with pytest.raises(Exception):
        contract.add_more_evidence(agreement_id, [REF3])

    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 90, "ok", sender=payor)
    assert _agreement(contract, agreement_id)["status"] == "RESOLVED"

    with pytest.raises(Exception):
        _resolve(contract, vm, agreement_id, "DATA_DISPUTED", 99, "too late", sender=payor)

    vm.sender = payor
    with pytest.raises(Exception):
        contract.retry_resolution(agreement_id)


def test_invalid_json_holds_escrow(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    _deposit(contract, vm, payor, agreement_id, DECLARED)

    payments = []
    _install_recorder(monkeypatch, payments)
    vm.sender = payor
    sim_installMocks(vm, web=_default_web(), llm="this is not json")
    contract.resolve_agreement(agreement_id)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "LOW_CONFIDENCE_DISPUTED"
    assert row["confidence"] == 0
    assert row["declared_revenue_amount"] == str(DECLARED)
    assert row["settled"] is False
    assert payments == []


def test_plausible_artist_fail_only_then_retry_no_double_pay(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    _deposit(contract, vm, payor, agreement_id, DECLARED)

    payments = []
    attempts = {"n": 0}

    def fail_first(_dest, _amount, paid):
        attempts["n"] += 1
        return attempts["n"] == 1

    _install_selective_fail(monkeypatch, fail_first, payments)
    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 94, "Plausible", sender=payor)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["artist_paid"] is False
    assert row["payor_share_returned"] is True
    assert "Artist payout failed" in row["verdict_reason"]
    assert [p["amount"] for p in payments] == [PAYOR_AMT]
    assert payments[0]["to"] == _account_addr(payor)

    monkeypatch.undo()
    retry_payments = []
    _install_recorder(monkeypatch, retry_payments)
    vm.sender = artist
    _clear_value(vm)
    contract.retry_resolution(agreement_id)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "RESOLVED"
    assert row["artist_paid"] is True
    assert row["payor_share_returned"] is True
    assert [p["amount"] for p in retry_payments] == [ARTIST_AMT]
    assert retry_payments[0]["to"] == _account_addr(artist)


def test_plausible_payor_fail_only_then_retry_no_double_pay(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    _deposit(contract, vm, payor, agreement_id, DECLARED)

    payments = []

    def fail_second(_dest, _amount, paid):
        return len(paid) == 1

    _install_selective_fail(monkeypatch, fail_second, payments)
    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 90, "Plausible", sender=artist)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["artist_paid"] is True
    assert row["payor_share_returned"] is False
    assert "Payor share return failed" in row["verdict_reason"]
    assert [p["amount"] for p in payments] == [ARTIST_AMT]
    assert payments[0]["to"] == _account_addr(artist)

    monkeypatch.undo()
    retry_payments = []
    _install_recorder(monkeypatch, retry_payments)
    vm.sender = payor
    _clear_value(vm)
    contract.retry_resolution(agreement_id)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "RESOLVED"
    assert row["artist_paid"] is True
    assert row["payor_share_returned"] is True
    assert [p["amount"] for p in retry_payments] == [PAYOR_AMT]
    assert retry_payments[0]["to"] == _account_addr(payor)


def test_plausible_both_fail_then_retry_pays_each_once(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    _deposit(contract, vm, payor, agreement_id, DECLARED)

    payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: True, payments)
    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 90, "Plausible", sender=payor)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "PAYOUT_FAILED"
    assert row["artist_paid"] is False
    assert row["payor_share_returned"] is False
    assert payments == []

    monkeypatch.undo()
    retry_payments = []
    _install_recorder(monkeypatch, retry_payments)
    vm.sender = payor
    _clear_value(vm)
    contract.retry_resolution(agreement_id)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "RESOLVED"
    assert row["artist_paid"] is True
    assert row["payor_share_returned"] is True
    assert [p["amount"] for p in retry_payments] == [ARTIST_AMT, PAYOR_AMT]
    assert sum(p["amount"] for p in retry_payments) == DECLARED


def test_disputed_refund_fail_then_retry_once(direct_vm, direct_deploy, direct_accounts, monkeypatch):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    _deposit(contract, vm, payor, agreement_id, DECLARED)

    payments = []
    _install_selective_fail(monkeypatch, lambda dest, amount, paid: True, payments)
    _resolve(contract, vm, agreement_id, "DATA_DISPUTED", 96, "Implausible", sender=payor)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "REFUND_FAILED"
    assert row["disputed_refunded"] is False
    assert row["artist_paid"] is False
    assert row["settled"] is False
    assert "Disputed refund failed" in row["verdict_reason"]
    assert payments == []

    monkeypatch.undo()
    retry_payments = []
    _install_recorder(monkeypatch, retry_payments)
    vm.sender = payor
    _clear_value(vm)
    contract.retry_resolution(agreement_id)

    row = _agreement(contract, agreement_id)
    assert row["status"] == "DATA_DISPUTED_REFUNDED"
    assert row["disputed_refunded"] is True
    assert row["settled"] is True
    assert row["artist_paid"] is False
    assert [p["amount"] for p in retry_payments] == [DECLARED]
    assert retry_payments[0]["to"] == _account_addr(payor)

    with pytest.raises(Exception):
        contract.retry_resolution(agreement_id)


def test_retry_blocked_for_outsider_and_wrong_status(direct_vm, direct_deploy, direct_accounts):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    stranger = direct_accounts[3]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    agreement_id = _create(contract, vm, payor, artist)
    vm.sender = payor
    _clear_value(vm)
    with pytest.raises(Exception):
        contract.retry_resolution(agreement_id)

    _deposit(contract, vm, payor, agreement_id, DECLARED)
    vm.sender = artist
    with pytest.raises(Exception):
        contract.retry_resolution(agreement_id)

    _resolve(contract, vm, agreement_id, "DATA_PLAUSIBLE", 30, "thin", sender=payor)
    assert _agreement(contract, agreement_id)["status"] == "LOW_CONFIDENCE_DISPUTED"
    vm.sender = stranger
    with pytest.raises(Exception):
        contract.retry_resolution(agreement_id)
    with pytest.raises(Exception):
        contract.add_more_evidence(agreement_id, [REF3])


def test_list_count_and_owner(direct_vm, direct_deploy, direct_accounts):
    payor = direct_accounts[1]
    artist = direct_accounts[2]
    contract = direct_deploy(CONTRACT_PATH)
    vm = _active_vm(direct_vm)

    assert contract.get_agreement_count() == 0
    first = _create(contract, vm, payor, artist, period="Q3 2026")
    second = _create(contract, vm, payor, artist, period="Q4 2026", desc="Track ABC streaming royalties — Q4 2026")
    assert first == "0"
    assert second == "1"
    assert contract.get_agreement_count() == 2

    listed = _parse_list(contract.list_agreements())
    assert len(listed) == 2
    assert listed[0]["agreement_id"] == "0"
    assert listed[1]["period_label"] == "Q4 2026"
    assert "reference_urls" not in listed[0]

    from gltest.direct.loader import create_address
    owner = str(contract.get_owner()).lower()
    deployer = _account_addr(create_address("default_sender"))
    assert owner == deployer
