const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_KEY || '';

const H5_API = 'https://h5-api.aoneroom.com';
const BASE_URL = 'https://moviebox.ph';
const NETFILM = 'https://netfilm.world';
const TMDB_API = 'https://api.themoviedb.org/3';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
const STATIC_UUID = 'd8c3539e-2e46-4000-af20-7046a856e30a';

const api = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: true }),
  timeout: 20000,
});

let jwtToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (jwtToken && Date.now() < tokenExpiry) return jwtToken;
  await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
  const res = await api.get(NETFILM, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Cookie': `uuid=${STATIC_UUID}` }
  });
  const cookies = res.headers['set-cookie'];
  if (cookies) {
    const str = Array.isArray(cookies) ? cookies.join('; ') : cookies;
    const m = str.match(/token=([^;]+)/);
    if (m) { jwtToken = m[1]; tokenExpiry = Date.now() + (90 * 24 * 60 * 60 * 1000); }
  }
  return jwtToken;
}

function cookieStr() { return `uuid=${STATIC_UUID}${jwtToken ? '; token=' + jwtToken : ''}`; }

// H5 API fetch
async function h5Fetch(path) {
  const res = await api.get(H5_API + path, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  if (res.data && res.data.code === 0) return res.data.data;
  throw new Error('H5 API error: ' + (res.data && res.data.code));
}

// NUXT parser for search
function resolveNuxt(html) {
  const $ = cheerio.load(html);
  const raw = $('script#__NUXT_DATA__').text();
  if (!raw) return null;
  const nuxt = JSON.parse(raw);
  function R(ref, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 15) return ref;
    if (ref === null || ref === undefined) return ref;
    if (typeof ref === 'string' || typeof ref === 'boolean') return ref;
    if (typeof ref === 'number') {
      if (ref < 0 || ref >= nuxt.length) return ref;
      return R(nuxt[ref], depth + 1);
    }
    if (Array.isArray(ref)) return ref.map(r => R(r, depth + 1));
    if (typeof ref === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(ref)) {
        if (k === 'subjects' || k === 'items' || k === 'banner' || k === 'liveList' || k === 'cover' || k === 'image' || k === 'stills' || k === 'trailer') {
          out[k] = R(v, depth + 1);
        } else if (typeof v === 'number') {
          out[k] = R(v, depth + 1);
        } else {
          out[k] = v;
        }
      }
      return out;
    }
    return ref;
  }
  return { nuxt, R };
}

function extractTrailer(html) {
  const m = html.match(/<video[^>]*src="(https:\/\/macdn\.aoneroom\.com\/media\/vone\/[^"]*\.mp4[^"]*)"[^>]*poster="([^"]*)"[^>]*>/);
  if (m) return { url: m[1], poster: m[2] };
  const s = html.match(/src="(https:\/\/macdn\.aoneroom\.com\/media\/vone\/[^"]*\.mp4[^"]*)"/);
  if (s) { const p = html.match(/poster="([^"]*)"/); return { url: s[1], poster: p ? p[1] : null }; }
  return null;
}

const cache = new Map();
function cget(k, t) { const i = cache.get(k); return (i && Date.now() - i.t < t) ? i.d : null; }
function cset(k, d) { cache.set(k, { d, t: Date.now() }); }

async function tmdbFetch(endpoint, params) {
  if (!TMDB_KEY) return null;
  params = params || {};
  const key = 'tmdb:' + endpoint + ':' + JSON.stringify(params);
  const c = cget(key, 600000);
  if (c) return c;
  try {
    const res = await axios.get(TMDB_API + endpoint, {
      headers: { Authorization: 'Bearer ' + TMDB_KEY },
      params, timeout: 8000,
    });
    cset(key, res.data);
    return res.data;
  } catch(e) { return null; }
}

function formatTMDB(item, mediaType) {
  return {
    tmdb_id: item.id,
    title: item.title || item.name,
    year: (item.release_date || item.first_air_date || '').substring(0, 4),
    rating: item.vote_average,
    overview: (item.overview || '').substring(0, 200),
    poster: item.poster_path ? 'https://image.tmdb.org/t/p/w500' + item.poster_path : null,
    backdrop: item.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + item.backdrop_path : null,
    type: mediaType || (item.media_type === 'tv' ? 'tv' : 'movie'),
  };
}

