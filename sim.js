// ============================================================
// SEASON SIMULATION ENGINE (NRL + AFL)
// ============================================================
// Pure logic, no DOM. Loaded as `window.LadderSim` in the browser and
// `require('./sim.js')` in node (so the harness exercises the shipping code).
//
// THE MODEL, in one paragraph. Every simulated game is decided by two
// independent axes plus one variance dial. STRENGTH (one Elo-style rating per
// team) gives the MARGIN: the rating gap between the sides, scaled into points.
// TEMPO (a team's average game total, points-for plus points-against) gives the
// TOTAL, independent of who wins — so a shootout and an arm-wrestle can have the
// same winner. VARIANCE is gaussian noise added to the expected margin; an upset
// is simply noise flipping the sign, never a special case. From those:
//   winner = (total + |margin|) / 2, loser = (total - |margin|) / 2.
//
// Ratings are NEVER stored. They are recomputed from scratch by replaying the
// season in order, exactly the way calculateLadder() replays `scores` — so the
// only persisted state is seeds + scores, and editing an early result cascades
// into every later round on the next re-sim.
//
// IMPORTANT — 0-0 MEANS "NOT PLAYED". calculateLadder()/calculateAFLLadder() in
// index.html both skip a game whose two scores are zero, and NRL only awards bye
// points once every game in the round is non-zero. So readScore() treats 0-0 as
// absent, and the sim never emits it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LadderSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

// ============================================================
// SIM_CONFIG — every tunable lives here, nothing is buried in logic
// ============================================================
const SIM_CONFIG = {
  common: {
    MEAN: 1500,
    REGRESSION: 0.72,          // between-season mean reversion
    K: 24,                     // rating update speed
    // Ordered worst to best: a full teardown, a side sliding off its peak,
    // steady, in the window, and a sustained peak.
    phaseOffset: { rebuild: -70, dropping: -35, stable: 0, contender: 45, dynasty: 90 },
    // Applied on top of the flat offset, scaled by how far ABOVE average the
    // team already sits. A flat offset let strong sides shrug off a full
    // rebuild — a 2nd-placed team dropped only to mid-table while the same
    // input gutted a mid-table one. A rebuild should cost a contender more,
    // because it has further to fall. Zero for a team already at or below the
    // mean, so weak teams are untouched.
    // Dropping gets half a rebuild's slope: a fading contender still has further
    // to fall than a mid-table side, just not as far as one being gutted.
    phaseSlope: { rebuild: -0.35, dropping: -0.18, stable: 0, contender: 0, dynasty: 0 },
    DEFAULT_PHASE: 'stable',   // team with no seedInputs set

    // Per-team game-to-game volatility, multiplied into MARGIN_SIGMA for the
    // games that team plays. Symmetric on purpose: a volatile side drops games
    // it should win AND steals ones it had no business winning. A one-directional
    // version would just be a strength penalty, which recruitment already does.
    // Note this never touches the seed — a volatile team isn't weaker, only
    // less predictable.
    consistency: {
      volatile: 1.45,
      streaky: 1.20,
      balanced: 1.00,
      steady: 0.85,
      ruthless: 0.72,
    },
    DEFAULT_CONSISTENCY: 'balanced',

    // Trajectory nudge: teams trending up/down over 2-3 prior seasons get a
    // small, capped bump. Set trajectoryCap to 0 to switch it off entirely.
    trajectoryCap: 25,
    TRAJECTORY_GAIN: 0.35,     // fraction of the year-on-year rating trend applied
    TRAJECTORY_RECENT_WEIGHT: 0.6, // last year's step vs the year before, when 3 seasons exist

    // Pre-2012 seasons have finish positions (HISTORICAL_LADDERS) but no scores,
    // so a ladder position is converted straight into a starting rating:
    // 1st = MEAN + POSITION_SPREAD, last = MEAN - POSITION_SPREAD. Overridden
    // per sport below — the NRL is a tighter competition than the AFL.
    POSITION_SPREAD: 150,

    SEED_LOOKBACK: 20,         // max seasons to chain back through (guard, not a design limit)

    // Margin-of-victory multiplier on the Elo update — off by default; the
    // simple version ships. Flip MOV_ENABLED to true to blow it up.
    MOV_ENABLED: false,

    // A game is level when the simulated margin lands inside this band. Without
    // it, integer rounding (and NRL's round-to-even) collapses a lot of
    // one-point games into draws — 5% of the round rather than the ~1% real
    // footy gives you. Overridden per sport below: the NRL sends level games to
    // golden point, the AFL just draws them. Raise it if you want more draws.
    DRAW_BAND: 0.25,

    // describeTrajectory() label thresholds, relative to MEAN
    labels: { dynasty: 120, contender: 55, rebuild: -80, trend: 25 },
  },
  afl: {
    MARGIN_SCALE: 0.20,        // rating points -> margin points
    MARGIN_SIGMA: 32,          // upset dial (bigger = more upsets)
    // Ceiling on the EXPECTED margin. MARGIN_SCALE is linear, so once seeds are
    // pushed apart by hand (phase + a 200-point recruitment slider can open a
    // 700-point gap, against a natural ladder spread of only 300) it predicted
    // absurd results — a 618-point gap asked for a 124-point win before a
    // single dice roll. Real footy doesn't scale that way: past a point the
    // better side just wins comfortably rather than proportionally. tanh keeps
    // ordinary gaps almost exactly as they were and bends only the extremes.
    MARGIN_CAP: 50,
    // Compresses the FINAL margin, after noise. MARGIN_CAP only bounds the
    // expectation — a 60-point expectation plus 1.3 sigma still cleared 100, so
    // blowouts stayed far too common. Margins below MARGIN_KNEE are untouched;
    // above it the excess is squeezed so results saturate toward MARGIN_MAX.
    // Real AFL has ~4-6 hundred-point wins a season and almost never exceeds
    // 150, which is what these two numbers encode.
    MARGIN_KNEE: 50, MARGIN_MAX: 115,
    POSITION_SPREAD: 150,      // overrides common.POSITION_SPREAD
    DRAW_BAND: 0.35,           // no golden point in the AFL — a level game just draws
    HGA: 30,                   // home rating bump
    TEMPO_PRIOR: 170,          // league-mean game total (both teams combined)
    TEMPO_PRIOR_WEIGHT: 6,     // games of "prior" a team is credited with before its own results outweigh it
    TOTAL_SIGMA: 17,
    TOTAL_FLOOR: 55, TOTAL_CEIL: 330,
    BLOWOUT_MARGIN: 70, BLOWOUT_LIFT: 0.35,  // margin past which the total starts inflating
    // Per-team range. The floor caps how lopsided a game can get; the ceiling is
    // the top of the "incredibly rare" band.
    SCORE_FLOOR: 20, SCORE_CEIL: 220,
    MOV_SCALE: 36,             // only read when common.MOV_ENABLED
    // Expansion sides enter far weaker than an ordinary wooden spooner, and a
    // debut ladder position understates that: positionToRating() bottoms out at
    // MEAN - POSITION_SPREAD (1350), which is what an established last-placed
    // club is worth, not a first-year one. These take priority over the
    // position mapping so Gold Coast's real 17th in 2011 still shows on the
    // preview without dragging its rating up to 1350.
    //
    // Only consulted when there is no prior simulated season to inherit from,
    // so it is a one-time entry rating — once you've played 2012, 2013 seeds
    // come from replaying it like any other club.
    expansionBase: { 'Gold Coast Suns': 1200, 'GWS Giants': 1200 },
  },
  nrl: {
    MARGIN_SCALE: 0.055,
    MARGIN_SIGMA: 13,
    MARGIN_CAP: 24,            // see afl.MARGIN_CAP
    MARGIN_KNEE: 26, MARGIN_MAX: 56,   // see afl.MARGIN_KNEE

    POSITION_SPREAD: 120,      // tighter comp than the AFL
    HGA: 40,
    TEMPO_PRIOR: 38,
    TEMPO_PRIOR_WEIGHT: 6,
    TOTAL_SIGMA: 12,
    TOTAL_FLOOR: 6, TOTAL_CEIL: 110,
    BLOWOUT_MARGIN: 16, BLOWOUT_LIFT: 0.60,  // margin past which the total starts inflating
    // Nil is a real NRL scoreline, so no floor here; the ceiling is the top of
    // the "almost impossible" band.
    SCORE_FLOOR: 0, SCORE_CEIL: 84,
    // Level at full time goes to golden point, and golden point is nearly always
    // settled by a field goal — which is why the NRL has far more 1-point
    // margins than draws. A wider band than the AFL's, because most of what
    // lands in it comes back out as a 1-point result rather than a draw.
    DRAW_BAND: 0.8,

    // Tries (4), conversions (2) and penalty goals (2) are all even, so a field
    // goal is the ONLY thing that makes an NRL score odd — and they get kicked
    // where the game is tight, not at random. See nrlFieldGoals().
    fieldGoal: {
      goldenPoint: 0.85,    // chance a level game is settled by a golden-point FG
      closeMargin: 12,      // "close" = a converted try or two; anything more is a blowout
      winnerClose: 0.095,   // the winning side kicks one to break a tight game open
      winnerBlowout: 0.026, // the cheeky one with the game already won: 31-10
      loserClose: 0.010,    // kicked to level or lead, then beaten by a late try: 19-24
      loserBlowout: 0.0025, // rarest of all
    },
    MOV_SCALE: 12,
  },
  // Round headlines — see buildHeadlines(). A game only gets a headline if it
  // clears one of these bars, so an unremarkable round prints nothing at all.
  headlines: {
    maxPerRound: 6,
    minRoundForSeasonHigh: 3,   // "highest score of the season" needs a season first
    // A run is only news when it first becomes notable and then at milestones.
    // Reporting it every round while it continues gave one slumping side seven
    // headlines in a row and buried everything else.
    streakMilestone: 5,
    nrl: {
      upsetGap: 130,     // pre-game rating gap the underdog had to overcome
      comeback: 14,      // points a side trailed by and still won
      thrashing: 34,     // winning margin
      thriller: 2,       // a win this tight is news on its own, upset or not
      lowScore: 4,       // holding a side to this is a defensive story
      narrowUpset: 6,    // a converted try; an upset this close is a different story to a rout
      streak: 5,         // consecutive wins or losses
      shutout: true,     // nil is a real NRL scoreline; the AFL floor is 20
      bigScore: 46,
    },
    afl: {
      upsetGap: 150,
      comeback: 36,      // six goals
      thrashing: 85,
      thriller: 6,       // under a goal
      lowScore: 35,      // the AFL has no nil, but 35 is a shutout in spirit
      narrowUpset: 15,   // under three goals; an upset this close is a different story to a rout
      streak: 5,
      shutout: false,
      bigScore: 150,
    },
  },
  // Play-by-play reconstruction — see buildProgression().
  progression: {
    conversionRate: 0.78,                    // NRL: share of tries converted
    penaltyGoals: [0.55, 0.30, 0.12, 0.03],  // NRL: weights for 0/1/2/3 penalty goals
    fullTime: { nrl: 80, afl: 120 },         // minutes, used only to order plays
    lateWindow: 0.70,                        // field goals land in the last 30% of the game
    goldenPointWindow: 10,                   // extra-time minutes for a golden-point kick
  },
  // Goals/behinds split for the AFL display layer. Bands are cumulative
  // probability thresholds; these are the values already shipping in
  // generateGoalsBehinds() in index.html.
  goalsBehinds: {
    bands: [
      { upTo: 0.18, min: 0.25, max: 0.55 }, // accurate day
      { upTo: 0.85, min: 0.55, max: 1.05 }, // typical
      { upTo: 1.00, min: 1.05, max: 1.70 }, // wayward in front of goal
    ],
    sanityRatio: 2.5,          // walk goals up while behinds exceed goals * this
  },
};

