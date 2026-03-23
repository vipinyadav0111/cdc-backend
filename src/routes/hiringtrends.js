const router = require('express').Router();
const { auth } = require('../middleware/auth');

// Helper: fetch RSS and parse to JSON
async function fetchRSS(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CDCPortal/1.0)' },
      signal: AbortSignal.timeout(8000)
    });
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]*)<\/${tag}>`));
        return m ? (m[1] || m[2] || '').trim() : '';
      };
      const title   = get('title');
      const link    = get('link') || block.match(/<link>([^<]*)<\/link>/)?.[1]?.trim() || '';
      const pubDate = get('pubDate');
      const desc    = get('description').replace(/<[^>]+>/g,'').slice(0,200);
      const source  = get('source') || '';
      if(title) items.push({ title, link, pubDate, desc, source });
    }
    return items;
  } catch(e) { return []; }
}

// Cache layer — 15 min TTL
const cache = {};
function getCache(key) {
  const c = cache[key];
  if(c && Date.now() - c.ts < 15*60*1000) return c.data;
  return null;
}
function setCache(key, data) { cache[key] = { data, ts: Date.now() }; }

// ── NEWS FEED ─────────────────────────────────────────
router.get('/news', auth, async (req, res) => {
  const cacheKey = 'news';
  const cached = getCache(cacheKey);
  if(cached) return res.json(cached);

  const queries = [
    'campus+placement+India+2026',
    'fresher+hiring+India+2026',
    'engineering+jobs+India',
    'MBA+hiring+India+2026',
    'top+skills+demand+India+2026',
    'NASSCOM+hiring+India',
    'IT+sector+hiring+India',
  ];

  const allItems = [];
  await Promise.allSettled(queries.map(async q => {
    const items = await fetchRSS(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`);
    items.forEach(item => allItems.push({ ...item, category: 'news' }));
  }));

  // Deduplicate by title similarity
  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = item.title.toLowerCase().slice(0,60);
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date
  deduped.sort((a,b) => new Date(b.pubDate||0) - new Date(a.pubDate||0));
  const result = deduped.slice(0, 40);
  setCache(cacheKey, result);
  res.json(result);
});

// ── COMPANY WATCH ─────────────────────────────────────
router.get('/companies', auth, async (req, res) => {
  const cacheKey = 'companies';
  const cached = getCache(cacheKey);
  if(cached) return res.json(cached);

  const companies = [
    'TCS', 'Infosys', 'Wipro', 'Accenture', 'Capgemini',
    'HCL', 'Amazon', 'Google', 'Microsoft', 'IBM',
    'Deloitte', 'KPMG', 'HDFC+Bank', 'Kotak', 'Axis+Bank',
    'Cognizant', 'Tech+Mahindra', 'L%26T'
  ];

  const allItems = [];
  await Promise.allSettled(companies.map(async co => {
    const items = await fetchRSS(`https://news.google.com/rss/search?q=${co}+hiring+India+campus&hl=en-IN&gl=IN&ceid=IN:en`);
    items.slice(0,3).forEach(item => allItems.push({ ...item, company: co.replace(/\+/g,' ').replace(/%26/g,'&') }));
  }));

  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = item.title.toLowerCase().slice(0,60);
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a,b) => new Date(b.pubDate||0) - new Date(a.pubDate||0)).slice(0,30);

  setCache(cacheKey, deduped);
  res.json(deduped);
});

