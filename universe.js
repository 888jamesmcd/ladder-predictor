// universe.js — Universe mode: seasons that play themselves in real time.
//
// Pure logic, no DOM. Loaded as `window.LadderUniverse` in the browser and
// via require() in Node. It leans on sim.js (window.LadderSim) for ratings,
// results and match timelines, and adds the calendar on top: a fixture each
// season, a kick-off time for every game, and where every game is at any
// given moment.
//
// Nothing here runs in the background. Every game's state is a function of
// the clock: a game is upcoming, live (at a known point of its timeline) or
// final, and opening the app after a week away simply works out the week.
// Results are decided when a round (or finals day) first kicks off and are
// stored, so a later engine change can never rewrite a season already played.

(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./sim.js')
    : root.LadderSim);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LadderUniverse = api;
}(typeof self !== 'undefined' ? self : this, function (LS) {
'use strict';

const DAY_MS = 86400000;
const MIN_MS = 60000;

// ============================================================
// UNIVERSE_CONFIG — the calendar, per sport
// ============================================================
const UNIVERSE_CONFIG = {
  // Brisbane: UTC+10, no daylight saving, so a day is always 24 hours and a
  // slot is always the same UTC time.
  utcOffsetMins: 600,
  // Clubs between seasons — see nextTalent(). Every season's clubs and
  // seeds are worked out once, when it is planned, and stored with it.
  talent: {
    // Each off-season a list drifts this far back toward the pack (0.96 keeps
    // 96% of its distance from average), then moves with its stage: `drift`
    // rating points a year on average, for `years` seasons before moving on.
    regression: 0.96,
    stages: {
      rebuilding: { drift: 2,   years: [2, 3] },
      emerging:   { drift: 7.5, years: [2, 3] },
      contending: { drift: 3,   years: [1, 3] },
      peak:       { drift: 0,   years: [1, 3] },
      ageing:     { drift: -8,  years: [2, 3] },
    },
    // Year-to-year wobble on top of the stage: shared by attack and defence,
    // and each on its own.
    noise: 2.5, own: 1.5,
    // A list this far above or below average jumps ahead in its cycle (a
    // rebuild that's come good early, an ageing list that's hit the bottom).
    stageJump: 10,
    // Draft help for the bottom of the ladder, wooden spoon first (overall
    // rating points, split across attack and defence).
    draft: [3, 2.2, 1.5, 1],
    // Coaches: quality is drawn with this spread (most between −1.3 and +1.3)
    // and adds quality × coachWeight to attack and defence; a new coach's
    // first season gets `honeymoon` on top.
    coachSpread: 1.3, coachWeight: 1, honeymoon: 1,
    // How busy the off-season is: 1 is about one move for every second club.
    moveRate: 1,
    // The 'Random' start: how widely sides are spread around the mean.
    randomSpread: 10,
    // The 'Real world' start: how much of last real season's gap to the pack
    // each club keeps going in (see realWorldTalent).
    realRegression: 0.75,
    // Consistency: how much a side's results wobble around what its ratings
    // say, from volatile to ruthless (multipliers in SIM_CONFIG.common
    // .consistency). Drawn for each side at the start, by these weights; each
    // off-season a side has consistencyShift chance of moving one step.
    consistencyWeights: { volatile: 1, streaky: 2, balanced: 4, steady: 2, ruthless: 1 },
    consistencyShift: 0.2,
  },
  afl: {
    rounds: 24,
    daysPerRound: 2,
    // Kick-off slots, Brisbane time, for each day of a round.
    slots: [
      ['12:00', '14:30', '16:00', '18:30'],
      ['12:00', '14:30', '16:00', '18:30', '20:00'],
    ],
    // Prime time, best first: [day, slot]. A game between two top-8 sides
    // takes the next of these; there can be at most four of them a round.
    primeSlots: [[0, 3], [1, 3], [0, 2], [1, 2]],
    maxMeetings: 2,       // nobody plays anybody three times
    rematchGap: 8,        // a rematch is at least 8 rounds after the first meeting
    byeRounds: [],        // 18 sides: everyone plays every round
    // Real minutes between periods: quarter time, half time, three-quarter time.
    breaks: [4, 10, 4],
    breakLabels: ['QT', 'HT', '3QT'],
    // Universe-only tweaks laid over SIM_CONFIG.afl (see simConfig). W is
    // how much a rating point is worth on the scoreboard: 0.62 against the
    // predictor's 0.55, so a strong side against a weak one shows it. 0.7 had
    // the best side winning by 30-40 a game; 0.62 keeps it near a real minor
    // premier's 25-30.
    // SWING is the roll that decides margins and upsets (see SIM_CONFIG.afl):
    // 11 against the predictor's 13.5 keeps games between closely rated sides
    // close, and lets the better side win more often (about 70% of games, 93%
    // of top-three v bottom-four) without the margins blowing out.
    // AVG 80 against the predictor's 85: a side averages about 84 a game (a
    // game about 168), a little under 2026's 89.
    sim: { W: 0.62, SWING: 11, AVG: 80 },
    maxGameMins: 4 * 35 + 18,  // the longest a game can run, breaks included
    // Four points a win, two a draw; level on points goes to percentage.
    ladder: { win: 4, draw: 2, bye: 0, sortBy: 'pct' },
    wildcard: true,
    // Finals: one finals round per day, straight after the home-and-away
    // season. The wildcard round (7v10, 8v9) comes first, then the top eight.
    finals: [
      { stage: 'WC', games: [['WC2', '16:00'], ['WC1', '18:30']] },
      { stage: 'W1', games: [['EF2', '12:00'], ['EF1', '14:30'], ['QF2', '16:00'], ['QF1', '18:30']] },
      { stage: 'SF', games: [['SF1', '16:00'], ['SF2', '18:30']] },
      { stage: 'PF', games: [['PF2', '16:00'], ['PF1', '18:30']] },
      { stage: 'GF', games: [['GF', '14:30']] },
    ],
    grandFinalVenue: 'MCG',
    offSeasonDays: 2,     // empty days between the grand final and Round 1
    // Staple games, in every season's fixture. Rounds count from 1: one
    // round is that round exactly; [first, last] is any round in between,
    // drawn each season. slot 'prime' takes the round's best prime-time slot,
    // 'last' the round's final game. Which side is at home stays a coin toss.
    staples: [
      { teams: ['Collingwood', 'Essendon'], rounds: [5], slot: 'prime' },        // Anzac Day
      { teams: ['Hawthorn', 'Geelong Cats'], rounds: [3], slot: 'last' },        // Easter Monday
      { teams: ['Essendon', 'Richmond'], rounds: [10, 14] },                     // Dreamtime
      { teams: ['Collingwood', 'Melbourne'], rounds: [10, 14] },                 // King's Birthday
    ],
    // Pairs that always meet twice a season.
    twice: [
      ['Fremantle', 'West Coast Eagles'], ['Brisbane Lions', 'Gold Coast Suns'],
      ['Port Adelaide', 'Adelaide'], ['Sydney', 'GWS Giants'],
      ['Collingwood', 'Carlton'], ['Richmond', 'Carlton'], ['Collingwood', 'Essendon'],
    ],
  },
  nrl: {
    // 17 sides, so someone has the bye every round. 27 rounds: 21 of eight
    // games with one bye, and six Origin-period rounds of six games with five
    // byes. That's 24 games and 3 byes for everybody, as in the real NRL.
    rounds: 27,
    daysPerRound: 2,
    slots: [
      ['13:15', '15:30', '18:00', '21:00'],
      ['12:45', '14:00', '16:30', '19:00'],
    ],
    primeSlots: [[0, 2], [1, 3], [1, 2], [0, 1]],
    maxMeetings: 2,
    rematchGap: 8,
    byeRounds: [11, 12, 14, 15, 17, 18],   // Rounds 12, 13, 15, 16, 18, 19
    bigByeCount: 5,
    // Half time is five minutes; golden point follows straight on.
    breaks: [5, 0],
    breakLabels: ['HT', 'GP'],
    // See afl.sim. W 0.32 (0.38 had the best side winning by 17+ a game,
    // against a real minor premier's 10-15) and SWING 5 against the
    // predictor's 6.5: closely rated sides average an 8-point game.
    // AVG 19.5 against the predictor's 21: about 21 a side, 42 a game.
    sim: { W: 0.32, SWING: 5, AVG: 19.5 },
    maxGameMins: 40 + 5 + 40 + 10,
    // Two points a win, one a draw, two for the bye; then points differential.
    ladder: { win: 2, draw: 1, bye: 2, sortBy: 'diff' },
    wildcard: false,
    finals: [
      { stage: 'W1', games: [['EF2', '14:00'], ['EF1', '16:30'], ['QF2', '18:00'], ['QF1', '19:55']] },
      { stage: 'SF', games: [['SF1', '16:30'], ['SF2', '19:00']] },
      { stage: 'PF', games: [['PF2', '16:30'], ['PF1', '19:00']] },
      { stage: 'GF', games: [['GF', '19:30']] },
    ],
    grandFinalVenue: 'Accor Stadium',
    offSeasonDays: 2,
    staples: [
      { teams: ['Dragons', 'Roosters'], rounds: [8], slot: 'prime' },            // Anzac Day
    ],
    twice: [
      ['Dragons', 'Roosters'], ['Broncos', 'Cowboys'], ['Broncos', 'Dolphins'],
      ['Roosters', 'Rabbitohs'], ['Panthers', 'Eels'],
    ],
  },
};

// ============================================================
// CLOCK — Brisbane days and slots as UTC milliseconds
// ============================================================
function brisbaneMidnight(ms, cfg) {
  const off = (cfg || UNIVERSE_CONFIG).utcOffsetMins * MIN_MS;
  return Math.floor((ms + off) / DAY_MS) * DAY_MS - off;
}
function slotMs(dayMs, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return dayMs + (h * 60 + m) * MIN_MS;
}
// "Start season" kicks off at the next 12:00pm Brisbane: today if it hasn't
// passed yet, otherwise tomorrow.
function firstDay0(nowMs, sportCfg, cfg) {
  const today = brisbaneMidnight(nowMs, cfg);
  return nowMs < slotMs(today, sportCfg.slots[0][0]) ? today : today + DAY_MS;
}

// Test mode: every game in a round kicks off together, and the next round
// (or finals week, or season) follows as soon as the longest game could be
// over. A season that takes months normally plays out in a few days.
// These are the only places the calendar is worked out, so a season planned
// either way reads back the same.
function testGap(scfg) { return (scfg.maxGameMins + 5) * MIN_MS; }
// When round r begins and ends (the end is when the next one may begin).
function roundStart(universe, season, r) {
  const scfg = universe.config[universe.sport];
  return season.test ? season.day0 + r * testGap(scfg) : season.day0 + r * scfg.daysPerRound * DAY_MS;
}
function roundEnd(universe, season, r) {
  const scfg = universe.config[universe.sport];
  return season.test ? roundStart(universe, season, r) + testGap(scfg) : roundStart(universe, season, r + 1);
}
// Finals week si: when it begins, and when one of its games kicks off.
function finalsStageStart(universe, season, si) {
  const scfg = universe.config[universe.sport];
  return season.test ? season.day0 + (scfg.rounds + si) * testGap(scfg)
    : season.day0 + (season.finalsDay0 + si) * DAY_MS;
}
function finalKickoff(universe, season, si, time) {
  const start = finalsStageStart(universe, season, si);
  return season.test ? start : slotMs(start, time);
}
// The first bounce of a season that begins at day0.
function seasonFirstKickoff(universe, day0, test) {
  return test ? day0 : slotMs(day0, universe.config[universe.sport].slots[0][0]);
}

// ============================================================
// FIXTURE — a fresh draw each season
// ============================================================
// Every pair meets at least once and at most maxMeetings times; a rematch
// comes at least rematchGap rounds after the first meeting. Pairs in
// scfg.twice meet exactly twice, and staple games (`fixed`, from
// resolveStaples) are placed in their round before anything else. Each round
// is a perfect matching found by a randomised backtracking search; a dead end
// restarts the whole draw with the same rng running on, so a seed always
// produces the same fixture.
// `byes` is one array of team names per round (empty when nobody has one).
function generatePairings(teams, rounds, rng, scfg, byes, fixed) {
  const n = teams.length;
  const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const onBye = (byes || []).map(list => new Set((list || []).map(t => teams.indexOf(t))));
  // Staples: which pairs are placed in which rounds.
  const forcedAt = Array.from({ length: rounds }, () => []);
  const forcedRounds = {};                     // pairKey -> [round, ...]
  (fixed || []).forEach(f => {
    const i = teams.indexOf(f.a), j = teams.indexOf(f.b);
    forcedAt[f.r].push([i, j]);
    (forcedRounds[pairKey(i, j)] = forcedRounds[pairKey(i, j)] || []).push(f.r);
  });
  const forcedAfter = (k, r) => (forcedRounds[k] || []).filter(R => R > r).length;
  const twice = new Set(pairsPresent(teams, scfg.twice).map(([a, b]) => pairKey(teams.indexOf(a), teams.indexOf(b))));
  const need = k => (twice.has(k) ? 2 : 1);
  // Games a side still has to play from round r on, round r included.
  const playsFrom = [];
  for (let r = rounds; r >= 0; r--) {
    playsFrom[r] = teams.map((_, i) => r === rounds ? 0
      : playsFrom[r + 1][i] + ((onBye[r] && onBye[r].has(i)) ? 0 : 1));
  }

  for (let attempt = 0; attempt < 2000; attempt++) {
    const meetings = {};                       // pairKey -> [round, ...]
    const out = [];
    let failed = false;

    for (let r = 0; r < rounds && !failed; r++) {
      const left = i => playsFrom[r][i];       // games left, this one included
      // Meetings a pair still owes beyond the staples already placed for it
      // later on: one for a pair yet to meet, two for an unmet `twice` pair.
      const owes = (i, j) => {
        const k = pairKey(i, j);
        return Math.max(0, need(k) - (meetings[k] || []).length - forcedAfter(k, r));
      };
      const owed = teams.map((_, i) => {
        let c = 0;
        for (let j = 0; j < n; j++) if (j !== i) c += owes(i, j);
        return c;
      });
      // Staples still to come take games too.
      const booked = teams.map((_, i) => {
        let c = 0;
        for (let R = r + 1; R < rounds; R++) forcedAt[R].forEach(([a, b]) => { if (a === i || b === i) c++; });
        return c;
      });
      const allowed = (i, j) => {
        const k = pairKey(i, j);
        const m = meetings[k] || [];
        if (m.length + forcedAfter(k, r) >= scfg.maxMeetings) return false;
        if (m.length && r - m[m.length - 1] < scfg.rematchGap) return false;
        if ((forcedRounds[k] || []).some(R => R > r && R - r < scfg.rematchGap)) return false;
        // Meeting now and still owing one more needs room for the rematch.
        if (owes(i, j) > 1 && r + scfg.rematchGap > rounds - 1) return false;
        // A side with as many owed games as games left must play one now.
        if (owed[i] + booked[i] >= left(i) && !owes(i, j)) return false;
        if (owed[j] + booked[j] >= left(j) && !owes(i, j)) return false;
        return true;
      };

      // Most constrained side first; partners in a random order that leans
      // toward unmet opponents, harder the fewer rounds are left.
      let budget = 4000;
      // Sides on the bye sit this round out; staples are placed first.
      const used = teams.map((_, i) => !!(onBye[r] && onBye[r].has(i)));
      const pairs = [];
      for (const [i, j] of forcedAt[r]) {
        if (used[i] || used[j]) { failed = true; break; }
        used[i] = used[j] = true;
        pairs.push([i, j]);
      }
      if (failed) break;
      const solve = () => {
        if (--budget < 0) return false;
        let pick = -1, best = Infinity;
        for (let i = 0; i < n; i++) {
          if (used[i]) continue;
          let c = 0;
          for (let j = 0; j < n; j++) if (j !== i && !used[j] && allowed(i, j)) c++;
          if (c < best) { best = c; pick = i; }
        }
        if (pick < 0) return true;
        if (best === 0) return false;
        const cands = [];
        for (let j = 0; j < n; j++) {
          if (j === pick || used[j] || !allowed(pick, j)) continue;
          const lean = owes(pick, j) ? (owed[pick] + booked[pick]) / left(pick) : 0;
          cands.push({ j, key: rng() + lean * 1.5 });
        }
        cands.sort((a, b) => b.key - a.key);
        used[pick] = true;
        for (const { j } of cands) {
          used[j] = true;
          pairs.push([pick, j]);
          if (solve()) return true;
          pairs.pop();
          used[j] = false;
        }
        used[pick] = false;
        return false;
      };

      if (!solve()) { failed = true; break; }
      pairs.forEach(([i, j]) => {
        (meetings[pairKey(i, j)] = meetings[pairKey(i, j)] || []).push(r);
      });
      out.push(pairs.map(([i, j]) => [teams[i], teams[j]]));
    }
    if (failed) continue;
    let complete = true;
    for (let i = 0; i < n && complete; i++) {
      for (let j = i + 1; j < n; j++) {
        const k = pairKey(i, j);
        const m = (meetings[k] || []).length;
        if (m < need(k) || (twice.has(k) && m !== 2)) { complete = false; break; }
      }
    }
    if (complete) return out;
  }
  throw new Error('Could not draw a fixture under the rules');
}

// Config pairs whose sides are both in this universe (a test universe with
// made-up names simply has no staples).
function pairsPresent(teams, list) {
  return (list || []).filter(p => teams.includes(p[0]) && teams.includes(p[1]));
}

// This season's staple games, each pinned to a round: a window is drawn
// within. No side gets two staples in one round.
//   [{ a, b, r (0-based), slot }]
function resolveStaples(teams, rng, scfg) {
  const list = (scfg.staples || []).filter(st => teams.includes(st.teams[0]) && teams.includes(st.teams[1]));
  for (let attempt = 0; attempt < 100; attempt++) {
    const out = list.map(st => {
      const lo = st.rounds[0], hi = st.rounds[st.rounds.length - 1];
      const round = lo + Math.floor(rng() * (hi - lo + 1));
      return { a: st.teams[0], b: st.teams[1], r: Math.min(scfg.rounds, Math.max(1, round)) - 1, slot: st.slot || null };
    });
    const clash = out.some((f, i) => out.some((g, j) => j > i && f.r === g.r &&
      [f.a, f.b].some(t => t === g.a || t === g.b)));
    if (!clash) return out;
  }
  throw new Error('Staple games clash');
}

// Who has the bye each round. Every side gets the same number of byes: one
// round in each normal round, bigByeCount in each of byeRounds. Byes are
// dealt so nobody sits out two rounds running.
// A side with a staple game in a round can't have the bye that round.
function scheduleByes(teams, rounds, rng, scfg, fixed) {
  const busy = Array.from({ length: rounds }, () => new Set());
  (fixed || []).forEach(f => { busy[f.r].add(f.a); busy[f.r].add(f.b); });
  const out = Array.from({ length: rounds }, () => []);
  if (teams.length % 2 === 0) return out;
  const sizes = out.map((_, r) => scfg.byeRounds.includes(r) ? scfg.bigByeCount : 1);
  const total = sizes.reduce((a, b) => a + b, 0);
  const each = total / teams.length;
  for (let attempt = 0; attempt < 200; attempt++) {
    const left = {};
    teams.forEach(t => { left[t] = each; });
    const res = out.map(() => []);
    let ok = true;
    // Fill the big rounds first: they're the hardest to satisfy.
    const order = sizes.map((n, r) => r).sort((a, b) => sizes[b] - sizes[a] || a - b);
    for (const r of order) {
      const pool = teams.filter(t => left[t] > 0 && !busy[r].has(t) &&
        !(res[r - 1] || []).includes(t) && !(res[r + 1] || []).includes(t));
      if (pool.length < sizes[r]) { ok = false; break; }
      // Sides with the most byes still to take go first, ties at random.
      pool.sort((a, b) => left[b] - left[a] || rng() - 0.5);
      res[r] = pool.slice(0, sizes[r]);
      res[r].forEach(t => left[t]--);
    }
    if (ok && teams.every(t => left[t] === 0)) return res;
  }
  throw new Error('Could not schedule byes');
}

// Home ground, so every side gets exactly half its games at home.
//   - A pair that meets twice has one home game each: the first is a coin
//     toss, the rematch swaps it.
//   - Pairs that meet once form a graph where every side has the same, even
//     number of edges (10 for the AFL). Walking it in closed loops and making
//     each edge's home side the one the walk leaves from gives every side
//     exactly half of them at home — every visit to a side enters once and
//     leaves once.
function assignHomeAway(pairings, teams, rng) {
  const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const count = {};
  pairings.forEach(round => round.forEach(([a, b]) => {
    count[pairKey(a, b)] = (count[pairKey(a, b)] || 0) + 1;
  }));

  const homeOf = {};                       // single meetings: pairKey -> home side
  const adj = {};
  teams.forEach(t => { adj[t] = []; });
  Object.keys(count).forEach(k => {
    if (count[k] !== 1) return;
    const [a, b] = k.split('|');
    adj[a].push(b);
    adj[b].push(a);
  });
  const used = new Set();
  teams.forEach(start => {
    for (;;) {
      const open = adj[start].filter(o => !used.has(pairKey(start, o)));
      if (!open.length) break;
      // One closed walk from `start`, picking unused edges at random.
      let at = start;
      for (;;) {
        const next = adj[at].filter(o => !used.has(pairKey(at, o)));
        if (!next.length) break;
        const to = next[Math.floor(rng() * next.length)];
        used.add(pairKey(at, to));
        homeOf[pairKey(at, to)] = at;
        at = to;
      }
    }
  });

  const firstHome = {};
  return pairings.map(round => round.map(([a, b]) => {
    const k = pairKey(a, b);
    let home;
    if (count[k] === 1) home = homeOf[k];
    else if (firstHome[k]) home = firstHome[k] === a ? b : a;
    else home = firstHome[k] = rng() < 0.5 ? a : b;
    return { home, away: home === a ? b : a };
  }));
}

// Slots. Games between two top-8 sides (by the ranking the season started
// with) take the prime slots in order, best match-up first. Prime slots left
// over go to the best remaining games; everything else is drawn at random.
function assignSlots(round, ranking, rng, scfg) {
  const rank = {};
  ranking.forEach((t, i) => { rank[t] = i; });
  const top8 = g => rank[g.home] < 8 && rank[g.away] < 8;
  const quality = g => rank[g.home] + rank[g.away];

  const all = [];
  scfg.slots.forEach((daySlots, d) => daySlots.forEach((time, s) => all.push({ day: d, slot: s, time })));
  const isPrime = x => scfg.primeSlots.some(([d, s]) => d === x.day && s === x.slot);
  const prime = scfg.primeSlots.map(([d, s]) => all.find(x => x.day === d && x.slot === s));
  const rest = all.filter(x => !isPrime(x));

  const games = round.map(g => Object.assign({}, g));
  // Staples with a slot of their own go first: 'prime' takes the best prime
  // slot, 'last' the round's final game.
  const taken = [];
  games.forEach(g => {
    if (!g.fixedSlot) return;
    const x = g.fixedSlot === 'prime' ? prime[0] : all[all.length - 1];
    Object.assign(g, x, { prime: g.fixedSlot === 'prime' });
    taken.push(x);
    delete g.fixedSlot;
  });
  const open = games.filter(g => g.day == null);
  const primeFree = prime.filter(x => !taken.includes(x));

  const byQuality = open.slice().sort((a, b) => quality(a) - quality(b));
  const primeGames = byQuality.filter(top8).concat(byQuality.filter(g => !top8(g)))
    .slice(0, primeFree.length);
  primeGames.forEach((g, i) => Object.assign(g, primeFree[i], { prime: top8(g) }));

  const others = open.filter(g => !primeGames.includes(g));
  const pool = rest.filter(x => !taken.includes(x));
  others.forEach(g => {
    const k = Math.floor(rng() * pool.length);
    Object.assign(g, pool.splice(k, 1)[0], { prime: false });
  });
  // Fixture order within a round: by day, then time.
  return games.sort((a, b) => a.day - b.day || a.slot - b.slot);
}

// A whole season's plan: fixture, slots, kick-offs. Stored once it's made.
//   { n, day0, ranking, rounds: [[{ home, away, day, slot, time, prime, kickoff }]],
//     byes: [[team, ...] per round], finalsDay0, endDay, scores: {}, finals: {} }
function planSeason(opts) {
  const { sport, teams, n, day0, seed } = opts;
  const cfg = opts.config || UNIVERSE_CONFIG;
  const scfg = cfg[sport];
  const rng = LS.makeRng(LS.hashKey(seed + '|season' + n + '|fixture'));
  // Season 1 has no ladder to rank by yet, so its prime-time ranking comes
  // from the starting talent, or is drawn when everyone starts level.
  const shuffled = teams.slice().sort(() => rng() - 0.5);
  const overall = t => opts.seeds && opts.seeds[t] ? opts.seeds[t].att + opts.seeds[t].def : 0;
  const ranking = opts.ranking || shuffled.sort((a, b) => overall(b) - overall(a));

  const staples = resolveStaples(teams, rng, scfg);
  const byes = scheduleByes(teams, scfg.rounds, rng, scfg, staples);
  const pairings = generatePairings(teams, scfg.rounds, rng, scfg, byes, staples);
  const home = assignHomeAway(pairings, teams, rng);
  // Tag the staples so the slots can find them.
  staples.forEach(f => {
    const g = home[f.r].find(x => (x.home === f.a && x.away === f.b) || (x.home === f.b && x.away === f.a));
    g.staple = true;
    if (f.slot) g.fixedSlot = f.slot;
  });
  const test = !!opts.test;
  const gap = testGap(scfg);
  const rounds = home.map((round, r) =>
    assignSlots(round, ranking, rng, scfg).map(g => {
      const dayIdx = r * scfg.daysPerRound + g.day;
      // Test mode: the whole round bounces together.
      const kickoff = test ? day0 + r * gap : slotMs(day0 + dayIdx * DAY_MS, g.time);
      return Object.assign(g, { dayIdx, kickoff });
    }));

  const finalsDay0 = scfg.rounds * scfg.daysPerRound;
  const endDay = finalsDay0 + scfg.finals.length;            // first day after the grand final
  const season = {
    n, day0, ranking, rounds, byes, finalsDay0, endDay,
    nextDay0: test ? day0 + (scfg.rounds + scfg.finals.length) * gap + 5 * MIN_MS
      : day0 + (endDay + scfg.offSeasonDays) * DAY_MS,
    scores: {}, finals: {},
  };
  if (test) season.test = true;
  if (opts.seeds) season.seeds = opts.seeds;
  if (opts.clubs) season.clubs = opts.clubs;
  if (opts.consistency) season.consistency = opts.consistency;
  if (opts.offseason) season.offseason = opts.offseason;
  return season;
}

// ============================================================
// TALENT — clubs, their lists and their coaches, season to season
// ============================================================
// Each season stores every club's state:
//
//   season.clubs[team] = { base: {att, def}, stage, stageLeft, coach, carry }
//   season.seeds[team] = {att, def}      its TRUE strength for the season
//   season.offseason   = [event, ...]    what happened to get here
//
// `base` is the list: what the players are worth. The seed adds the coach and
// anything that only lasts a season (an injury, a new coach's honeymoon). The
// seed is what every game is simulated from, and it holds for the whole
// season — a lucky month doesn't make a club better (see simConfig: K is 0).
//
// Between seasons a club's list moves with its stage (a rebuild comes good,
// a peak list ages out), the bottom sides get draft help, coaches get sacked
// or re-signed, and a few moves — trades, free agents, retirements, injuries —
// are drawn from each club's situation. All of it comes from the universe's
// seed, so the same universe always tells the same story.
const STAGES = ['rebuilding', 'emerging', 'contending', 'peak', 'ageing'];
const STAGE_NAMES = { rebuilding: 'Rebuilding', emerging: 'Emerging', contending: 'Contending', peak: 'Peak', ageing: 'Ageing' };

function clampTalent(v) {
  const c = LS.SIM_CONFIG.common;
  return Math.max(c.RATING_FLOOR, Math.min(c.RATING_CEIL, v));
}
function roundTalent(v) { return Math.round(clampTalent(v) * 10) / 10; }
function round1(v) { return Math.round(v * 10) / 10; }
function between(rng, lo, hi) { return lo + rng() * (hi - lo); }
function pickOf(rng, list) { return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]; }
function talentCfg(cfg) { return (cfg || UNIVERSE_CONFIG).talent; }
function possessive(name) { return /s$/i.test(name) ? name + "'" : name + "'s"; }

// Consistency levels, most volatile first.
function consistencyLevels() { return Object.keys(LS.SIM_CONFIG.common.consistency); }
function drawConsistency(rng, tc) {
  const w = tc.consistencyWeights;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (const k of consistencyLevels()) { x -= w[k] || 0; if (x < 0) return k; }
  return LS.SIM_CONFIG.common.DEFAULT_CONSISTENCY;
}
function startingConsistency(teams, seed, cfg) {
  const tc = talentCfg(cfg);
  const rng = LS.makeRng(LS.hashKey(seed + '|consistency'));
  const out = {};
  teams.forEach(t => { out[t] = drawConsistency(rng, tc); });
  return out;
}
// The sim's per-side noise multipliers for a season. A season from before
// consistency existed has none, so everyone plays balanced.
function volatilityOf(season) {
  const table = LS.SIM_CONFIG.common.consistency;
  const out = {};
  Object.keys(season.consistency || {}).forEach(t => {
    const m = table[season.consistency[t]];
    if (m != null) out[t] = m;
  });
  return out;
}

// Season 1's strength for one of the built-in starts. 'level' puts everyone
// on the mean; 'random' spreads them out. (A real-world start comes from the
// predictor's own ratings, so the screen passes those in itself.)
function startingTalent(teams, preset, seed, cfg) {
  const tc = talentCfg(cfg);
  const mean = LS.SIM_CONFIG.common.MEAN;
  const rng = LS.makeRng(LS.hashKey(seed + '|start'));
  const out = {};
  teams.forEach(t => {
    if (preset === 'random') {
      // Mostly how good the list is, a little of how it's split.
      const base = LS.gaussian(rng, 0, tc.randomSpread * 0.85);
      out[t] = {
        att: roundTalent(mean + base + LS.gaussian(rng, 0, tc.randomSpread * 0.5)),
        def: roundTalent(mean + base + LS.gaussian(rng, 0, tc.randomSpread * 0.5)),
      };
    } else {
      out[t] = { att: mean, def: mean };
    }
  });
  return out;
}

// ---------- the real world ----------
// The 2026 final home-and-away ladders (Wikipedia, 2026 AFL season and 2026
// NRL season pages, read October 2026): games, points for, points against.
// realWorldTalent() turns them into a 'Real world' start.
const REAL_WORLD = {
  afl: {
    season: 2026, premiers: 'Brisbane Lions',
    ladder: [
      ['Fremantle', 23, 2286, 1666], ['Sydney', 23, 2543, 1869], ['Brisbane Lions', 23, 2499, 2054],
      ['Hawthorn', 23, 2260, 1881], ['Geelong Cats', 23, 2355, 1925], ['Adelaide', 23, 2169, 1849],
      ['Melbourne', 23, 2301, 2099], ['Western Bulldogs', 23, 1901, 1992], ['Collingwood', 23, 2021, 1974],
      ['Carlton', 23, 2007, 1978], ['St Kilda', 23, 2030, 1974], ['GWS Giants', 23, 2073, 2095],
      ['Gold Coast Suns', 23, 2011, 2128], ['North Melbourne', 23, 1932, 2175], ['Port Adelaide', 23, 1804, 2048],
      ['West Coast Eagles', 23, 1615, 2333], ['Richmond', 23, 1483, 2373], ['Essendon', 23, 1601, 2478],
    ],
  },
  nrl: {
    season: 2026, premiers: 'Roosters',
    ladder: [
      ['Panthers', 24, 683, 347], ['Warriors', 24, 728, 418], ['Dolphins', 24, 662, 506],
      ['Roosters', 24, 619, 501], ['Sharks', 24, 672, 523], ['Rabbitohs', 24, 694, 581],
      ['Knights', 24, 633, 591], ['Cowboys', 24, 568, 652], ['Sea Eagles', 24, 623, 524],
      ['Storm', 24, 594, 576], ['Raiders', 24, 581, 626], ['Bulldogs', 24, 476, 536],
      ['Eels', 24, 497, 678], ['Broncos', 24, 471, 677], ['Wests Tigers', 24, 445, 699],
      ['Titans', 24, 477, 663], ['Dragons', 24, 392, 717],
    ],
  },
};
// Attack from points scored a game, defence from points conceded, each
// against the league average and turned into rating points at the scoreboard
// rate Universe plays at (so a club rated this way would score and concede
// what it really did), then pulled part of the way back to the pack, as a
// new season does. Clubs missing from the table start on the mean.
//   -> { team: { att, def } } or null if there's no table for the sport
function realWorldTalent(sport, teams, cfg) {
  const rw = REAL_WORLD[sport];
  if (!rw) return null;
  const c = cfg || UNIVERSE_CONFIG;
  const W = (c[sport].sim && c[sport].sim.W) || LS.SIM_CONFIG[sport].W;
  const keep = talentCfg(c).realRegression;
  const mean = LS.SIM_CONFIG.common.MEAN;
  const rows = rw.ladder.map(([team, p, pf, pa]) => ({ team, f: pf / p, a: pa / p }));
  const avg = rows.reduce((x, r) => x + r.f, 0) / rows.length;
  const out = {};
  teams.forEach(t => {
    const r = rows.find(x => x.team === t);
    out[t] = r ? {
      att: roundTalent(mean + keep * (r.f - avg) / W),
      def: roundTalent(mean + keep * (avg - r.a) / W),
    } : { att: mean, def: mean };
  });
  return out;
}

// ---------- coaches ----------
const COACH_FIRST = ['Adam', 'Ben', 'Brett', 'Chris', 'Craig', 'Damien', 'Dean', 'Gary', 'Glenn', 'Grant',
  'Jason', 'Jeff', 'John', 'Justin', 'Kane', 'Leon', 'Luke', 'Mark', 'Matt', 'Michael', 'Nathan', 'Neil',
  'Paul', 'Peter', 'Rhys', 'Ross', 'Scott', 'Shane', 'Simon', 'Steve', 'Todd', 'Trent', 'Wayne'];
const COACH_LAST = ['Barker', 'Bourke', 'Calder', 'Carey', 'Dalton', 'Doyle', 'Ellis', 'Fenwick', 'Gale',
  'Hadley', 'Harding', 'Hogan', 'Keogh', 'Lander', 'Maddox', 'Marsh', 'McAlister', 'Nolan', 'Oakes',
  'Pearce', 'Quinlan', 'Rafferty', 'Rowe', 'Sheedy', 'Thorne', 'Toohey', 'Vance', 'Walsh', 'Whitford', 'Yates'];
// `taken` is the names already in jobs, so no two clubs share a coach.
function newCoach(rng, tc, taken) {
  let name;
  do { name = pickOf(rng, COACH_FIRST) + ' ' + pickOf(rng, COACH_LAST); } while (taken && taken.has(name));
  if (taken) taken.add(name);
  return {
    name,
    q: round1(Math.max(-3, Math.min(3, LS.gaussian(rng, 0, tc.coachSpread)))),
    years: 1, contract: 2 + Math.floor(rng() * 3), finishes: [],
  };
}
// A coach's word, from quality.
function coachGrade(q) {
  return q >= 1.6 ? 'Elite' : q >= 0.6 ? 'Good' : q > -0.6 ? 'Average' : q > -1.6 ? 'Poor' : 'Out of his depth';
}
// What the coach adds on top of the list this season.
function coachEffect(coach, tc) {
  return coach.q * tc.coachWeight + (coach.years === 1 ? tc.honeymoon : 0);
}

// ---------- season 1 ----------
// Stage from where a club sits: the best are at their peak or contending, the
// worst rebuilding or ageing, the middle either side of it. A stage the screen
// hands in (Edit clubs) wins.
function stageForRank(rng, p) {
  const opts = p < 0.2 ? ['peak', 'contending'] : p < 0.45 ? ['contending', 'emerging', 'peak']
    : p < 0.7 ? ['emerging', 'ageing', 'contending'] : ['rebuilding', 'ageing', 'emerging'];
  return pickOf(rng, opts);
}
function stageYears(rng, tc, stage) {
  const [lo, hi] = tc.stages[stage].years;
  return lo + Math.floor(rng() * (hi - lo + 1));
}
// Clubs for season 1, built so each club's seed is exactly the strength it
// was started on: the list is the seed less the coach.
//   given: { team: { stage } } from the start screen, optional
function startingClubs(teams, seeds, seed, cfg, given) {
  const tc = talentCfg(cfg);
  const rng = LS.makeRng(LS.hashKey(seed + '|clubs'));
  const order = teams.slice().sort((a, b) => (seeds[b].att + seeds[b].def) - (seeds[a].att + seeds[a].def));
  const clubs = {};
  const taken = new Set();
  order.forEach((t, i) => {
    const want = given && given[t] && given[t].stage;
    const stage = STAGES.indexOf(want) >= 0 ? want : stageForRank(rng, i / Math.max(1, teams.length - 1));
    const coach = newCoach(rng, tc, taken);
    // A coach already in the job: somewhere into his tenure, no honeymoon.
    coach.years = 2 + Math.floor(rng() * 4);
    coach.contract = 1 + Math.floor(rng() * 3);
    const ce = coachEffect(coach, tc);
    clubs[t] = {
      base: { att: round1(seeds[t].att - ce), def: round1(seeds[t].def - ce) },
      stage, stageLeft: stageYears(rng, tc, stage), coach, carry: { att: 0, def: 0 },
    };
  });
  return clubs;
}
// A season from before clubs existed: work them out from its seeds.
function clubsFromSeeds(universe, season) {
  const seeds = {};
  universe.teams.forEach(t => { seeds[t] = LS.normRating(season.seeds && season.seeds[t], LS.SIM_CONFIG.common); });
  return startingClubs(universe.teams, seeds, seasonKeyOf(universe, season.n), universe.config);
}

// ---------- the off-season ----------
// Words for the part of the ground a move touches.
const POSITIONS = {
  afl: { att: ['key forward', 'small forward', 'midfielder', 'ruckman'], def: ['key defender', 'half-back', 'tagger', 'inside midfielder'] },
  nrl: { att: ['halfback', 'five-eighth', 'fullback', 'centre'], def: ['prop', 'lock', 'back-rower', 'hooker'] },
};

// The next season's clubs, seeds, consistency and off-season story, from the
// season just finished.
function nextTalent(universe, prev) {
  const tc = talentCfg(universe.config);
  const mean = LS.SIM_CONFIG.common.MEAN;
  const rng = LS.makeRng(LS.hashKey(seasonKeyOf(universe, prev.n + 1) + '|talent'));
  const teams = universe.teams;
  const ladder = prev.finalLadder || ladderAt(universe, prev, Infinity).map(x => x.team);
  const pos = t => ladder.indexOf(t);            // 0 = minor premier
  const was = prev.clubs || clubsFromSeeds(universe, prev);
  const pp = POSITIONS[universe.sport] || POSITIONS.afl;
  const events = [];
  const clubs = {};
  const once = {};                               // this season only
  teams.forEach(t => {
    const c = was[t];
    clubs[t] = {
      base: { att: c.base.att, def: c.base.def }, stage: c.stage, stageLeft: c.stageLeft,
      coach: Object.assign({}, c.coach, { finishes: (c.coach.finishes || []).slice() }),
      carry: { att: 0, def: 0 },
    };
    once[t] = { att: 0, def: 0 };
  });
  const add = (obj, side, v) => { obj[side] += v; };
  const sideOf = () => (rng() < 0.5 ? 'att' : 'def');
  const word = side => pickOf(rng, pp[side]);

  teams.forEach(t => {
    const c = clubs[t], prior = was[t];
    // Last year's deferred moves land: picks mature, old recruits fade.
    add(c.base, 'att', prior.carry ? prior.carry.att : 0);
    add(c.base, 'def', prior.carry ? prior.carry.def : 0);
    // The list drifts back toward the pack a little, then moves with its stage.
    const st = tc.stages[c.stage];
    const shared = st.drift + LS.gaussian(rng, 0, tc.noise);
    ['att', 'def'].forEach(k => {
      c.base[k] = mean + tc.regression * (c.base[k] - mean) + shared + LS.gaussian(rng, 0, tc.own);
    });
  });

  // Draft help for the bottom of the ladder.
  ladder.slice(-tc.draft.length).reverse().forEach((t, i) => {
    const v = tc.draft[i];
    const split = between(rng, 0.3, 0.7);
    clubs[t].base.att += v * 2 * split;
    clubs[t].base.def += v * 2 * (1 - split);
    if (i === 0) events.push({ team: t, kind: 'draft', text: `${t} hold the number one draft pick` });
  });

  // Stages move on. A club whose list has clearly outgrown (or fallen below)
  // its stage jumps ahead rather than waiting it out.
  teams.forEach(t => {
    const c = clubs[t];
    const ov = (c.base.att + c.base.def) / 2;
    const from = c.stage;
    c.stageLeft--;
    if (c.stage === 'ageing' && ov < mean - tc.stageJump) c.stageLeft = 0;
    if ((c.stage === 'rebuilding' || c.stage === 'emerging') && ov > mean + tc.stageJump) c.stageLeft = 0;
    if (c.stageLeft <= 0) {
      let next = STAGES[(STAGES.indexOf(c.stage) + 1) % STAGES.length];
      // A rebuild that's come good fast skips straight to contending; a
      // contender that's fallen away goes back to the start.
      if (c.stage === 'rebuilding' && ov > mean + tc.stageJump) next = 'contending';
      if (c.stage === 'contending' && ov < mean - tc.stageJump) next = 'rebuilding';
      c.stage = next;
      c.stageLeft = stageYears(rng, tc, next);
    }
    if (c.stage !== from && (c.stage === 'peak' || c.stage === 'rebuilding')) {
      const say = { peak: `${t} enter their premiership window`, rebuilding: `${t} begin a rebuild` };
      events.push({ team: t, kind: 'stage', text: say[c.stage] });
    }
  });

  // Coaches: the season's finish goes on the record, then the board decides.
  const taken = new Set(teams.map(t => clubs[t].coach.name));
  teams.forEach(t => {
    const c = clubs[t];
    const co = c.coach;
    co.finishes = co.finishes.concat([pos(t)]).slice(-3);
    const bottom = p => p >= teams.length - 6;
    const poorRun = co.finishes.filter(bottom).length >= 2;
    let leaves = null;
    if (co.years >= 2 && (pos(t) >= teams.length - 3 || poorRun) && rng() < 0.75) leaves = 'sacked';
    else if (co.contract <= 1) {
      // Out of contract: a winner or a good coach is kept, most others go.
      const keep = pos(t) < teams.length / 2 || co.q > 0.5 ? 0.85 : 0.3;
      if (rng() > keep) leaves = 'not renewed';
    } else if (co.years >= 8 && rng() < 0.15) leaves = 'retires';
    if (leaves) {
      taken.delete(co.name);
      const fresh = newCoach(rng, tc, taken);
      const tenure = `${co.years} season${co.years === 1 ? '' : 's'}`;
      const text = leaves === 'sacked' ? `${t} sack ${co.name} after ${tenure}; ${fresh.name} takes over`
        : leaves === 'retires' ? `${co.name} retires after ${tenure} at ${t}; ${fresh.name} takes over`
        : `${t} let ${co.name} go after ${tenure}; ${fresh.name} takes over`;
      events.push({ team: t, kind: 'coach', text });
      c.coach = fresh;
    } else {
      co.years++;
      co.contract = co.contract <= 1 ? 2 + Math.floor(rng() * 2) : co.contract - 1;
    }
  });

  // Moves, drawn from each club's situation. At most two per club.
  const moves = {};
  teams.forEach(t => { moves[t] = 0; });
  const can = t => moves[t] < 2;
  const r = tc.moveRate;
  const sellers = () => teams.filter(t => can(t) && (clubs[t].stage === 'rebuilding' || clubs[t].stage === 'ageing'));
  teams.slice().sort(() => rng() - 0.5).forEach(t => {
    const c = clubs[t];
    if (!can(t)) return;
    const s = c.stage;
    // Contenders buy experience from clubs heading the other way: better now,
    // worse once he's past it. The seller gets picks that mature next year.
    if ((s === 'contending' || s === 'peak') && rng() < 0.45 * r) {
      const from = sellers().filter(x => x !== t);
      if (from.length) {
        const o = pickOf(rng, from), side = sideOf(), v = between(rng, 1.5, 3);
        add(c.base, side, v); add(c.carry, side, -v * 0.6);
        add(clubs[o].base, side, -v * 0.6); add(clubs[o].carry, side, v * 0.8);
        moves[t]++; moves[o]++;
        events.push({ team: t, other: o, kind: 'trade', side, v, text: `${t} trade for ${possessive(o)} experienced ${word(side)}; ${o} take picks` });
        return;
      }
    }
    if ((s === 'ageing' || s === 'peak') && rng() < (s === 'ageing' ? 0.5 : 0.2) * r) {
      const side = sideOf(), v = between(rng, 1.5, 3.5);
      add(c.base, side, -v); moves[t]++;
      events.push({ team: t, kind: 'retire', side, v: -v, text: `${t} lose a champion ${word(side)} to retirement` });
    }
    if (can(t) && (s === 'rebuilding' || s === 'emerging') && rng() < 0.3 * r) {
      const side = sideOf(), v = between(rng, 1, 2.5);
      add(c.base, side, v); moves[t]++;
      events.push({ team: t, kind: 'breakout', side, v, text: `A young ${word(side)} is ready to break out at ${t}` });
    }
    if (can(t) && s !== 'rebuilding' && rng() < 0.12 * r) {
      // Free agency: a player walks out of a club for one with a better shot.
      const from = teams.filter(x => x !== t && can(x) && pos(x) > pos(t));
      if (from.length) {
        const o = pickOf(rng, from), side = sideOf(), v = between(rng, 1, 2.5);
        add(c.base, side, v); add(clubs[o].base, side, -v * 0.8);
        moves[t]++; moves[o]++;
        events.push({ team: t, other: o, kind: 'free-agent', side, v, text: `${possessive(o)} ${word(side)} walks out to join ${t} as a free agent` });
      }
    }
    if (can(t) && rng() < 0.1 * r) {
      const side = sideOf(), v = between(rng, 1.5, 3);
      add(once[t], side, -v); moves[t]++;
      events.push({ team: t, kind: 'injury', side, v: -v, text: `${t} lose their star ${word(side)} to a knee injury for the season` });
    }
  });

  // The salary cap, in effect: the league as a whole stays centred on the
  // mean, so the cycle moves clubs against each other rather than lifting or
  // sinking everyone.
  ['att', 'def'].forEach(k => {
    const shift = mean - teams.reduce((a, t) => a + clubs[t].base[k], 0) / teams.length;
    teams.forEach(t => { clubs[t].base[k] += shift; });
  });

  // The seeds: list + coach + this season only.
  const seeds = {};
  teams.forEach(t => {
    const c = clubs[t];
    c.base = { att: round1(clampTalent(c.base.att)), def: round1(clampTalent(c.base.def)) };
    c.carry = { att: round1(c.carry.att), def: round1(c.carry.def) };
    const ce = coachEffect(c.coach, tc);
    seeds[t] = { att: roundTalent(c.base.att + ce + once[t].att), def: roundTalent(c.base.def + ce + once[t].def) };
  });

  // Consistency mostly holds; now and then a side steadies or loses its way.
  // Drawn from its own stream so it never disturbs anything above.
  const levels = consistencyLevels();
  const crng = LS.makeRng(LS.hashKey(seasonKeyOf(universe, prev.n + 1) + '|consistency'));
  const consistency = {};
  teams.forEach(t => {
    let i = levels.indexOf((prev.consistency && prev.consistency[t]) || LS.SIM_CONFIG.common.DEFAULT_CONSISTENCY);
    // A shift leans back toward the middle two times in three, so the
    // extremes stay rare instead of collecting the sides that wander there.
    if (crng() < tc.consistencyShift) {
      const mid = (levels.length - 1) / 2;
      const toMid = i < mid ? 1 : i > mid ? -1 : (crng() < 0.5 ? -1 : 1);
      i += crng() < (i === mid ? 1 : 2 / 3) ? toMid : -toMid;
    }
    consistency[t] = levels[Math.max(0, Math.min(levels.length - 1, i))];
  });

  // Coaching news first, then the big moves, then the rest.
  const order = { coach: 0, draft: 1, trade: 2, 'free-agent': 3, retire: 4, injury: 5, breakout: 6, stage: 7 };
  events.sort((a, b) => order[a.kind] - order[b.kind]);
  return { seeds, clubs, consistency, offseason: events };
}

// Form: every side's strength moved by its results, as the predictor would
// rate it. It never feeds back into the games — it's the "how they're going"
// line on the Teams tab. Only games over by nowMs count (a result is decided
// at the round's first kick-off, well before it's shown).
function seasonEndRatings(universe, season, nowMs) {
  const eng = asEngineSeason(universe, season);
  const rounds = eng.rounds.slice();
  const over = g => nowMs == null || g.kickoff + universe.config[universe.sport].maxGameMins * MIN_MS <= nowMs;
  const scores = {};
  season.rounds.forEach((round, r) => round.forEach((g, i) => {
    const k = LS.scoreKey(r, i);
    if (eng.scores[k] && over(g)) scores[k] = eng.scores[k];
  }));
  const finals = Object.values(season.finals || {}).filter(f => f.score && over(f));
  if (finals.length) {
    const r = rounds.length;
    rounds.push(finals.map(f => ({ home: f.home, away: f.away })));
    finals.forEach((f, i) => { scores[LS.scoreKey(r, i)] = f.score; });
  }
  return LS.computeRatings({
    teams: universe.teams, rounds, scores, seeds: season.seeds || {},
    config: formConfig(universe), sport: universe.sport,
  }).current;
}

// How far each side's results have strayed from what its strength said, game
// by game: the spread of (actual margin − expected margin). A small number is
// a side that does what it should week to week; a big one is all over the
// place. Only games over by nowMs count. { team: { games, swing } }
function consistencyStats(universe, season, nowMs) {
  const config = simConfig(universe);
  const common = config.common;
  const cfg = config[universe.sport];
  const eng = asEngineSeason(universe, season);
  const maxMs = universe.config[universe.sport].maxGameMins * MIN_MS;
  const rate = t => LS.normRating(season.seeds && season.seeds[t], common);
  const miss = {};
  universe.teams.forEach(t => { miss[t] = []; });
  season.rounds.forEach((round, r) => round.forEach((g, i) => {
    const sc = eng.scores[LS.scoreKey(r, i)];
    if (!sc || (nowMs != null && g.kickoff + maxMs > nowMs)) return;
    const H = rate(g.home), A = rate(g.away);
    const exp = LS.expectedScore(cfg, common, H, A, true) - LS.expectedScore(cfg, common, A, H, false);
    const d = (sc.home - sc.away) - exp;
    miss[g.home].push(d);
    miss[g.away].push(-d);
  }));
  const out = {};
  universe.teams.forEach(t => {
    const xs = miss[t];
    out[t] = { games: xs.length, swing: xs.length ? Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length) : null };
  });
  return out;
}