// ============================================================
// RNG — injectable and seeded, so a sim is reproducible and a
// re-roll is just "same inputs, fresh seed".
// ============================================================
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng, mean, sd) {
  // Box-Muller. u1 is nudged off zero so log() stays finite.
  const u1 = 1 - rng();
  const u2 = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// FNV-1a. Turns a descriptive key into an rng seed, so anything derived from a
// score (the goals/behinds split, the play-by-play, a headline) is stable for
// that score instead of re-rolling on every render.
function hashKey(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function sportCfg(config, sport) { return sport === 'afl' ? config.afl : config.nrl; }

// ============================================================
// SCORE ACCESS — the app's flat "R{n}G{i}" keying
// ============================================================
function scoreKey(roundIdx, gameIdx) { return 'R' + (roundIdx + 1) + 'G' + gameIdx; }

// Returns {home, away} or null. 0-0 reads as null: that is what the ladder does.
function readScore(scores, roundIdx, gameIdx) {
  const s = scores && scores[scoreKey(roundIdx, gameIdx)];
  if (!s) return null;
  const h = parseInt(s.home, 10) || 0;
  const a = parseInt(s.away, 10) || 0;
  if (h === 0 && a === 0) return null;
  return { home: h, away: a };
}

function hasScore(scores, roundIdx, gameIdx) {
  return readScore(scores, roundIdx, gameIdx) !== null;
}

// ============================================================
// RATINGS BY REPLAY
// ============================================================
// computeRatings({teams, rounds, scores, seeds, config, sport, upToRound})
//   -> { current: {team: rating}, history: [{roundIdx, ratings}] }
// upToRound is exclusive: pass the round being simulated so it sees only the
// rounds before it. Omit it to replay the whole season.
function computeRatings(opts) {
  const { teams, rounds, scores, seeds, config, sport } = opts;
  const cfg = sportCfg(config, sport);
  const common = config.common;
  const limit = opts.upToRound == null ? rounds.length : Math.min(opts.upToRound, rounds.length);

  const ratings = {};
  teams.forEach(t => { ratings[t] = seeds && seeds[t] != null ? seeds[t] : common.MEAN; });

  const history = [];
  for (let r = 0; r < limit; r++) {
    const round = rounds[r] || [];
    for (let g = 0; g < round.length; g++) {
      const game = round[g];
      const s = readScore(scores, r, g);
      if (!s) continue;
      if (ratings[game.home] == null || ratings[game.away] == null) continue;
      applyElo(ratings, game.home, game.away, s.home, s.away, cfg, common);
    }
    history.push({ roundIdx: r, ratings: Object.assign({}, ratings) });
  }
  return { current: ratings, history };
}

function applyElo(ratings, home, away, hs, as, cfg, common) {
  const expHome = 1 / (1 + Math.pow(10, -((ratings[home] + cfg.HGA) - ratings[away]) / 400));
  const resultHome = hs > as ? 1 : hs === as ? 0.5 : 0;
  let k = common.K;
  if (common.MOV_ENABLED) {
    // Hook: blowouts move ratings more than a one-point win. ~1x at MOV_SCALE.
    k = common.K * (Math.log(1 + Math.abs(hs - as) / cfg.MOV_SCALE) / Math.LN2);
    k = clamp(k, common.K * 0.5, common.K * 2);
  }
  const delta = k * (resultHome - expHome);
  ratings[home] += delta;
  ratings[away] -= delta;
}

// ============================================================
// TEMPO — a team's average game total, blended toward a prior
// ============================================================
// tempo(team) = mean of (PF + PA) across that team's played games, shrunk
// toward `priorTempos[team]` (or the league prior) by TEMPO_PRIOR_WEIGHT
// pseudo-games. Before round 1 everyone sits on the prior.
function computeTempos(opts) {
  const { teams, rounds, scores, config, sport, priorTempos } = opts;
  const cfg = sportCfg(config, sport);
  const limit = opts.upToRound == null ? rounds.length : Math.min(opts.upToRound, rounds.length);

  const sum = {}, played = {};
  teams.forEach(t => { sum[t] = 0; played[t] = 0; });

  for (let r = 0; r < limit; r++) {
    const round = rounds[r] || [];
    for (let g = 0; g < round.length; g++) {
      const game = round[g];
      const s = readScore(scores, r, g);
      if (!s) continue;
      const total = s.home + s.away;
      if (sum[game.home] != null) { sum[game.home] += total; played[game.home]++; }
      if (sum[game.away] != null) { sum[game.away] += total; played[game.away]++; }
    }
  }

  const w = cfg.TEMPO_PRIOR_WEIGHT;
  const out = {};
  teams.forEach(t => {
    const prior = priorTempos && priorTempos[t] != null ? priorTempos[t] : cfg.TEMPO_PRIOR;
    out[t] = (sum[t] + prior * w) / (played[t] + w);
  });
  return out;
}

// Last season's tempos, pulled back toward the league mean the same way ratings
// are. Feed the result in as `priorTempos` so round 1 of a fresh season isn't
// flat across the whole competition.
function regressTempos(prevTempos, config, sport) {
  const cfg = sportCfg(config, sport);
  const out = {};
  Object.keys(prevTempos || {}).forEach(t => {
    out[t] = cfg.TEMPO_PRIOR + config.common.REGRESSION * (prevTempos[t] - cfg.TEMPO_PRIOR);
  });
  return out;
}

// ============================================================
// PRESEASON SEEDING
// ============================================================
// The archive is injected so the engine stays pure and the harness can feed it
// synthetic seasons. Shape:
//   archive.season(seasonKey)          -> { teams, rounds, scores } | null
//   archive.historicalLadder(seasonKey)-> { team: finishPosition } | null
//   archive.seedInputs(seasonKey)      -> { team: {phase, recruitment, baseOverride} } | null
function seasonYear(sport, seasonKey) { return parseInt(seasonKey.slice(sport.length), 10); }
function shiftSeason(sport, seasonKey, back) { return sport + (seasonYear(sport, seasonKey) - back); }

function regressToMean(r, common) { return common.MEAN + common.REGRESSION * (r - common.MEAN); }

function positionToRating(pos, teamCount, common, spreadOverride) {
  if (!(teamCount > 1)) return common.MEAN;
  const spread = spreadOverride != null ? spreadOverride : common.POSITION_SPREAD;
  // 1st -> +spread, last -> -spread, linear in between.
  return common.MEAN + spread * (1 - 2 * (pos - 1) / (teamCount - 1));
}

function newMemo() { return { seeds: {}, end: {} }; }

// End-of-season ratings for a past season: replay it from its own seeds. A
// season with no results simply ends where it started, which still chains
// correctly into the year after it.
function seasonEndRatings(sport, seasonKey, archive, config, depth, memo) {
  if (Object.prototype.hasOwnProperty.call(memo.end, seasonKey)) return memo.end[seasonKey];
  memo.end[seasonKey] = null; // cycle guard while we recurse
  const season = archive.season(seasonKey);
  if (!season) return (memo.end[seasonKey] = null);
  const seeds = computeSeedDetailInner(sport, seasonKey, archive, config, depth + 1, memo).seeds;
  const res = computeRatings({
    teams: season.teams, rounds: season.rounds, scores: season.scores || {},
    seeds, config, sport,
  });
  return (memo.end[seasonKey] = res.current);
}

// Per-team breakdown of how the seed was arrived at. computeSeeds() is the thin
// wrapper; the preview UI wants the detail (and describeTrajectory needs trend).
function computeSeedDetailInner(sport, seasonKey, archive, config, depth, memo) {
  if (memo.seeds[seasonKey]) return memo.seeds[seasonKey];
  const common = config.common;
  const cfg = sportCfg(config, sport);
  const season = archive.season(seasonKey);
  if (!season) return { seeds: {}, detail: {} };

  const result = { seeds: {}, detail: {} };
  memo.seeds[seasonKey] = result; // publish before recursing so cycles resolve

  const inputs = archive.seedInputs(seasonKey) || {};
  const canRecurse = depth < common.SEED_LOOKBACK;
  const p1 = shiftSeason(sport, seasonKey, 1);
  const p2 = shiftSeason(sport, seasonKey, 2);
  const p3 = shiftSeason(sport, seasonKey, 3);
  const end1 = canRecurse ? seasonEndRatings(sport, p1, archive, config, depth, memo) : null;
  const end2 = canRecurse ? seasonEndRatings(sport, p2, archive, config, depth, memo) : null;
  const end3 = canRecurse ? seasonEndRatings(sport, p3, archive, config, depth, memo) : null;
  const hist1 = archive.historicalLadder(p1);
  const hist1Count = hist1 ? Object.keys(hist1).length : 0;

  season.teams.forEach(team => {
    const inp = inputs[team] || {};
    const phase = common.phaseOffset[inp.phase] != null ? inp.phase : common.DEFAULT_PHASE;
    const recruitment = num(inp.recruitment, 0);

    // Base, in priority order:
    //   1. a real prior season, replayed and regressed toward the mean
    //   2. an explicit baseOverride (the user typed it, so it wins over a proxy)
    //   3. a pre-2012 finish position converted to a rating
    //   4. MEAN — expansion sides and anything else with no history
    let base, baseSource;
    const prevRating = end1 && end1[team] != null ? end1[team] : null;
    if (prevRating != null) {
      base = regressToMean(prevRating, common); baseSource = 'prev';
    } else if (inp.baseOverride != null && inp.baseOverride !== '') {
      base = num(inp.baseOverride, common.MEAN); baseSource = 'override';
    } else if (cfg.expansionBase && cfg.expansionBase[team] != null) {
      // Ahead of the position mapping on purpose — see cfg.expansionBase.
      base = cfg.expansionBase[team]; baseSource = 'expansion';
    } else if (hist1 && hist1[team]) {
      base = positionToRating(hist1[team], hist1Count, common, cfg.POSITION_SPREAD); baseSource = 'historical';
    } else {
      base = common.MEAN; baseSource = 'mean';
    }

    // Trajectory: needs two prior end-ratings. Weighted toward the recent step
    // when a third season is available, then capped hard.
    let trend = 0, trajectory = 0;
    const r1 = end1 && end1[team] != null ? end1[team] : null;
    const r2 = end2 && end2[team] != null ? end2[team] : null;
    const r3 = end3 && end3[team] != null ? end3[team] : null;
    if (r1 != null && r2 != null) {
      trend = r3 != null
        ? (r1 - r2) * common.TRAJECTORY_RECENT_WEIGHT + (r2 - r3) * (1 - common.TRAJECTORY_RECENT_WEIGHT)
        : (r1 - r2);
      trajectory = clamp(trend * common.TRAJECTORY_GAIN, -common.trajectoryCap, common.trajectoryCap);
    }

    // Phase = flat offset + a slope against how far above average the team
    // already sits, so a rebuild bites a contender harder than a cellar-dweller.
    const slope = (common.phaseSlope && common.phaseSlope[phase]) || 0;
    const phaseAdj = common.phaseOffset[phase] + slope * Math.max(0, base - common.MEAN);

    const seed = base + recruitment + phaseAdj + trajectory;
    result.seeds[team] = seed;
    result.detail[team] = { seed, base, baseSource, phase, phaseAdj, recruitment, trajectory, trend, prevRating };
  });

  return result;
}

// computeSeeds({sport, seasonKey, archive, config}) -> { team: rating }
function computeSeeds(opts) {
  const config = opts.config || SIM_CONFIG;
  return computeSeedDetailInner(opts.sport, opts.seasonKey, opts.archive, config, 0, opts.memo || newMemo()).seeds;
}

// computeSeedDetail(...) -> { team: {seed, base, baseSource, phase, recruitment, trajectory, trend} }
function computeSeedDetail(opts) {
  const config = opts.config || SIM_CONFIG;
  return computeSeedDetailInner(opts.sport, opts.seasonKey, opts.archive, config, 0, opts.memo || newMemo()).detail;
}

// Per-team sigma multipliers, read straight from the persisted seedInputs.
// Like seeds this is an INPUT to the sim, not something derived from results.
function computeVolatility(opts) {
  const config = opts.config || SIM_CONFIG;
  const common = config.common;
  const season = opts.archive.season(opts.seasonKey);
  if (!season) return {};
  const inputs = opts.archive.seedInputs(opts.seasonKey) || {};
  const fallback = common.consistency[common.DEFAULT_CONSISTENCY];
  const out = {};
  season.teams.forEach(team => {
    const c = (inputs[team] || {}).consistency;
    out[team] = common.consistency[c] != null ? common.consistency[c] : fallback;
  });
  return out;
}

// A short read-only label for the preview screen. No prose, no AI.
function describeTrajectory(opts) {
  const config = opts.config || SIM_CONFIG;
  const detail = opts.detail || computeSeedDetail(opts);
  const d = detail[opts.team];
  if (!d) return '';
  const L = config.common.labels;
  const rel = d.seed - config.common.MEAN;
  if (rel >= L.dynasty) return 'Dynasty';
  if (rel >= L.contender) return 'Contender';
  if (rel <= L.rebuild) return 'Rebuild';
  if (d.trend >= L.trend) return 'On the rise';
  if (d.trend <= -L.trend) return 'Sliding';
  return 'Stable';
}

// Last season's tempos ready to feed in as `priorTempos`, or null if there is
// no prior season with results.
function priorSeasonTempos(opts) {
  const { sport, seasonKey, archive } = opts;
  const config = opts.config || SIM_CONFIG;
  const prev = archive.season(shiftSeason(sport, seasonKey, 1));
  if (!prev) return null;
  const tempos = computeTempos({
    teams: prev.teams, rounds: prev.rounds, scores: prev.scores || {}, config, sport,
  });
  return regressTempos(tempos, config, sport);
}

// ============================================================
// SPORT-SPECIFIC SCORE REALISM
// ============================================================
// AFL: split a total into goals and behinds. Canonical implementation — the
// scorecard's generateGoalsBehinds() delegates here. Models the BEHINDS-TO-GOALS
// RATIO rather than goals' share of the total: a realistic 14.11 (95) puts goals
// at 88% of the score, so a share model forces behinds to outnumber goals.
// 6*goals + behinds === points always holds; points stays authoritative.
function generateGoalsBehinds(total, rng, config) {
  const r = rng || Math.random;
  const gb = (config || SIM_CONFIG).goalsBehinds;
  const points = Math.max(0, Math.round(num(total, 0)));
  if (points === 0) return { points: 0, goals: 0, behinds: 0 };
  if (points < 6) return { points, goals: 0, behinds: points };

  const roll = r();
  let band = gb.bands[gb.bands.length - 1];
  for (let i = 0; i < gb.bands.length; i++) {
    if (roll < gb.bands[i].upTo) { band = gb.bands[i]; break; }
  }

  // points = goals*6 + behinds, behinds = ratio*goals, so goals = points/(6+ratio)
  const ratio = band.min + r() * (band.max - band.min);
  const maxGoals = Math.floor(points / 6);
  let goals = clamp(Math.round(points / (6 + ratio)), 0, maxGoals);
  let behinds = points - goals * 6;

  // Rounding at the extremes can still throw up a freak split (e.g. 3.14) —
  // walk goals up until the scoreline looks sane.
  while (behinds > goals * gb.sanityRatio && goals < maxGoals) {
    goals++;
    behinds = points - goals * 6;
  }
  return { points, goals, behinds };
}

// NRL: tries (4), conversions (2) and penalty goals (2) are all even, so every
// team total starts even and stays that way unless someone kicks a field goal.
function nrlEvenScore(value, cfg) {
  return clamp(Math.round(Math.max(0, value) / 2) * 2, 0, cfg.SCORE_CEIL);
}

// Field goals are the only source of an odd NRL score, and real ones cluster in
// tight games: a side kicks one to break a deadlock or stretch a one-score lead.
// So the odds are conditioned on the margin and on who wins —
//   - winner, close game:   the ordinary case, 20-19 and the like
//   - winner, blowout:      the cheeky one with the game already won, 31-10
//   - loser:                rarest — a field goal to level or lead that a late
//                           try wipes out, giving the 19-24 scoreline
// Both sides kicking one leaves the margin even again (21-19), which is also real.
function nrlFieldGoals(winner, loser, rng, cfg) {
  const fg = cfg.fieldGoal;
  const close = (winner - loser) <= fg.closeMargin;
  if (rng() < (close ? fg.winnerClose : fg.winnerBlowout)) winner++;
  if (rng() < (close ? fg.loserClose : fg.loserBlowout)) loser++;
  winner = clamp(winner, 0, cfg.SCORE_CEIL);
  loser = clamp(loser, 0, cfg.SCORE_CEIL);
  if (loser >= winner) loser = Math.max(0, winner - 1);
  return { winner, loser };
}

// Optional: a plausible tries/goals decomposition of an NRL total. Not wired
// into anything — only the total is ever stored.
function nrlBreakdown(total, rng) {
  const r = rng || Math.random;
  let points = Math.max(0, Math.round(num(total, 0)));
  const fieldGoals = points % 2 === 1 ? 1 : 0;
  points -= fieldGoals;
  const maxTries = Math.floor(points / 4);
  let tries = 0;
  for (let t = maxTries; t >= 0; t--) {
    // Every try is worth 4 with up to one 2-point conversion on top, so a
    // total of `points` needs tries*4 + goals*2 === points with goals <= tries
    // plus penalty goals. Take the largest try count that leaves a sane number
    // of goals, then jitter down a little for variety.
    const goalsNeeded = (points - t * 4) / 2;
    if (goalsNeeded >= 0 && goalsNeeded <= t + 3) { tries = t; break; }
  }
  if (maxTries > 0 && tries > 1 && r() < 0.35) tries--;
  const goals = (points - tries * 4) / 2;
  return { tries, goals: Math.max(0, goals), fieldGoals };
}

// ============================================================
// SCORING PROGRESSION
// ============================================================
// Rebuilds a plausible play-by-play from a final score: which scoring plays got
// each side to its total, and roughly when they landed. Derived, never stored —
// the same score and the same rng always rebuild the same progression, so a
// score you typed by hand gets one exactly like a simulated score does.
//
// Returns cumulative states, the last of which always equals the final score:
//   [{ home, away, team, play, points, minute,
//      homeGoals, homeBehinds, awayGoals, awayBehinds }]   (AFL fields AFL-only)

function pickCount(rng, weights) {
  let r = rng(), acc = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r < acc) return i; }
  return weights.length - 1;
}

