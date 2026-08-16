// ============================================================
// SEASON SIMULATION ENGINE (NRL + AFL)
// ============================================================
// Pure logic, no DOM. Loaded as `window.LadderSim` in the browser and
// `require('./sim.js')` in node (so the harness exercises the shipping code).
//
// THE MODEL, in one paragraph. This engine is TEAM-FIRST: each side generates
// its own score and the margin is whatever falls out. Nothing computes a margin
// directly. Every team carries two ratings on a 0-100 scale where 50 is league
// average — ATTACK (how much it scores) and DEFENCE (how much it stops the other
// side scoring) — and one score is:
//   AVG + (own attack - 50)*W - (opp defence - 50)*W + home bonus + noise
// The noise is three rolls, which is what keeps scores tight while still
// producing upsets: TEMPO moves both sides together (a shootout or an
// arm-wrestle), SWING moves them in opposite directions (this is what decides
// close games and creates upsets), and IND is each team's own wobble, scaled by
// its consistency setting.
//
// Why team-first: the old engine scaled a rating GAP into a margin, so a big
// margin could be manufactured by an ordinary game rolling a lucky number, and
// capping that flattened genuine mismatches into the same result as mid-table
// ones. Here a 100-point margin requires a genuinely 100-point-worse team. That
// removes the need for a margin cap, knee, ceiling, blowout lift or score floor
// — every one of those was a patch over the old model's shape.
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
    MEAN: 50,                  // league average, on the 0-100 scale both ratings live on
    RATING_FLOOR: 2, RATING_CEIL: 98,
    REGRESSION: 0.72,          // between-season mean reversion
    K: 0.05,                   // rating update speed: share of each game's surprise

    // PHASE IS A LABEL ONLY. It is stored, shown on the preview, and used for
    // nothing else — it does not move a seed and it never touches a score.
    // Kept as a list so the UI has something to render.
    phases: ['rebuild', 'dropping', 'stable', 'contender', 'dynasty'],
    DEFAULT_PHASE: 'stable',

    // Per-team wobble, applied to that team's own IND noise roll. Symmetric on
    // purpose: a volatile side drops games it should win AND steals ones it had
    // no business winning. It never touches the rating — a volatile team isn't
    // weaker, only less predictable.
    //
    // This shapes SCORELINES, not ladder positions. A 22-game season carries a
    // ~2-win spread from chance alone, which swamps any variance setting, so a
    // volatile side still finishes about where its ratings say. That is the
    // intended behaviour, not a limitation to tune around.
    consistency: { volatile: 1.45, streaky: 1.20, balanced: 1.00, steady: 0.85, ruthless: 0.72 },
    DEFAULT_CONSISTENCY: 'balanced',

    // The recruitment slider is -200..200 in the UI; this scales it into rating
    // points and it lands on attack and defence alike. At full tilt it is worth
    // 10 rating points — about a third of the way from mid-table to the top.
    RECRUIT_SCALE: 0.05,

    // Trajectory nudge: teams trending up or down across 2-3 prior seasons get
    // a small, capped bump. Set trajectoryCap to 0 to switch it off entirely.
    trajectoryCap: 4,
    TRAJECTORY_GAIN: 0.35,
    TRAJECTORY_RECENT_WEIGHT: 0.6,

    // Pre-2012 seasons have finish positions but no scores, so a ladder position
    // converts straight into a rating: 1st = MEAN + POSITION_SPREAD, last =
    // MEAN - POSITION_SPREAD. Attack and defence both get that value, since a
    // finish position says nothing about how a side split the two.
    POSITION_SPREAD: 25,

    SEED_LOOKBACK: 20,         // max seasons to chain back through (guard, not a design limit)

    // A game is level when the two scores land within this of each other.
    DRAW_BAND: 0.25,

    // Noise past this many standard deviations is re-rolled. Freak scorelines
    // come from the extreme tail of the bell curve; lopping it off roughly
    // halves the 100+ margins and leaves the upset rate alone.
    NOISE_CLIP: 2,

    // describeTrajectory() label thresholds, relative to MEAN
    labels: { dynasty: 20, contender: 9, rebuild: -13, trend: 4 },
  },
  afl: {
    AVG: 85,                   // what an average side scores against an average defence
    W: 0.55,                   // rating points -> score points, for attack and defence alike
    HOME: 8,
    // The three noise rolls. TEMPO moves both sides together, so it decides
    // whether this is a shootout or an arm-wrestle without touching who wins.
    // SWING moves them in opposite directions, so it alone decides close games
    // and upsets. IND is each side's own wobble, scaled by its consistency.
    // Splitting them this way is what allows tight, believable scorelines and a
    // healthy upset rate at the same time — one combined roll cannot do both.
    TEMPO: 7, SWING: 13.5, IND: 8,
    DRAW_BAND: 0.35,           // no golden point in the AFL — a level game just draws
    // Plain bounds on a team's own score, which is NOT the old SCORE_FLOOR —
    // that one clamped a margin so subtraction couldn't drag the loser to nil.
    // Nothing is subtracted here; this is just the realistic range of an AFL
    // score, and it matches the ends of the rarity bands.
    SCORE_FLOOR: 20, SCORE_CEIL: 220,
    POSITION_SPREAD: 25,
    // Expansion sides enter far weaker than an established wooden spooner, and
    // a debut ladder position understates that. Only consulted when there is no
    // prior simulated season to inherit from, so it is a one-time entry rating.
    expansionBase: {
      'Gold Coast Suns': { att: 18, def: 18 },
      'GWS Giants':      { att: 18, def: 18 },
    },
  },
  nrl: {
    AVG: 21, W: 0.30, HOME: 2,
    TEMPO: 3, SWING: 6.5, IND: 3,   // see afl.TEMPO
    // Level at full time goes to golden point, and golden point is nearly always
    // settled by a field goal — which is why the NRL has far more 1-point
    // margins than draws. Wider than the AFL's, because most of what lands in it
    // comes back out as a 1-point result rather than a draw.
    DRAW_BAND: 0.8,
    // Nil is a real NRL scoreline, so the floor stays at zero.
    SCORE_FLOOR: 0, SCORE_CEIL: 84,
    POSITION_SPREAD: 20,       // tighter comp than the AFL

    // Tries (4), conversions (2) and penalty goals (2) are all even, so a field
    // goal is the ONLY thing that makes an NRL score odd — and they get kicked
    // where the game is tight, not at random. See nrlFieldGoals().
    fieldGoal: {
      goldenPoint: 0.85,    // chance a level game is settled by a golden-point FG
      closeMargin: 12,      // "close" = a converted try or two; anything more is a blowout
      winnerClose: 0.130,   // the winning side kicks one to break a tight game open
      winnerBlowout: 0.035, // the cheeky one with the game already won: 31-10
      loserClose: 0.014,    // kicked to level or lead, then beaten by a late try: 19-24
      loserBlowout: 0.0035, // rarest of all
    },
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
      upsetGap: 22,      // pre-game rating gap the underdog had to overcome
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
      upsetGap: 25,
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
// A rating is { att, def } on the 0-100 scale. Anything else coming in — a bare
// number from an older save, or nothing at all — is widened into the pair, so a
// stale seed still loads instead of poisoning a whole season with NaN.
function normRating(v, common) {
  if (v == null) return { att: common.MEAN, def: common.MEAN };
  if (typeof v === 'number') return { att: v, def: v };
  return { att: num(v.att, common.MEAN), def: num(v.def, common.MEAN) };
}
function clampRating(v, common) { return clamp(v, common.RATING_FLOOR, common.RATING_CEIL); }
function cloneRatings(r) {
  const out = {};
  Object.keys(r).forEach(t => { out[t] = { att: r[t].att, def: r[t].def }; });
  return out;
}
// What this side is expected to put on, given both sets of ratings. The single
// source of truth for the model — the replay and the simulation both call it,
// so a rating can never mean one thing going in and another coming out.
function expectedScore(cfg, common, own, opp, atHome) {
  return cfg.AVG
    + (own.att - common.MEAN) * cfg.W
    - (opp.def - common.MEAN) * cfg.W
    + (atHome ? cfg.HOME : 0);
}

// Replay the season in order, moving both ratings on every result. Never stored.
function computeRatings(opts) {
  const { teams, rounds, scores, seeds, config, sport } = opts;
  const cfg = sportCfg(config, sport);
  const common = config.common;
  const limit = opts.upToRound == null ? rounds.length : Math.min(opts.upToRound, rounds.length);

  const ratings = {};
  teams.forEach(t => { ratings[t] = normRating(seeds && seeds[t], common); });

  const history = [];
  for (let r = 0; r < limit; r++) {
    const round = rounds[r] || [];
    for (let g = 0; g < round.length; g++) {
      const game = round[g];
      const s = readScore(scores, r, g);
      if (!s) continue;
      if (!ratings[game.home] || !ratings[game.away]) continue;
      applyResult(ratings, game.home, game.away, s.home, s.away, cfg, common);
    }
    history.push({ roundIdx: r, ratings: cloneRatings(ratings) });
  }
  return { current: ratings, history };
}

// One game's worth of learning. A side scoring above expectation lifts its own
// ATTACK and drops the other side's DEFENCE by the same amount — from a
// scoreline alone there is no way to tell which of the two caused it, so both
// move. Dividing by W converts a surprise measured in score points back into
// rating points, so K stays meaningful when the sports are scaled differently.
function applyResult(ratings, home, away, hs, as, cfg, common) {
  const H = ratings[home], A = ratings[away];
  const dHome = common.K * (hs - expectedScore(cfg, common, H, A, true)) / cfg.W;
  const dAway = common.K * (as - expectedScore(cfg, common, A, H, false)) / cfg.W;
  H.att = clampRating(H.att + dHome, common);
  A.def = clampRating(A.def - dHome, common);
  A.att = clampRating(A.att + dAway, common);
  H.def = clampRating(H.def - dAway, common);
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

function regressToMean(r, common) {
  const v = normRating(r, common);
  return {
    att: common.MEAN + common.REGRESSION * (v.att - common.MEAN),
    def: common.MEAN + common.REGRESSION * (v.def - common.MEAN),
  };
}

// A finish position says nothing about how a side split attack and defence, so
// both come back on the same value.
function positionToRating(pos, teamCount, common, spreadOverride) {
  if (!(teamCount > 1)) return { att: common.MEAN, def: common.MEAN };
  const spread = spreadOverride != null ? spreadOverride : common.POSITION_SPREAD;
  // 1st -> +spread, last -> -spread, linear in between.
  const v = common.MEAN + spread * (1 - 2 * (pos - 1) / (teamCount - 1));
  return { att: v, def: v };
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
    const phase = common.phases.indexOf(inp.phase) >= 0 ? inp.phase : common.DEFAULT_PHASE;
    const recruitment = num(inp.recruitment, 0);

    // Base, in priority order:
    //   1. a real prior season, replayed and regressed toward the mean
    //   2. an explicit baseOverride (the user typed it, so it wins over a proxy)
    //   3. an expansion side's entry rating
    //   4. a pre-2012 finish position converted to a rating
    //   5. MEAN — anything else with no history
    let base, baseSource;
    const prevRating = end1 && end1[team] != null ? normRating(end1[team], common) : null;
    if (prevRating != null) {
      base = regressToMean(prevRating, common); baseSource = 'prev';
    } else if (inp.baseOverride != null && inp.baseOverride !== '') {
      base = normRating(num(inp.baseOverride, common.MEAN), common); baseSource = 'override';
    } else if (cfg.expansionBase && cfg.expansionBase[team] != null) {
      // Ahead of the position mapping on purpose — see cfg.expansionBase.
      base = normRating(cfg.expansionBase[team], common); baseSource = 'expansion';
    } else if (hist1 && hist1[team]) {
      base = positionToRating(hist1[team], hist1Count, common, cfg.POSITION_SPREAD); baseSource = 'historical';
    } else {
      base = { att: common.MEAN, def: common.MEAN }; baseSource = 'mean';
    }

    // Trajectory, run separately for attack and defence. That is the whole
    // reason for carrying two numbers: a side can be trending up going forward
    // and down at the back, and "last 2 years" should be able to say so.
    const trend = { att: 0, def: 0 }, trajectory = { att: 0, def: 0 };
    const r1 = prevRating;
    const r2 = end2 && end2[team] != null ? normRating(end2[team], common) : null;
    const r3 = end3 && end3[team] != null ? normRating(end3[team], common) : null;
    if (r1 && r2) {
      ['att', 'def'].forEach(k => {
        trend[k] = r3
          ? (r1[k] - r2[k]) * common.TRAJECTORY_RECENT_WEIGHT + (r2[k] - r3[k]) * (1 - common.TRAJECTORY_RECENT_WEIGHT)
          : (r1[k] - r2[k]);
        trajectory[k] = clamp(trend[k] * common.TRAJECTORY_GAIN, -common.trajectoryCap, common.trajectoryCap);
      });
    }

    // PHASE CONTRIBUTES NOTHING. It is carried through to the detail so the
    // preview can show it, and that is all it does — see common.phases.
    const recruit = recruitment * common.RECRUIT_SCALE;
    const seed = {
      att: clampRating(base.att + recruit + trajectory.att, common),
      def: clampRating(base.def + recruit + trajectory.def, common),
    };
    result.seeds[team] = seed;
    result.detail[team] = {
      seed, att: seed.att, def: seed.def, overall: (seed.att + seed.def) / 2,
      base, baseSource, phase, recruitment, trajectory, trend, prevRating,
    };
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
  const rel = d.overall - config.common.MEAN;
  const trend = (d.trend.att + d.trend.def) / 2;
  if (rel >= L.dynasty) return 'Dynasty';
  if (rel >= L.contender) return 'Contender';
  if (rel <= L.rebuild) return 'Rebuild';
  if (trend >= L.trend) return 'On the rise';
  if (trend <= -L.trend) return 'Sliding';
  return 'Stable';
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
      // Overall strength is attack and defence averaged — a side is only a real
      // underdog if it is behind on both counts, not just one.
      const ovr = t => {
        const r = normRating(ratings[t], config.common);
        return (r.att + r.def) / 2;
      };
      const rw = ovr(winner), rl = ovr(loser);
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
// simulateGame({home, away, ratings, volatility, config, sport, rng})
//   -> { home, away, expHome, expAway, actualMargin, total, goldenPoint }
// Each side generates its OWN score and the margin is whatever falls out —
// nothing here computes a margin. The returned home/away go straight into
// `scores`.

// Gaussian with the extreme tail re-rolled. Freak scorelines live past 2sd, and
// cutting them out roughly halves the 100-point margins while leaving the upset
// rate alone — upsets come from the middle of the distribution, not the tail.
function clippedGaussian(rng, sd, common) {
  if (!(sd > 0)) return 0;
  const lim = common.NOISE_CLIP;
  let z;
  do { z = gaussian(rng, 0, 1); } while (lim && Math.abs(z) > lim);
  return z * sd;
}

function simulateGame(opts) {
  const { home, away, ratings, volatility, sport, rng } = opts;
  const config = opts.config || SIM_CONFIG;
  const cfg = sportCfg(config, sport);
  const common = config.common;

  const Rh = normRating(ratings && ratings[home], common);
  const Ra = normRating(ratings && ratings[away], common);
  const vH = volatility && volatility[home] != null ? volatility[home] : 1;
  const vA = volatility && volatility[away] != null ? volatility[away] : 1;

  const expHome = expectedScore(cfg, common, Rh, Ra, true);
  const expAway = expectedScore(cfg, common, Ra, Rh, false);

  // The three rolls — see cfg.TEMPO for why they are split.
  //   TEMPO lands on both sides identically, so it sets the game total (shootout
  //     or arm-wrestle) without touching who wins.
  //   SWING lands with opposite signs, so it alone decides the margin, and it is
  //     the only thing that produces an upset.
  //   IND is each side's own wobble, widened or narrowed by its consistency.
  const tempo = clippedGaussian(rng, cfg.TEMPO, common);
  const swing = clippedGaussian(rng, cfg.SWING * (vH + vA) / 2, common);
  const lo = cfg.SCORE_FLOOR || 0;
  let hs = clamp(expHome + tempo + swing + clippedGaussian(rng, cfg.IND * vH, common), lo, cfg.SCORE_CEIL);
  let as = clamp(expAway + tempo - swing + clippedGaussian(rng, cfg.IND * vA, common), lo, cfg.SCORE_CEIL);

  const actualMargin = hs - as;
  const rawTotal = hs + as;
  // Level is decided up front, on the raw margin, rather than by letting integer
  // rounding (and NRL's round-to-even) collapse a lot of one-point games into
  // draws. In the NRL most of these come back out of golden point as a 1-point
  // result; in the AFL they stand, which the ladder handles.
  const isDraw = Math.abs(actualMargin) < (cfg.DRAW_BAND != null ? cfg.DRAW_BAND : common.DRAW_BAND);

  let goldenPoint = false;
  if (isDraw) {
    const level = sport === 'nrl'
      ? Math.min(nrlEvenScore(rawTotal / 2, cfg), cfg.SCORE_CEIL - 1)
      : clamp(Math.round(rawTotal / 2), 0, cfg.SCORE_CEIL);
    // Golden point: a game level at full time is usually settled by a field goal
    // in extra time. That's why the NRL has far more 1-point margins than draws.
    if (sport === 'nrl' && rng() < cfg.fieldGoal.goldenPoint) {
      goldenPoint = true;
      if (actualMargin >= 0) { hs = level + 1; as = level; }
      else { hs = level; as = level + 1; }
    } else {
      hs = level; as = level;
    }
  } else {
    let winner = Math.max(hs, as), loser = Math.min(hs, as);
    if (sport === 'nrl') {
      winner = nrlEvenScore(winner, cfg);
      loser = nrlEvenScore(loser, cfg);
      // A decided game must stay decided; separating by 2 keeps both even.
      if (winner <= loser) winner = loser + 2;
      const fg = nrlFieldGoals(winner, loser, rng, cfg);
      winner = fg.winner; loser = fg.loser;
    } else {
      winner = Math.round(winner); loser = Math.round(loser);
      if (winner <= loser) winner = loser + 1;
    }
    if (actualMargin >= 0) { hs = winner; as = loser; }
    else { hs = loser; as = winner; }
  }

  // Last guard: 0-0 would read as "not played" everywhere downstream.
  if (hs === 0 && as === 0) { hs = sport === 'nrl' ? 6 : 30; as = hs; }

  return { home: hs, away: as, expHome, expAway, actualMargin, total: hs + as, goldenPoint };
}

// ============================================================
// THE ROUND
// ============================================================
// simulateRound({sport, teams, rounds, scores, seeds, config, roundIdx, rng,
//                volatility, shouldWrite}) -> { "R3G0": {home, away}, ... }
//
// Ratings are replayed from `scores` up to (not including) roundIdx,
// so every game in the round is decided off the same pre-round state — they're
// simultaneous, as they should be.
//
// `shouldWrite(key, alreadyHasScore)` decides what gets filled. The default
// fills only empty games, which is "Automate round". Re-roll passes its own
// predicate; the engine deliberately holds no opinion about provenance, because
// once a simmed score is written it is indistinguishable from a typed one.
function simulateRound(opts) {
  const { sport, teams, rounds, scores, seeds, roundIdx, rng, volatility } = opts;
  const config = opts.config || SIM_CONFIG;
  const shouldWrite = opts.shouldWrite || function (key, already) { return !already; };

  const ratings = computeRatings({
    teams, rounds, scores, seeds, config, sport, upToRound: roundIdx,
  }).current;
  const out = {};
  const round = rounds[roundIdx] || [];
  for (let g = 0; g < round.length; g++) {
    const key = scoreKey(roundIdx, g);
    if (!shouldWrite(key, hasScore(scores, roundIdx, g))) continue;
    const res = simulateGame({
      home: round[g].home, away: round[g].away, ratings, volatility, config, sport, rng,
    });
    out[key] = { home: res.home, away: res.away };
  }
  return out;
}

// "Sim rest of season": loop simulateRound from fromRound, applying each round's
// results to a working copy before the next one so later rounds see them.
// Returns every key written; the caller merges it into the real `scores`.
function simulateRest(opts) {
  const { sport, teams, rounds, seeds, rng, volatility } = opts;
  const config = opts.config || SIM_CONFIG;
  const working = Object.assign({}, opts.scores);
  const all = {};
  for (let r = opts.fromRound || 0; r < rounds.length; r++) {
    const written = simulateRound({
      sport, teams, rounds, scores: working, seeds, config,
      roundIdx: r, rng, volatility, shouldWrite: opts.shouldWrite,
    });
    Object.keys(written).forEach(k => { working[k] = written[k]; all[k] = written[k]; });
  }
  return all;
}

return {
  SIM_CONFIG,
  makeRng, gaussian,
  scoreKey, readScore, hasScore,
  computeRatings, expectedScore, normRating,
  computeSeeds, computeSeedDetail, computeVolatility, describeTrajectory,
  positionToRating, regressToMean,
  simulateGame, simulateRound, simulateRest,
  buildProgression, buildHeadlines, hashKey,
  generateGoalsBehinds, nrlBreakdown,
};
});