// Each club at a glance, for the Teams tab.
//   { team: { att, def, overall, form, formAtt, formDef, formOverall, startRank,
//             stage, stageName, coach, coachGrade, consistency, swing, games, events } }
// att/def/overall are its true strength this season; formAtt/formDef/
// formOverall are that strength moved by its results (the predictor's way of
// rating it), and form is how far above (+) or below (−) the strength that is.
// startRank is where its strength ranked it before Round 1.
function talentView(universe, season, nowMs) {
  const common = LS.SIM_CONFIG.common;
  const tc = talentCfg(universe.config);
  const now = seasonEndRatings(universe, season, nowMs);
  const stats = consistencyStats(universe, season, nowMs);
  const clubs = season.clubs || clubsFromSeeds(universe, season);
  const seedOf = t => LS.normRating(season.seeds && season.seeds[t], common);
  const startOrder = universe.teams.slice().sort((a, b) =>
    (seedOf(b).att + seedOf(b).def) - (seedOf(a).att + seedOf(a).def));
  const out = {};
  universe.teams.forEach(t => {
    const s = seedOf(t);
    const r = now[t] || s;
    const overall = (s.att + s.def) / 2;
    const c = clubs[t];
    out[t] = {
      att: s.att, def: s.def, overall, form: (r.att + r.def) / 2 - overall,
      formAtt: r.att, formDef: r.def, formOverall: (r.att + r.def) / 2,
      startRank: startOrder.indexOf(t) + 1,
      stage: c.stage, stageName: STAGE_NAMES[c.stage],
      coach: c.coach, coachGrade: coachGrade(c.coach.q), coachEffect: coachEffect(c.coach, tc),
      list: (c.base.att + c.base.def) / 2,
      consistency: (season.consistency && season.consistency[t]) || common.DEFAULT_CONSISTENCY,
      swing: stats[t].swing, games: stats[t].games,
      events: (season.offseason || []).filter(e => e.team === t || e.other === t),
    };
  });
  return out;
}