// Decompose an NRL total into the plays that produced it. Everything except a
// field goal is worth an even number, so the total is worked in 2-point units:
// a try is 2 units, a conversion or penalty goal 1.
function nrlPlayList(total, rng, config) {
  const p = config.progression;
  let points = Math.max(0, Math.round(num(total, 0)));
  const fieldGoals = points % 2;   // an odd total means exactly one field goal
  points -= fieldGoals;

  const units = points / 2;
  let pens = Math.min(pickCount(rng, p.penaltyGoals), units);
  let u = units - pens;
  if (u === 1) { pens++; u = 0; } // a lone unit can only be a goal, never a try

  // u = 2*tries + conversions with conversions <= tries, which boxes tries into
  // [u/3, u/2]. Aim at the real conversion rate inside that window.
  let tries = 0, convs = 0;
  if (u > 0) {
    tries = clamp(Math.round(u / (2 + p.conversionRate)), Math.ceil(u / 3), Math.floor(u / 2));
    convs = u - 2 * tries;
  }

  const plays = [];
  for (let i = 0; i < convs; i++) plays.push({ play: 'convertedTry', points: 6 });
  for (let i = 0; i < tries - convs; i++) plays.push({ play: 'try', points: 4 });
  for (let i = 0; i < pens; i++) plays.push({ play: 'penaltyGoal', points: 2 });
  for (let i = 0; i < fieldGoals; i++) plays.push({ play: 'fieldGoal', points: 1 });
  return plays;
}

