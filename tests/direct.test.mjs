import test from 'node:test';
import assert from 'node:assert/strict';
import {articleLinks,articleMetadata,withinDay,websiteURL} from '../supabase/functions/_shared/direct.js';
import {discover} from '../supabase/functions/_shared/core.js';
test('article links exclude navigation, other domains, duplicates and feeds',()=>{
 const html='<a href="/news/2026/10/11/story">عنوان الخبر الأول هنا</a><a href="/news/2026/10/11/story?tracking=x">عنوان الخبر الأول هنا</a><a href="https://evil.example/news/2026/10/11/a">رابط غير موثوق هنا</a><a href="/news/">صفحة الأخبار الرئيسية</a>';
 assert.equal(articleLinks(html,'https://www.aljazeera.net/news/').length,1);
 assert.equal(websiteURL('https://feeds.bbci.co.uk/arabic/rss.xml'),'https://www.bbc.com/arabic');
});
test('publication date never uses modification date or an ambiguous local time',()=>{
 assert.equal(articleMetadata('<meta property="article:modified_time" content="2026-10-11T12:00:00Z">').publishedAt,null);
 assert.equal(articleMetadata('<meta property="article:published_time" content="2026-10-11">').publishedAt,null);
 assert.equal(articleMetadata('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-11T12:00:00+03:00"}</script>').publishedAt,'2026-10-11T09:00:00.000Z');
 const now=Date.parse('2026-10-11T12:00:00Z');
 assert.equal(withinDay('2026-10-10T12:00:00Z',now),true);
 assert.equal(withinDay('2026-10-10T11:59:59Z',now),false);
 assert.equal(withinDay('2026-10-11T12:00:01Z',now),false);
});
test('HTML discovery migrates old RSS URLs without requesting feeds; sorts and filters dates',async()=>{
 const calls=[];const now=Date.now();
 const fetcher=async url=>{calls.push(url);let body;
 if(url==='https://www.bbc.com/arabic')body=['a','b','c'].map(id=>`<a href="/arabic/articles/${id}">عنوان إخباري تجريبي ${id}</a>`).join('');
 else {const hours=url.endsWith('/a')?2:url.endsWith('/b')?26:1;body=`<meta property="article:published_time" content="${new Date(now-hours*3600000).toISOString()}"><h1>عنوان موثوق</h1>`;}
 return new Response(body,{headers:{'content-type':'text/html'}});};
 const result=await discover([{id:'bbc',name:'BBC',url:'https://feeds.bbci.co.uk/arabic/rss.xml',section:'عام'}],20,'total',false,fetcher,'24h');
 assert.equal(result.articles.length,2);assert.ok(result.articles[0].url.endsWith('/c'));
 assert.ok(calls.every(url=>!url.includes('rss')&&!url.includes('feeds.')));
 assert.equal(result.errors.length,0);assert.equal(result.notes.length,1);
});