// ============================================================
// GAME CLOCK — where a game is at a given moment
// ============================================================
// The timeline's periods run back to back in real time with the breaks
// between them: an AFL game is four quarters of 28-35 minutes plus 2/5/2
// minutes of breaks, a little over two hours all up.
function realDurationMs(tl, scfg) {
  let ms = 0;
  tl.periods.forEach((p, i) => {
    ms += p.len * 1000;
    if (i < tl.periods.length - 1) ms += (scfg.breaks[i] || 0) * MIN_MS;
  });
  return ms;
}
// Upper bound on any game's length, for skipping timelines on games that
// are long finished: four 35-minute quarters plus the breaks.
function maxDurationMs(scfg) {
  return scfg.maxGameMins * MIN_MS;
}

//   { status: 'upcoming', startsInMs }
//   { status: 'live', t, period, clock }        clock = seconds into the period
//   { status: 'break', t, label }               label from breakLabels: 'QT', 'HT'...
//   { status: 'final', t: 1 }
function gameStatusAt(tl, kickoff, nowMs, scfg) {
  if (nowMs < kickoff) return { status: 'upcoming', startsInMs: kickoff - nowMs };
  let at = kickoff;
  const labels = scfg.breakLabels || [];
  for (let i = 0; i < tl.periods.length; i++) {
    const p = tl.periods[i];
    const end = at + p.len * 1000;
    if (nowMs < end) {
      const clock = Math.floor((nowMs - at) / 1000);
      return { status: 'live', period: p, clock, t: p.start + (clock / p.len) * (p.end - p.start) };
    }
    at = end;
    if (i < tl.periods.length - 1) {
      const brk = (scfg.breaks[i] || 0) * MIN_MS;
      if (brk && nowMs < at + brk) return { status: 'break', label: labels[i] || 'Break', t: p.end };
      at += brk;
    }
  }
  return { status: 'final', t: 1 };
}