function aflPlayList(split) {
  const plays = [];
  for (let i = 0; i < split.goals; i++) plays.push({ play: 'goal', points: 6 });
  for (let i = 0; i < split.behinds; i++) plays.push({ play: 'behind', points: 1 });
  return plays;
}

function buildProgression(opts) {
  const config = opts.config || SIM_CONFIG;
  const rng = opts.rng || Math.random;
  const p = config.progression;
  const afl = opts.sport === 'afl';
  const home = Math.max(0, Math.round(num(opts.home, 0)));
  const away = Math.max(0, Math.round(num(opts.away, 0)));

  let homePlays, awayPlays;
  if (afl) {
    // Splits can be passed in so the progression ends on the same G.B the
    // scorecard shows; otherwise one is generated here.
    homePlays = aflPlayList(opts.homeSplit || generateGoalsBehinds(home, rng, config));
    awayPlays = aflPlayList(opts.awaySplit || generateGoalsBehinds(away, rng, config));
  } else {
    homePlays = nrlPlayList(home, rng, config);
    awayPlays = nrlPlayList(away, rng, config);
  }

  // A 1-point margin with the winner odd and the loser even is a golden-point
  // finish, so that field goal belongs after the siren rather than late in the
  // second half.
  const margin = home - away;
  const winnerOdd = (margin > 0 ? home : away) % 2 === 1;
  const loserEven = (margin > 0 ? away : home) % 2 === 0;
  const golden = Math.abs(margin) === 1 && winnerOdd && loserEven;

  const full = afl ? p.fullTime.afl : p.fullTime.nrl;
  const events = [];
  const place = (list, team) => list.forEach(pl => {
    let minute;
    if (pl.play === 'fieldGoal') {
      const isWinner = (team === 'home') === (margin > 0);
      minute = golden && isWinner
        ? full + 1 + rng() * p.goldenPointWindow
        : full * p.lateWindow + rng() * full * (1 - p.lateWindow);
    } else {
      minute = 1 + rng() * (full - 1);
    }
    events.push({ team, play: pl.play, points: pl.points, minute });
  });
  place(homePlays, 'home');
  place(awayPlays, 'away');
  events.sort((a, b) => a.minute - b.minute);

  let h = 0, a = 0, hg = 0, hb = 0, ag = 0, ab = 0;
  return events.map(e => {
    if (e.team === 'home') {
      h += e.points;
      if (e.play === 'goal') hg++; else if (e.play === 'behind') hb++;
    } else {
      a += e.points;
      if (e.play === 'goal') ag++; else if (e.play === 'behind') ab++;
    }
    const step = { home: h, away: a, team: e.team, play: e.play, points: e.points, minute: Math.round(e.minute) };
    if (afl) { step.homeGoals = hg; step.homeBehinds = hb; step.awayGoals = ag; step.awayBehinds = ab; }
    return step;
  });
}

