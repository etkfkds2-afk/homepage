import { ensureNewsDb, json } from '../../_lib/news-db.js';

export async function onRequestGet({ env }) {
  try {
    await ensureNewsDb(env);
    const [articles, run] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS count, MAX(fetched_at) AS latest FROM news_articles').first(),
      env.DB.prepare('SELECT started_at,finished_at,status,inserted_count,message FROM news_runs ORDER BY id DESC LIMIT 1').first()
    ]);
    return json({ ok: true, article_count: articles?.count || 0, latest_article: articles?.latest || '', last_run: run || null });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