// ============================================================
// RESULTS — decided at kick-off, revealed by the clock
// ============================================================
function seasonKeyOf(universe, n) { return universe.id + ':s' + n; }

// The engine config Universe games are simulated with: SIM_CONFIG with the
// sport's `sim` tweaks laid over it, and K at 0 — a club's strength is set
// for the season and results don't move it (they're dice rolls from it).
function simConfig(universe) {
  const base = formConfig(universe);
  return Object.assign({}, base, { common: Object.assign({}, base.common, { K: 0 }) });
}
// The same, with results moving ratings as in the predictor: the Teams tab's
// form line.
function formConfig(universe) {
  const over = universe.config[universe.sport].sim;
  if (!over) return LS.SIM_CONFIG;
  return Object.assign({}, LS.SIM_CONFIG, {
    [universe.sport]: Object.assign({}, LS.SIM_CONFIG[universe.sport], over),
  });
}

// The season in the shape sim.js expects: { teams, rounds, scores }.
function asEngineSeason(universe, season) {
  return {
    teams: universe.teams,
    rounds: season.rounds.map(r => r.map(g => ({ home: g.home, away: g.away }))),
    scores: season.scores,
  };
}

function timelineFor(universe, season, roundIdx, gameIdx) {
  const g = season.rounds[roundIdx][gameIdx];
  const s = season.scores[LS.scoreKey(roundIdx, gameIdx)];
  if (!s) return null;
  return LS.buildMatchTimeline({
    sport: universe.sport, seasonKey: seasonKeyOf(universe, season.n),
    roundIdx, gameIdx, game: g, score: s, config: LS.SIM_CONFIG,
  });
}
function finalTimeline(universe, season, id) {
  const f = season.finals[id];
  if (!f || !f.score) return null;
  // Finals sit after the last round in the score keyspace so their seeds
  // never collide with a home-and-away game's.
  const idx = universe.config[universe.sport].finals.flatMap(s => s.games.map(g => g[0])).indexOf(id);
  return LS.buildMatchTimeline({
    sport: universe.sport, seasonKey: seasonKeyOf(universe, season.n) + ':F',
    roundIdx: 900, gameIdx: idx, game: f, score: f.score, config: LS.SIM_CONFIG,
  });
}