// ============================================================
// ROUND HEADLINES
// ============================================================
// Derived, never stored. A round is scanned for things worth reporting and each
// candidate is scored for newsworthiness; a game only produces a headline if it
// clears a threshold, so a round of unremarkable results prints nothing.
//
// Wording is picked by a seeded rng keyed on the season, round and scoreline, so
// a given round always reads the same way — the same discipline as the
// goals/behinds split and the play-by-play.

function pick(rng, list) { return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]; }

// Same as pick, but avoids a phrasing already used elsewhere in the round —
// two games both reading "cause a boilover against..." is what made a round of
// headlines look generated rather than written. `used` is shared across the
// round; games are walked in order, so the choice is still deterministic.
function pickVariant(rng, list, used, tag) {
  const free = [];
  for (let i = 0; i < list.length; i++) if (!used.has(tag + i)) free.push(i);
  const pool = free.length ? free : list.map((_, i) => i);
  const idx = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  used.add(tag + idx);
  return list[idx];
}

// "an 18-point deficit", not "a 18-point deficit". Only the numbers that can
// actually turn up here matter: 8, 11, 18 and the eighties.
function articleFor(n) {
  const s = String(Math.abs(Math.round(n)));
  if (s[0] === '8') return 'an';
  if (s.length === 2 && (s === '11' || s === '18')) return 'an';
  return 'a';
}

