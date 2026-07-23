import { buildSummary, normalizeText } from '../../_lib/news-summary.js';
import {
  canonicalUrl, ensureNewsDb, isCollectorAuthorized, json, sha256
} from '../../_lib/news-db.js';

const SEARCHES = [
  ['정치', '정치 주요 뉴스'], ['경제', '경제 주요 뉴스'], ['사회', '사회 주요 뉴스'],
  ['생활/문화', '생활 문화 주요 뉴스'], ['세계', '세계 주요 뉴스'],
  ['IT/과학', 'IT 과학 주요 뉴스'], ['바둑', '바둑 대회 프로기사']
];

const GENERIC_TITLES = new Set(['이 시각 주요 뉴스', '오늘의 주요 뉴스', '주요 뉴스', '뉴스 브리핑']);

function stripHtml(value) {
  return normalizeText(String(value || '').replace(/<[^>]*>/g, ' '));
}

function cleanTitle(value) {
  return stripHtml(value)
    .replace(/\s*[-|–—]\s*[^-|–—]{1,30}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function pressFromTitle(value) {
  const text = stripHtml(value);
  return (text.match(/\s[-|–—]\s([^\-|–—]{1,30})$/u)?.[1] || '').trim().slice(0, 80);
}

function parseDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
}

async function fetchArticleText(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/Cloudflare' },
      cf: { cacheTtl: 300, cacheEverything: false }
    });
    if (!response.ok) return { body: '', image: '' };
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return { body: '', image: '' };
    const html = (await response.text()).slice(0, 800000);
    const image = (html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i)?.[1] || '').trim();
    const article = html.match(/<(?:article|div)[^>]+(?:id|class)=["'][^"']*(?:article|news|content|body)[^"']*["'][^>]*>([\s\S]{100,}?)<\/(?:article|div)>/i)?.[1] || '';
    const body = stripHtml(article
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')).slice(0, 12000);
    return { body, image: /^https?:\/\//.test(image) ? image : '' };
  } catch {
    return { body: '', image: '' };
  }
}

async function naverSearch(env, query) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
    throw new Error('NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET이 없습니다.');
  }
  const endpoint = new URL('https://openapi.naver.com/v1/search/news.json');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('display', '5');
  endpoint.searchParams.set('display', '6');
  const slot = Math.floor(Date.now() / 1800000) % 5;
  endpoint.searchParams.set('start', String(slot * 6 + 1));
  endpoint.searchParams.set('sort', 'date');
  const response = await fetch(endpoint, {
    headers: {
      'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET
    }
  });
  if (!response.ok) throw new Error(`Naver API ${response.status}`);
  return (await response.json()).items || [];
}

async function collect(env) {
  await env.DB.prepare(`DELETE FROM news_articles
    WHERE title IN ('이 시각 주요 뉴스','오늘의 주요 뉴스','주요 뉴스','뉴스 브리핑')
       OR summary LIKE '%완독 약%분 소요%'`).run();
  const candidates = [];
  for (const [category, query] of SEARCHES) {
    const items = await naverSearch(env, query);
    for (const item of items.slice(0, 6)) candidates.push({ category, item });
  }

  let inserted = 0;
  for (const { category, item } of candidates) {
    const url = canonicalUrl(item.originallink || item.link);
    const title = cleanTitle(item.title);
    if (!url || !title || GENERIC_TITLES.has(title) || !/^https?:\/\//.test(url)) continue;
    const press = pressFromTitle(item.title);
    const urlKey = await sha256(url);
    const exists = await env.DB.prepare('SELECT id FROM news_articles WHERE url_key=?').bind(urlKey).first();
    if (exists) continue;

    const rawSummary = stripHtml(item.description);
    const article = await fetchArticleText(url);
    const body = article.body;
    const summary = buildSummary({ title, rawSummary, body });
    const lineCount = summary ? summary.split('\n').length : 0;
    if (!lineCount) continue;

    await env.DB.prepare(`
      INSERT INTO news_articles
        (url,url_key,title,source,press,category,published_at,raw_summary,body_text,summary,summary_quality,image_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(url_key) DO UPDATE SET
        title=excluded.title, press=excluded.press, category=excluded.category,
        published_at=excluded.published_at, raw_summary=excluded.raw_summary,
        body_text=CASE WHEN length(excluded.body_text)>length(news_articles.body_text) THEN excluded.body_text ELSE news_articles.body_text END,
        summary=CASE WHEN length(excluded.summary)>length(news_articles.summary) THEN excluded.summary ELSE news_articles.summary END,
        summary_quality=excluded.summary_quality
    `).bind(
      url, urlKey, title, 'NAVER', press, category, parseDate(item.pubDate), rawSummary,
      body, summary, lineCount >= 3 ? 'full' : 'short', article.image
    ).run();
    inserted += 1;
  }
  return inserted;
}

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  let runId;
  try {
    await ensureNewsDb(env);
    const started = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO news_runs(started_at,status) VALUES(?,'running') RETURNING id").bind(started).first();
    runId = run?.id;
    const inserted = await collect(env);
    await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=? WHERE id=?")
      .bind(new Date().toISOString(), inserted, runId).run();
    return json({ ok: true, inserted });
  } catch (error) {
    if (runId) {
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='error',message=? WHERE id=?")
        .bind(new Date().toISOString(), String(error.message || error).slice(0, 500), runId).run();
    }
    return json({ ok: false, error: error.message }, 500);
  }
}
