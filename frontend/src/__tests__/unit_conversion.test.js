import {
  parseGenToWei,
  formatWeiToGen,
  sanitizeGenInput,
  percentToBps,
  formatBpsAsPercent,
  parseSplitPercent,
  computeSplitPreview,
  splitBothPositive,
  sideLabel,
  weiFromField,
} from '../money.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run() {
  console.log('Starting RoyaltySplit money tests...');

  const smallestWei = parseGenToWei('0.000000000000000001');
  assert(smallestWei === 1n, `smallest wei expected 1n, got ${smallestWei}`);
  assert(formatWeiToGen(1n) === '0.000000000000000001', 'format 1 wei');

  const pointOneWei = parseGenToWei('0.1');
  assert(pointOneWei === 100000000000000000n, '0.1 GEN');
  assert(formatWeiToGen(pointOneWei) === '0.1', 'format 0.1');

  const millionWei = parseGenToWei('1000000');
  assert(millionWei === 1000000000000000000000000n, '1000000 GEN');
  assert(formatWeiToGen(millionWei) === '1000000', 'format million');

  for (const val of ['1', '0.5', '100.25', '0.000001', '30000']) {
    const formatted = formatWeiToGen(parseGenToWei(val));
    assert(formatted === val, `round-trip ${val} -> ${formatted}`);
  }

  assert(parseGenToWei('') === 0n, 'empty');
  assert(parseGenToWei('abc') === 0n, 'invalid');
  assert(parseGenToWei('1e18') === 0n, 'scientific notation rejected');
  assert(formatWeiToGen(0n) === '0', 'zero');
  assert(sanitizeGenInput('12.3abc4') === '12.34', 'sanitize');

  assert(percentToBps(60) === 6000, '60% is 6000 bps');
  assert(percentToBps('80') === 8000, 'chip 80');
  assert(parseSplitPercent('1') === 1, 'min percent');
  assert(parseSplitPercent('99') === 99, 'max percent');
  assert(parseSplitPercent('0') === 1, '0 clamps to 1');
  assert(parseSplitPercent('100') === 99, '100 clamps to 99');
  assert(percentToBps('60.5') === 6000, 'non-integer percent falls back to 60');
  assert(formatBpsAsPercent(6000) === '60', '6000 bps displays as 60');
  assert(formatBpsAsPercent(6050) === '60.5', '6050 bps displays as 60.5');

  const hand = computeSplitPreview(1000n, 6000);
  assert(hand.artistAmount === 600n, `artist 600, got ${hand.artistAmount}`);
  assert(hand.payorShare === 400n, `payor 400, got ${hand.payorShare}`);
  assert(hand.artistAmount + hand.payorShare === 1000n, 'hand split sums to total');

  const remainder = computeSplitPreview(10001n, 6000);
  assert(remainder.artistAmount === 6000n, 'remainder artist');
  assert(remainder.payorShare === 4001n, 'remainder payor');
  assert(remainder.artistAmount + remainder.payorShare === 10001n, 'remainder sums');

  const ten = parseGenToWei('10');
  const preview = computeSplitPreview(ten, percentToBps(60));
  assert(preview.artistAmount === parseGenToWei('6'), '6 GEN artist from 10 GEN at 60%');
  assert(preview.payorShare === parseGenToWei('4'), '4 GEN payor from 10 GEN at 60%');
  assert(splitBothPositive(ten, 6000) === true, '10 GEN splits cleanly');
  assert(splitBothPositive(1n, 6000) === false, '1 wei at 60% truncates the artist side');

  assert(weiFromField('600') === 600n, 'wei field string');
  assert(weiFromField(1.5) === 0n, 'js number money is rejected');
  assert(sideLabel(0n, false) === 'Không có', 'zero side');
  assert(sideLabel(600n, true) === 'Đã chuyển', 'paid side');
  assert(sideLabel(400n, false) === 'Đang chờ', 'pending side');

  console.log('All RoyaltySplit money tests passed.');
}

run();