function formatMovieBox(item) {
  return {
    id: item.subjectId,
    title: item.title || item.name || '',
    poster: item.cover && item.cover.url ? item.cover.url : null,
    slug: item.detailPath || '',
    year: item.releaseDate ? item.releaseDate.substring(0, 4) : null,
    rating: item.imdbRatingValue || null,
    type: item.subjectType === 1 ? 'movie' : item.subjectType === 2 ? 'tv' : 'unknown',
    hasResource: item.hasResource || false,
  };
}

// CORS
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', function(req, res) {
  res.json({ api: 'MovieStream API', v: '3.0.0', tmdb: !!TMDB_KEY, source: 'H5 API + moviebox.ph' });
});

app.get('/api/health', async function(req, res) {
  try { await getToken(); res.json({ status: 'healthy', tmdb: !!TMDB_KEY, cache: cache.size }); }
  catch(e) { res.json({ status: 'degraded', error: e.message }); }
});

// TMDB
app.get('/api/trending', async function(req, res) {
  try {
    var type = req.query.type || 'all';
    var results = [];
    if (type === 'all' || type === 'movie') {
      var data = await tmdbFetch('/trending/movie/week');
      if (data) results = results.concat(data.results.map(function(r) { return formatTMDB(r, 'movie'); }));
    }
    if (type === 'all' || type === 'tv') {
      var data = await tmdbFetch('/trending/tv/week');
      if (data) results = results.concat(data.results.map(function(r) { return formatTMDB(r, 'tv'); }));
    }
    res.json({ success: true, source: 'tmdb', count: results.length, results: results.slice(0, 20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/popular', async function(req, res) {
  try {
    var type = req.query.type || 'movie';
    var endpoint = type === 'tv' ? '/tv/popular' : '/movie/popular';
    var data = await tmdbFetch(endpoint);
    var results = (data && data.results || []).map(function(r) { return formatTMDB(r, type); });
    res.json({ success: true, source: 'tmdb', type: type, count: results.length, results: results.slice(0, 20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/upcoming', async function(req, res) {
  try {
    var data = await tmdbFetch('/movie/upcoming');
    var results = (data && data.results || []).map(function(r) { return formatTMDB(r, 'movie'); });
    res.json({ success: true, source: 'tmdb', count: results.length, results: results.slice(0, 20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// HOMEPAGE - Direct from H5 API!
async function getHomepageData() {
  var c = cget('home', 600000);
  if (c) return c;

  console.log('Fetching from H5 API...');
  await new Promise(function(r) { setTimeout(r, 500 + Math.random() * 800); });

  var data = await h5Fetch('/wefeed-h5api-bff/home?host=moviebox.ph');
  var ops = data.operatingList || [];
  var plats = data.platformList || [];

  console.log('Found ' + ops.length + ' sections, ' + plats.length + ' platforms');

  var banners = [];
  var sections = {};

  for (var i = 0; i < ops.length; i++) {
    var item = ops[i];
    if (!item) continue;

    if (item.type === 'BANNER' && item.banner && item.banner.items) {
      for (var j = 0; j < item.banner.items.length; j++) {
        var b = item.banner.items[j];
        banners.push({
          title: b.title,
          image: b.image && b.image.url ? b.image.url : null,
          id: b.subjectId,
          slug: b.detailPath,
          type: b.subjectType === 1 ? 'movie' : b.subjectType === 2 ? 'tv' : 'unknown',
        });
      }
    } else if (item.subjects && item.subjects.length > 0 && item.title) {
      var key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
      sections[key] = {
        name: item.title,
        type: item.type,
        count: item.subjects.length,
        movies: item.subjects.map(formatMovieBox)
      };
    }
  }

  var result = {
    banners: banners,
    sections: sections,
    platforms: (plats || []).map(function(p) { return { name: p.name, uploadedBy: p.uploadBy }; })
  };
  cset('home', result);
  return result;
}

app.get('/api/home', async function(req, res) {
  try {
    var data = await getHomepageData();
    res.json({ success: true, banners: data.banners, sections: data.sections, platforms: data.platforms, total_sections: Object.keys(data.sections).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/banners', async function(req, res) {
  try {
    var data = await getHomepageData();
    res.json({ success: true, count: data.banners.length, banners: data.banners });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sections', async function(req, res) {
  try {
    var data = await getHomepageData();
    var list = Object.keys(data.sections).map(function(key) {
      return { id: key, name: data.sections[key].name, type: data.sections[key].type, count: data.sections[key].count };
    });
    res.json({ success: true, count: list.length, sections: list });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/section/:name', async function(req, res) {
  try {
    var data = await getHomepageData();
    var section = data.sections[req.params.name];
    if (!section) return res.status(404).json({ error: 'Section not found', available: Object.keys(data.sections) });
    res.json({ success: true, name: section.name, type: section.type, count: section.count, movies: section.movies });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SEARCH - from moviebox.ph
app.get('/api/search', async function(req, res) {
  try {
    var q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q required' });
    console.log('Search: ' + q);
    await new Promise(function(r) { setTimeout(r, 300 + Math.random() * 500); });

    var resp = await api.get(BASE_URL + '/web/searchResult', {
      params: { keyword: q },
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
    });

    var parsed = resolveNuxt(resp.data);
    if (!parsed) throw new Error('No NUXT data');

    var items = [];
    for (var i = 0; i < Math.min(parsed.nuxt.length, 30); i++) {
      var r = parsed.R(parsed.nuxt[i]);
      if (r && r.data && r.data.items) { items = r.data.items; break; }
    }

    var seen = {};
    var results = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (seen[item.subjectId]) continue;
      seen[item.subjectId] = true;
      results.push(formatMovieBox(item));
    }
    res.json({ success: true, query: q, count: results.length, results: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DETAIL - from moviebox.ph
app.get('/api/detail/:slug', async function(req, res) {
  try {
    var slug = req.params.slug;
    var id = req.query.id;
    console.log('Detail: ' + slug);
    await new Promise(function(r) { setTimeout(r, 300 + Math.random() * 500); });

    var url = BASE_URL + '/detail/' + slug;
    var resp = await api.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
    var html = resp.data;
    var trailer = extractTrailer(html);
    var parsed = resolveNuxt(html);

    if (!parsed && id) {
      url = BASE_URL + '/moviedetail/' + slug + '?id=' + id;
      resp = await api.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
      html = resp.data;
      trailer = trailer || extractTrailer(html);
      parsed = resolveNuxt(html);
    }

    if (!parsed) throw new Error('No NUXT data');

    var subject = null, stars = [], seasons = [];
    for (var i = 0; i < Math.min(parsed.nuxt.length, 50); i++) {
      var r = parsed.R(parsed.nuxt[i]);
      if (!r || typeof r !== 'object') continue;
      if (r.subjectId && r.title && !subject) subject = r;
      if (r.stars && Array.isArray(r.stars)) stars = r.stars;
      if (r.seasons && Array.isArray(r.seasons)) seasons = r.seasons;
    }

    if (!subject) return res.status(404).json({ error: 'Not found' });

    res.json({
      success: true,
      id: subject.subjectId,
      title: subject.title,
      description: subject.description || '',
      year: (subject.releaseDate || '').substring(0, 4),
      rating: subject.imdbRatingValue || null,
      duration: subject.duration || 0,
      genres: (subject.genre || '').split(',').map(function(g) { return g.trim(); }).filter(Boolean),
      country: subject.countryName || '',
      poster: subject.cover && subject.cover.url ? subject.cover.url : null,
      backdrop: subject.stills && subject.stills.url ? subject.stills.url : null,
      trailer: trailer,
      cast: (stars || []).map(function(s) { return { name: s.name, character: s.character, avatar: s.avatarUrl }; }),
      seasons: (seasons || []).map(function(s) { return { season: s.se, episodes: s.maxEp }; }),
      hasResource: subject.hasResource || false,
      type: subject.subjectType === 1 ? 'movie' : 'tv',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// STREAM - from netfilm.world
app.get('/api/stream/:id', async function(req, res) {
  try {
    var id = req.params.id;
    var detail_path = req.query.detail_path;
    var se = req.query.se || 0;
    var ep = req.query.ep || 0;
    if (!detail_path) return res.status(400).json({ error: 'detail_path required' });

    await getToken();
    var resp = await api.get(
      NETFILM + '/wefeed-h5api-bff/subject/play?subjectId=' + id + '&se=' + se + '&ep=' + ep + '&detailPath=' + detail_path,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': NETFILM + '/spa/videoPlayPage/movies/' + detail_path, 'Origin': NETFILM, 'Cookie': cookieStr() } }
    );

    var streams = resp.data && resp.data.data && resp.data.data.streams ? resp.data.data.streams : [];
    var sources = streams.map(function(s) {
      return {
        quality: s.resolutions + 'p',
        format: s.format,
        url: s.url,
        size_mb: Math.round(parseInt(s.size) / 1024 / 1024),
        duration_sec: s.duration,
        proxy_url: '/api/watch/' + id + '?detail_path=' + detail_path + '&se=' + se + '&ep=' + ep + '&quality=' + s.resolutions,
      };
    }).sort(function(a, b) { return parseInt(b.quality) - parseInt(a.quality); });

    res.json({ success: true, id: id, detail_path: detail_path, season: +se, episode: +ep, count: sources.length, sources: sources });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// WATCH - proxy CDN
app.get('/api/watch/:id', async function(req, res) {
  try {
    var id = req.params.id;
    var detail_path = req.query.detail_path;
    var se = req.query.se || 0;
    var ep = req.query.ep || 0;
    var quality = req.query.quality;
    if (!detail_path) return res.status(400).send('detail_path required');

    await getToken();
    var resp = await api.get(
      NETFILM + '/wefeed-h5api-bff/subject/play?subjectId=' + id + '&se=' + se + '&ep=' + ep + '&detailPath=' + detail_path,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': NETFILM + '/spa/videoPlayPage/movies/' + detail_path, 'Origin': NETFILM, 'Cookie': cookieStr() } }
    );

    var streams = resp.data && resp.data.data && resp.data.data.streams ? resp.data.data.streams : [];
    if (quality) streams = streams.filter(function(s) { return s.resolutions === quality.toString(); });
    streams.sort(function(a, b) { return parseInt(b.resolutions) - parseInt(a.resolutions); });
    if (!streams.length) return res.status(404).send('No stream');

    var streamUrl = streams[0].url;
    console.log('Proxy: ' + streamUrl.substring(0, 80) + '...');

    var videoRes = await axios.get(streamUrl, {
      responseType: 'stream',
      headers: { 'User-Agent': UA, 'Referer': NETFILM + '/', 'Origin': NETFILM },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 0,
    });

    res.status(videoRes.status);
    res.set('Content-Type', videoRes.headers['content-type'] || 'video/mp4');
    res.set('Accept-Ranges', 'bytes');
    if (videoRes.headers['content-length']) res.set('Content-Length', videoRes.headers['content-length']);
    videoRes.data.pipe(res);
  } catch(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// DOWNLOAD
app.get('/api/download/:id', async function(req, res) {
  try {
    var id = req.params.id;
    var detail_path = req.query.detail_path;
    var se = req.query.se || 0;
    var ep = req.query.ep || 0;
    var quality = req.query.quality;
    if (!detail_path) return res.status(400).send('detail_path required');

    await getToken();
    var resp = await api.get(
      NETFILM + '/wefeed-h5api-bff/subject/play?subjectId=' + id + '&se=' + se + '&ep=' + ep + '&detailPath=' + detail_path,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': NETFILM + '/spa/videoPlayPage/movies/' + detail_path, 'Origin': NETFILM, 'Cookie': cookieStr() } }
    );

    var streams = resp.data && resp.data.data && resp.data.data.streams ? resp.data.data.streams : [];
    if (quality) streams = streams.filter(function(s) { return s.resolutions === quality.toString(); });
    streams.sort(function(a, b) { return parseInt(b.resolutions) - parseInt(a.resolutions); });
    if (!streams.length) return res.status(404).send('No stream');

    var streamUrl = streams[0].url;
    var videoRes = await axios.get(streamUrl, {
      responseType: 'stream',
      headers: { 'User-Agent': UA, 'Referer': NETFILM + '/', 'Origin': NETFILM },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 0,
    });

    res.status(videoRes.status);
    res.set('Content-Type', videoRes.headers['content-type'] || 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="movie-' + id + '-' + (quality || streams[0].resolutions) + 'p.mp4"');
    res.set('Accept-Ranges', 'bytes');
    if (videoRes.headers['content-length']) res.set('Content-Length', videoRes.headers['content-length']);
    videoRes.data.pipe(res);
  } catch(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', async function() {
  console.log('Server on port ' + PORT + ', TMDB: ' + !!TMDB_KEY);
  try { await getToken(); console.log('Token ready'); } catch(e) {}
});

module.exports = app;

// ═══════════════════════════════════════════════════
// SPORTS ENDPOINTS — FIFA, WWE, Live Sports
// ═══════════════════════════════════════════════════

const SPORT_API = 'https://h5-sport-api.aoneroom.com';
const SPORT_SITE = 'https://sportslivetoday.com';

// Sports API fetch
async function sportFetch(path) {
  const res = await api.get(SPORT_API + path, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Origin': SPORT_SITE, 'Referer': SPORT_SITE + '/' }
  });
  if (res.data && res.data.code === 0) return res.data.data;
  throw new Error('Sport API error: ' + (res.data?.code || 'unknown'));
}

// Parse sports HTML (NUXT format)
function resolveSportNuxt(html) {
  const $ = cheerio.load(html);
  const raw = $('script#__NUXT_DATA__').text();
  if (!raw) return null;
  const nuxt = JSON.parse(raw);
  function R(ref, depth = 0) {
    if (depth > 15 || ref === null || ref === undefined) return ref;
    if (typeof ref === 'string' || typeof ref === 'boolean') return ref;
    if (typeof ref === 'number') {
      if (ref < 0 || ref >= nuxt.length) return ref;
      return R(nuxt[ref], depth + 1);
    }
    if (Array.isArray(ref)) return ref.map(r => R(r, depth + 1));
    if (typeof ref === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(ref)) {
        if (['subjects','items','banner','liveList','cover','image','stills'].includes(k)) {
          out[k] = R(v, depth + 1);
        } else if (typeof v === 'number') {
          out[k] = R(v, depth + 1);
        } else {
          out[k] = v;
        }
      }
      return out;
    }
    return ref;
  }
  return { nuxt, R };
}

// ═══ SPORTS ENDPOINTS ═══

// Get all sports sections (FIFA, WWE, Live)
app.get('/api/sports', async (req, res) => {
  try {
    const data = await sportFetch('/wefeed-h5api-bff/home?host=sportslivetoday.com');
    const sections = (data.operatingList || []).map(item => ({
      title: item.title,
      type: item.type,
      position: item.position,
      subjectCount: item.subjects?.length || 0,
      hasLiveList: !!item.liveList,
      subjects: (item.subjects || []).map(s => ({
        id: s.subjectId,
        title: s.title,
        poster: s.cover?.url || null,
        slug: s.detailPath,
        hasResource: s.hasResource || false
      }))
    }));
    res.json({ success: true, source: 'h5-sport-api', sections });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get FIFA World Cup section
app.get('/api/sports/fifa', async (req, res) => {
  try {
    const data = await sportFetch('/wefeed-h5api-bff/home?host=sportslivetoday.com');
    const fifa = (data.operatingList || []).find(s => 
      s.title?.toLowerCase().includes('fifa') || s.title?.toLowerCase().includes('world cup')
    );
    if (!fifa) return res.status(404).json({ error: 'FIFA section not found' });
    
    res.json({
      success: true,
      title: fifa.title,
      type: fifa.type,
      matches: (fifa.subjects || []).map(s => ({
        id: s.subjectId,
        title: s.title,
        poster: s.cover?.url || null,
        slug: s.detailPath,
        hasResource: s.hasResource || false
      })),
      liveList: fifa.liveList || null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get WWE section
app.get('/api/sports/wwe', async (req, res) => {
  try {
    const data = await sportFetch('/wefeed-h5api-bff/home?host=sportslivetoday.com');
    const wwe = (data.operatingList || []).find(s => 
      s.title?.toLowerCase().includes('wwe') || s.title?.toLowerCase().includes('wrestling')
    );
    if (!wwe) return res.status(404).json({ error: 'WWE section not found' });
    
    res.json({
      success: true,
      title: wwe.title,
      type: wwe.type,
      events: (wwe.subjects || []).map(s => ({
        id: s.subjectId,
        title: s.title,
        poster: s.cover?.url || null,
        slug: s.detailPath,
        hasResource: s.hasResource || false
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get live sports
app.get('/api/sports/live', async (req, res) => {
  try {
    const data = await sportFetch('/wefeed-h5api-bff/home?host=sportslivetoday.com');
    const live = (data.operatingList || []).find(s => s.type === 'SPORT_LIVE');
    if (!live) return res.status(404).json({ error: 'No live sports' });
    
    res.json({
      success: true,
      title: live.title,
      liveNow: (live.liveList || []).map(l => ({
        id: l.subjectId,
        title: l.title,
        poster: l.cover?.url || null,
        status: l.status || 'live',
        viewers: l.viewCount || 0
      })),
      upcoming: (live.subjects || []).map(s => ({
        id: s.subjectId,
        title: s.title,
        poster: s.cover?.url || null,
        slug: s.detailPath
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get match details
app.get('/api/sports/match/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const html = await api.get(`${SPORT_SITE}/detail/${id}`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' }
    });
    const parsed = resolveSportNuxt(html.data);
    if (!parsed) return res.status(404).json({ error: 'Match not found' });
    
    let match = null;
    for (let i = 0; i < Math.min(parsed.nuxt.length, 50); i++) {
      const r = parsed.R(parsed.nuxt[i]);
      if (r?.subjectId) { match = r; break; }
    }
    
    if (!match) return res.status(404).json({ error: 'Match data not found' });
    
    res.json({
      success: true,
      id: match.subjectId,
      title: match.title,
      description: match.description || '',
      poster: match.cover?.url || null,
      streams: (match.streams || []).map(s => ({
        quality: s.resolutions + 'p',
        url: s.url,
        format: s.format
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get sport streams
app.get('/api/sports/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const detailPath = req.query.detail_path || '';
    
    // Try the sport API for streams
    const data = await sportFetch(`/wefeed-h5api-bff/subject/play?subjectId=${id}&detailPath=${encodeURIComponent(detailPath)}`);
    
    const streams = (data.streams || []).map(s => ({
      quality: s.resolutions + 'p',
      format: s.format,
      url: s.url,
      size_mb: Math.round(parseInt(s.size || '0') / 1024 / 1024),
      duration_sec: s.duration
    })).sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
    
    res.json({ success: true, id, streams });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════
// SPORTS PROVIDER CHAIN — Multiple backup sources
// ═══════════════════════════════════════════════════

// Provider 1: H5 Sport API (primary)
const SPORT_PROVIDERS = [
  {
    name: "h5-sport-api",
    baseUrl: "https://h5-sport-api.aoneroom.com",
    async getHomepage() {
      const res = await api.get(`${this.baseUrl}/wefeed-h5api-bff/home?host=sportslivetoday.com`, {
        headers: { 'User-Agent': UA, 'Origin': 'https://sportslivetoday.com' }
      });
      if (res.data?.code === 0) return res.data.data;
      throw new Error('H5 API failed');
    },
    async getStream(subjectId, sportType = 'football') {
      const res = await api.get(`${this.baseUrl}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&sportType=${sportType}`, {
        headers: { 'User-Agent': UA, 'Origin': 'https://sportsnow.top' }
      });
      if (res.data?.code === 0) return res.data.data;
      throw new Error('H5 stream failed');
    }
  },
  {
    name: "sportsnow-scraper",
    baseUrl: "https://sportsnow.top",
    async getStream(subjectId, sportType = 'football') {
      const html = await api.get(`${this.baseUrl}/live/detail?id=${subjectId}&sportType=${sportType}`, {
        headers: { 'User-Agent': UA }
      });
      const $ = cheerio.load(html.data);
      // Try to find NUXT data with stream info
      const nuxtRaw = $('script#__NUXT_DATA__').text();
      if (!nuxtRaw) throw new Error('No NUXT data');
      const nuxt = JSON.parse(nuxtRaw);
      // Walk NUXT to find streams (dynamic keys)
      function findStreams(obj, depth = 0) {
        if (depth > 10) return null;
        if (!obj || typeof obj !== 'object') return null;
        if (obj.streams && Array.isArray(obj.streams)) return obj;
        for (const v of Object.values(obj)) {
          const found = findStreams(v, depth + 1);
          if (found) return found;
        }
        return null;
      }
      const data = findStreams(nuxt);
      if (data?.streams?.length) return data;
      throw new Error('No streams found in page');
    }
  },
  {
    name: "aisports-scraper",
    baseUrl: "https://aisports.cc",
    async getStream(subjectId, sportType = 'football') {
      try {
        const res = await api.get(`${this.baseUrl}/live/detail?id=${subjectId}&sportType=${sportType}`, {
          headers: { 'User-Agent': UA }
        });
        const $ = cheerio.load(res.data);
        const nuxtRaw = $('script#__NUXT_DATA__').text();
        if (!nuxtRaw) throw new Error('No data');
        const nuxt = JSON.parse(nuxtRaw);
        // Same recursive search
        function find(obj, d = 0) {
          if (d > 10 || !obj || typeof obj !== 'object') return null;
          if (obj.streams?.length) return obj;
          for (const v of Object.values(obj)) {
            const f = find(v, d + 1);
            if (f) return f;
          }
          return null;
        }
        const data = find(nuxt);
        if (data?.streams) return data;
        throw new Error('No streams');
      } catch(e) {
        throw new Error('AIsports failed: ' + e.message);
      }
    }
  },
  {
    name: "pacdn-direct",
    baseUrl: "https://pacdn.aoneroom.com",
    async getStream(subjectId, sportType = 'football') {
      // Try direct CDN access — sometimes streams are on pacdn
      const res = await api.get(`${this.baseUrl}/media/sport/${subjectId}/index.m3u8`, {
        headers: { 'User-Agent': UA, 'Origin': 'https://sportslivetoday.com' },
        validateStatus: () => true
      });
      if (res.status === 200) {
        return {
          streams: [{ url: `${this.baseUrl}/media/sport/${subjectId}/index.m3u8`, format: 'hls', quality: 'adaptive' }]
        };
      }
      throw new Error('No direct CDN stream');
    }
  }
];

// Sports provider chain — tries each provider until one works
async function getSportsWithFallback(type, ...args) {
  const errors = [];
  for (const provider of SPORT_PROVIDERS) {
    try {
      if (type === 'homepage' && provider.getHomepage) {
        return { data: await provider.getHomepage(), provider: provider.name };
      }
      if (type === 'stream' && provider.getStream) {
        return { data: await provider.getStream(...args), provider: provider.name };
      }
    } catch (e) {
      errors.push(`${provider.name}: ${e.message}`);
    }
  }
  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

// Updated sports endpoint with provider chain
app.get('/api/sports/v2', async (req, res) => {
  try {
    const { data, provider } = await getSportsWithFallback('homepage');
    const sections = (data.operatingList || []).map(item => ({
      title: item.title,
      type: item.type,
      subjectCount: item.subjects?.length || 0,
      hasLiveList: !!item.liveList,
      subjects: (item.subjects || []).map(s => ({
        id: s.subjectId,
        title: s.title,
        poster: s.cover?.url || null,
        slug: s.detailPath
      }))
    }));
    res.json({ success: true, provider, sections });
  } catch(e) { res.status(500).json({ error: e.message, tried: SPORT_PROVIDERS.map(p => p.name) }); }
});

// Updated stream endpoint with provider chain
app.get('/api/sports/stream-v2/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sportType = req.query.sportType || 'football';
    const { data, provider } = await getSportsWithFallback('stream', id, sportType);
    
    res.json({
      success: true,
      id,
      provider,
      hasResource: data.hasResource || false,
      streams: (data.streams || []).map(s => ({
        quality: s.resolutions ? s.resolutions + 'p' : s.quality || 'HD',
        format: s.format || 'hls',
        url: s.url || s.src || ''
      })),
      hls: data.hls || [],
      dash: data.dash || []
    });
  } catch(e) {
    res.status(500).json({ 
      error: e.message, 
      tried: SPORT_PROVIDERS.map(p => p.name) 
    });
  }
});