// Win/loss streak for every team, counting up to and including `throughRound`.
function streaksThrough(teams, rounds, scores, throughRound) {
  const st = {};
  teams.forEach(t => { st[t] = { type: null, count: 0 }; });
  for (let r = 0; r <= Math.min(throughRound, rounds.length - 1); r++) {
    (rounds[r] || []).forEach((game, g) => {
      const s = readScore(scores, r, g);
      if (!s) return;
      const res = s.home === s.away ? 'D' : s.home > s.away ? 'H' : 'A';
      [[game.home, res === 'H' ? 'W' : res === 'D' ? 'D' : 'L'],
       [game.away, res === 'A' ? 'W' : res === 'D' ? 'D' : 'L']].forEach(([team, outcome]) => {
        if (!st[team]) return;
        if (outcome === 'D') { st[team] = { type: 'D', count: 1 }; }
        else if (st[team].type === outcome) { st[team].count++; }
        else { st[team] = { type: outcome, count: 1 }; }
      });
    });
  }
  return st;
}

// Best team score and biggest margin in the rounds BEFORE this one, so "highest
// of the season" means what it says.
function seasonBestsBefore(rounds, scores, beforeRound) {
  let bestScore = 0, bestMargin = 0;
  for (let r = 0; r < Math.min(beforeRound, rounds.length); r++) {
    (rounds[r] || []).forEach((game, g) => {
      const s = readScore(scores, r, g);
      if (!s) return;
      bestScore = Math.max(bestScore, s.home, s.away);
      bestMargin = Math.max(bestMargin, Math.abs(s.home - s.away));
    });
  }
  return { bestScore, bestMargin };
}

