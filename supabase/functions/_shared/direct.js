import { parseHTML } from 'linkedom';

// Only site HTML and article HTML are read. No feeds or search services.
export function websiteURL(value) {
  const u = new URL(value);
  if (u.hostname === 'feeds.bbci.co.uk' || (/bbc\./.test(u.hostname) && /rss|feed/.test(u.pathname))) return 'https://www.bbc.com/arabic';
  if (/aljazeera\.net$/.test(u.hostname) && (u.pathname === '/' || /rss|xml/.test(u.pathname))) return 'https://www.aljazeera.net/news/';
  if (u.hostname === 'news.un.org' && /feed|rss/.test(u.pathname)) return 'https://news.un.org/ar/';
  return u.href;
}
export function articleLinks(html, base) {
  const {document} = parseHTML(html);
  const domain = new URL(base).hostname.replace(/^www\./,'');
  const seen = new Set(), items = [];
  for (const a of document.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.getAttribute('href'),base);
      if (u.protocol !== 'https:' || u.hostname.replace(/^www\./,'') !== domain) continue;
      const supported = domain === 'aljazeera.net' ? /^\/(news|politics|ebusiness|tech|science|sport|culture|health|misc|encyclopedia)\/\d{4}\/\d{1,2}\/\d{1,2}\//.test(u.pathname)
        : domain === 'bbc.com' || domain === 'bbc.co.uk' ? /^\/arabic\/articles\/[a-z0-9]+\/?$/.test(u.pathname)
        : domain === 'news.un.org' ? /^\/ar\/story\/\d{4}\/\d{2}\/\d+/.test(u.pathname) : false;
      if (!supported) continue;
      u.hash=''; u.search='';
      const title=(a.textContent||'').replace(/\s+/g,' ').trim();
      if(title.length<15 || seen.has(u.href))continue;
      seen.add(u.href);items.push({url:u.href,title:title.slice(0,300)});
      if(items.length===20)break;
    }catch{}
  }
  return items;
}
export function articleMetadata(html) {
  const {document}=parseHTML(html);
  const dates=[]; let title='';
  const walk=(value)=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(walk);return;}
    const types=[value['@type']].flat();
    if(types.some(t=>/^(NewsArticle|Article|ReportageNewsArticle|LiveBlogPosting)$/.test(t))){
      if(value.datePublished)dates.push(value.datePublished);
      if(typeof value.headline==='string')title=value.headline;
    }
    if(value['@graph'])walk(value['@graph']);
    if(value.mainEntity)walk(value.mainEntity);
  };
  for(const script of document.querySelectorAll('script[type="application/ld+json"]'))try{walk(JSON.parse(script.textContent));}catch{}
  for(const selector of ['meta[property="article:published_time"]','meta[name="datePublished"]','meta[itemprop="datePublished"]','time[itemprop="datePublished"]']){
    const node=document.querySelector(selector);if(node)dates.push(node.getAttribute('content')||node.getAttribute('datetime'));
  }
  // Require a complete timestamp with explicit timezone; never substitute modified time.
  const date=dates.find(v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v)));
  const decoded = parseHTML('<html><body>'+ (title||document.querySelector('h1')?.textContent||'') +'</body></html>').document.body.textContent;
  return {publishedAt:date?new Date(date).toISOString():null,title:decoded.replace(/\s+/g,' ').trim().slice(0,300)};
}
export function withinDay(date, now=Date.now()) {const t=Date.parse(date);return Number.isFinite(t)&&t<=now&&t>=now-86400000;}
