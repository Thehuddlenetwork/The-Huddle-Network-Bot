'use strict';
// THN rules and starting values. Credit values and limits can be changed live
// with /setup credit and /setup limit — the numbers here are only the defaults.

const BRAND = {
  red: 0xF2010E,
  black: 0x0A0A0A,
  gold: 0xFFCC00,
  green: 0x22C55E,
  silver: 0xC0C0C0,
  grey: 0x2B2B2B,
  name: 'THE HUDDLE NETWORK',
};

const LEAGUES = { HL: 'Huddle League', NL: 'Network League' };

// Advances: Monday, Wednesday, Friday at 8 PM PT. A missed advance moves to the next day.
const ADVANCE = { days: [1, 3, 5], hour: 20, minute: 0 };

// [default value, what it pays for]
const CREDITS = {
  lockIn: [5, 'Lock In: game time confirmed within 12 hrs of the advance'],
  onTime: [10, 'On-Time Kickoff: live within 5 min of the locked time'],
  streak3: [15, '3-game on-time streak'],
  streak5: [30, '5-game on-time streak'],
  streak10: [75, '10-game on-time streak (+ Iron Clock role)'],
  cleanDivision: [5, 'Clean Division: every division game on time'],
  complete: [10, 'Complete Game: played to the final whistle'],
  double: [5, 'The Double: on time AND complete'],
  fullBroadcast: [5, 'Full Broadcast: VOD posted'],
  completeWeek: [10, 'Complete Week: every game that week complete'],
  completeStreak8: [40, '8 straight complete games'],
  cleanAdvance: [5, 'Clean Advance: whole division complete before the advance'],
  clipAccepted: [5, 'Clip accepted (Highlight Drop)'],
  clipVertical: [5, 'Clip cut vertical with captions'],
  clipFeatured: [20, 'Clip featured on THN socials'],
  clip1k: [10, 'Clip hit 1K views on THN'],
  clip10k: [30, 'Clip hit 10K views on THN'],
  clip100k: [100, 'Clip hit 100K views on THN'],
  clipOfWeek: [50, 'Clip of the Week'],
  scoutReport: [10, 'Scouting Report'],
  activeChat: [3, 'Active chat in a member stream'],
  raid: [5, 'Raid to a live THN member'],
  event: [10, 'Network event attendance'],
  academyLevel: [25, 'Academy level completed'],
  spoilerBounty: [20, 'Spoiler Bounty: underdog beat a contender'],
  unusedAudible: [0, 'Each unused Audible at season end (0 = off)'],
};

// [default value, what it controls]
const LIMITS = {
  clipsPerWeek: [5, 'Clips per week that earn credits'],
  scoutPerWeek: [3, 'Scouting Reports per week that earn credits'],
  chatPerWeek: [10, 'Active-chat credits per week'],
  raidsPerWeek: [5, 'Raid credits per week'],
  audiblesPerSeason: [2, 'Audibles (reschedules) per member per season'],
  audibleNoticeHours: [6, 'Hours of notice an Audible needs'],
  lockInHours: [12, 'Hours after an advance to lock a game time'],
  bufferHours: [2, 'Kickoff must be this many hours before the next advance'],
  advanceGraceMinutes: [60, 'Minutes after 8 PM PT before a missed advance moves to tomorrow'],
  tradeVoteHours: [24, 'Hours before a trade with no majority auto-passes'],
  finalAutoConfirmHours: [6, 'Hours before an unconfirmed final auto-confirms'],
  primeTimeOnTime: [90, 'On-time % needed for Game of the Week'],
  primeTimeComplete: [95, 'Completion % needed for Game of the Week'],
  strikesFreeze: [3, 'Strikes that freeze trades and Prime Time'],
  strikesReview: [5, 'Strikes that trigger a removal review'],
  noShowsReview: [2, 'No-shows that trigger a removal review'],
  rageQuitsReview: [2, 'Rage quits that trigger a removal review'],
  creatorScoreMin: [70, 'Network League Creator Score minimum'],
  fanPoints: [5, 'Passport points for the THN Fan role'],
  superfanPoints: [25, 'Passport points for the THN Superfan role'],
};

