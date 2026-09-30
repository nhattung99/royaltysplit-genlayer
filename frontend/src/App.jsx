import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Music,
  Wallet,
  Coins,
  Sparkles,
  RefreshCw,
  ClipboardPaste,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Info,
  ExternalLink,
  RotateCcw,
  Loader2,
  Share2,
  ShieldCheck,
} from 'lucide-react';
import {
  DEFAULT_CONTRACT_ADDRESS,
  isValidContractAddress,
  isEthAddress,
  switchToGenlayerStudionet,
  sendContractTransaction,
  waitForFinalizedTx,
  waitForContractEffect,
  readContractState,
  parseGenToWei,
  formatWeiToGen,
  sanitizeGenInput,
  weiFromField,
  parseSplitPercent,
  percentToBps,
  formatBpsAsPercent,
  computeSplitPreview,
  splitBothPositive,
  sideLabel,
  sameAddress,
  txExplorerUrl,
  formatWriteError,
} from './genlayerClient.js';
import { SPLIT_PRESETS, REVENUE_PRESETS, PERIOD_PRESETS, URL_HINTS } from './data/presets.js';

const STORAGE_KEY = 'royaltysplit_contract_address';

const STATUS_LABEL = {
  AWAITING_DEPOSIT: 'Chờ escrow',
  DEPOSITED: 'Đã escrow',
  LOW_CONFIDENCE_DISPUTED: 'Độ tin cậy thấp',
  RESOLVED: 'Đã chia',
  DATA_DISPUTED_REFUNDED: 'Đã hoàn cho payor',
  PAYOUT_FAILED: 'Chia lỗi một phần',
  REFUND_FAILED: 'Hoàn tiền lỗi',
};

const loadInitialAddress = () => {
  if (isValidContractAddress(DEFAULT_CONTRACT_ADDRESS)) return DEFAULT_CONTRACT_ADDRESS.trim();
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isValidContractAddress(stored)) return stored.trim();
  } catch {
    /* ignore */
  }
  return '';
};

const shortAddr = (a) => {
  if (!a) return '—';
  const s = String(a);
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
};

const statusClass = (status) => {
  const s = String(status || '');
  if (s === 'RESOLVED') return 'badge-ok';
  if (s === 'DATA_DISPUTED_REFUNDED') return 'badge-warn';
  if (s === 'LOW_CONFIDENCE_DISPUTED') return 'badge-warn';
  if (s === 'PAYOUT_FAILED' || s === 'REFUND_FAILED') return 'badge-bad';
  if (s === 'DEPOSITED') return 'badge-info';
  return 'badge-idle';
};

const fingerprint = (row) => [
  row?.status,
  row?.verdict,
  row?.confidence,
  row?.verdict_reason,
  row?.artist_paid,
  row?.payor_share_returned,
  row?.disputed_refunded,
  row?.declared_revenue_amount,
].join('|');

const cleanUrls = (list) => list.map((u) => String(u || '').trim()).filter(Boolean);

const outcomeCopy = (row) => {
  const status = String(row?.status || '');
  if (status === 'RESOLVED') return 'Đã chia đúng % đã ký. AI chỉ xác nhận số liệu hợp lý; số GEN do contract tính.';
  if (status === 'DATA_DISPUTED_REFUNDED') return 'Số liệu bị đánh giá không hợp lý. Toàn bộ GEN escrow đã hoàn cho payor. Muốn thử lại thì tạo agreement mới.';
  if (status === 'LOW_CONFIDENCE_DISPUTED') return 'Độ tin cậy dưới 60. GEN vẫn nằm nguyên trong escrow. Bổ sung nguồn rồi xác minh lại.';
  if (status === 'PAYOUT_FAILED') return 'Một phần chuyển tiền chưa xong. Thử lại chỉ gửi phần còn thiếu, không trả trùng.';
  if (status === 'REFUND_FAILED') return 'Hoàn tiền cho payor chưa xong. Thử lại chỉ gửi đúng khoản hoàn đó.';
  if (status === 'DEPOSITED') return 'Đã escrow. Bước tiếp theo là yêu cầu AI xác minh tính hợp lý.';
  if (status === 'AWAITING_DEPOSIT') return 'Payor chưa gửi GEN doanh thu kỳ này.';
  return status;
};

