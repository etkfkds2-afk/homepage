const queries = [
  '바둑', 'baduk', '바둑 대회', '바둑 행사', '바둑 축제', '전국 바둑대회',
  '한국기원 대회', '대한바둑협회 바둑대회', '아마추어 바둑대회', '어린이 바둑대회',
  '초등 바둑대회', '학생 바둑대회', '청소년 바둑대회', '유소년 바둑대회',
  '꿈나무 바둑대회', '지역 바둑대회', '시니어 아마 바둑대회', '생활체육 바둑대회',
  '바둑 참가자 모집', '바둑문화 행사', '시도 바둑협회 대회', '전국체전 바둑',
  '소년체전 바둑', '프로바둑 대회', '바둑리그', '여자바둑리그',
  '시니어바둑리그', '바둑 기전', '세계 바둑대회', '신진서 대국', '최정 바둑'
];

function text(block, tag) {
  return (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').trim();
}

const token = process.env.NEWSBRIEF_COLLECT_TOKEN;
if (!token) throw new Error('NEWSBRIEF_COLLECT_TOKEN is missing');
const full = process.env.NEWSBRIEF_BACKFILL === '1';
const hourSlot = Math.floor(Date.now() / 1800000);
const selected = full ? queries : Array.from({ length: 8 }, (_, i) => queries[(hourSlot * 8 + i) % queries.length]);
const found = new Map();
for (const query of selected) {
  const endpoint = new URL('https://news.google.com/rss/search');
  endpoint.searchParams.set('q', `${query} when:${full ? 30 : 1}d`);
  endpoint.searchParams.set('hl', 'ko'); endpoint.searchParams.set('gl', 'KR'); endpoint.searchParams.set('ceid', 'KR:ko');
  const response = await fetch(endpoint, { headers: { 'user-agent': 'Mozilla/5.0 NewsBrief personal feed reader' } });
  if (!response.ok) continue;
  const xml = await response.text();
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const raw = text(match[1], 'title');
    const parts = raw.split(/\s+-\s+/); const press = parts.length > 1 ? parts.pop() : '';
    const title = parts.join(' - ') || raw;
    if (title.length >= 8 && !found.has(title)) found.set(title, { title, press, pubDate: text(match[1], 'pubDate') });
    if (found.size >= (full ? 100 : 40)) break;
  }
  if (found.size >= (full ? 100 : 40)) break;
}
const endpoint = `https://newsbrief-etkfkds2.pages.dev/api/news/collect${full ? '?backfill=1' : ''}`;
const response = await fetch(endpoint, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ googleDiscoveries: [...found.values()] })
});
const result = await response.text();
console.log(`Google discoveries=${found.size} collector=${response.status} ${result}`);
if (!response.ok) process.exitCode = 1;
