const { chromium } = require('playwright');
const fs = require('fs');

const OUTPUT_FILE = 'utolsomerkozesek.json';
const URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061404';

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log('Navigating to URL...');
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for the actual table with match rows
    console.log('Waiting for table...');
    await page.waitForSelector('table.table-condensed tbody tr', { timeout: 30000 });
    await page.waitForTimeout(2000);

    const matches = await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll('table.table-condensed tbody tr');

      rows.forEach(row => {
        // --- Round: VLLM + number ---
        const roundDivs = row.querySelectorAll('td:first-child span div');
        const league   = roundDivs[0]?.innerText?.trim() || '';
        const roundNum = roundDivs[1]?.innerText?.trim() || '';
        const round    = `${league} ${roundNum}`.trim();

        // --- Team names (desktop label, .hidden-xs-up.visible-sm-up) ---
        const teamNames = row.querySelectorAll('.hidden-xs-up.visible-sm-up');
        const homeTeam  = teamNames[0]?.innerText?.trim() || '';
        const awayTeam  = teamNames[1]?.innerText?.trim() || '';

        // --- Match time (first .text-center inside the middle col-xs-4) ---
        const middleCol = row.querySelector('.col-xs-4:nth-child(2)');
        const timeEl    = middleCol?.querySelector('.text-center');
        const matchTime = timeEl?.innerText?.trim() || '';

        // --- Score from [aria-label="Eredm."] ---
        const scoreEl = row.querySelector('[aria-label="Eredm."]');
        let score = '';
        if (scoreEl) {
          // Collect the visible inline blocks: home_goals  :  away_goals  (RJ)
          const blocks = [...scoreEl.querySelectorAll('.inline-block')]
            .map(b => b.innerText?.trim())
            .filter(Boolean);
          score = blocks.join(' ').replace(/\s+/g, ' ').trim();
        }

        if (homeTeam && awayTeam) {
          results.push({ round, home_team: homeTeam, away_team: awayTeam, score, match_time: matchTime, scraped_at: new Date().toISOString() });
        }
      });

      return results;
    });

    await browser.close();
    console.log(`Scraped ${matches.length} rows`);
    return matches;

  } catch (err) {
    console.error('Scrape error:', err.message);
    try { await browser.close(); } catch (_) {}
    return null;
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting scrape...`);

  const newData = await scrape();

  if (!newData || newData.length === 0) {
    console.log('No data scraped, skipping update.');
    process.exit(0);
  }

  const last13 = newData.slice(0, 13);
  last13.forEach(m => console.log(`  [${m.round}] ${m.home_team} ${m.score} ${m.away_team} @ ${m.match_time}`));

  // --- Change detection ---
  let existing = { matches: [] };
  if (fs.existsSync(OUTPUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch (_) {}
  }

  const fp = (arr) => arr.map(m => `${m.round}|${m.home_team}|${m.away_team}|${m.score}`).join(';;');

  if (fp(existing.matches || []) === fp(last13)) {
    console.log('No changes detected.');
    process.exit(0);  // exit 0 = no change
  }

  console.log('Changes detected! Saving...');
  const output = { last_updated: new Date().toISOString(), total_matches: last13.length, matches: last13 };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Saved to ${OUTPUT_FILE}`);

  process.exit(2);  // exit 2 = changed, trigger git commit
}

main();
