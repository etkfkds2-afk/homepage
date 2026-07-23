import { ensureNewsDb, json, userId } from '../../_lib/news-db.js';

const CATEGORIES = new Set(['정치', '경제', '사회', '생활/문화', '세계', 'IT/과학', '바둑', '기타']);

export async function onRequestGet({ request, env }) {
  try {
    await ensureNewsDb(env);
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const requestedView = url.searchParams.get('view') || 'latest';
    const view = ['saved', 'popular'].includes(requestedView) ? requestedView : 'latest';
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
    if (query) {
      where.push('(a.title LIKE ? OR a.summary LIKE ? OR a.press LIKE ?)');
      const term = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      bindings.push(term, term, term);
    }
    if (view === 'saved') where.push('s.url_key IS NOT NULL');
    if (view === 'popular') where.push('p.title IS NOT NULL');
    if (view !== 'saved') where.push("COALESCE(NULLIF(a.published_at,''),a.fetched_at) >= datetime('now','-30 days')");
    bindings.push(limit);

    const order = view === 'popular'
      ? "p.score DESC, COALESCE(NULLIF(a.published_at,''),a.fetched_at) DESC"
      : "COALESCE(NULLIF(a.published_at,''), a.fetched_at) DESC";

    const result = await env.DB.prepare(`
      SELECT a.id, a.url, a.url_key, a.title, a.source, a.press, a.category,
             a.published_at, a.fetched_at, a.summary, a.summary_quality, a.image_url,
             CASE WHEN s.url_key IS NULL THEN 0 ELSE 1 END AS saved
      FROM news_articles a
      LEFT JOIN news_saved s ON s.url_key=a.url_key AND s.user_id=?
      LEFT JOIN news_hidden h ON h.url_key=a.url_key AND h.user_id=?
      LEFT JOIN news_popular_items p ON (p.url_key=a.url_key OR p.title=a.title) AND p.collected_at >= datetime('now','-2 days')
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ?
    `).bind(...bindings).all();
    const seenTitles = new Set();
    const items = (result.results || []).filter(item => {
      const key = String(item.title || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
      if (!key || seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });
    return json({ ok: true, items });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
