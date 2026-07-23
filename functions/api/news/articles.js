import { ensureNewsDb, json, userId } from '../../_lib/news-db.js';

const CATEGORIES = new Set(['정치', '경제', '사회', '생활/문화', '세계', 'IT/과학', '바둑', '기타']);

export async function onRequestGet({ request, env }) {
  try {
    await ensureNewsDb(env);
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '';
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const view = url.searchParams.get('view') === 'saved' ? 'saved' : 'latest';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 200);
    const uid = userId(request);
    const where = ['h.url_key IS NULL'];
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
    bindings.push(limit);

    const result = await env.DB.prepare(`
      SELECT a.id, a.url, a.url_key, a.title, a.source, a.press, a.category,
             a.published_at, a.fetched_at, a.summary, a.summary_quality, a.image_url,
             CASE WHEN s.url_key IS NULL THEN 0 ELSE 1 END AS saved
      FROM news_articles a
      LEFT JOIN news_saved s ON s.url_key=a.url_key AND s.user_id=?
      LEFT JOIN news_hidden h ON h.url_key=a.url_key AND h.user_id=?
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(NULLIF(a.published_at,''), a.fetched_at) DESC
      LIMIT ?
    `).bind(...bindings).all();
    return json({ ok: true, items: result.results || [] });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
