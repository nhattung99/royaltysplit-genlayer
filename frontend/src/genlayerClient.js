import { createClient } from 'genlayer-js';
import { studionet as officialStudionet } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import {
  parseGenToWei,
  formatWeiToGen,
  sanitizeGenInput,
  toWeiString,
  weiFromField,
  parseSplitPercent,
  percentToBps,
  formatBpsAsPercent,
  computeSplitPreview,
  splitBothPositive,
  sideLabel,
  WEI_PER_GEN,
} from './money.js';

export {
  parseGenToWei,
  formatWeiToGen,
  sanitizeGenInput,
  toWeiString,
  weiFromField,
  parseSplitPercent,
  percentToBps,
  formatBpsAsPercent,
  computeSplitPreview,
  splitBothPositive,
  sideLabel,
  WEI_PER_GEN,
};

const ZERO = '0x0000000000000000000000000000000000000000';
const VIEW_FROM = '0x0000000000000000000000000000000000000001';
const STUDIO_RPC = 'https://studio.genlayer.com/api';
const rawAddress = (import.meta.env.VITE_CONTRACT_ADDRESS || '').trim();

export const DEFAULT_CONTRACT_ADDRESS = rawAddress;
export const EXPLORER_BASE = 'https://explorer-studio.genlayer.com';

export const isValidContractAddress = (addr) => {
  const s = String(addr || '').trim();
  return Boolean(s && s !== ZERO && /^0x[0-9a-fA-F]{40}$/.test(s));
};

export const hasContractAddress = isValidContractAddress(rawAddress);

export const studionet = officialStudionet || {
  id: 61999,
  name: 'GenLayer Studionet',
  rpcUrls: { default: { http: [STUDIO_RPC] } },
  nativeCurrency: {
    name: 'GEN Token',
    symbol: 'GEN',
    decimals: 18,
  },
};

export const studioRpcUrl = (origin) => {
  if (!origin || typeof origin !== 'string') return STUDIO_RPC;
  return `${origin.replace(/\/$/, '')}/api/genlayer`;
};

const browserOrigin = () => (typeof window !== 'undefined' ? window.location.origin : '');

function studioChain() {
  const endpoint = studioRpcUrl(browserOrigin());
  return {
    ...studionet,
    rpcUrls: {
      default: { http: [endpoint] },
    },
  };
}

const toAddress = (account) => {
  if (!account) return '';
  if (typeof account === 'string') return account.trim();
  return String(account.address || '').trim();
};

const toWriteAccount = (account) => {
  const address = toAddress(account);
  if (!address) return null;
  return { address };
};

export const sameAddress = (a, b) => {
  const left = toAddress(a).toLowerCase();
  const right = toAddress(b).toLowerCase();
  if (!left || !right) return false;
  return left === right;
};

export const isEthAddress = (addr) => /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim());

export const asPlain = (val) => {
  if (val instanceof Map) {
    const obj = {};
    for (const [k, v] of val.entries()) obj[String(k)] = asPlain(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(asPlain);
  if (typeof val === 'bigint') return val.toString();
  return val;
};

export const unwrapViewResult = (val) => {
  const plain = asPlain(val);
  if (plain === null || plain === undefined) return plain;
  if (typeof plain === 'string') {
    const trimmed = plain.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length > 4 && trimmed.length % 2 === 0) {
      try {
        const hex = trimmed.slice(2);
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i += 1) {
          bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        const text = new TextDecoder().decode(bytes).trim();
        if (text.startsWith('[') || text.startsWith('{') || /^\d+$/.test(text)) {
          return unwrapViewResult(text);
        }
      } catch {
        /* keep original */
      }
    }
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return unwrapViewResult(JSON.parse(trimmed));
      } catch {
        return plain;
      }
    }
  }
  return plain;
};

export const formatWriteError = (err) => {
  const msg = String(err?.shortMessage || err?.details || err?.message || err || '');
  const low = msg.toLowerCase();
  if (low.includes('user rejected') || low.includes('user denied') || low.includes('rejected the request')) {
    return 'Đã hủy giao dịch trong MetaMask.';
  }
  if (low.includes('insufficient') || low.includes('funds')) {
    return 'Không đủ GEN cho số escrow cộng gas. Nạp ví từ GenLayer Studio → Accounts.';
  }
  if (low.includes('invalid address') || (low.includes('undefined') && low.includes('address'))) {
    return 'Chưa gắn địa chỉ ví. Kết nối lại MetaMask trên GenLayer Studionet rồi thử lại.';
  }
  if (low.includes('reverted')) {
    return 'Giao dịch Studionet bị revert. Trạng thái contract không đổi. Kiểm tra % chia, nguồn tham chiếu và số GEN.';
  }
  if (low.includes('did not update') || low.includes('state unchanged') || low.includes('to update on studionet')) {
    return 'MetaMask đã xác nhận nhưng storage chưa đổi. Bấm Làm mới. Nếu vẫn vậy, giao dịch GenVM chưa vào — kiểm tra số dư GEN rồi gửi lại.';
  }
  if (low.includes('canceled') || low.includes('cancelled')) {
    return 'Studionet đánh dấu giao dịch CANCELED. Làm mới, rồi gửi lại nếu state chưa đổi.';
  }
  if (low.includes('leader_timeout') || low.includes('validators_timeout')) {
    return 'Đồng thuận Studionet hết giờ trước khi GenVM xong. Đợi khoảng 30 giây, Làm mới, chỉ gửi lại nếu state chưa đổi.';
  }
  if (low.includes('timed out') || low.includes('timeout')) {
    return 'Hết giờ chờ xác nhận. Nếu MetaMask đã xác nhận, đợi 30 giây rồi Làm mới — chưa gửi lại ngay.';
  }
  return msg || 'Giao dịch ghi thất bại.';
};