// Simulate any home-and-away round that has reached its first kick-off and
// hasn't been decided yet. Returns true if anything was written.
function decideRounds(universe, season, nowMs) {
  let changed = false;
  for (let r = 0; r < season.rounds.length; r++) {
    const round = season.rounds[r];
    if (nowMs < round[0].kickoff) break;
    if (LS.hasScore(season.scores, r, 0)) continue;
    const eng = asEngineSeason(universe, season);
    const written = LS.simulateRound({
      sport: universe.sport, teams: eng.teams, rounds: eng.rounds, scores: eng.scores,
      seeds: season.seeds || {}, config: simConfig(universe), roundIdx: r, volatility: volatilityOf(season),
      rng: LS.makeRng(LS.hashKey(seasonKeyOf(universe, season.n) + '|round' + r)),
    });
    Object.assign(season.scores, written);
    changed = true;
  }
  return changed;
}

// ============================================================
// LADDER — as of a moment
// ============================================================
// Finished games always count. With { live: true }, games in progress count
// too, as they stand: the side in front holds the four points until the
// siren says otherwise, and those rows are flagged `live`.
function ladderAt(universe, season, nowMs, opts) {
  const live = !!(opts && opts.live);
  const scfg = universe.config[universe.sport];
  const pts = scfg.ladder;
  const rows = {};
  universe.teams.forEach(t => {
    rows[t] = { team: t, p: 0, w: 0, l: 0, d: 0, b: 0, f: 0, a: 0, pts: 0 };
  });
  const maxMs = maxDurationMs(scfg);
  season.rounds.forEach((round, r) => {
    let roundDone = true;
    round.forEach((g, i) => {
      let s = season.scores[LS.scoreKey(r, i)];
      if (!s || nowMs < g.kickoff) { roundDone = false; return; }
      let inPlay = false;
      if (nowMs < g.kickoff + maxMs) {
        const tl = timelineFor(universe, season, r, i);
        const st = gameStatusAt(tl, g.kickoff, nowMs, scfg);
        if (st.status !== 'final') {
          roundDone = false;
          if (!live) return;
          let at = null;
          for (const step of tl.steps) { if (step.t <= st.t) at = step; else break; }
          s = { home: at ? at.home : 0, away: at ? at.away : 0 };
          inPlay = true;
        }
      }
      const H = rows[g.home], A = rows[g.away];
      if (inPlay) { H.live = true; A.live = true; }
      H.p++; A.p++;
      H.f += s.home; H.a += s.away; A.f += s.away; A.a += s.home;
      if (s.home > s.away) { H.w++; A.l++; H.pts += pts.win; }
      else if (s.away > s.home) { A.w++; H.l++; A.pts += pts.win; }
      else { H.d++; A.d++; H.pts += pts.draw; A.pts += pts.draw; }
    });
    // The bye counts once the rest of the round has been played.
    if (roundDone) ((season.byes || [])[r] || []).forEach(t => { rows[t].b++; rows[t].pts += pts.bye; });
  });
  const tiebreak = pts.sortBy === 'diff' ? (x => x.f - x.a) : (x => x.pct);
  return Object.values(rows)
    .map(x => Object.assign(x, { pct: x.a ? (x.f / x.a) * 100 : (x.f ? Infinity : 0), diff: x.f - x.a }))
    .sort((a, b) => b.pts - a.pts || tiebreak(b) - tiebreak(a) || a.team.localeCompare(b.team));
}

