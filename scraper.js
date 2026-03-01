const { chromium } = require('playwright');
const fs = require('fs');

const OUTPUT_FILE = 'utolsomerkozesek.json';
const URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061404';

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for the last matches table to appear
    await page.waitForSelector('.matches-table, table, .last-matches', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const matches = await page.evaluate(() => {
      const results = [];

      // Find all table rows
      const rows = document.querySelectorAll('tr');

      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) return;

        const rowText = row.innerText || '';

        // Look for rows with score pattern like "1 : 3" or "2 : 0"
        if (!rowText.match(/\d+\s*:\s*\d+/)) return;

        // Try to extract round info (VLLM + number)
        const roundCell = cells[0]?.innerText?.trim() || '';
        if (!roundCell.includes('VLLM') && !roundCell.match(/\d+/)) return;

        // Find home team, score, away team
        // Typical structure: [round] [home] [time/score] [away]
        let homeTeam = '';
        let awayTeam = '';
        let score = '';
        let matchTime = '';
        let round = '';

        if (cells.length >= 4) {
          round = cells[0]?.innerText?.trim().replace(/\s+/g, ' ') || '';
          homeTeam = cells[1]?.innerText?.trim() || '';
          const middleCell = cells[2]?.innerText?.trim() || '';
          awayTeam = cells[3]?.innerText?.trim() || '';

          // Extract time and score from middle cell
          // Format: "11:32\n1 : 3 (RJ)" or similar
          const lines = middleCell.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length >= 2) {
            matchTime = lines[0];
            score = lines[1];
          } else if (lines.length === 1) {
            if (lines[0].match(/\d+:\d+/) && !lines[0].match(/\s*:\s*\d+\s*\(/)) {
              matchTime = lines[0];
            } else {
              score = lines[0];
            }
          }
        }

        if (homeTeam && awayTeam) {
          results.push({
            round: round,
            home_team: homeTeam,
            away_team: awayTeam,
            score: score,
            match_time: matchTime,
            scraped_at: new Date().toISOString()
          });
        }
      });

      return results;
    });

    await browser.close();

    if (matches.length === 0) {
      console.log('No matches found, trying alternative selector...');
      return null;
    }

    // Take last 13
    const last13 = matches.slice(0, 13);

    console.log(`Found ${matches.length} matches, keeping last 13`);
    last13.forEach(m => {
      console.log(`  [${m.round}] ${m.home_team} ${m.score} ${m.away_team} @ ${m.match_time}`);
    });

    return last13;

  } catch (err) {
    console.error('Scrape error:', err.message);
    await browser.close();
    return null;
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting scrape...`);

  const newData = await scrape();

  if (!newData || newData.length === 0) {
    console.log('No data scraped, skipping update.');
    return;
  }

  // Load existing data
  let existing = { last_updated: null, matches: [] };
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    } catch (e) {
      console.log('Could not parse existing file, starting fresh.');
    }
  }

  // Check if data changed
  const existingStr = JSON.stringify(existing.matches.map(m => `${m.home_team}${m.score}${m.away_team}${m.round}`));
  const newStr = JSON.stringify(newData.map(m => `${m.home_team}${m.score}${m.away_team}${m.round}`));

  if (existingStr === newStr) {
    console.log('No changes detected.');
    return;
  }

  console.log('Changes detected! Updating file...');

  const output = {
    last_updated: new Date().toISOString(),
    total_matches: newData.length,
    matches: newData
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Saved ${newData.length} matches to ${OUTPUT_FILE}`);
}

main();