// buildHeadlines({sport, seasonKey, teams, rounds, scores, seeds, config,
//                 roundIdx, ladderBefore, ladderAfter})
//   -> [{ kind, text, weight, gameIdx }]
//
// ladderBefore/ladderAfter are arrays of team names in ladder order, supplied by
// the caller. They come from the app's own ladder functions rather than being
// recomputed here — the bye points and tiebreakers live there, and duplicating
// them would only let the two drift apart. Omit them and ladder-movement
// headlines are simply skipped.
function buildHeadlines(opts) {
  const config = opts.config || SIM_CONFIG;
  const { sport, teams, rounds, scores, seeds, roundIdx } = opts;
  const H = config.headlines;
  const th = sport === 'afl' ? H.afl : H.nrl;
  const seasonKey = opts.seasonKey || '';
  const round = rounds[roundIdx] || [];
  if (!round.length) return [];

  const ratings = computeRatings({
    teams, rounds, scores, seeds, config, sport, upToRound: roundIdx,
  }).current;
  const cfg = sportCfg(config, sport);
  const bests = seasonBestsBefore(rounds, scores, roundIdx);
  const streaks = streaksThrough(teams, rounds, scores, roundIdx);
  const used = new Set();   // phrasings already spent this round
  const out = [];

  round.forEach((game, gi) => {
    const s = readScore(scores, roundIdx, gi);
    if (!s) return;

    const key = seasonKey + scoreKey(roundIdx, gi) + s.home + ':' + s.away;
    const rng = makeRng(hashKey('headline|' + key));
    const drawn = s.home === s.away;
    const homeWon = s.home > s.away;
    const winner = drawn ? null : (homeWon ? game.home : game.away);
    const loser = drawn ? null : (homeWon ? game.away : game.home);
    const ws = Math.max(s.home, s.away), ls = Math.min(s.home, s.away);
    const margin = ws - ls;
    const cands = [];

    if (drawn) {
      cands.push({ kind: 'draw', weight: 85, text: pickVariant(rng, [
        game.home + ' and ' + game.away + ' share the points, ' + s.home + '–' + s.away,
        'Nothing between ' + game.home + ' and ' + game.away + ' at ' + s.home + '–' + s.away,
      ], used, 'draw') });
    } else {
      // Golden point — a 1-point margin with the winner odd and loser even.
      if (sport === 'nrl' && margin === 1 && ws % 2 === 1 && ls % 2 === 0) {
        cands.push({ kind: 'goldenPoint', weight: 92, text: pickVariant(rng, [
          winner + ' win it in golden point against ' + loser,
          'Golden point: ' + winner + ' edge ' + loser + ' ' + ws + '–' + ls,
        ], used, 'gp') });
      }

      // Comeback — rebuild the same play-by-play the card animated and look for
      // the largest deficit the winner came back from.
      const prog = buildProgression({
        sport, home: s.home, away: s.away, config,
        rng: makeRng(hashKey(seasonKey + scoreKey(roundIdx, gi) + s.home + ':' + s.away)),
      });
      let deficit = 0;
      prog.forEach(step => {
        const behind = homeWon ? step.away - step.home : step.home - step.away;
        if (behind > deficit) deficit = behind;
      });
      if (deficit >= th.comeback) {
        cands.push({ kind: 'comeback', weight: 100 + deficit, text: pickVariant(rng, [
          winner + ' overturn ' + articleFor(deficit) + ' ' + deficit + '-point deficit to beat ' + loser + ' ' + ws + '–' + ls,
          winner + ' come from ' + deficit + ' down to beat ' + loser + ' ' + ws + '–' + ls,
        ], used, 'comeback') });
      }

      // Upset — the underdog by pre-game rating won.
      const rw = ratings[winner] != null ? ratings[winner] : config.common.MEAN;
      const rl = ratings[loser] != null ? ratings[loser] : config.common.MEAN;
      const gap = rl - rw + (loser === game.home ? cfg.HGA : -cfg.HGA);
      if (gap >= th.upsetGap) {
        // A 2-point upset and a 36-point upset are not the same story, so the
        // wording follows the margin instead of one generic "boilover" line.
        let variants, tag;
        if (margin >= th.thrashing) {
          tag = 'upsetBig';
          variants = [
            winner + ' demolish favourites ' + loser + ' ' + ws + '–' + ls,
            winner + ' humble ' + loser + ' by ' + margin + ' as favourites',
            'Boilover of the round: ' + winner + ' beat ' + loser + ' by ' + margin,
          ];
        } else if (margin <= th.narrowUpset) {
          tag = 'upsetNarrow';
          variants = [
            winner + ' edge favourites ' + loser + ' ' + ws + '–' + ls,
            winner + ' pinch it against ' + loser + ', ' + ws + '–' + ls,
            'Favourites ' + loser + ' go down narrowly to ' + winner + ', ' + ws + '–' + ls,
          ];
        } else {
          tag = 'upsetMid';
          variants = [
            winner + ' upset ' + loser + ' ' + ws + '–' + ls,
            winner + ' shock ' + loser + ' ' + ws + '–' + ls,
            'Favourites ' + loser + ' fall to ' + winner + ', ' + ws + '–' + ls,
          ];
        }
        // Outrank the plain thrashing line — that a favourite was beaten this
        // badly is the bigger story, and the wording already carries the margin.
        cands.push({ kind: 'upset', weight: 70 + gap / 4, text: pickVariant(rng, variants, used, tag) });
      }

      if (th.shutout && ls === 0) {
        cands.push({ kind: 'shutout', weight: 78, text: pickVariant(rng, [
          winner + ' keep ' + loser + ' scoreless, ' + ws + '–0',
          winner + ' shut out ' + loser + ' ' + ws + '–0',
        ], used, 'shutout') });
      }

      if (margin >= th.thrashing) {
        cands.push({ kind: 'thrashing', weight: 50 + margin, text: pickVariant(rng, [
          winner + ' thrash ' + loser + ' by ' + margin,
          winner + ' overwhelm ' + loser + ' ' + ws + '–' + ls,
          winner + ' run away with it against ' + loser + ', ' + ws + '–' + ls,
        ], used, 'thrash') });
      }

      // A tight finish is a story whether or not the favourite lost. Golden
      // point already covers the NRL 1-pointers, so this picks up the rest.
      if (margin <= th.thriller && !(sport === 'nrl' && margin === 1)) {
        cands.push({ kind: 'thriller', margin: margin, weight: 68, text: pickVariant(rng, [
          margin + ' points the difference as ' + winner + ' beat ' + loser + ', ' + ws + '–' + ls,
          winner + ' hold on to beat ' + loser + ' by ' + margin,
          winner + ' survive a tight one against ' + loser + ', ' + ws + '–' + ls,
        ], used, 'thriller') });
      }

      // Keeping a side to very little. The NRL version of this is the shutout
      // above; the AFL has no nil, so a score in the twenties plays the part.
      if (ls <= th.lowScore && !(th.shutout && ls === 0)) {
        cands.push({ kind: 'lowScore', weight: 76, text: pickVariant(rng, [
          winner + ' hold ' + loser + ' to just ' + ls,
          loser + ' manage just ' + ls + ' against ' + winner,
          winner + ' stifle ' + loser + ', ' + ws + '–' + ls,
        ], used, 'lowScore') });
      }

      if (roundIdx + 1 >= H.minRoundForSeasonHigh && ws > bests.bestScore && ws >= th.bigScore) {
        cands.push({ kind: 'seasonHigh', weight: 72, text:
          winner + "'s " + ws + ' is the highest score of the season' });
      }

      const notableRun = c => c === th.streak || c % H.streakMilestone === 0;
      const stk = streaks[winner];
      if (stk && stk.type === 'W' && stk.count >= th.streak && notableRun(stk.count)) {
        cands.push({ kind: 'streak', run: stk.count, weight: 40 + stk.count * 5, text: pickVariant(rng, [
          winner + ' make it ' + stk.count + ' straight',
          winner + ' stretch their winning run to ' + stk.count,
        ], used, 'streak') });
      }
      const lstk = streaks[loser];
      if (lstk && lstk.type === 'L' && lstk.count >= th.streak && notableRun(lstk.count)) {
        cands.push({ kind: 'slump', run: lstk.count, weight: 38 + lstk.count * 4, text:
          loser + ' slip to ' + lstk.count + ' straight defeats' });
      }
    }

    if (cands.length) {
      cands.sort((a, b) => b.weight - a.weight);
      out.push(Object.assign({ gameIdx: gi }, cands[0]));
    }
  });

  // League-level: a change at the top isn't tied to any one game.
  // Ladder news. Round 1 has no "before" to change from, so it reports who
  // leads rather than claiming someone moved there.
  const before = opts.ladderBefore, after = opts.ladderAfter;
  if (after && after.length) {
    const rng = makeRng(hashKey('leader|' + seasonKey + '|' + roundIdx + '|' + after[0]));
    if (roundIdx === 0) {
      out.push({ kind: 'ladderLeader', gameIdx: -1, weight: 55, text: pickVariant(rng, [
        after[0] + ' lead the ladder after round 1',
        after[0] + ' top the ladder after the opening round',
      ], used, 'leader') });
    } else if (before && before.length && before[0] !== after[0]) {
      out.push({ kind: 'ladderLeader', gameIdx: -1, weight: 80, text: pickVariant(rng, [
        after[0] + ' move to top spot',
        after[0] + ' take over at the top of the ladder',
      ], used, 'leader') });
    }
  }

  // Once a side is on a run, every round would otherwise report it — six teams
  // "on 4 straight" drowns out the actual news. Keep only the standout run and
  // the standout slump in the round.
  ['streak', 'slump'].forEach(kind => {
    const of = out.filter(h => h.kind === kind);
    if (of.length > 1) {
      const best = of.reduce((a, b) => (b.run > a.run ? b : a));
      of.forEach(h => { if (h !== best) out.splice(out.indexOf(h), 1); });
    }
  });
  // Same for close finishes — report the tightest game of the round, not every
  // game that happened to finish inside a converted try.
  const thrillers = out.filter(h => h.kind === 'thriller');
  if (thrillers.length > 1) {
    const tightest = thrillers.reduce((a, b) => (b.margin < a.margin ? b : a));
    thrillers.forEach(h => { if (h !== tightest) out.splice(out.indexOf(h), 1); });
  }

  out.sort((a, b) => b.weight - a.weight);
  return out.slice(0, H.maxPerRound);
}

