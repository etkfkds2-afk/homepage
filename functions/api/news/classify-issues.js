import { ensureNewsDb, isCollectorAuthorized, json } from '../../_lib/news-db.js';
import { CONTENT_QUALITY_FILTERS } from './articles.js';
import { classifyIssues } from '../../_lib/news-issue-classify.js';

const SUPPORTED_CATEGORIES = new Set(['바둑', '최신순', '인기순']);

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);
  try {
    await ensureNewsDb(env);
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || '바둑';
    if (!SUPPORTED_CATEGORIES.has(category)) return json({ error: `지원하지 않는 category: ${category}` }, 400);

    const dbCategory = category === '바둑' ? '바둑' : null;
    const where = [...CONTENT_QUALITY_FILTERS, "COALESCE(NULLIF(a.published_at,''),a.fetched_at) >= datetime('now','-30 days')"];
    const bindings = [];
    if (dbCategory) {
      where.push('a.category = ?');
      bindings.push(dbCategory);
    } else if (category === '최신순') {
      where.push("a.category <> '바둑'");
    }
    bindings.push(400);

    const result = await env.DB.prepare(`
      SELECT a.url_key, a.title, a.summary, a.published_at, a.fetched_at
      FROM news_articles a
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(NULLIF(a.published_at,''), a.fetched_at) DESC
      LIMIT ?
    `).bind(...bindings).all();
    const articles = result.results || [];
    if (!articles.length) {
      return json({ ok: true, category, count: 0, issues: [] });
    }

    const groups = await classifyIssues(env, articles);
    const payload = groups.map((group, index) => ({
      key: group.misc ? `${category}|ai:misc` : `${category}|ai:${index}`,
      title: group.title,
      url_keys: group.url_keys
    }));

    await env.DB.prepare(
      `INSERT INTO news_issue_cache (category, payload, built_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(category) DO UPDATE SET payload = excluded.payload, built_at = CURRENT_TIMESTAMP`
    ).bind(category, JSON.stringify(payload)).run();

    const provider = env?.ANTHROPIC_API_KEY ? 'anthropic' : env?.AI ? 'workers-ai' : 'none';

    return json({
      ok: true,
      category,
      count: articles.length,
      provider,
      issues: payload.map(group => ({ key: group.key, title: group.title, count: group.url_keys.length }))
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
