const NUMBERING = /^\s*(?:\d{1,2}[.)]|[①-⑳]|[-•▪▶])\s*/u;

const CUT_MARKERS = [
  '함께 찾은 검색어', '이 시각 추천뉴스', '많이 본 뉴스', '관련기사',
  '기사 더보기', '해당 언론사로 이동합니다', '뉴시스에서 직접 확인하세요'
];

const JUNK_PATTERNS = [
  /기사\s*제목과\s*주요\s*문장을\s*기반으로.*결과입니다/i,
  /(?:자동\s*요약|요약보기|음성으로\s*듣기|음성재생\s*설정|번역\s*(?:beta|베타)|타임톡)/i,
  /(?:무단전재|재배포\s*금지|저작권자|Copyright|인터넷신문윤리위원회|한국기자협회)/i,
  /(?:제보|문의).*(?:전화|이메일|메일|카카오톡|카톡|jebo)/i,
  /(?:전화|이메일|메일|카카오톡|카톡|jebo).*(?:제보|문의)/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /^(?:입력|수정)\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}/,
  /^\s*(?:사진|자료사진|동영상|광고|ADVERTISEMENT)\s*$/i,
  /(?:구독|좋아요|공감|댓글)\s*(?:버튼|하기|눌러)/i
  ,/(?:^|\s)편집국\s+[A-Z][a-z]+\s+\d{1,2},\s*\d{4}.*완독/i
  ,/완독\s*약?\s*\d+\s*분\s*소요/i
];

export function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripNumbering(value) {
  return normalizeText(value).replace(NUMBERING, '').trim();
}

function comparisonKey(value) {
  return stripNumbering(value).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

export function isJunkLine(value) {
  const line = stripNumbering(value);
  if (!line || line.length < 8) return true;
  if ((line.match(/#[0-9A-Za-z가-힣_]+/g) || []).length >= 2) return true;
  return JUNK_PATTERNS.some(pattern => pattern.test(line));
}

function isNearDuplicate(a, b) {
  const left = comparisonKey(a);
  const right = comparisonKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) >= 14 && (left.includes(right) || right.includes(left))) return true;
  const leftSet = new Set(left.match(/.{1,2}/g) || []);
  const rightSet = new Set(right.match(/.{1,2}/g) || []);
  let common = 0;
  for (const token of leftSet) if (rightSet.has(token)) common += 1;
  return common / Math.max(leftSet.size, rightSet.size, 1) >= 0.82;
}

function splitCandidates(value) {
  let text = normalizeText(value);
  let cut = text.length;
  for (const marker of CUT_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0) cut = Math.min(cut, at);
  }
  text = text.slice(0, cut);
  return text
    .split(/\n+|(?<=[.!?…])\s+(?=["'“‘(]?[0-9A-Za-z가-힣])/u)
    .map(stripNumbering)
    .map(line => line.replace(/^(?:[가-힣]{2,4}\s*)?(?:기자|특파원)\s*[=:·-]?\s*/u, '').trim())
    .filter(Boolean);
}

function cleanCandidate(value) {
  return stripNumbering(value)
    .replace(/\b자동\s*요약\b/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:·|]+|[,;:·|]+$/g, '')
    .trim();
}

function validCandidate(value, title) {
  if (isJunkLine(value)) return false;
  const line = cleanCandidate(value);
  if (line.length < 18 || line.length > 220) return false;
  if (/(?:\.{3,}|…)$/.test(line)) return false;
  if (title && isNearDuplicate(line, title)) return false;
  if (/^(?:기자|특파원|앵커)\s*[=:]/.test(line)) return false;
  return true;
}

export function buildSummary({ title = '', rawSummary = '', body = '', maxLines = 3 } = {}) {
  const candidates = [...splitCandidates(rawSummary), ...splitCandidates(body)];
  const lines = [];
  for (const raw of candidates) {
    const line = cleanCandidate(raw);
    if (!validCandidate(line, title)) continue;
    if (lines.some(existing => isNearDuplicate(existing, line))) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines.map((line, index) => `${index + 1}) ${line}`).join('\n');
}

export function sanitizeStoredSummary({ title = '', summary = '', body = '' } = {}) {
  const cleaned = buildSummary({ title, rawSummary: summary, body });
  const lineCount = cleaned ? cleaned.split('\n').length : 0;
  return {
    summary: cleaned,
    quality: lineCount >= 3 ? 'full' : lineCount > 0 ? 'short' : 'none',
    lineCount
  };
}
