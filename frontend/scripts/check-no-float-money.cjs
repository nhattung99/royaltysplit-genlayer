// Fails if parseFloat / Math.round / Math.floor / Math.ceil sit near money words.
// Sole whitelist: the float call's own line names bps / basisPoints / splitPercent
// and does not also name a wei/revenue/payout/balance amount.
// .cjs so this works when frontend/package.json has "type": "module".

const fs = require('fs');
const path = require('path');

const WINDOW = 12;
const BLOCK_MAX = 40;

function resolveSrcDir() {
  const candidates = [
    path.join(__dirname, '..', 'src'),
    path.join(__dirname, '..', 'frontend', 'src'),
  ];
  const found = candidates.find((dir) => fs.existsSync(dir));
  if (!found) {
    console.error('[BUILD REJECTED] Could not locate frontend src directory for float-money audit.');
    process.exit(1);
  }
  return found;
}

function getFilesRecursively(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath));
    } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
      results.push(fullPath);
    }
  });
  return results;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function enclosingBlockRange(lines, index) {
  let start = index;
  let depth = 0;
  for (let i = index; i >= 0 && (index - i) < BLOCK_MAX; i -= 1) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    depth += closes - opens;
    start = i;
    if (depth > 0) continue;
    if (opens > 0) break;
  }
  let end = index;
  depth = 0;
  for (let i = index; i < lines.length && (i - index) < BLOCK_MAX; i += 1) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    depth += opens - closes;
    end = i;
    if (i > index && depth <= 0 && closes > 0) break;
  }
  return { start, end };
}

function isWhitelistedBpsLine(line) {
  const namesBps = /\b(bps|basisPoints|splitPercent)\b/.test(line);
  const namesHardMoney = /revenue|payout|balance|\bwei\b/i.test(line);
  return namesBps && !namesHardMoney;
}

function runCheck() {
  console.log('Running prebuild check: Auditing codebase for floating-point money math...');

  const targetDir = resolveSrcDir();
  const displayRoot = path.join(targetDir, '..', '..');
  const files = getFilesRecursively(targetDir);
  let failed = false;
  let hitCount = 0;

  const floatRegex = /\bparseFloat\s*\(|Math\.round\s*\(|Math\.floor\s*\(|Math\.ceil\s*\(/;
  const moneyRegex = /revenue|amount|payout|balance|wei|gen|artist|payor/i;

  files.forEach((file) => {
    const relativePath = path.relative(displayRoot, file);
    const content = stripComments(fs.readFileSync(file, 'utf-8'));
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      if (!floatRegex.test(line)) return;
      if (isWhitelistedBpsLine(line)) return;

      const windowStart = Math.max(0, index - WINDOW);
      const windowEnd = Math.min(lines.length - 1, index + WINDOW);
      const windowText = lines.slice(windowStart, windowEnd + 1).join('\n');
      const block = enclosingBlockRange(lines, index);
      const blockText = lines.slice(block.start, block.end + 1).join('\n');

      const sameLine = moneyRegex.test(line);
      const nearWindow = moneyRegex.test(windowText);
      const nearBlock = moneyRegex.test(blockText);

      if (sameLine || nearWindow || nearBlock) {
        hitCount += 1;
        const reason = sameLine ? 'same line' : (nearWindow ? `within ±${WINDOW} lines` : 'same code block');
        console.error(`\x1b[31m[ERROR]\x1b[0m Float operation near monetary identifier (${reason}) in ${relativePath}:${index + 1}`);
        console.error(`  > Line: ${line.trim()}`);
        failed = true;
      }
    });
  });

  if (failed) {
    console.error(`\x1b[31m[BUILD REJECTED]\x1b[0m ${hitCount} floating-point operation(s) detected near monetary variables. Use parseGenToWei / formatWeiToGen / computeSplitPreview.`);
    process.exit(1);
  }
  console.log('\x1b[32m[PASS]\x1b[0m No floating-point operations detected on monetary variables. Strict BigInt integrity verified.');
  process.exit(0);
}

runCheck();
