import { ensureNewsDb, json, userId } from '../../_lib/news-db.js';
import { normalizeText, validateThreeLineSummary } from '../../_lib/news-summary.js';

const CATEGORIES = new Set(['정치', '경제', '사회', '생활/문화', '세계', 'IT/과학', '바둑', '기타']);
const NAVER_OUTLETS = {
  '001': '연합뉴스', '003': '뉴시스', '005': '국민일보', '008': '머니투데이',
  '009': '매일경제', '011': '서울경제', '014': '파이낸셜뉴스', '015': '한국경제TV',
  '016': '헤럴드경제', '018': '이데일리', '020': '동아일보', '021': '문화일보',
  '022': '세계일보', '023': '조선일보', '025': '중앙일보', '028': '한겨레',
  '032': '경향신문', '052': 'YTN', '055': 'SBS', '056': 'KBS', '057': 'MBN',
  '081': '서울신문', '082': '부산일보', '087': '강원일보', '092': '부산MBC',
  '119': '데일리안', '214': 'MBC', '215': '한국경제', '277': '아시아경제',
  '079': '노컷뉴스', '293': '블로터', '366': '조선비즈', '374': 'SBS Biz',
  '421': '뉴스1', '448': 'TV조선'
};
const HOST_OUTLETS = {
  'cctoday.co.kr': '충청투데이', 'econovill.com': '이코노믹리뷰', 'etnews.com': '전자신문',
  'ichannela.com': '채널A', 'imaeil.com': '매일신문', 'kids.donga.com': '어린이동아',
  'mbn.mk.co.kr': 'MBN', 'ppss.kr': 'ㅍㅍㅅㅅ', 'topstarnews.net': '톱스타뉴스',
  'yna.co.kr': '연합뉴스'
};

