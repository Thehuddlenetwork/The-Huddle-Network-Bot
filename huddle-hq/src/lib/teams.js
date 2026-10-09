'use strict';

const RAW = [
  ['Bills', 'Buffalo', 'BUF', 'AFC East'], ['Dolphins', 'Miami', 'MIA', 'AFC East'],
  ['Patriots', 'New England', 'NE', 'AFC East', ['pats']], ['Jets', 'New York', 'NYJ', 'AFC East'],
  ['Ravens', 'Baltimore', 'BAL', 'AFC North'], ['Bengals', 'Cincinnati', 'CIN', 'AFC North'],
  ['Browns', 'Cleveland', 'CLE', 'AFC North'], ['Steelers', 'Pittsburgh', 'PIT', 'AFC North'],
  ['Texans', 'Houston', 'HOU', 'AFC South'], ['Colts', 'Indianapolis', 'IND', 'AFC South'],
  ['Jaguars', 'Jacksonville', 'JAX', 'AFC South', ['jags']], ['Titans', 'Tennessee', 'TEN', 'AFC South'],
  ['Broncos', 'Denver', 'DEN', 'AFC West'], ['Chiefs', 'Kansas City', 'KC', 'AFC West'],
  ['Raiders', 'Las Vegas', 'LV', 'AFC West', ['lvr']], ['Chargers', 'Los Angeles', 'LAC', 'AFC West', ['bolts']],
  ['Cowboys', 'Dallas', 'DAL', 'NFC East'], ['Giants', 'New York', 'NYG', 'NFC East'],
  ['Eagles', 'Philadelphia', 'PHI', 'NFC East'], ['Commanders', 'Washington', 'WAS', 'NFC East', ['wsh']],
  ['Bears', 'Chicago', 'CHI', 'NFC North'], ['Lions', 'Detroit', 'DET', 'NFC North'],
  ['Packers', 'Green Bay', 'GB', 'NFC North', ['pack']], ['Vikings', 'Minnesota', 'MIN', 'NFC North', ['vikes']],
  ['Falcons', 'Atlanta', 'ATL', 'NFC South'], ['Panthers', 'Carolina', 'CAR', 'NFC South'],
  ['Saints', 'New Orleans', 'NO', 'NFC South'], ['Buccaneers', 'Tampa Bay', 'TB', 'NFC South', ['bucs']],
  ['Cardinals', 'Arizona', 'ARI', 'NFC West', ['cards']], ['Rams', 'Los Angeles', 'LAR', 'NFC West'],
  ['49ers', 'San Francisco', 'SF', 'NFC West', ['niners']], ['Seahawks', 'Seattle', 'SEA', 'NFC West', ['hawks']],
];

const TEAMS = RAW.map(([name, city, abbr, div, aliases = []]) => ({
  name, city, abbr, div, conf: div.slice(0, 3), aliases,
}));

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const INDEX = new Map();
for (const t of TEAMS) {
  for (const key of [t.name, t.abbr, `${t.city}${t.name}`, ...t.aliases]) INDEX.set(norm(key), t);
}
// Unique city names also work ("Dallas", "Green Bay"); shared cities (New York, Los Angeles) do not.
const cityCount = {};
for (const t of TEAMS) cityCount[norm(t.city)] = (cityCount[norm(t.city)] || 0) + 1;
for (const t of TEAMS) if (cityCount[norm(t.city)] === 1 && !INDEX.has(norm(t.city))) INDEX.set(norm(t.city), t);

function findTeam(input) {
  if (!input) return null;
  const direct = INDEX.get(norm(input));
  if (direct) return direct;
  const words = String(input).trim().split(/\s+/);
  return INDEX.get(norm(words[words.length - 1])) || null;
}

const DIVISIONS = [...new Set(TEAMS.map((t) => t.div))];

function divisionOf(teamName) {
  const t = findTeam(teamName);
  return t ? t.div : null;
}

// "Raiders @ Chiefs", "LV at KC", "1. Raiders vs Chiefs"
function parseMatchupLine(line) {
  const clean = String(line).replace(/^\s*(?:[-*•]+|\d+[.)])\s+/, '').trim();
  if (!clean) return null;
  const pieces = clean.split(/\s+(?:@|at|vs\.?|v\.?|versus)\s+|\s*@\s*/i).map((s) => s.trim()).filter(Boolean);
  if (pieces.length !== 2) return { error: `Couldn't read "${clean}". Use the format: Raiders @ Chiefs` };
  const away = findTeam(pieces[0]);
  const home = findTeam(pieces[1]);
  if (!away) return { error: `Unknown team "${pieces[0]}"` };
  if (!home) return { error: `Unknown team "${pieces[1]}"` };
  if (away.name === home.name) return { error: `A team can't play itself: "${clean}"` };
  return { away: away.name, home: home.name };
}

module.exports = { TEAMS, DIVISIONS, findTeam, divisionOf, parseMatchupLine };
