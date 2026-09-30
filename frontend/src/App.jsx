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
  AWAITING_DEPOSIT: 'Awaiting escrow',
  DEPOSITED: 'Escrowed',
  LOW_CONFIDENCE_DISPUTED: 'Low confidence',
  RESOLVED: 'Split paid',
  DATA_DISPUTED_REFUNDED: 'Refunded to payor',
  PAYOUT_FAILED: 'Partial payout failed',
  REFUND_FAILED: 'Refund failed',
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
  if (status === 'RESOLVED') return 'Paid at the signed percentage. The AI only confirmed the figures look plausible. The contract calculated the GEN.';
  if (status === 'DATA_DISPUTED_REFUNDED') return 'The declared revenue was judged implausible. The full escrow was refunded to the payor. To try again, create a new agreement.';
  if (status === 'LOW_CONFIDENCE_DISPUTED') return 'Confidence is below 60. The GEN stays in escrow. Add another source, then verify again.';
  if (status === 'PAYOUT_FAILED') return 'One side of the transfer did not finish. Retry sends only the missing part. It does not pay twice.';
  if (status === 'REFUND_FAILED') return 'The payor refund did not finish. Retry sends only that refund.';
  if (status === 'DEPOSITED') return 'Escrow is in. Next, ask the AI to check whether the declared revenue is plausible.';
  if (status === 'AWAITING_DEPOSIT') return 'The payor has not escrowed this period’s revenue yet.';
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
        <span>Signed split</span>
        <b>{artistPct}% artist · {payorPct}% payor</b>
      </div>
      <div className="split-grid">
        <div>
          <span>Artist receives</span>
          <strong>{formatWeiToGen(artistAmount)} GEN</strong>
          <em>{row ? sideLabel(artistAmount, Boolean(row.artist_paid)) : 'Preview'}</em>
        </div>
        <div>
          <span>Payor keeps</span>
          <strong>{formatWeiToGen(payorAmount)} GEN</strong>
          <em>{row ? sideLabel(payorAmount, Boolean(row.payor_share_returned)) : 'Preview'}</em>
        </div>
      </div>
      {disputed && declaredWei > 0n && (
        <p className="hint">On DATA_DISPUTED the contract refunds the full {formatWeiToGen(declaredWei)} GEN to the payor. It does not apply the percentage.</p>
      )}
      {mismatch && <p className="hint warn-text">The on-chain amounts differ from the local BigInt preview. Refresh before signing another transaction.</p>}
      <p className="hint">These GEN amounts are integer division (total × bps ÷ 10000). The AI does not calculate them.</p>
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
      setTxMessage({ status: 'error', title: 'MetaMask required', detail: 'Install MetaMask to use RoyaltySplit on Studionet.' });
      return;
    }
    try {
      await switchToGenlayerStudionet();
      const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
      setAccount(accs[0]);
    } catch (err) {
      setTxMessage({ status: 'error', title: 'Wallet connection failed', detail: err.message || String(err) });
    }
  };

  const pasteInto = async (apply) => {
    try {
      const text = (await navigator.clipboard.readText() || '').trim();
      if (!text) {
        setTxMessage({ status: 'error', title: 'Clipboard is empty', detail: 'Copy something, then paste again.' });
        return;
      }
      apply(text);
    } catch (err) {
      setTxMessage({ status: 'error', title: 'Could not read the clipboard', detail: err.message || String(err) });
    }
  };

  const saveAddress = (value) => {
    const next = String(value || '').trim();
    if (!isValidContractAddress(next)) {
      setTxMessage({ status: 'error', title: 'Invalid contract address', detail: 'Use a 0x address with 40 hex characters from a Studio deployment whose result is SUCCESS.' });
      return;
    }
    setContractAddress(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    setTxMessage({ status: 'success', title: 'Studionet contract saved', detail: next });
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
    if (!hasContract) throw new Error('Contract address is not configured yet.');
    if (!account) throw new Error('Connect MetaMask first.');
    setBusy(true);
    if (ai) setResolvingId(agreementId);
    setTxMessage({
      status: ai ? 'consensus' : 'pending',
      title: ai ? 'Waiting for AI consensus…' : `Submitting ${title}`,
      detail: ai
        ? 'The AI returns only DATA_PLAUSIBLE or DATA_DISPUTED. The percentage split runs afterward, in the contract, and is identical on every validator.'
        : 'Confirm in MetaMask on GenLayer Studionet. Keep this tab open.',
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
        title: `${title} submitted`,
        detail: 'Waiting for Studionet and GenVM…',
        hash,
      });
      const receipt = await waitForFinalizedTx(hash, ai ? 90 : 60, ai ? 4000 : 3000);
      if (receipt?.pending) {
        setTxMessage({
          status: 'pending',
          title: `${title}: checking contract storage…`,
          detail: receipt.warning || 'The receipt is slow. Check contract state instead of sending again right away.',
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
      setTxMessage({ status: 'error', title: `${title} failed`, detail, hash: hash || undefined });
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
      setTxMessage({ status: 'error', title: 'Artist address required', detail: 'Paste the artist wallet address (0x, 40 hex characters).' });
      return;
    }
    if (account && sameAddress(account, artistAddr)) {
      setTxMessage({ status: 'error', title: 'Same wallet', detail: 'The payor and the artist must be two different addresses.' });
      return;
    }
    if (!desc) {
      setTxMessage({ status: 'error', title: 'Description required', detail: 'Write a short agreement, for example the track name and period.' });
      return;
    }
    if (!periodLabel) {
      setTxMessage({ status: 'error', title: 'Period required', detail: 'Choose a payment period.' });
      return;
    }
    if (refs.length < 2) {
      setTxMessage({ status: 'error', title: 'Sources required', detail: 'Add at least two independent public URLs.' });
      return;
    }
    try {
      const result = await runWrite(
        'Create agreement',
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
        title: newId !== '' ? `Created agreement #${newId}` : 'Agreement created',
        detail: 'Share the link with the artist, then escrow this period’s revenue.',
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
      setTxMessage({ status: 'error', title: 'Invalid GEN amount', detail: 'Choose or enter period revenue greater than 0.' });
      return;
    }
    if (!splitBothPositive(wei, splitBps)) {
      setTxMessage({
        status: 'error',
        title: 'Amount too small to split',
        detail: 'At this percentage, integer division would pay one side 0. Increase the GEN amount.',
      });
      return;
    }
    try {
      const result = await runWrite('Escrow period revenue', 'deposit_revenue', [id], wei, {
        agreementId: id,
        confirm: {
          readBefore: async () => readAgreement(id),
          readAfter: async () => readAgreement(id),
          ready: (_before, after) => String(after?.status) === 'DEPOSITED' && weiFromField(after?.declared_revenue_amount) === wei,
        },
      });
      setTxMessage({
        status: 'success',
        title: `Escrowed agreement #${id}`,
        detail: `${formatWeiToGen(wei)} GEN is now in the contract.`,
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
      const result = await runWrite('Ask the AI to check plausibility', 'resolve_agreement', [id], 0n, {
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
        title: `${STATUS_LABEL[latest?.status] || latest?.status || 'Checked'} · #${id}`,
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
      const result = await runWrite('Retry the missing transfer', 'retry_resolution', [id], 0n, {
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
        title: `${STATUS_LABEL[latest?.status] || 'Retried'} · #${id}`,
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
      setTxMessage({ status: 'error', title: 'New source required', detail: 'Paste at least one additional URL.' });
      return;
    }
    const beforeCount = Array.isArray(row.reference_urls) ? row.reference_urls.length : 0;
    try {
      const result = await runWrite('Add sources', 'add_more_evidence', [id, extra], 0n, {
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
        title: `Added sources to #${id}`,
        detail: 'Escrowed GEN is unchanged. You can ask the AI to check again.',
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
      setTxMessage({ status: 'success', title: `Copied link for agreement #${id}`, detail: url.toString() });
    } catch (err) {
      setTxMessage({ status: 'error', title: 'Could not copy the link', detail: err.message || url.toString() });
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
        Free to use. You only pay GenLayer network gas when you sign a transaction. There is no other platform fee.
      </div>

      <header className="header">
        <div className="brand">
          <div className="brand-mark"><Music size={22} /></div>
          <div>
            <h1>RoyaltySplit</h1>
            <p>Split streaming revenue at a signed percentage. The AI only judges plausibility.</p>
          </div>
        </div>
        <div className="header-right">
          <div className="network"><span className="dot" /> Studionet</div>
          {account ? (
            <button className="btn-secondary" type="button" onClick={connectWallet}>{shortAddr(account)}</button>
          ) : (
            <button className="btn-primary" type="button" onClick={connectWallet}><Wallet size={16} /> Connect MetaMask</button>
          )}
        </div>
      </header>

      {!hasContract && (
        <div className="missing-banner">
          <AlertTriangle size={18} />
          <div>
            <strong>No contract address yet.</strong>
            <p>Deploy <code>contracts/royalty_split.py</code> on GenLayer Studio, confirm <code>Result: SUCCESS</code>, then paste the address here or set <code>VITE_CONTRACT_ADDRESS</code>. The form still loads. No transaction is sent.</p>
            {!envLocked && (
              <div className="url-row">
                <input
                  className="input"
                  placeholder="0x… Studionet contract address"
                  value={addressDraft}
                  onChange={(e) => setAddressDraft(e.target.value.trim())}
                />
                <button className="btn-ghost" type="button" onClick={() => pasteInto(setAddressDraft)}><ClipboardPaste size={16} /></button>
                <button className="btn-secondary" type="button" onClick={() => saveAddress(addressDraft)}>Save</button>
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
                View transaction <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>
      )}

      <section className="steps">
        <article><b>1</b><span>The percentage is fixed at signing. The AI does not choose it.</span></article>
        <article><b>2</b><span>The payor declares revenue and escrows that exact GEN amount.</span></article>
        <article><b>3</b><span>The AI only says plausible or not. The contract splits with integers.</span></article>
      </section>

      <div className="tabs">
        <button className={tab === 'create' ? 'tab active' : 'tab'} type="button" onClick={() => setTab('create')}>Create agreement</button>
        <button className={tab === 'agreements' ? 'tab active' : 'tab'} type="button" onClick={() => setTab('agreements')}>
          Agreements {hasContract ? `(${agreements.length})` : ''}
        </button>
      </div>

      {tab === 'create' && (
        <section className="card">
          <h2><ShieldCheck size={18} /> One period, one agreement</h2>
          <p className="hint">Each agreement covers a single payment period. For another period, create a new agreement and enter the signed percentage again.</p>

          <label className="label">Artist wallet address</label>
          <div className="url-row">
            <input className="input" value={artist} placeholder="0x…" onChange={(e) => setArtist(e.target.value.trim())} />
            <button className="btn-ghost" type="button" onClick={() => pasteInto(setArtist)}><ClipboardPaste size={16} /> Paste</button>
          </div>

          <label className="label">Agreement description</label>
          <textarea
            className="input textarea"
            maxLength={800}
            placeholder="Track XYZ streaming royalties — Q3 2026"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <label className="label">Artist receives {parseSplitPercent(splitPercent)}% · payor keeps {payorPercent}% · {bps} bps</label>
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

          <label className="label">Payment period</label>
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

          <label className="label">Public data sources (at least 2)</label>
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
            <button className="btn-ghost" type="button" onClick={() => setUrls(urls.concat(['']))}><Plus size={16} /> Add source</button>
          )}

          <button className="btn-primary full create-btn" type="button" disabled={!hasContract || busy || !account} onClick={handleCreate}>
            Create agreement
          </button>
          {!account && <p className="hint">Connect the payor wallet to sign. The artist uses a different wallet.</p>}
        </section>
      )}

      {tab === 'agreements' && (
        <section>
          <div className="card-header">
            <h2>Agreements</h2>
            <button className="btn-ghost" type="button" onClick={() => loadAgreements()} disabled={!hasContract || busy}>
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
          {!hasContract && <p className="hint">The contract cannot be read until an address is set.</p>}
          {hasContract && agreements.length === 0 && <p className="hint">No agreements on this contract yet.</p>}
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
                  <p className="mono">Payor {shortAddr(row.payor)} · Artist {shortAddr(row.artist)} · {formatBpsAsPercent(splitBps)}% artist</p>
                  <p className="hint">{outcomeCopy(row)}</p>
                  {row.verdict && (
                    <div className="reason">
                      <strong>{row.verdict}</strong> · confidence {row.confidence}/100
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
                      <p>The AI is reading public sources and judging plausibility. It is not calculating money. Keep this tab open.</p>
                    </div>
                  )}

                  <div className="row-actions">
                    <button className="btn-ghost" type="button" onClick={() => shareAgreement(id)}><Share2 size={16} /> Share with the artist</button>
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
                          placeholder="Period revenue (GEN)"
                          value={depositGen}
                          onChange={(e) => setDepositDrafts((prev) => ({ ...prev, [id]: sanitizeGenInput(e.target.value) }))}
                        />
                        <button className="btn-primary" type="button" disabled={busy} onClick={() => handleDeposit(row)}>
                          <Coins size={16} /> Escrow period revenue
                        </button>
                      </>
                    )}
                    {(row.status === 'DEPOSITED' || row.status === 'LOW_CONFIDENCE_DISPUTED') && (
                      <button className="btn-ai" type="button" disabled={busy || !account} onClick={() => handleResolve(row)}>
                        <Sparkles size={16} /> Ask the AI to check plausibility
                      </button>
                    )}
                    {row.status === 'LOW_CONFIDENCE_DISPUTED' && isParty && (
                      <>
                        {evidence.map((url, index) => (
                          <div className="url-row" key={`${id}-ev-${index}`}>
                            <input
                              className="input"
                              placeholder="Additional source URL"
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
                          Add sources
                        </button>
                      </>
                    )}
                    {(row.status === 'PAYOUT_FAILED' || row.status === 'REFUND_FAILED') && isParty && (
                      <button className="btn-primary" type="button" disabled={busy} onClick={() => handleRetry(row)}>
                        <RotateCcw size={16} /> Retry the missing transfer
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
