import { normalizeText, validateThreeLineSummary } from '../../_lib/news-summary.js';
import { makeBestSummary } from '../../_lib/news-ai-summary.js';
import {
  canonicalUrl, ensureNewsDb, isCollectorAuthorized, json, sha256
} from '../../_lib/news-db.js';

const SEARCHES = [
  ['정치', '정치 주요 뉴스'], ['경제', '경제 주요 뉴스'], ['사회', '사회 주요 뉴스'],
  ['생활/문화', '생활 문화 주요 뉴스'], ['세계', '세계 주요 뉴스'],
  ['IT/과학', 'IT 과학 주요 뉴스'], ['바둑', '바둑 대회 프로기사']
];

const GENERIC_TITLES = new Set(['이 시각 주요 뉴스', '오늘의 주요 뉴스', '주요 뉴스', '뉴스 브리핑']);

const BODY_JUNK = /(?:무단전재|재배포\s*금지|저작권자|구독|로그인|회원가입|제보|관련기사|추천뉴스|많이\s*본\s*뉴스|기사제공|기자\s*[A-Z0-9._%+-]+@)/i;

function stripHtml(value) {
  return normalizeText(String(value || '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '));
}

function cleanBody(value) {
  const lines = normalizeText(value).split(/\n+/).map(line => line.trim()).filter(line =>
    line.length >= 12 && !BODY_JUNK.test(line) && !/^\s*(?:사진|영상|그래픽|ADVERTISEMENT)\s*[=:]/i.test(line)
  );
  return lines.join('\n').slice(0, 16000);
}

function findArticleBodies(value, found = []) {
  if (!value || found.length > 30) return found;
  if (Array.isArray(value)) {
    for (const item of value) findArticleBodies(item, found);
  } else if (typeof value === 'object') {
    if (typeof value.articleBody === 'string') found.push(value.articleBody);
    for (const child of Object.values(value)) findArticleBodies(child, found);
  }
  return found;
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
    let jsonBody = '';
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(match[1]);
        for (const found of findArticleBodies(data)) if (found.length > jsonBody.length) jsonBody = found;
      } catch {}
    }
    const articleStart = html.search(/<(?:article|div)[^>]+(?:id|class)=["'][^"']*(?:dic_area|article_view|article-body|newsct_article|article_body|articleBody|news_body|view_cont)[^"']*["'][^>]*>/i);
    const article = articleStart >= 0 ? html.slice(articleStart, Math.min(html.length, articleStart + 180000)) : '';
    const body = cleanBody(jsonBody || stripHtml(article
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')));
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
  const diagnostics = { retry_attempted: 0, retry_repaired: 0, samples: [] };
  const stored = await env.DB.prepare('SELECT id,title,summary FROM news_articles').all();
  const poisoned = (stored.results || []).filter(row => GENERIC_TITLES.has(row.title) || !validateThreeLineSummary(row.summary, row.title));
  if (poisoned.length) await env.DB.batch(poisoned.map(row => env.DB.prepare("UPDATE news_articles SET summary='',summary_quality='none' WHERE id=?").bind(row.id)));
  const retryRows = await env.DB.prepare(`SELECT id,title,raw_summary,body_text FROM news_articles
    WHERE summary_quality='none' AND length(body_text)>=300 ORDER BY fetched_at DESC LIMIT 16`).all();
  for (const row of retryRows.results || []) {
    const detail = {};
    const repaired = await makeBestSummary(env, { title: row.title, rawSummary: row.raw_summary, body: row.body_text }, detail);
    diagnostics.retry_attempted += 1;
    if (diagnostics.samples.length < 2) diagnostics.samples.push({ title: row.title, ...detail });
    if (validateThreeLineSummary(repaired, row.title)) {
      await env.DB.prepare("UPDATE news_articles SET summary=?,summary_quality='full' WHERE id=?").bind(repaired, row.id).run();
      diagnostics.retry_repaired += 1;
    }
  }
  const candidates = [];
  for (const [category, query] of SEARCHES) {
    const items = await naverSearch(env, query);
    for (const item of items.slice(0, 4)) candidates.push({ category, item });
  }

  let inserted = 0;
  for (const { category, item } of candidates) {
    const url = canonicalUrl(item.originallink || item.link);
    const title = cleanTitle(item.title);
    if (!url || !title || GENERIC_TITLES.has(title) || !/^https?:\/\//.test(url)) continue;
    const press = pressFromTitle(item.title);
    const urlKey = await sha256(url);
    const exists = await env.DB.prepare('SELECT id,image_url,summary_quality,raw_summary,body_text FROM news_articles WHERE url_key=?').bind(urlKey).first();
    if (exists) {
      if (!exists.image_url || exists.summary_quality !== 'full') {
        const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
        let article = await fetchArticleText(fetchUrl);
        if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
        const repaired = await makeBestSummary(env, { title, rawSummary: stripHtml(item.description) || exists.raw_summary, body: article.body || exists.body_text });
        const valid = validateThreeLineSummary(repaired, title);
        await env.DB.prepare(`UPDATE news_articles SET
          image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
          body_text=CASE WHEN ?<>'' THEN ? ELSE body_text END,
          summary=CASE WHEN ? THEN ? ELSE summary END,
          summary_quality=CASE WHEN ? THEN 'full' ELSE summary_quality END
          WHERE id=?`).bind(article.image, article.image, article.body, article.body, valid ? 1 : 0, repaired, valid ? 1 : 0, exists.id).run();
      }
      continue;
    }

    const rawSummary = stripHtml(item.description);
    const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
    let article = await fetchArticleText(fetchUrl);
    if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
    const body = article.body;
    const summary = await makeBestSummary(env, { title, rawSummary, body });
    const validSummary = validateThreeLineSummary(summary, title);

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
      body, validSummary ? summary : '', validSummary ? 'full' : 'none', article.image
    ).run();
    inserted += 1;
  }
  return { inserted, diagnostics };
}

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  let runId;
  try {
    await ensureNewsDb(env);
    const started = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO news_runs(started_at,status) VALUES(?,'running') RETURNING id").bind(started).first();
    runId = run?.id;
    const result = await collect(env);
    await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=? WHERE id=?")
      .bind(new Date().toISOString(), result.inserted, runId).run();
    return json({ ok: true, ...result });
  } catch (error) {
    if (runId) {
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='error',message=? WHERE id=?")
        .bind(new Date().toISOString(), String(error.message || error).slice(0, 500), runId).run();
    }
    return json({ ok: false, error: error.message }, 500);
  }
}