const toValueBigInt = (value) => {
  if (typeof value === 'bigint') return value < 0n ? 0n : value;
  if (typeof value === 'number') return 0n;
  const raw = String(value ?? '0').trim();
  if (raw === '' || raw === '0x' || raw === '0x0') return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
};

const extractTxHash = (raw) => {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    return String(raw.hash || raw.transactionHash || raw.txHash || raw.id || '');
  }
  return String(raw);
};

export const getGenlayerClient = (account) => {
  try {
    const cfg = { chain: studioChain() };
    const address = toAddress(account);
    if (address) cfg.account = address;
    if (typeof window !== 'undefined' && window.ethereum) {
      cfg.provider = window.ethereum;
    }
    return createClient(cfg);
  } catch (err) {
    console.warn('GenLayer client initialization fallback:', err);
    return null;
  }
};

const studioRpc = async (method, params = []) => {
  const endpoint = studioRpcUrl(browserOrigin());
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  }).then((r) => r.json());
  if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res?.result;
};

const SUCCESS_TX_STATUSES = new Set(['ACCEPTED', 'FINALIZED', 'READY_TO_FINALIZE']);
const FAILURE_TX_STATUSES = new Set(['CANCELED', 'UNDETERMINED', 'VALIDATORS_TIMEOUT', 'LEADER_TIMEOUT']);

const normalizeTxStatus = (raw) => {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    return String(raw.status || raw.statusName || raw.result || '').toUpperCase();
  }
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const map = {
      5: 'ACCEPTED',
      6: 'UNDETERMINED',
      7: 'FINALIZED',
      8: 'CANCELED',
      11: 'READY_TO_FINALIZE',
      12: 'VALIDATORS_TIMEOUT',
      13: 'LEADER_TIMEOUT',
    };
    return map[Number(s)] || s;
  }
  return s.toUpperCase();
};

const waitForStudioTx = async (txHash, maxRetries = 60, intervalMs = 3000) => {
  let lastStatus = '';
  let sawTx = false;

  for (let i = 0; i < maxRetries; i += 1) {
    const genStatus = await studioRpc('gen_getTransactionStatus', [txHash]).catch((err) => {
      const msg = String(err?.message || err || '');
      if (msg.toLowerCase().includes('not found')) return null;
      console.warn('gen_getTransactionStatus note:', err);
      return null;
    });

    if (genStatus != null) {
      sawTx = true;
      const status = normalizeTxStatus(genStatus);
      lastStatus = status || lastStatus;
      if (SUCCESS_TX_STATUSES.has(status)) {
        await new Promise((r) => setTimeout(r, 1500));
        return { hash: txHash, status, genStatus };
      }
      if (FAILURE_TX_STATUSES.has(status)) {
        throw new Error(`Studionet transaction ended as ${status}. Contract state was not changed.`);
      }
    }

    const receipt = await studioRpc('eth_getTransactionReceipt', [txHash]).catch(() => null);
    if (receipt) {
      sawTx = true;
      const status = receipt.status;
      if (status === '0x0' || status === 0 || status === '0') {
        throw new Error('Studionet transaction reverted. Contract state was not changed.');
      }
      if (!lastStatus || lastStatus === 'PENDING' || lastStatus === 'PROPOSING') {
        lastStatus = 'EVM_INCLUDED';
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (sawTx) {
    throw new Error(`Timed out waiting for Studionet tx ${txHash} (last status: ${lastStatus || 'unknown'}).`);
  }
  throw new Error(`Timed out waiting for Studionet receipt ${txHash}.`);
};

const studionetChainIdHex = () => {
  const id = Number((officialStudionet || studionet).id || 61999);
  return `0x${id.toString(16)}`;
};

export const switchToGenlayerStudionet = async () => {
  if (typeof window === 'undefined' || !window.ethereum) return;
  const chainIdHex = studionetChainIdHex();
  const rpc = studioRpcUrl(window.location.origin);
  const chain = officialStudionet || studionet;

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  } catch (switchError) {
    const missing =
      switchError?.code === 4902 ||
      String(switchError?.message || '').toLowerCase().includes('unrecognized chain');
    if (!missing) throw switchError;
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: chainIdHex,
        chainName: chain.name || 'GenLayer Studionet',
        nativeCurrency: chain.nativeCurrency || {
          name: 'GEN Token',
          symbol: 'GEN',
          decimals: 18,
        },
        rpcUrls: [rpc],
        blockExplorerUrls: [chain.blockExplorers?.default?.url || EXPLORER_BASE],
      }],
    });
  }
};

