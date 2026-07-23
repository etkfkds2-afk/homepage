import { ensureNewsDb, json } from '../../_lib/news-db.js';

export async function onRequestGet({ env }) {
  try {
    await ensureNewsDb(env);
    const [articles, run] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS count, MAX(fetched_at) AS latest,
        SUM(CASE WHEN length(body_text)>=300 THEN 1 ELSE 0 END) AS body_ready,
        SUM(CASE WHEN summary_quality='full' THEN 1 ELSE 0 END) AS publishable,
        SUM(CASE WHEN image_url<>'' THEN 1 ELSE 0 END) AS with_image
        FROM news_articles`).first(),
      env.DB.prepare('SELECT started_at,finished_at,status,inserted_count,message FROM news_runs ORDER BY id DESC LIMIT 1').first()
    ]);
    return json({
      ok: true,
      article_count: articles?.count || 0,
      latest_article: articles?.latest || '',
      body_ready: articles?.body_ready || 0,
      publishable: articles?.publishable || 0,
      with_image: articles?.with_image || 0,
      ai_bound: Boolean(env.AI),
      last_run: run || null
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