// ============================================================
// FINALS — the top-8 system, after a wildcard round in the AFL
// ============================================================
// Who plays in each final, from the final home-and-away ladder and the
// results of earlier finals. Returns null for a final whose feeders haven't
// been decided yet.
function finalsMatchup(id, ladder, results, wildcard) {
  if (wildcard === undefined) wildcard = true;
  const pos = i => ladder[i - 1];
  const winner = f => results[f] && results[f].winner;
  const loser = f => results[f] && results[f].loser;
  // Wildcard winners rank by where they finished: the higher one is the 7th
  // seed and meets 6th; the lower one is the 8th seed and meets 5th.
  const wcSeeds = () => {
    const a = winner('WC1'), b = winner('WC2');
    if (!a || !b) return null;
    const rank = t => ladder.indexOf(t);
    return rank(a) < rank(b) ? [a, b] : [b, a];
  };
  const pair = (h, a) => (h && a ? { home: h, away: a } : null);
  switch (id) {
    case 'WC1': return pair(pos(7), pos(10));
    case 'WC2': return pair(pos(8), pos(9));
    case 'QF1': return pair(pos(1), pos(4));
    case 'QF2': return pair(pos(2), pos(3));
    // Without a wildcard round, 7th and 8th go straight in: 5v8, 6v7.
    case 'EF1': { if (!wildcard) return pair(pos(5), pos(8)); const s = wcSeeds(); return s && pair(pos(5), s[1]); }
    case 'EF2': { if (!wildcard) return pair(pos(6), pos(7)); const s = wcSeeds(); return s && pair(pos(6), s[0]); }
    case 'SF1': return pair(loser('QF1'), winner('EF1'));
    case 'SF2': return pair(loser('QF2'), winner('EF2'));
    case 'PF1': return pair(winner('QF1'), winner('SF2'));
    case 'PF2': return pair(winner('QF2'), winner('SF1'));
    case 'GF': {
      // The higher-ranked preliminary final winner is the home side.
      const a = winner('PF1'), b = winner('PF2');
      if (!a || !b) return null;
      return ladder.indexOf(a) < ladder.indexOf(b) ? pair(a, b) : pair(b, a);
    }
    default: return null;
  }
}