const CLIP_TYPES = ['Play of the Week', 'Clutch', 'Reaction', 'Spoiler', 'Breakdown', 'Rivalry', 'Blooper', 'Big Moment'];

// Huddle Academy: worked in order. Edit the wording here any time.
const ACADEMY_LEVELS = [
  { name: 'Get On Air', check: 'Link a stream or VOD (30+ min) with clean game audio and your mic.' },
  { name: 'Look Like a Broadcast', check: 'Screenshot of your live stream with the THN watermark and your nameplate.' },
  { name: 'Call Your Own Game', check: 'VOD of a full league game with your commentary, plus your best timestamp.' },
  { name: 'Package It', check: 'Links to 3 clips from one league game, cut vertical with captions.' },
  { name: 'Multiply It', check: 'Links showing game content posted on 2+ platforms (TikTok, Shorts, Reels).' },
  { name: 'Build the Room', check: 'Proof of a raid, a community event, or your community hub (Discord or socials).' },
  { name: 'Turn It Into Income', check: 'Proof of a monetization path: affiliate, subs, tips, sponsor or merch.' },
];

const AWARD_CATEGORIES = [
  'MVP', 'Best Streamer', 'Best Content Creator', 'Best Broadcast', 'Most Improved Creator',
  'Best Personality', 'Best Rivalry', 'Best Community Member', 'Coach of the Year', 'Rookie of the Year',
];

const TIMEZONES = {
  PT: { zone: 'America/Los_Angeles', label: 'Pacific (PT)' },
  MT: { zone: 'America/Denver', label: 'Mountain (MT)' },
  AZ: { zone: 'America/Phoenix', label: 'Arizona (AZ)' },
  CT: { zone: 'America/Chicago', label: 'Central (CT)' },
  ET: { zone: 'America/New_York', label: 'Eastern (ET)' },
  AK: { zone: 'America/Anchorage', label: 'Alaska (AK)' },
  HI: { zone: 'Pacific/Honolulu', label: 'Hawaii (HI)' },
};

