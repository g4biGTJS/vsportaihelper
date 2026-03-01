const { chromium } = require('playwright');
const fs = require('fs');

const OUTPUT_FILE = 'utolsomerkozesek.json';
const URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061404';

async function scrape() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  // Intercept ALL responses and look for match data
  const capturedResponses = [];

  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    if (status === 200 && (url.includes('season') || url.includes('match') || url.includes('sport_event') || url.includes('summary') || url.includes('results') || url.includes('scigaming'))) {
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('json')) {
          const body = await response.json().catch(() => null);
          if (body) {
            capturedResponses.push({ url, body });
            console.log(`  [API] Captured: ${url.slice(0, 100)}`);
          }
        }
      } catch (_) {}
    }
  });

  try {
    console.log('Navigating...');
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for JS to run and make API calls
    console.log('Waiting for data to load (20s)...');
    await page.waitForTimeout(20000);

    // Try to get rendered HTML content as fallback
    const html = await page.content();

    await browser.close();

    // ---- Try to extract from intercepted API responses ----
    console.log(`Captured ${capturedResponses.length} API responses`);
    
    for (const resp of capturedResponses) {
      console.log(`  Trying: ${resp.url.slice(0, 120)}`);
      const matches = extractFromApiResponse(resp.body);
      if (matches && matches.length > 0) {
        console.log(`  Found ${matches.length} matches from API!`);
        return matches;
      }
    }

    // ---- Fallback: parse HTML with regex ----
    console.log('Trying HTML parse fallback...');
    const matches = extractFromHtml(html);
    if (matches.length > 0) {
      console.log(`Found ${matches.length} matches from HTML`);
      return matches;
    }

    console.log('No matches found in any source');
    return null;

  } catch (err) {
    console.error('Error:', err.message);
    try { await browser.close(); } catch (_) {}
    return null;
  }
}

function extractFromApiResponse(body) {
  // Sportradar API shapes vary — search recursively for match-like objects
  const matches = [];

  function walk(obj, depth = 0) {
    if (depth > 10 || !obj) return;
    if (Array.isArray(obj)) {
      obj.forEach(item => walk(item, depth + 1));
    } else if (typeof obj === 'object') {
      // Look for objects that have home_team/away_team or competitors
      if (obj.competitors && Array.isArray(obj.competitors) && obj.competitors.length === 2) {
        const home = obj.competitors.find(c => c.qualifier === 'home') || obj.competitors[0];
        const away = obj.competitors.find(c => c.qualifier === 'away') || obj.competitors[1];
        const homeName = home?.name || home?.abbreviation || '';
        const awayName = away?.name || away?.abbreviation || '';
        
        let score = '';
        if (obj.sport_event_status) {
          const s = obj.sport_event_status;
          const hs = s.home_score ?? s.home_score_total ?? '';
          const as = s.away_score ?? s.away_score_total ?? '';
          if (hs !== '' && as !== '') score = `${hs} : ${as}`;
        }
        if (obj.results) {
          const r = obj.results;
          const hs = r.home ?? r.home_team ?? '';
          const as = r.away ?? r.away_team ?? '';
          if (hs !== '' && as !== '') score = `${hs} : ${as}`;
        }

        const scheduledTime = obj.sport_event?.scheduled || obj.scheduled || '';
        const roundNum = obj.sport_event?.sport_event_context?.round?.number 
                      || obj.round?.number 
                      || obj.round_number 
                      || '';

        if (homeName && awayName) {
          matches.push({
            round: roundNum ? `VLLM ${roundNum}` : '',
            home_team: homeName,
            away_team: awayName,
            score,
            match_time: scheduledTime ? new Date(scheduledTime).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }) : '',
            scraped_at: new Date().toISOString()
          });
        }
        return; // don't recurse into processed node
      }

      Object.values(obj).forEach(val => walk(val, depth + 1));
    }
  }

  walk(body);
  return matches;
}

function extractFromHtml(html) {
  // Use the known HTML structure from real page
  // Team names are in: <div class="hidden-xs-up visible-sm-up wrap">TEAMNAME</div>
  // Score: <div ... aria-label="Eredm.">...blocks...</div>
  // Time: first .text-center in middle col
  const matches = [];

  // Extract round numbers
  const roundMatches = [...html.matchAll(/title="Virtuális Labdarúgás Liga Mód Retail">VLLM<\/div><div title="">([\d]+)<\/div>/g)];
  
  // Extract team name pairs  
  const teamMatches = [...html.matchAll(/class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/g)];
  
  // Extract scores using aria-label
  const scoreBlocks = [...html.matchAll(/aria-label="Eredm\.">([\s\S]*?)<\/div>\s*<\/div>/g)];
  
  // Extract times
  const timeMatches = [...html.matchAll(/class="text-center">([\d]{1,2}:[\d]{2})<\/div>/g)];

  const numRows = Math.floor(teamMatches.length / 2);

  for (let i = 0; i < numRows; i++) {
    const homeTeam = teamMatches[i * 2]?.[1]?.trim() || '';
    const awayTeam = teamMatches[i * 2 + 1]?.[1]?.trim() || '';
    const round = roundMatches[i] ? `VLLM ${roundMatches[i][1]}` : '';
    const matchTime = timeMatches[i]?.[1] || '';

    // Extract score numbers from the score block
    let score = '';
    if (scoreBlocks[i]) {
      const nums = [...scoreBlocks[i][1].matchAll(/>(\d+)<sup>/g)].map(m => m[1]);
      if (nums.length >= 2) score = `${nums[0]} : ${nums[1]} (RJ)`;
    }

    if (homeTeam && awayTeam) {
      matches.push({ round, home_team: homeTeam, away_team: awayTeam, score, match_time: matchTime, scraped_at: new Date().toISOString() });
    }
  }

  return matches;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting scrape...`);

  const newData = await scrape();

  if (!newData || newData.length === 0) {
    console.log('No data scraped.');
    process.exit(0);
  }

  const last13 = newData.slice(0, 13);
  last13.forEach(m => console.log(`  [${m.round}] ${m.home_team} ${m.score} ${m.away_team} @ ${m.match_time}`));

  let existing = { matches: [] };
  if (fs.existsSync(OUTPUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch (_) {}
  }

  const fp = (arr) => arr.map(m => `${m.round}|${m.home_team}|${m.away_team}|${m.score}`).join(';;');

  if (fp(existing.matches || []) === fp(last13)) {
    console.log('No changes.');
    process.exit(0);
  }

  console.log('Saving changes...');
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ last_updated: new Date().toISOString(), total_matches: last13.length, matches: last13 }, null, 2));
  console.log('Saved!');
  process.exit(2);
}

main();