// Decide each finals day once its first game kicks off. A final can't be
// drawn: a level result is replayed with a fresh roll — extra time in all but
// name, until the timeline grows an extra-time period of its own.
function decideFinals(universe, season, nowMs) {
  const scfg = universe.config[universe.sport];
  if (!season.rounds.every((round, r) => round.every((_, i) => LS.hasScore(season.scores, r, i)))) return false;
  let changed = false;

  // The ladder the finals are drawn from: every home-and-away game counted.
  const ladder = ladderAt(universe, season, Infinity).map(x => x.team);
  if (!season.finalLadder) { season.finalLadder = ladder; changed = true; }
  const ratings = LS.computeRatings({
    teams: universe.teams, rounds: asEngineSeason(universe, season).rounds,
    scores: season.scores, seeds: season.seeds || {}, config: simConfig(universe), sport: universe.sport,
  }).current;

  scfg.finals.forEach((stage, si) => {
    stage.games.forEach(([id, time]) => {
      if (season.finals[id] && season.finals[id].score) return;
      const kickoff = finalKickoff(universe, season, si, time);
      if (nowMs < kickoff && nowMs < finalKickoff(universe, season, si, stage.games[0][1])) return;
      const results = {};
      Object.keys(season.finals).forEach(k => {
        const f = season.finals[k];
        if (f.score) results[k] = f.score.home > f.score.away
          ? { winner: f.home, loser: f.away } : { winner: f.away, loser: f.home };
      });
      const m = finalsMatchup(id, season.finalLadder, results, scfg.wildcard);
      if (!m) return;
      let res, salt = 0;
      do {
        res = LS.simulateGame({
          home: m.home, away: m.away, ratings, volatility: volatilityOf(season), config: simConfig(universe),
          sport: universe.sport,
          rng: LS.makeRng(LS.hashKey(seasonKeyOf(universe, season.n) + '|' + id + '|' + salt++)),
        });
      } while (res.home === res.away && salt < 50);
      if (res.home === res.away) res.home++;
      season.finals[id] = {
        home: m.home, away: m.away, stage: stage.stage, kickoff,
        venue: id === 'GF' ? scfg.grandFinalVenue : null,
        score: { home: res.home, away: res.away },
      };
      changed = true;
    });
  });
  return changed;
}