// Availability windows, in each member's own time zone. "late" runs past midnight.
const WINDOWS = {
  morning: { label: 'Morning (9 AM to 12 PM)', start: 9, end: 12 },
  afternoon: { label: 'Afternoon (12 to 5 PM)', start: 12, end: 17 },
  evening: { label: 'Evening (5 to 8 PM)', start: 17, end: 20 },
  prime: { label: 'Prime time (8 to 11 PM)', start: 20, end: 23 },
  late: { label: 'Late night (11 PM to 2 AM)', start: 23, end: 26 },
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Media team weekly slate (1 = Monday ... 7 = Sunday)
const MEDIA_SLATE = {
  1: 'Power Rankings',
  2: 'Top 5 Plays',
  3: 'Creator Spotlight',
  4: 'Game of the Week Preview',
  5: 'Huddle Headlines',
  7: 'Weekend Recap',
};

// Channels the bot posts to. access: public | members | staff
const CHANNELS = {
  wire: { name: 'the-wire', label: 'The Wire (trades, spoilers, GOTW, winners)', access: 'public' },
  tonight: { name: 'tonight-on-thn', label: 'Tonight on THN schedule', access: 'public' },
  goLive: { name: 'go-live', label: 'Go-live alerts', access: 'public' },
  join: { name: 'join-the-network', label: 'Join panel', access: 'public' },
  clipVote: { name: 'clip-of-the-week', label: 'Clip of the Week voting', access: 'public' },
  passport: { name: 'passport', label: 'THN Passport', access: 'public' },
  advance: { name: 'advance-center', label: 'Advance announcements and countdowns', access: 'members' },
  gamesHL: { name: 'hl-game-times', label: 'Huddle League game threads', access: 'members' },
  gamesNL: { name: 'nl-game-times', label: 'Network League game threads', access: 'members' },
  reliability: { name: 'reliability-board', label: 'Weekly Reliability Board', access: 'members' },
  creditLog: { name: 'credit-log', label: 'Every credit transaction', access: 'members' },
  tradeDesk: { name: 'trade-desk', label: 'Trade proposals', access: 'members' },
  academy: { name: 'academy-check-ins', label: 'Academy check-ins', access: 'members' },
  scouting: { name: 'scouting', label: 'Scouting Reports', access: 'members' },
  tradeCommittee: { name: 'trade-committee', label: 'Trade committee votes', access: 'staff', extraRoles: ['committee'] },
  clipReview: { name: 'clip-review', label: 'Clip review queue', access: 'staff', extraRoles: ['clipTeam'] },
  staffAlerts: { name: 'staff-alerts', label: 'Staff alerts and rulings', access: 'staff' },
  strikeLog: { name: 'strike-log', label: 'Strike log', access: 'staff' },
  applications: { name: 'applications', label: 'Member applications', access: 'staff' },
  redemptions: { name: 'redemptions', label: 'Shop redemptions', access: 'staff' },
  mediaDesk: { name: 'media-desk', label: 'Daily media brief', access: 'staff', extraRoles: ['media'] },
};

const ROLES = {
  commissioner: { name: 'Commissioner', color: 0xF2010E, hoist: true },
  staff: { name: 'Ops Staff', color: 0xC0C0C0, hoist: true },
  committee: { name: 'Trade Committee', color: 0x9CA3AF },
  clipTeam: { name: 'Clip Team', color: 0x9CA3AF },
  coach: { name: 'Coach', color: 0x9CA3AF },
  media: { name: 'Media Team', color: 0x9CA3AF },
  member: { name: 'THN Member', color: 0xFFFFFF, hoist: true },
  leagueHL: { name: 'Huddle League', color: 0xF2010E },
  leagueNL: { name: 'Network League', color: 0xFFCC00 },
  standard: { name: 'Academy Standard', color: 0xE5E7EB },
  pro: { name: 'Academy Pro', color: 0xFFCC00 },
  waitlist: { name: 'Waitlist', color: 0x6B7280 },
  ironClock: { name: 'Iron Clock', color: 0xC0C0C0 },
  highlight: { name: 'Highlight', color: 0xF97316 },
  fan: { name: 'THN Fan', color: 0x9CA3AF },
  superfan: { name: 'THN Superfan', color: 0xF2010E },
};

// Starter shop. Edit or remove with /bank.
const SHOP_SEED = [
  { name: 'Thumbnail Critique', cost: 150, description: 'A THN coach reviews 3 of your thumbnails with written notes.' },
  { name: 'Stream Audit', cost: 300, description: '15-minute review of one VOD: setup, audio, overlays, pacing.' },
  { name: 'Featured Spot on THN Socials', cost: 400, description: 'Your best clip posted on THN accounts, credited to you.' },
  { name: '1-on-1 Coaching Session', cost: 600, description: '30 minutes with a THN coach on your growth plan.' },
];

const PASSPORT_WORDS = [
  'BLITZ', 'AUDIBLE', 'REDZONE', 'PICKSIX', 'HAILMARY', 'SHOTGUN', 'PLAYACTION', 'ONSIDE', 'GOALLINE',
  'CLUTCH', 'HUDDLE', 'ENDZONE', 'FLEAFLICKER', 'COVER2', 'NICKEL', 'DIME', 'BOOTLEG', 'SLANT',
  'WILDCAT', 'QBSNEAK', 'TWOMINUTE', 'PRIMETIME', 'HOTROUTE', 'MAN2', 'STRETCH',
];

module.exports = {
  BRAND, LEAGUES, ADVANCE, CREDITS, LIMITS, CLIP_TYPES, ACADEMY_LEVELS, AWARD_CATEGORIES,
  TIMEZONES, WINDOWS, WEEKDAYS, MEDIA_SLATE, CHANNELS, ROLES, SHOP_SEED, PASSPORT_WORDS,
};