export const sendContractTransaction = async ({
  from,
  to,
  functionName,
  args = [],
  value = 0n,
}) => {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('Cần MetaMask để ký giao dịch trên GenLayer.');
  }
  if (!isValidContractAddress(to)) {
    throw new Error('Chưa có địa chỉ contract. Deploy trên GenLayer Studio trước.');
  }

  const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const sender = toAddress(from) || (accs && accs[0]);
  if (!sender) {
    throw new Error('Chưa có ví. Kết nối MetaMask để tiếp tục.');
  }

  await switchToGenlayerStudionet();

  const client = getGenlayerClient(sender);
  if (!client || !client.writeContract) {
    throw new Error('GenLayer write client is not available.');
  }

  const valueWei = toValueBigInt(value);
  const writeAccount = toWriteAccount(sender);

  try {
    const raw = await client.writeContract({
      account: writeAccount,
      address: to,
      functionName,
      args,
      value: valueWei,
    });
    const hash = extractTxHash(raw);
    if (!hash) throw new Error('writeContract returned no transaction hash.');
    return hash;
  } catch (err) {
    throw new Error(formatWriteError(err));
  }
};

export const waitForFinalizedTx = async (txHash, maxRetries = 60, intervalMs = 3000) => {
  const hash = extractTxHash(txHash);
  if (!hash) throw new Error('Missing transaction hash.');

  try {
    return await waitForStudioTx(hash, maxRetries, intervalMs);
  } catch (studioErr) {
    const studioMsg = String(studioErr?.message || '').toLowerCase();
    if (
      studioMsg.includes('reverted') ||
      studioMsg.includes('ended as') ||
      studioMsg.includes('canceled') ||
      studioMsg.includes('undetermined') ||
      studioMsg.includes('leader_timeout') ||
      studioMsg.includes('validators_timeout')
    ) {
      throw studioErr;
    }

    const client = getGenlayerClient();
    if (client && client.waitForTransactionReceipt) {
      try {
        const receipt = await client.waitForTransactionReceipt({
          hash,
          status: TransactionStatus.ACCEPTED,
          retries: maxRetries < 40 ? maxRetries : 40,
          interval: intervalMs,
        });
        return receipt;
      } catch (err) {
        console.warn('waitForTransactionReceipt note:', err);
      }
    }
    return { hash, pending: true, warning: String(studioErr?.message || studioErr) };
  }
};

export const waitForContractEffect = async ({
  read,
  predicate,
  retries = 30,
  intervalMs = 2000,
  label = 'contract state',
}) => {
  let last = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      last = await read();
      if (await predicate(last)) return last;
    } catch (err) {
      console.warn(`waitForContractEffect(${label}) read note:`, err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Hết giờ chờ ${label} cập nhật trên Studionet. Làm mới trang; nếu số liệu vẫn cũ, lệnh GenVM chưa vào — đừng coi là thành công.`
  );
};

export const readContractState = async (functionName, args = [], targetAddress, fromAddress) => {
  const addr = targetAddress;
  if (!isValidContractAddress(addr)) return null;

  try {
    const client = getGenlayerClient(fromAddress || VIEW_FROM);
    if (client && client.readContract) {
      const result = await client.readContract({
        address: addr,
        functionName,
        args,
        account: toWriteAccount(fromAddress || VIEW_FROM),
        stateStatus: 'accepted',
      });
      return unwrapViewResult(result);
    }
  } catch (err) {
    console.warn(`readContract ${functionName} note:`, err);
  }

  try {
    const client = getGenlayerClient(VIEW_FROM);
    if (client && client.readContract) {
      const result = await client.readContract({
        address: addr,
        functionName,
        args,
        account: { address: VIEW_FROM },
      });
      return unwrapViewResult(result);
    }
  } catch (err) {
    console.warn(`readContract fallback ${functionName} note:`, err);
  }
  return null;
};

export const txExplorerUrl = (hash) => {
  if (!hash) return EXPLORER_BASE;
  return `${EXPLORER_BASE}/tx/${hash}`;
};

export const addressExplorerUrl = (addr) => {
  if (!addr) return EXPLORER_BASE;
  return `${EXPLORER_BASE}/address/${addr}`;
};