// ── UNIVERSITY PLACEMENT WATCH ────────────────────────
router.get('/universities', auth, async (req, res) => {
  const cacheKey = 'universities';
  const cached = getCache(cacheKey);
  if(cached) return res.json(cached);

  const unis = [
    'VIT+Vellore+placement', 'Manipal+University+placement',
    'SRM+University+placement', 'Amity+University+placement',
    'Bennett+University+placement', 'Sharda+University+placement',
    'Chandigarh+University+placement', 'Lovely+Professional+University+placement',
    'private+university+campus+placement+India+2026',
  ];

  const allItems = [];
  await Promise.allSettled(unis.map(async q => {
    const items = await fetchRSS(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`);
    items.slice(0,4).forEach(item => allItems.push({ ...item }));
  }));

  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = item.title.toLowerCase().slice(0,60);
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a,b) => new Date(b.pubDate||0) - new Date(a.pubDate||0)).slice(0,30);

  setCache(cacheKey, deduped);
  res.json(deduped);
});

// ── SKILLS IN DEMAND ──────────────────────────────────
router.get('/skills', auth, async (req, res) => {
  const cacheKey = 'skills';
  const cached = getCache(cacheKey);
  if(cached) return res.json(cached);

  const queries = [
    'top+skills+demand+freshers+India+2026',
    'skills+IT+jobs+India+2026',
    'soft+skills+workplace+India',
    'data+analytics+demand+India',
    'AI+ML+jobs+freshers+India',
  ];

  const allItems = [];
  await Promise.allSettled(queries.map(async q => {
    const items = await fetchRSS(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`);
    items.slice(0,5).forEach(item => allItems.push(item));
  }));

  // Extract skill keywords from titles
  const SKILL_KEYWORDS = [
    'Python','JavaScript','Java','SQL','Excel','Power BI','Tableau',
    'Data Analytics','Data Science','Machine Learning','AI','Artificial Intelligence',
    'Cloud','AWS','Azure','DevOps','React','Node.js',
    'Communication','Soft Skills','Aptitude','Logical Reasoning','Verbal',
    'Problem Solving','Critical Thinking','Leadership','Teamwork',
    'C++','C Programming','DSA','Data Structures',
    'Full Stack','Web Development','Cybersecurity','Blockchain',
    'Digital Marketing','Finance','Accounting','MS Office',
  ];

  const skillCount = {};
  const allText = allItems.map(i => i.title + ' ' + i.desc).join(' ');
  SKILL_KEYWORDS.forEach(skill => {
    const regex = new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
    const count = (allText.match(regex)||[]).length;
    if(count > 0) skillCount[skill] = count;
  });

  const ranked = Object.entries(skillCount)
    .sort((a,b) => b[1]-a[1])
    .slice(0,20)
    .map(([skill, count]) => ({ skill, count, score: Math.min(100, count*15) }));

  const result = { skills: ranked, articles: allItems.slice(0,15) };
  setCache(cacheKey, result);
  res.json(result);
});

// ── JOB ALERTS — fresher jobs via Indeed/Naukri/Shine RSS ──
router.get('/jobs', auth, async (req, res) => {
  const cacheKey = 'jobs';
  const cached = getCache(cacheKey);
  if(cached) return res.json(cached);

  const jobFeeds = [
    // Indeed RSS
    'https://in.indeed.com/rss?q=fresher+CSE&l=India&sort=date',
    'https://in.indeed.com/rss?q=fresher+engineer&l=India&sort=date',
    'https://in.indeed.com/rss?q=fresher+MBA&l=India&sort=date',
    'https://in.indeed.com/rss?q=fresher+software+engineer&l=India&sort=date',
    // Google News job-related
    'https://news.google.com/rss/search?q=fresher+job+openings+CSE+India+2026&hl=en-IN&gl=IN&ceid=IN:en',
    'https://news.google.com/rss/search?q=fresher+engineering+jobs+India+2026&hl=en-IN&gl=IN&ceid=IN:en',
    'https://news.google.com/rss/search?q=fresher+MBA+jobs+India+2026+campus&hl=en-IN&gl=IN&ceid=IN:en',
    'https://news.google.com/rss/search?q=freshersworld+hiring+campus+drive+2026&hl=en-IN&gl=IN&ceid=IN:en',
    'https://news.google.com/rss/search?q=campus+drive+2026+freshers+engineering&hl=en-IN&gl=IN&ceid=IN:en',
    'https://news.google.com/rss/search?q=off+campus+drive+2026+freshers&hl=en-IN&gl=IN&ceid=IN:en',
  ];

  const allJobs = [];
  await Promise.allSettled(jobFeeds.map(async url => {
    const items = await fetchRSS(url);
    items.slice(0,8).forEach(item => allJobs.push({ ...item, type:'job' }));
  }));

  const seen = new Set();
  const deduped = allJobs.filter(item => {
    const key = item.title.toLowerCase().slice(0,60);
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a,b) => new Date(b.pubDate||0) - new Date(a.pubDate||0)).slice(0,40);

  setCache(cacheKey, deduped);
  res.json(deduped);
});

module.exports = router;
