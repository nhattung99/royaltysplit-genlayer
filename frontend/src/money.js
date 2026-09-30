const WEI_PER_GEN = 1000000000000000000n;

export const parseGenToWei = (genAmountStr) => {
  if (!genAmountStr) return 0n;
  const str = String(genAmountStr).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return 0n;
  const [intPart, fracPartRaw = ""] = str.split(".");
  const fracPart = (fracPartRaw + "0".repeat(18)).slice(0, 18);
  const wei = BigInt(intPart + fracPart);
  return wei > 0n ? wei : 0n;
};

export const formatWeiToGen = (val) => {
  if (val === null || val === undefined || val === '') return '0';
  let wei;
  try { wei = BigInt(val); } catch { return String(val); }
  if (wei === 0n) return '0';
  const intPart = wei / WEI_PER_GEN;
  const fracPart = wei % WEI_PER_GEN;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : intPart.toString();
};

export const sanitizeGenInput = (raw) => {
  const str = String(raw ?? '');
  let out = '';
  let seenDot = false;
  let fracCount = 0;
  for (const ch of str) {
    if (ch >= '0' && ch <= '9') {
      if (seenDot) {
        if (fracCount >= 18) continue;
        fracCount += 1;
      }
      out += ch;
    } else if (ch === '.' && !seenDot) {
      seenDot = true;
      out += ch;
    }
  }
  return out;
};

export const toWeiString = (val) => {
  if (val === null || val === undefined || val === '') return '0';
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'number') return '0';
  const str = String(val).trim();
  if (!/^\d+$/.test(str)) return '0';
  return str;
};

export const weiFromField = (val) => {
  try {
    return BigInt(toWeiString(val));
  } catch {
    return 0n;
  }
};

/** Integer percent 1-99 → basis points. UI only. Never used as a wei amount. */
export const parseSplitPercent = (raw) => {
  const str = String(raw ?? '').trim();
  if (!/^\d+$/.test(str)) return 60;
  const n = Number(str);
  if (!Number.isInteger(n)) return 60;
  if (n < 1) return 1;
  if (n > 99) return 99;
  return n;
};

export const percentToBps = (splitPercent) => {
  const n = parseSplitPercent(splitPercent);
  return n * 100;
};

/** Display helper. Integer basis points → percent text, no binary float. */
export const formatBpsAsPercent = (bps) => {
  const str = String(bps ?? '').trim();
  if (!/^\d+$/.test(str)) return '0';
  const n = BigInt(str);
  const whole = n / 100n;
  const frac = n % 100n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
};

/**
 * Same integer formula as the contract, outside any AI result:
 * artist = (total * bps) / 10000, payor = total - artist.
 */
export const computeSplitPreview = (declaredWei, artistSplitBps) => {
  const total = BigInt(toWeiString(declaredWei));
  const bpsStr = String(artistSplitBps ?? '').trim();
  const bps = /^\d+$/.test(bpsStr) ? BigInt(bpsStr) : 0n;
  const artistAmount = (total * bps) / 10000n;
  const payorShare = total - artistAmount;
  return { artistAmount, payorShare };
};

export const splitBothPositive = (declaredWei, artistSplitBps) => {
  const { artistAmount, payorShare } = computeSplitPreview(declaredWei, artistSplitBps);
  return artistAmount > 0n && payorShare > 0n;
};

export const sideLabel = (amountWei, alreadyPaid) => {
  if (amountWei <= 0n) return 'Không có';
  return alreadyPaid ? 'Đã chuyển' : 'Đang chờ';
};

export { WEI_PER_GEN };
