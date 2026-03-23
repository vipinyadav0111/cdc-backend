const router = require('express').Router();
const https = require('https');
const http = require('http');
const { auth } = require('../middleware/auth');

const FEEDS = {
  toi: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms',
  bbc: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  hindu: 'https://www.thehindu.com/news/feeder/default.rss',
  ndtv: 'https://feeds.feedburner.com/ndtvnews-top-stories',
  india: 'https://www.thehindu.com/feeder/default.rss',
};

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CDCBot/1.0)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 15) {
    const item = match[1];
    const get = (tag) => {
      const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([^<]*)</${tag}>`));
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const getAttr = (tag, attr) => {
      const m = item.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/?>`));
      return m ? m[1] : '';
    };
    const title = get('title');
    const link = get('link') || get('guid');
    const pubDate = get('pubDate');
    const description = get('description').replace(/<[^>]+>/g, '').slice(0, 200);
    const thumbnail = getAttr('media:thumbnail', 'url') || getAttr('media:content', 'url') || getAttr('enclosure', 'url') || '';
    if (title) items.push({ title, link, pubDate, description, thumbnail });
  }
  return items;
}

// GET /api/news?source=bbc
router.get('/', auth, async (req, res) => {
  const source = req.query.source || 'bbc';
  const feedUrl = FEEDS[source] || FEEDS.bbc;
  try {
    const xml = await fetchUrl(feedUrl);
    const items = parseRSS(xml);
    res.json({ status: 'ok', source, items });
  } catch (e) {
    console.error('News fetch error:', e.message);
    res.status(500).json({ status: 'error', error: e.message, items: [] });
  }
});

module.exports = router;