function bigrams(value) {
  const text = String(value || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
  const out = new Set();
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

function similar(a, b, threshold = 0.64) {
  const left = bigrams(a), right = bigrams(b);
  if (!left.size || !right.size) return false;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return (2 * common) / (left.size + right.size) >= threshold;
}

function cleanOutlet(value) {
  return normalizeText(value)
    .replace(/\s+(?:[-|–—]|·)\s+(?:[^\n]{2,})$/u, '')
    .replace(/\s*(?:대한민국|울산)\s*(?:최초|최고)[^\n]*$/u, '')
    .trim()
    .slice(0, 40);
}

function outletFor(item) {
  const press = cleanOutlet(item.press);
  if (press) return press;
  const oid = String(item.url || '').match(/\/article\/(\d{3})\//)?.[1];
  if (oid && NAVER_OUTLETS[oid]) return NAVER_OUTLETS[oid];
  if (item.source === 'NAVER') return '네이버 뉴스';
  if (item.source === 'DAUM' || item.source === 'KAKAO') return '다음 뉴스';
  if (item.source === 'GOOGLE') return 'Google 뉴스';
  const source = cleanOutlet(item.source);
  return HOST_OUTLETS[source.replace(/^www\./, '')] || source || '기타';
}

export async function onRequestGet({ request, env }) {
  try {
    await ensureNewsDb(env);
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 0, 0), 24 * 30);
    const requestedView = url.searchParams.get('view') || 'latest';
    const view = ['saved', 'popular', 'home'].includes(requestedView) ? requestedView : 'latest';
    const excludeBaduk = url.searchParams.get('exclude_baduk') === '1';
    const maxLimit = category === '바둑' ? 100 : 300;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), maxLimit);
    const uid = userId(request);
    const where = [
      "h.url_key IS NULL", "a.summary_quality='full'", "TRIM(a.summary)<>''",
      "instr(a.title,'�')=0",
      "lower(a.url) NOT LIKE '%dcinside.com%'",
      "lower(a.url) NOT LIKE '%blog.naver.com%'",
      "lower(a.url) NOT LIKE '%cafe.naver.com%'",
      "lower(a.url) NOT LIKE '%tistory.com%'",
      "lower(a.url) NOT LIKE '%fmkorea.com%'",
      "lower(a.url) NOT LIKE '%theqoo.net%'",
      "lower(a.url) NOT LIKE '%ruliweb.com%'",
      "lower(a.url) NOT LIKE '%clien.net%'",
      "lower(a.url) NOT LIKE '%ppomppu.co.kr%'",
      "lower(a.url) NOT LIKE '%instiz.net%'",
      "lower(a.url) NOT LIKE '%youtube.com%'",
      "lower(a.url) NOT LIKE '%namu.wiki%'",
      "lower(a.url) NOT LIKE '%sports.naver.com/%'",
      "a.summary NOT LIKE '%글자크기%'",
      "a.summary NOT LIKE '%글자 크기%'",
      "a.summary NOT LIKE '%본문 내용은%'",
      "a.title NOT LIKE '%시세 조회로%'",
      "a.title NOT LIKE '%현명한 투자하세요%'",
      "a.title NOT LIKE '%숙소 환급 상세 안내%'",
      "a.title NOT LIKE '%자동차월드%'"
    ];
    const bindings = [uid, uid];

    if (category && CATEGORIES.has(category)) {
      where.push('a.category = ?');
      bindings.push(category);
    }
    if (excludeBaduk && category !== '바둑') where.push("a.category <> '바둑'");
    if (query) {
      where.push('(a.title LIKE ? OR a.summary LIKE ? OR a.press LIKE ?)');
      const term = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      bindings.push(term, term, term);
    }
    if (view === 'saved') where.push('s.url_key IS NOT NULL');
    if (view === 'popular') where.push('p.title IS NOT NULL');
    if (view !== 'saved') where.push("COALESCE(NULLIF(a.published_at,''),a.fetched_at) >= datetime('now','-30 days')");
    if (hours > 0 && view !== 'saved') {
      where.push("COALESCE(NULLIF(a.published_at,''),a.fetched_at) >= datetime('now', ?)");
      bindings.push(`-${hours} hours`);
    }
    // Similar stories are collapsed after the query. Read extra rows so that
    // deduplication does not make a requested 100/300 item page needlessly short.
    const queryLimit = Math.min(limit * 3, 900);
    bindings.push(queryLimit);

    const order = view === 'popular'
      ? "p.score DESC, COALESCE(NULLIF(a.published_at,''),a.fetched_at) DESC"
      : view === 'home'
        ? "CASE WHEN p.title IS NULL THEN 0 ELSE 1 END DESC, p.score DESC, COALESCE(NULLIF(a.published_at,''),a.fetched_at) DESC"
      : "COALESCE(NULLIF(a.published_at,''), a.fetched_at) DESC";

    const result = await env.DB.prepare(`
      SELECT a.id, a.url, a.url_key, a.title, a.source, a.press, a.category,
             a.published_at, a.fetched_at, a.summary, a.summary_quality, a.image_url,
             CASE WHEN s.url_key IS NULL THEN 0 ELSE 1 END AS saved
      FROM news_articles a
      LEFT JOIN news_saved s ON s.url_key=a.url_key AND s.user_id=?
      LEFT JOIN news_hidden h ON h.url_key=a.url_key AND h.user_id=?
      LEFT JOIN news_popular_items p ON (p.url_key=a.url_key OR p.title=a.title)
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?
    `).bind(...bindings).all();
    const accepted = [];
    for (const item of result.results || []) {
      item.summary = normalizeText(String(item.summary || '').replace(/([1-3][.)])\s*&#10;/gi, '$1 '));
      item.image_url = normalizeText(item.image_url);
      item.source = cleanOutlet(item.source) || '기타';
      item.press = cleanOutlet(item.press);
      if (item.press === item.source) item.press = '';
      item.outlet = outletFor(item);
      if (!validateThreeLineSummary(item.summary, item.title)) continue;
      const first = String(item.summary || '').split('\n')[0].replace(/^\s*1[.)]\s*/, '');
      // Baduk headlines legitimately repeat player and tournament names. Use a
      // much stricter threshold so separate games are not collapsed together.
      const titleThreshold = category === '바둑' ? 0.86 : 0.64;
      const summaryThreshold = category === '바둑' ? 0.9 : 0.72;
      const group = accepted.find(old => similar(item.title, old.title, titleThreshold) || similar(first, old.first, summaryThreshold));
      if (group) {
        if (!group.related.some(old => old.url_key === item.url_key)) {
          group.related.push({ url_key: item.url_key, url: item.url, title: item.title, outlet: item.outlet });
          group.related_count = group.related.length;
        }
        continue;
      }
      accepted.push({ ...item, first, related: [], related_count: 0 });
    }
    const items = accepted.slice(0, limit).map(({ first, ...item }) => item);
    return json({ ok: true, items });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