// ============================================================
// THE GAME
// ============================================================
// simulateGame({home, away, ratings, tempos, config, sport, rng})
//   -> { home, away, expMargin, actualMargin, total }
// The returned home/away are what gets written straight into `scores`.
function simulateGame(opts) {
  const { home, away, ratings, tempos, volatility, sport, rng } = opts;
  const config = opts.config || SIM_CONFIG;
  const cfg = sportCfg(config, sport);
  const common = config.common;

  // MARGIN, from strength. The noise is what produces upsets, and its width is
  // set by how consistent the two sides are — a volatile team makes its games
  // less predictable in both directions.
  const Rh = ratings && ratings[home] != null ? ratings[home] : common.MEAN;
  const Ra = ratings && ratings[away] != null ? ratings[away] : common.MEAN;
  const vH = volatility && volatility[home] != null ? volatility[home] : 1;
  const vA = volatility && volatility[away] != null ? volatility[away] : 1;
  const ratingGap = (Rh + cfg.HGA) - Ra;
  // Linear for ordinary gaps, saturating toward MARGIN_CAP for extreme ones —
  // tanh(x) ~= x when x is small, so existing calibration is preserved.
  const linearMargin = ratingGap * cfg.MARGIN_SCALE;
  const expMargin = cfg.MARGIN_CAP
    ? cfg.MARGIN_CAP * Math.tanh(linearMargin / cfg.MARGIN_CAP)
    : linearMargin;
  let actualMargin = expMargin + gaussian(rng, 0, cfg.MARGIN_SIGMA * (vH + vA) / 2);

  // TOTAL, from tempo — independent of who wins.
  const Th = tempos && tempos[home] != null ? tempos[home] : cfg.TEMPO_PRIOR;
  const Ta = tempos && tempos[away] != null ? tempos[away] : cfg.TEMPO_PRIOR;
  let total = clamp((Th + Ta) / 2 + gaussian(rng, 0, cfg.TOTAL_SIGMA), cfg.TOTAL_FLOOR, cfg.TOTAL_CEIL);

  // A one-sided contest inflates the game total: the winning side keeps scoring
  // while the beaten one doesn't. Tempo and margin are otherwise independent by
  // design, and without this a huge margin only ever drives the loser toward
  // nil — it never pushes the winner up into the big scores, so 58+ never
  // happened in the NRL at all.
  const blowout = Math.max(0, Math.abs(actualMargin) - cfg.BLOWOUT_MARGIN);
  if (blowout > 0) total = Math.min(total + blowout * cfg.BLOWOUT_LIFT, cfg.TOTAL_CEIL);

  // Squeeze the tail before anything downstream sees it, so the blowout lift
  // and the score split both work from a realistic margin.
  let squeezed = Math.abs(actualMargin);
  if (cfg.MARGIN_KNEE && squeezed > cfg.MARGIN_KNEE) {
    const room = cfg.MARGIN_MAX - cfg.MARGIN_KNEE;
    squeezed = cfg.MARGIN_KNEE + room * Math.tanh((squeezed - cfg.MARGIN_KNEE) / room);
  }
  actualMargin = actualMargin < 0 ? -squeezed : squeezed;

  const rawMargin = Math.abs(actualMargin);
  // A level game is decided up front, by the margin landing inside DRAW_BAND —
  // not by rounding artifacts. In the NRL most of these come back out of golden
  // point as a 1-point result; in the AFL they stand as draws, which the ladder
  // handles (NRL 1 pt each, AFL 2 each).
  const isDraw = rawMargin < (cfg.DRAW_BAND != null ? cfg.DRAW_BAND : common.DRAW_BAND);

  // Keep the beaten side inside the plausible range. Margin and total are drawn
  // independently, so a big margin on a modest total used to drag the loser to
  // nothing — the 12-154 AFL scoreline. Capping the margin preserves the game
  // total and just makes the thrashing a little less absurd.
  const m = Math.min(rawMargin, Math.max(0, total - 2 * cfg.SCORE_FLOOR));

  let winner = Math.round((total + m) / 2);
  let loser = Math.max(0, Math.round((total - m) / 2));

  if (sport === 'nrl') {
    winner = nrlEvenScore(winner, cfg);
    loser = nrlEvenScore(loser, cfg);
    if (loser > winner) { const t = winner; winner = loser; loser = t; }
  } else {
    winner = clamp(winner, 0, cfg.SCORE_CEIL);
    loser = clamp(loser, 0, cfg.SCORE_CEIL);
  }

  let hs, as, goldenPoint = false;
  if (isDraw) {
    let level = sport === 'nrl'
      ? Math.min(nrlEvenScore(total / 2, cfg), cfg.SCORE_CEIL - 1)
      : clamp(Math.round(total / 2), 0, cfg.SCORE_CEIL);
    // Golden point: a game level at full time is usually settled by a field goal
    // in extra time. That's why 1-point margins are common in the NRL and true
    // draws are not — what isn't settled stays drawn.
    if (sport === 'nrl' && rng() < cfg.fieldGoal.goldenPoint) {
      goldenPoint = true;
      if (actualMargin >= 0) { hs = level + 1; as = level; }
      else { hs = level; as = level + 1; }
    } else {
      hs = level; as = level;
    }
  } else {
    // A decided game must stay decided; separating by 2 keeps both totals even.
    if (winner <= loser) winner = loser + 2;
    if (sport === 'nrl') {
      const fg = nrlFieldGoals(winner, loser, rng, cfg);
      winner = fg.winner; loser = fg.loser;
    }
    if (actualMargin >= 0) { hs = winner; as = loser; }
    else { hs = loser; as = winner; }
  }

  // Last guard: 0-0 would read as "not played" everywhere downstream.
  if (hs === 0 && as === 0) { hs = sport === 'nrl' ? 6 : 30; as = hs; }

  return { home: hs, away: as, expMargin, actualMargin, total, goldenPoint };
}

// ============================================================
// THE ROUND
// ============================================================
// simulateRound({sport, teams, rounds, scores, seeds, config, roundIdx, rng,
//                priorTempos, shouldWrite}) -> { "R3G0": {home, away}, ... }
//
// Ratings and tempos are replayed from `scores` up to (not including) roundIdx,
// so every game in the round is decided off the same pre-round state — they're
// simultaneous, as they should be.
//
// `shouldWrite(key, alreadyHasScore)` decides what gets filled. The default
// fills only empty games, which is "Automate round". Re-roll passes its own
// predicate; the engine deliberately holds no opinion about provenance, because
// once a simmed score is written it is indistinguishable from a typed one.
function simulateRound(opts) {
  const { sport, teams, rounds, scores, seeds, roundIdx, rng, priorTempos, volatility } = opts;
  const config = opts.config || SIM_CONFIG;
  const shouldWrite = opts.shouldWrite || function (key, already) { return !already; };

  const ratings = computeRatings({
    teams, rounds, scores, seeds, config, sport, upToRound: roundIdx,
  }).current;
  const tempos = computeTempos({
    teams, rounds, scores, config, sport, upToRound: roundIdx, priorTempos,
  });

  const out = {};
  const round = rounds[roundIdx] || [];
  for (let g = 0; g < round.length; g++) {
    const key = scoreKey(roundIdx, g);
    if (!shouldWrite(key, hasScore(scores, roundIdx, g))) continue;
    const res = simulateGame({
      home: round[g].home, away: round[g].away, ratings, tempos, volatility, config, sport, rng,
    });
    out[key] = { home: res.home, away: res.away };
  }
  return out;
}

// "Sim rest of season": loop simulateRound from fromRound, applying each round's
// results to a working copy before the next one so later rounds see them.
// Returns every key written; the caller merges it into the real `scores`.
function simulateRest(opts) {
  const { sport, teams, rounds, seeds, rng, priorTempos, volatility } = opts;
  const config = opts.config || SIM_CONFIG;
  const working = Object.assign({}, opts.scores);
  const all = {};
  for (let r = opts.fromRound || 0; r < rounds.length; r++) {
    const written = simulateRound({
      sport, teams, rounds, scores: working, seeds, config,
      roundIdx: r, rng, priorTempos, volatility, shouldWrite: opts.shouldWrite,
    });
    Object.keys(written).forEach(k => { working[k] = written[k]; all[k] = written[k]; });
  }
  return all;
}

return {
  SIM_CONFIG,
  makeRng, gaussian,
  scoreKey, readScore, hasScore,
  computeRatings, computeTempos, regressTempos, priorSeasonTempos,
  computeSeeds, computeSeedDetail, computeVolatility, describeTrajectory,
  positionToRating, regressToMean,
  simulateGame, simulateRound, simulateRest,
  buildProgression, buildHeadlines, hashKey,
  generateGoalsBehinds, nrlBreakdown,
};
});