function SplitBreakdown({ declaredWei, bps, row }) {
  const preview = computeSplitPreview(declaredWei, bps);
  const chainArtist = weiFromField(row?.artist_amount);
  const chainPayor = weiFromField(row?.payor_share);
  const hasChain = declaredWei > 0n && (chainArtist > 0n || chainPayor > 0n);
  const artistAmount = hasChain ? chainArtist : preview.artistAmount;
  const payorAmount = hasChain ? chainPayor : preview.payorShare;
  const mismatch = hasChain && (chainArtist !== preview.artistAmount || chainPayor !== preview.payorShare);
  const artistPct = formatBpsAsPercent(bps);
  const payorPct = formatBpsAsPercent(10000n - BigInt(String(bps || '0').replace(/\D/g, '') || '0'));
  const disputed = row?.status === 'DATA_DISPUTED_REFUNDED' || row?.verdict === 'DATA_DISPUTED';

  return (
    <div className="split-box">
      <div className="split-head">
        <span>Phần chia đã ký</span>
        <b>{artistPct}% nghệ sĩ · {payorPct}% payor</b>
      </div>
      <div className="split-grid">
        <div>
          <span>Nghệ sĩ nhận</span>
          <strong>{formatWeiToGen(artistAmount)} GEN</strong>
          <em>{row ? sideLabel(artistAmount, Boolean(row.artist_paid)) : 'Xem trước'}</em>
        </div>
        <div>
          <span>Payor giữ lại</span>
          <strong>{formatWeiToGen(payorAmount)} GEN</strong>
          <em>{row ? sideLabel(payorAmount, Boolean(row.payor_share_returned)) : 'Xem trước'}</em>
        </div>
      </div>
      {disputed && declaredWei > 0n && (
        <p className="hint">Khoản thực chuyển khi DATA_DISPUTED là hoàn đủ {formatWeiToGen(declaredWei)} GEN cho payor, không chia theo %.</p>
      )}
      {mismatch && <p className="hint warn-text">Số trên contract lệch với preview BigInt cục bộ. Làm mới trước khi ký thêm giao dịch.</p>}
      <p className="hint">Số GEN này là phép chia số nguyên (total × bps ÷ 10000). AI không tính ra số này.</p>
    </div>
  );
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [contractAddress, setContractAddress] = useState(loadInitialAddress);
  const [addressDraft, setAddressDraft] = useState('');
  const [tab, setTab] = useState('create');
  const [agreements, setAgreements] = useState([]);
  const [txMessage, setTxMessage] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [focusId, setFocusId] = useState('');

  const [artist, setArtist] = useState('');
  const [description, setDescription] = useState('');
  const [splitPercent, setSplitPercent] = useState(60);
  const [period, setPeriod] = useState(PERIOD_PRESETS[0]);
  const [urls, setUrls] = useState(['', '']);
  const [depositDrafts, setDepositDrafts] = useState({});
  const [evidenceDrafts, setEvidenceDrafts] = useState({});

  const hasContract = isValidContractAddress(contractAddress);
  const envLocked = isValidContractAddress(DEFAULT_CONTRACT_ADDRESS);
  const bps = percentToBps(splitPercent);
  const payorPercent = 100 - parseSplitPercent(splitPercent);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('agreement');
    if (id) {
      setFocusId(id);
      setTab('agreements');
    }
  }, []);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const onAccounts = (accs) => setAccount(accs?.[0] || null);
    window.ethereum.on?.('accountsChanged', onAccounts);
    return () => window.ethereum.removeListener?.('accountsChanged', onAccounts);
  }, []);

  const connectWallet = async () => {
    if (typeof window === 'undefined' || !window.ethereum) {
      setTxMessage({ status: 'error', title: 'Cần MetaMask', detail: 'Cài MetaMask để dùng RoyaltySplit trên Studionet.' });
      return;
    }
    try {
      await switchToGenlayerStudionet();
      const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
      setAccount(accs[0]);
    } catch (err) {
      setTxMessage({ status: 'error', title: 'Không kết nối được ví', detail: err.message || String(err) });
    }
  };

  const pasteInto = async (apply) => {
    try {
      const text = (await navigator.clipboard.readText() || '').trim();
      if (!text) {
        setTxMessage({ status: 'error', title: 'Clipboard trống', detail: 'Sao chép nội dung rồi bấm dán lại.' });
        return;
      }
      apply(text);
    } catch (err) {
      setTxMessage({ status: 'error', title: 'Không đọc được clipboard', detail: err.message || String(err) });
    }
  };

  const saveAddress = (value) => {
    const next = String(value || '').trim();
    if (!isValidContractAddress(next)) {
      setTxMessage({ status: 'error', title: 'Địa chỉ contract không hợp lệ', detail: 'Cần địa chỉ 0x dài 40 ký tự hex, sau khi Studio báo Result: SUCCESS.' });
      return;
    }
    setContractAddress(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    setTxMessage({ status: 'success', title: 'Đã gắn contract Studionet', detail: next });
  };

  const loadAgreements = useCallback(async () => {
    if (!hasContract) {
      setAgreements([]);
      return;
    }
    const countRaw = await readContractState('get_agreement_count', [], contractAddress, account);
    const countStr = String(countRaw ?? '0').trim();
    let count = 0;
    if (/^\d+$/.test(countStr)) {
      const n = BigInt(countStr);
      count = n > 200n ? 200 : Number(n);
    }
    const ids = Array.from({ length: count }, (_, i) => String(i));
    const rows = await Promise.all(ids.map((id) => readContractState('get_agreement', [id], contractAddress, account)));
    setAgreements(rows.filter((row) => row && typeof row === 'object'));
  }, [hasContract, contractAddress, account]);

  useEffect(() => {
    loadAgreements().catch((err) => console.warn('load agreements', err));
    if (!hasContract) return undefined;
    const timer = setInterval(() => {
      loadAgreements().catch((err) => console.warn('refresh agreements', err));
    }, 20000);
    return () => clearInterval(timer);
  }, [loadAgreements, hasContract]);

  const readAgreement = async (id) => readContractState('get_agreement', [String(id)], contractAddress, account);

  const runWrite = async (title, functionName, args, value = 0n, { ai = false, agreementId = null, confirm = null } = {}) => {
    if (!hasContract) throw new Error('Chưa có địa chỉ contract.');
    if (!account) throw new Error('Kết nối MetaMask trước.');
    setBusy(true);
    if (ai) setResolvingId(agreementId);
    setTxMessage({
      status: ai ? 'consensus' : 'pending',
      title: ai ? 'Đang chờ đồng thuận AI…' : `Đang gửi: ${title}`,
      detail: ai
        ? 'AI chỉ trả DATA_PLAUSIBLE hoặc DATA_DISPUTED. Phép chia % chạy sau đó, trong contract, giống nhau trên mọi validator.'
        : 'Xác nhận trong MetaMask trên GenLayer Studionet. Giữ tab này mở.',
    });
    let hash = '';
    try {
      const before = confirm ? await confirm.readBefore() : null;
      hash = await sendContractTransaction({
        from: account,
        to: contractAddress,
        functionName,
        args,
        value,
      });
      setTxMessage({
        status: ai ? 'consensus' : 'pending',
        title: `${title} đã gửi`,
        detail: 'Đang chờ Studionet + GenVM…',
        hash,
      });
      const receipt = await waitForFinalizedTx(hash, ai ? 90 : 60, ai ? 4000 : 3000);
      if (receipt?.pending) {
        setTxMessage({
          status: 'pending',
          title: `${title}: đang đối chiếu storage…`,
          detail: receipt.warning || 'Receipt chậm — kiểm tra state contract thay vì gửi lại ngay.',
          hash,
        });
      }
      let row = null;
      if (confirm) {
        row = await waitForContractEffect({
          label: title,
          retries: ai ? 40 : 24,
          intervalMs: ai ? 4000 : 2500,
          read: async () => {
            const after = await confirm.readAfter();
            return { before, after };
          },
          predicate: async ({ before: prev, after }) => confirm.ready(prev, after),
        });
      }
      await loadAgreements();
      return { hash, row };
    } catch (err) {
      const detail = formatWriteError(err) || err.message || String(err);
      setTxMessage({ status: 'error', title: `${title} thất bại`, detail, hash: hash || undefined });
      try { await loadAgreements(); } catch { /* ignore */ }
      throw err;
    } finally {
      setBusy(false);
      setResolvingId(null);
    }
  };

  const handleCreate = async () => {
    const artistAddr = artist.trim();
    const desc = description.trim();
    const periodLabel = period.trim();
    const refs = cleanUrls(urls);
    if (!isEthAddress(artistAddr)) {
      setTxMessage({ status: 'error', title: 'Thiếu địa chỉ nghệ sĩ', detail: 'Dán địa chỉ ví nghệ sĩ (0x, 40 hex).' });
      return;
    }
    if (account && sameAddress(account, artistAddr)) {
      setTxMessage({ status: 'error', title: 'Trùng ví', detail: 'Payor và nghệ sĩ phải là hai địa chỉ khác nhau.' });
      return;
    }
    if (!desc) {
      setTxMessage({ status: 'error', title: 'Thiếu mô tả', detail: 'Ghi ngắn thỏa thuận, ví dụ tên track và kỳ.' });
      return;
    }
    if (!periodLabel) {
      setTxMessage({ status: 'error', title: 'Thiếu kỳ', detail: 'Chọn một kỳ thanh toán.' });
      return;
    }
    if (refs.length < 2) {
      setTxMessage({ status: 'error', title: 'Thiếu nguồn', detail: 'Cần ít nhất 2 URL công khai độc lập.' });
      return;
    }
    try {
      const result = await runWrite(
        'Tạo thỏa thuận',
        'create_agreement',
        [artistAddr, desc, BigInt(bps), periodLabel, refs],
        0n,
        {
          confirm: {
            readBefore: async () => {
              const raw = await readContractState('get_agreement_count', [], contractAddress, account);
              const str = String(raw ?? '0').trim();
              return /^\d+$/.test(str) ? BigInt(str) : 0n;
            },
            readAfter: async () => {
              const raw = await readContractState('get_agreement_count', [], contractAddress, account);
              const str = String(raw ?? '0').trim();
              return /^\d+$/.test(str) ? BigInt(str) : 0n;
            },
            ready: (before, after) => after === before + 1n,
          },
        },
      );
      const beforeCount = result?.row?.before;
      const newId = beforeCount === undefined || beforeCount === null ? '' : String(beforeCount);
      setTxMessage({
        status: 'success',
        title: newId !== '' ? `Đã tạo agreement #${newId}` : 'Đã tạo thỏa thuận',
        detail: 'Gửi link cho nghệ sĩ xem trước, rồi escrow doanh thu kỳ.',
        hash: result.hash,
      });
      setDescription('');
      setUrls(['', '']);
      setTab('agreements');
      if (newId !== '') setFocusId(newId);
    } catch {
      /* message already set */
    }
  };

  const handleDeposit = async (row) => {
    const id = String(row.agreement_id);
    const gen = depositDrafts[id] || '';
    const wei = parseGenToWei(gen);
    const splitBps = String(row.artist_split_bps);
    if (wei <= 0n) {
      setTxMessage({ status: 'error', title: 'Số GEN không hợp lệ', detail: 'Chọn hoặc nhập doanh thu kỳ lớn hơn 0.' });
      return;
    }
    if (!splitBothPositive(wei, splitBps)) {
      setTxMessage({
        status: 'error',
        title: 'Số quá nhỏ để chia',
        detail: 'Với % này, một bên sẽ nhận 0 sau phép chia số nguyên. Tăng số GEN.',
      });
      return;
    }
    try {
      const result = await runWrite('Escrow doanh thu kỳ', 'deposit_revenue', [id], wei, {
        agreementId: id,
        confirm: {
          readBefore: async () => readAgreement(id),
          readAfter: async () => readAgreement(id),
          ready: (_before, after) => String(after?.status) === 'DEPOSITED' && weiFromField(after?.declared_revenue_amount) === wei,
        },
      });
      setTxMessage({
        status: 'success',
        title: `Đã escrow agreement #${id}`,
        detail: `${formatWeiToGen(wei)} GEN đang nằm trong contract.`,
        hash: result.hash,
      });
    } catch {
      /* message already set */
    }
  };

  const handleResolve = async (row) => {
    const id = String(row.agreement_id);
    const beforeFp = fingerprint(row);
    try {
      const result = await runWrite('Yêu cầu AI xác minh tính hợp lý', 'resolve_agreement', [id], 0n, {
        ai: true,
        agreementId: id,
        confirm: {
          readBefore: async () => beforeFp,
          readAfter: async () => fingerprint(await readAgreement(id)),
          ready: (before, after) => Boolean(after) && after !== before,
        },
      });
      const latest = await readAgreement(id);
      setTxMessage({
        status: latest?.status === 'PAYOUT_FAILED' || latest?.status === 'REFUND_FAILED' ? 'error' : 'success',
        title: `${STATUS_LABEL[latest?.status] || latest?.status || 'Đã xác minh'} · #${id}`,
        detail: outcomeCopy(latest),
        hash: result.hash,
      });
    } catch {
      /* message already set */
    }
  };

  const handleRetry = async (row) => {
    const id = String(row.agreement_id);
    const beforeFp = fingerprint(row);
    try {
      const result = await runWrite('Thử lại phần còn thiếu', 'retry_resolution', [id], 0n, {
        agreementId: id,
        confirm: {
          readBefore: async () => beforeFp,
          readAfter: async () => fingerprint(await readAgreement(id)),
          ready: (before, after) => Boolean(after) && after !== before,
        },
      });
      const latest = await readAgreement(id);
      setTxMessage({
        status: latest?.status === 'RESOLVED' || latest?.status === 'DATA_DISPUTED_REFUNDED' ? 'success' : 'error',
        title: `${STATUS_LABEL[latest?.status] || 'Đã thử lại'} · #${id}`,
        detail: outcomeCopy(latest),
        hash: result.hash,
      });
    } catch {
      /* message already set */
    }
  };

  const handleAddEvidence = async (row) => {
    const id = String(row.agreement_id);
    const extra = cleanUrls(evidenceDrafts[id] || ['']);
    if (extra.length < 1) {
      setTxMessage({ status: 'error', title: 'Thiếu nguồn mới', detail: 'Dán ít nhất một URL bổ sung.' });
      return;
    }
    const beforeCount = Array.isArray(row.reference_urls) ? row.reference_urls.length : 0;
    try {
      const result = await runWrite('Bổ sung nguồn', 'add_more_evidence', [id, extra], 0n, {
        agreementId: id,
        confirm: {
          readBefore: async () => beforeCount,
          readAfter: async () => {
            const latest = await readAgreement(id);
            return Array.isArray(latest?.reference_urls) ? latest.reference_urls.length : 0;
          },
          ready: (before, after) => after > before,
        },
      });
      setEvidenceDrafts((prev) => ({ ...prev, [id]: [''] }));
      setTxMessage({
        status: 'success',
        title: `Đã thêm nguồn cho #${id}`,
        detail: 'GEN escrow không đổi. Có thể yêu cầu AI xác minh lại.',
        hash: result.hash,
      });
    } catch {
      /* message already set */
    }
  };

  const shareAgreement = async (id) => {
    const url = new URL(window.location.href);
    url.searchParams.set('agreement', String(id));
    try {
      await navigator.clipboard.writeText(url.toString());
      setTxMessage({ status: 'success', title: `Đã chép link agreement #${id}`, detail: url.toString() });
    } catch (err) {
      setTxMessage({ status: 'error', title: 'Không chép được link', detail: err.message || url.toString() });
    }
  };

  const visibleAgreements = useMemo(() => {
    if (!focusId) return agreements;
    const hit = agreements.find((row) => String(row.agreement_id) === String(focusId));
    if (!hit) return agreements;
    return [hit, ...agreements.filter((row) => String(row.agreement_id) !== String(focusId))];
  }, [agreements, focusId]);

  return (
    <div className="app">
      <div className="free-banner">
        Miễn phí sử dụng — chỉ tốn phí gas mạng GenLayer khi ký giao dịch. Không có phí nền tảng nào khác.
      </div>

      <header className="header">
        <div className="brand">
          <div className="brand-mark"><Music size={22} /></div>
          <div>
            <h1>RoyaltySplit</h1>
            <p>Chia doanh thu streaming theo % đã ký. AI chỉ xét tính hợp lý.</p>
          </div>
        </div>
        <div className="header-right">
          <div className="network"><span className="dot" /> Studionet</div>
          {account ? (
            <button className="btn-secondary" type="button" onClick={connectWallet}>{shortAddr(account)}</button>
          ) : (
            <button className="btn-primary" type="button" onClick={connectWallet}><Wallet size={16} /> Kết nối MetaMask</button>
          )}
        </div>
      </header>

      {!hasContract && (
        <div className="missing-banner">
          <AlertTriangle size={18} />
          <div>
            <strong>Chưa có địa chỉ contract.</strong>
            <p>Deploy <code>contracts/royalty_split.py</code> trên GenLayer Studio, xác nhận <code>Result: SUCCESS</code>, rồi dán địa chỉ vào đây hoặc set <code>VITE_CONTRACT_ADDRESS</code>. Trang vẫn dùng được để xem form — không có giao dịch nào được gửi.</p>
            {!envLocked && (
              <div className="url-row">
                <input
                  className="input"
                  placeholder="0x… địa chỉ contract Studionet"
                  value={addressDraft}
                  onChange={(e) => setAddressDraft(e.target.value.trim())}
                />
                <button className="btn-ghost" type="button" onClick={() => pasteInto(setAddressDraft)}><ClipboardPaste size={16} /></button>
                <button className="btn-secondary" type="button" onClick={() => saveAddress(addressDraft)}>Gắn</button>
              </div>
            )}
          </div>
        </div>
      )}

      {txMessage && (
        <div className={txMessage.status === 'error' ? 'err-banner' : txMessage.status === 'success' ? 'ok-banner' : 'info-banner'}>
          {txMessage.status === 'error' ? <AlertTriangle size={18} /> : txMessage.status === 'success' ? <CheckCircle2 size={18} /> : <Info size={18} />}
          <div>
            <strong>{txMessage.title}</strong>
            <p>{txMessage.detail}</p>
            {txMessage.hash && (
              <a href={txExplorerUrl(txMessage.hash)} target="_blank" rel="noreferrer">
                Xem giao dịch <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>
      )}

      <section className="steps">
        <article><b>1</b><span>% cố định lúc ký, không do AI quyết.</span></article>
        <article><b>2</b><span>Payor tự khai doanh thu và escrow đúng số GEN.</span></article>
        <article><b>3</b><span>AI chỉ nói hợp lý hoặc không. Contract chia bằng số nguyên.</span></article>
      </section>

      <div className="tabs">
        <button className={tab === 'create' ? 'tab active' : 'tab'} type="button" onClick={() => setTab('create')}>Tạo thỏa thuận</button>
        <button className={tab === 'agreements' ? 'tab active' : 'tab'} type="button" onClick={() => setTab('agreements')}>
          Thỏa thuận {hasContract ? `(${agreements.length})` : ''}
        </button>
      </div>

      {tab === 'create' && (
        <section className="card">
          <h2><ShieldCheck size={18} /> Một kỳ, một agreement</h2>
          <p className="hint">Mỗi thỏa thuận là một kỳ thanh toán. Hợp tác nhiều kỳ thì tạo agreement mới và nhập lại % đã ký.</p>

          <label className="label">Địa chỉ ví nghệ sĩ</label>
          <div className="url-row">
            <input className="input" value={artist} placeholder="0x…" onChange={(e) => setArtist(e.target.value.trim())} />
            <button className="btn-ghost" type="button" onClick={() => pasteInto(setArtist)}><ClipboardPaste size={16} /> Dán</button>
          </div>

          <label className="label">Mô tả thỏa thuận</label>
          <textarea
            className="input textarea"
            maxLength={800}
            placeholder="Track XYZ streaming royalties — Q3 2026"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <label className="label">Phần nghệ sĩ nhận: {parseSplitPercent(splitPercent)}% · payor giữ {payorPercent}% · {bps} bps</label>
          <div className="chips">
            {SPLIT_PRESETS.map((pct) => (
              <button
                key={pct}
                type="button"
                className={parseSplitPercent(splitPercent) === pct ? 'chip active' : 'chip'}
                onClick={() => setSplitPercent(pct)}
              >
                {pct}%
              </button>
            ))}
          </div>
          <input
            className="slider"
            type="range"
            min="1"
            max="99"
            step="1"
            value={parseSplitPercent(splitPercent)}
            onChange={(e) => setSplitPercent(parseSplitPercent(e.target.value))}
          />

          <label className="label">Kỳ thanh toán</label>
          <div className="chips">
            {PERIOD_PRESETS.map((item) => (
              <button
                key={item}
                type="button"
                className={period === item ? 'chip active' : 'chip'}
                onClick={() => setPeriod(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <input className="input" value={period} maxLength={64} onChange={(e) => setPeriod(e.target.value)} />

          <label className="label">Nguồn số liệu công khai (tối thiểu 2)</label>
          <p className="hint">{URL_HINTS.join(' · ')}</p>
          {urls.map((url, index) => (
            <div className="url-row" key={`url-${index}`}>
              <input
                className="input"
                placeholder={URL_HINTS[index] || 'https://'}
                value={url}
                onChange={(e) => {
                  const next = urls.slice();
                  next[index] = e.target.value;
                  setUrls(next);
                }}
              />
              <button
                className="btn-ghost"
                type="button"
                onClick={() => pasteInto((text) => {
                  const next = urls.slice();
                  next[index] = text;
                  setUrls(next);
                })}
              >
                <ClipboardPaste size={16} />
              </button>
              {urls.length > 2 && (
                <button className="btn-ghost" type="button" onClick={() => setUrls(urls.filter((_, i) => i !== index))}><Trash2 size={16} /></button>
              )}
            </div>
          ))}
          {urls.length < 8 && (
            <button className="btn-ghost" type="button" onClick={() => setUrls(urls.concat(['']))}><Plus size={16} /> Thêm nguồn</button>
          )}

          <button className="btn-primary full create-btn" type="button" disabled={!hasContract || busy || !account} onClick={handleCreate}>
            Tạo thỏa thuận
          </button>
          {!account && <p className="hint">Kết nối ví payor để ký. Nghệ sĩ dùng một ví khác.</p>}
        </section>
      )}

      {tab === 'agreements' && (
        <section>
          <div className="card-header">
            <h2>Các kỳ đã tạo</h2>
            <button className="btn-ghost" type="button" onClick={() => loadAgreements()} disabled={!hasContract || busy}>
              <RefreshCw size={16} /> Làm mới
            </button>
          </div>
          {!hasContract && <p className="hint">Chưa đọc được contract vì chưa có địa chỉ.</p>}
          {hasContract && agreements.length === 0 && <p className="hint">Chưa có agreement nào trên contract này.</p>}
          <div className="agreement-list">
            {visibleAgreements.map((row) => {
              const id = String(row.agreement_id);
              const declared = weiFromField(row.declared_revenue_amount);
              const splitBps = String(row.artist_split_bps ?? '0');
              const isPayor = sameAddress(account, row.payor);
              const isArtist = sameAddress(account, row.artist);
              const isParty = isPayor || isArtist;
              const depositGen = depositDrafts[id] ?? '';
              const depositWei = parseGenToWei(depositGen);
              const evidence = evidenceDrafts[id] || [''];
              const highlighted = focusId && focusId === id;
              return (
                <article key={id} id={`agreement-${id}`} className={highlighted ? 'agreement-card highlight' : 'agreement-card'}>
                  <div className="agreement-top">
                    <div>
                      <h3>#{id} · {row.period_label}</h3>
                      <p>{row.agreement_description}</p>
                    </div>
                    <span className={`badge ${statusClass(row.status)}`}>{STATUS_LABEL[row.status] || row.status}</span>
                  </div>
                  <p className="mono">Payor {shortAddr(row.payor)} · Nghệ sĩ {shortAddr(row.artist)} · {formatBpsAsPercent(splitBps)}% nghệ sĩ</p>
                  <p className="hint">{outcomeCopy(row)}</p>
                  {row.verdict && (
                    <div className="reason">
                      <strong>{row.verdict}</strong> · độ tin cậy {row.confidence}/100
                      <p>{row.verdict_reason}</p>
                    </div>
                  )}
                  {(row.status !== 'AWAITING_DEPOSIT' || depositWei > 0n) && (
                    <SplitBreakdown
                      declaredWei={row.status === 'AWAITING_DEPOSIT' ? depositWei : declared}
                      bps={splitBps}
                      row={row.status === 'AWAITING_DEPOSIT' ? null : row}
                    />
                  )}
                  {Array.isArray(row.reference_urls) && row.reference_urls.length > 0 && (
                    <ul className="url-list">
                      {row.reference_urls.map((url) => (
                        <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>
                      ))}
                    </ul>
                  )}

                  {resolvingId === id && (
                    <div className="loading-panel">
                      <Loader2 className="spin" size={18} />
                      <p>AI đang đọc nguồn công khai và đánh giá tính hợp lý. AI không tính số tiền — giữ tab này mở.</p>
                    </div>
                  )}

                  <div className="row-actions">
                    <button className="btn-ghost" type="button" onClick={() => shareAgreement(id)}><Share2 size={16} /> Chia sẻ cho nghệ sĩ</button>
                    {row.status === 'AWAITING_DEPOSIT' && isPayor && (
                      <>
                        <div className="chips">
                          {REVENUE_PRESETS.map((amt) => (
                            <button
                              key={amt}
                              type="button"
                              className={depositGen === amt ? 'chip active' : 'chip'}
                              onClick={() => setDepositDrafts((prev) => ({ ...prev, [id]: amt }))}
                            >
                              {amt} GEN
                            </button>
                          ))}
                        </div>
                        <input
                          className="input"
                          inputMode="decimal"
                          placeholder="Doanh thu kỳ (GEN)"
                          value={depositGen}
                          onChange={(e) => setDepositDrafts((prev) => ({ ...prev, [id]: sanitizeGenInput(e.target.value) }))}
                        />
                        <button className="btn-primary" type="button" disabled={busy} onClick={() => handleDeposit(row)}>
                          <Coins size={16} /> Escrow doanh thu kỳ
                        </button>
                      </>
                    )}
                    {(row.status === 'DEPOSITED' || row.status === 'LOW_CONFIDENCE_DISPUTED') && (
                      <button className="btn-ai" type="button" disabled={busy || !account} onClick={() => handleResolve(row)}>
                        <Sparkles size={16} /> Yêu cầu AI xác minh tính hợp lý
                      </button>
                    )}
                    {row.status === 'LOW_CONFIDENCE_DISPUTED' && isParty && (
                      <>
                        {evidence.map((url, index) => (
                          <div className="url-row" key={`${id}-ev-${index}`}>
                            <input
                              className="input"
                              placeholder="URL nguồn bổ sung"
                              value={url}
                              onChange={(e) => {
                                const next = evidence.slice();
                                next[index] = e.target.value;
                                setEvidenceDrafts((prev) => ({ ...prev, [id]: next }));
                              }}
                            />
                            <button
                              className="btn-ghost"
                              type="button"
                              onClick={() => pasteInto((text) => {
                                const next = evidence.slice();
                                next[index] = text;
                                setEvidenceDrafts((prev) => ({ ...prev, [id]: next }));
                              })}
                            >
                              <ClipboardPaste size={16} />
                            </button>
                          </div>
                        ))}
                        <button className="btn-secondary" type="button" disabled={busy} onClick={() => handleAddEvidence(row)}>
                          Bổ sung nguồn
                        </button>
                      </>
                    )}
                    {(row.status === 'PAYOUT_FAILED' || row.status === 'REFUND_FAILED') && isParty && (
                      <button className="btn-primary" type="button" disabled={busy} onClick={() => handleRetry(row)}>
                        <RotateCcw size={16} /> Thử lại phần còn thiếu
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