// ============================================================
// THE UNIVERSE — create, then catch up to now
// ============================================================
//   { v, id, sport, seed, teams, createdAt, seasons: [season] }
function createUniverse(opts) {
  const cfg = opts.config || UNIVERSE_CONFIG;
  const seed = opts.seed != null ? String(opts.seed) : String(Math.floor(Math.random() * 1e9));
  const universe = {
    v: 1, id: 'u' + LS.hashKey(seed).toString(36), sport: opts.sport, seed,
    teams: opts.teams.slice(), createdAt: opts.nowMs, seasons: [],
    start: opts.start || 'level',
  };
  // Test mode: whole rounds at once, back to back (see testGap).
  if (opts.test) universe.test = true;
  Object.defineProperty(universe, 'config', { value: cfg, enumerable: false, writable: true });
  // Season 1's talent: seeds handed in (a real-world or hand-edited start),
  // else one of the built-in starts.
  const seeds = {};
  const given = opts.seeds || startingTalent(universe.teams, universe.start, seed, cfg);
  universe.teams.forEach(t => {
    const r = LS.normRating(given[t], LS.SIM_CONFIG.common);
    seeds[t] = { att: roundTalent(r.att), def: roundTalent(r.def) };
  });
  const drawn = startingConsistency(universe.teams, seed, cfg);
  const consistency = {};
  universe.teams.forEach(t => {
    const c = opts.consistency && opts.consistency[t];
    consistency[t] = consistencyLevels().indexOf(c) >= 0 ? c : drawn[t];
  });
  const clubs = startingClubs(universe.teams, seeds, seed, cfg, opts.clubs);
  universe.seasons.push(planSeason({
    sport: opts.sport, teams: universe.teams, n: 1, seed, seeds, consistency, clubs,
    day0: opts.test ? opts.nowMs + MIN_MS
      : opts.startNow ? brisbaneMidnight(opts.nowMs, cfg) : firstDay0(opts.nowMs, cfg[opts.sport], cfg),
    config: cfg, test: !!opts.test,
  }));
  if (opts.startNow && !opts.test) delayMissedKickoffs(universe.seasons[0], opts.nowMs);
  return universe;
}

// "Start now": the season is on the real calendar from today, and any of
// today's games whose kick-off has already gone are played late instead: the
// first a minute from now, the rest after it with the same gaps between them.
// Today's games still to come keep their times, and from tomorrow it's all on
// schedule.
function delayMissedKickoffs(season, nowMs) {
  const missed = season.rounds[0].filter(g => g.kickoff < nowMs + MIN_MS);
  if (!missed.length) return;
  const base = Math.min(...missed.map(g => g.kickoff));
  missed.forEach(g => {
    g.kickoff = nowMs + MIN_MS + (g.kickoff - base);
    g.delayed = true;
  });
}

// A stored universe comes back as plain JSON; give it its config again.
function attach(universe, cfg) {
  Object.defineProperty(universe, 'config', { value: cfg || UNIVERSE_CONFIG, enumerable: false, writable: true });
  return universe;
}

// Bring the universe up to nowMs: decide rounds and finals that have kicked
// off, and start the next season once the off-season is over. Returns true
// if anything changed (so the caller knows to save).
// opts.delayFrom: the next season starts today, with any of today's games
// already gone played late from then (see delayMissedKickoffs).
function advance(universe, nowMs, opts) {
  let changed = false;
  for (;;) {
    const season = universe.seasons[universe.seasons.length - 1];
    if (decideRounds(universe, season, nowMs)) changed = true;
    if (decideFinals(universe, season, nowMs)) changed = true;
    if (nowMs < season.nextDay0 || !season.finals.GF) break;
    // Next season: prime time goes to last season's top eight, and every
    // side's talent moves on from where it finished.
    const talent = nextTalent(universe, season);
    universe.seasons.push(planSeason({
      sport: universe.sport, teams: universe.teams, n: season.n + 1, seed: universe.seed,
      day0: season.nextDay0, ranking: season.finalLadder, config: universe.config,
      seeds: talent.seeds, clubs: talent.clubs, consistency: talent.consistency, offseason: talent.offseason,
      test: !!universe.test,
    }));
    if (opts && opts.delayFrom != null) delayMissedKickoffs(universe.seasons[universe.seasons.length - 1], opts.delayFrom);
    changed = true;
  }
  return changed;
}

// The grand final's siren has gone (on the clock, not just decided).
function seasonOver(universe, season, nowMs) {
  const gf = season.finals && season.finals.GF;
  if (!gf || !gf.score) return false;
  const tl = finalTimeline(universe, season, 'GF');
  return gameStatusAt(tl, gf.kickoff, nowMs, universe.config[universe.sport]).status === 'final';
}

// Skip the rest of the off-season: the next season starts today, the same way
// "Start now" does (today's games already gone are played late, from a minute
// from now). Only once the grand final is over. Returns true if it started one.
function startNextSeason(universe, nowMs) {
  const season = universe.seasons[universe.seasons.length - 1];
  if (!seasonOver(universe, season, nowMs) || nowMs >= season.nextDay0) return false;
  if (universe.test) {
    season.nextDay0 = Math.min(season.nextDay0, nowMs + MIN_MS);
    advance(universe, nowMs);
  } else {
    season.nextDay0 = Math.min(season.nextDay0, brisbaneMidnight(nowMs, universe.config));
    advance(universe, nowMs, { delayFrom: nowMs });
  }
  return universe.seasons[universe.seasons.length - 1] !== season;
}

// Round by round through a season so far: each club's form rating, its rank
// on that rating, and its ladder place, after every round whose games have
// all finished by nowMs. Point 0 is before Round 1 (its strength, and the
// rankings it started on).
//   { rounds, teams: { team: [{ round, att, def, overall, rank, ladder }] } }
function seasonTrack(universe, season, nowMs) {
  const common = LS.SIM_CONFIG.common;
  const maxMs = universe.config[universe.sport].maxGameMins * MIN_MS;
  const roundOver = round => round.every(g => g.kickoff + maxMs <= nowMs);
  let done = 0;
  while (done < season.rounds.length && roundOver(season.rounds[done])) done++;
  const eng = asEngineSeason(universe, season);
  const hist = LS.computeRatings({
    teams: universe.teams, rounds: eng.rounds, scores: eng.scores, seeds: season.seeds || {},
    config: formConfig(universe), sport: universe.sport, upToRound: done,
  }).history;
  const out = {};
  universe.teams.forEach(t => { out[t] = []; });
  const push = (round, ratings, ladder) => {
    const ov = t => { const r = LS.normRating(ratings[t], common); return (r.att + r.def) / 2; };
    const order = universe.teams.slice().sort((a, b) => ov(b) - ov(a));
    universe.teams.forEach(t => {
      const r = LS.normRating(ratings[t], common);
      out[t].push({ round, att: r.att, def: r.def, overall: (r.att + r.def) / 2,
        rank: order.indexOf(t) + 1, ladder: ladder ? ladder.indexOf(t) + 1 : null });
    });
  };
  push(0, season.seeds || {}, null);
  for (let r = 0; r < done; r++) {
    const end = Math.max(...season.rounds[r].map(g => g.kickoff)) + maxMs;
    push(r + 1, hist[r].ratings, ladderAt(universe, season, end).map(x => x.team));
  }
  return { rounds: done, teams: out };
}

// A hand edit to a club, mid-season: its strength (attack/defence), stage or
// consistency. Strength and consistency change this season's seeds, so they
// apply from the next round that hasn't been decided (games already played
// stay as they were); the list moves with them, so the change carries into
// next season too. A new stage starts fresh in it.
function editClub(universe, season, team, patch) {
  const common = LS.SIM_CONFIG.common;
  if (!season.clubs) season.clubs = clubsFromSeeds(universe, season);
  const club = season.clubs[team];
  if (!club) return false;
  const seed = LS.normRating(season.seeds && season.seeds[team], common);
  if (!season.seeds) season.seeds = {};
  const next = { att: seed.att, def: seed.def };
  ['att', 'def'].forEach(k => {
    if (patch[k] == null || !Number.isFinite(Number(patch[k]))) return;
    next[k] = roundTalent(Number(patch[k]));
    club.base[k] = round1(clampTalent(club.base[k] + (next[k] - seed[k])));
  });
  season.seeds[team] = next;
  if (patch.stage && STAGES.indexOf(patch.stage) >= 0 && patch.stage !== club.stage) {
    club.stage = patch.stage;
    const rng = LS.makeRng(LS.hashKey(seasonKeyOf(universe, season.n) + '|edit|' + team + '|' + patch.stage));
    club.stageLeft = stageYears(rng, talentCfg(universe.config), patch.stage);
  }
  if (patch.consistency && consistencyLevels().indexOf(patch.consistency) >= 0) {
    season.consistency = Object.assign({}, season.consistency, { [team]: patch.consistency });
  }
  return true;
}

// ============================================================
// VIEWS — everything the screen needs about a moment
// ============================================================
// The round to show: the one being played now, else the next one coming up,
// else (in finals) the last one.
function currentRoundIdx(universe, season, nowMs) {
  for (let r = 0; r < season.rounds.length; r++) {
    if (nowMs < roundEnd(universe, season, r)) return r;
  }
  return season.rounds.length - 1;
}

// Every game in a round with its timeline and status at nowMs.
function roundView(universe, season, roundIdx, nowMs) {
  const scfg = universe.config[universe.sport];
  return season.rounds[roundIdx].map((g, i) => {
    const tl = timelineFor(universe, season, roundIdx, i);
    const st = tl ? gameStatusAt(tl, g.kickoff, nowMs, scfg)
      : { status: 'upcoming', startsInMs: Math.max(0, g.kickoff - nowMs) };
    return Object.assign({ gameIdx: i, tl }, g, st);
  });
}

return {
  UNIVERSE_CONFIG, DAY_MS,
  roundStart, roundEnd, finalsStageStart, finalKickoff, seasonFirstKickoff,
  brisbaneMidnight, slotMs, firstDay0,
  generatePairings, assignHomeAway, assignSlots, planSeason,
  realDurationMs, gameStatusAt,
  seasonKeyOf, timelineFor, finalTimeline, decideRounds, decideFinals, finalsMatchup,
  ladderAt, createUniverse, attach, advance, seasonOver, startNextSeason, currentRoundIdx, roundView,
  startingTalent, startingConsistency, consistencyLevels, volatilityOf,
  STAGES, STAGE_NAMES, startingClubs, coachGrade, simConfig, formConfig, REAL_WORLD, realWorldTalent,
  seasonEndRatings, nextTalent, consistencyStats, talentView, seasonTrack, editClub,
};
}));
