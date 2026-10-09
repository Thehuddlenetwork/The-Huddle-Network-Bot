'use strict';
// Huddle Awards: member votes plus data-driven awards from the season's numbers.
const db = require('../db');
const settings = require('../settings');
const { UserError } = require('../bus');
const members = require('./members');
const games = require('./games');
const { AWARD_CATEGORIES } = require('../constants');

const isOpen = () => settings.get(`awards_open:${settings.season()}`) === '1';
const setOpen = (open) => settings.set(`awards_open:${settings.season()}`, open ? '1' : null);

function vote(voterId, category, nomineeId) {
  if (!isOpen()) throw new UserError('Award voting isn\'t open right now.');
  if (!AWARD_CATEGORIES.includes(category)) throw new UserError('Pick a category from the list.');
  if (voterId === nomineeId) throw new UserError('You can\'t vote for yourself.');
  const voter = members.get(voterId);
  if (!voter || voter.status !== 'active') throw new UserError('Only THN members can vote.');
  const n = members.get(nomineeId);
  if (!n || !['active', 'alumni'].includes(n.status)) throw new UserError('That person isn\'t a THN member.');
  db.run(`INSERT INTO award_votes (season, category, voter_id, nominee_id) VALUES (?,?,?,?)
    ON CONFLICT(season, category, voter_id) DO UPDATE SET nominee_id = excluded.nominee_id`, settings.season(), category, voterId, nomineeId);
}

const myBallot = (voterId) => db.all('SELECT category, nominee_id FROM award_votes WHERE season = ? AND voter_id = ?', settings.season(), voterId);

function results() {
  const s = settings.season();
  return AWARD_CATEGORIES.map((category) => {
    const rows = db.all(`SELECT nominee_id, COUNT(*) AS n FROM award_votes WHERE season = ? AND category = ?
      GROUP BY nominee_id ORDER BY n DESC LIMIT 3`, s, category);
    return { category, top: rows };
  });
}

function dataAwards() {
  const s = settings.season();
  const since = settings.getInt('season_started_at', 0);
  const list = members.active().map((m) => ({ m, st: games.memberStats(m.user_id, s) }));
  const ironClock = list.filter((x) => x.st.timed >= 5 && x.st.ontime === x.st.timed).map((x) => x.m.user_id);
  const finalWhistle = list.filter((x) => x.st.counted >= 5 && x.st.complete === x.st.counted).map((x) => x.m.user_id);
  const clipMachine = db.one(`SELECT user_id, COUNT(*) AS n FROM clips WHERE featured = 1 AND created_at >= ?
    GROUP BY user_id ORDER BY n DESC LIMIT 1`, since);
  const mostViral = db.one(`SELECT user_id, id FROM clips WHERE created_at >= ? AND milestones <> ''
    ORDER BY LENGTH(milestones) DESC, id ASC LIMIT 1`, since);
  return { ironClock, finalWhistle, clipMachine, mostViral };
}

module.exports = { isOpen, setOpen, vote, myBallot, results, dataAwards };
