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
    // TEMPO 15 puts a 230+ or sub-120 game at about 4% each (roughly eight
    // or nine of each a season) and a game-total spread of ±31 — a touch
    // wilder than the real ±28, on purpose.
    TEMPO: 15, SWING: 13.5, IND: 8,
    // No golden point in the AFL, so a level game just draws. 0.04 makes that
    // about one game in 1,000, a draw every five seasons or so (0.35 had nearly
    // two a season).
    DRAW_BAND: 0.04,
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
    // Lower-rated sides play looser, higher-scoring games: each side's score
    // moves this many points per rating point the two sides average below
    // (or above) the mean. Two 40-rated sides add about 2.5 each; two
    // 60-rated sides lose about the same.
    weakTempo: 0.25,
    // See afl.TEMPO. 7: a 70+ game about 3% of the time and a sub-20 one about
    // 5.5% (the floor at nil makes the low end come up more), roughly six and
    // eleven a season, and a game-total spread of ±14.
    TEMPO: 7, SWING: 6.5, IND: 3,
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
      // Chance a level game is settled in golden point. 0.985 leaves a draw
      // about once in eight seasons (0.85 had one or two a season).
      goldenPoint: 0.985,
      closeMargin: 12,      // "close" = a converted try or two; anything more is a blowout
      // Field goals outside golden point are rare, and a side never kicks one
      // while behind (buildNrlTimeline puts it where the kicker is level or
      // ahead: almost always the last score, else to go 7 or 13 up).
      winnerClose: 0.10,    // the winning side kicks one to put a tight game away
      winnerBlowout: 0.012, // the cheeky one with the game already won: 31-10
      // The losing side kicked one while level or ahead, then the other side
      // scored a try to win it: 19-24. Only in games settled by a try or less.
      loserClose: 0.008,    // extremely rare: about one a season
      loserBlowout: 0,
      // A side whose only points are a penalty goal (2) is very rare: a 2
      // usually comes out as nil or a try. This share are left alone.
      keepTwo: 0.05,
      // A game with under 12 points between the two sides is very rare:
      // most get topped up with tries (the result stays the same). This share
      // are left alone.
      minGameTotal: 12, keepLowTotal: 0.02,
      convertRate: 0.78,    // share of those top-up tries that are converted
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
      thrashing: 28,     // winning margin
      thriller: 2,       // a win this tight is news on its own, upset or not
      lowScore: 4,       // holding a side to this is a defensive story
      narrowUpset: 6,    // a converted try; an upset this close is a different story to a rout
      streak: 5,         // consecutive wins or losses
      shutout: true,     // nil is a real NRL scoreline; the AFL floor is 20
      bigScore: 46,
      // Held off a late comeback: the lead fell by `drop` or more over the
      // last 40% of the game and the win ended up within `within`.
      lateHold: { drop: 12, within: 8 },
      // How a game read: close is within a converted try; low and high are the
      // game total; a see-saw has this many lead changes; comfy is a clear
      // win short of a thrashing.
      close: 6, lowTotal: 30, highTotal: 50, seesaw: 3, comfy: 18,
      pileOn: 40,        // a winning score this big is a story in itself
      // The match centre tells every game's story, so its bars sit lower than
      // the round list's. upsetMargin is what the favourite was expected to
      // win by, in points.
      matchCentre: { comeback: 12, smashing: 30, upsetMargin: 6 },
    },
    afl: {
      upsetGap: 25,
      comeback: 36,      // six goals
      thrashing: 65,
      thriller: 6,       // under a goal
      lowScore: 35,      // the AFL has no nil, but 35 is a shutout in spirit
      narrowUpset: 15,   // under three goals; an upset this close is a different story to a rout
      streak: 5,
      shutout: false,
      bigScore: 150,
      lateHold: { drop: 24, within: 18 },   // four goals clawed back, won by three or fewer
      close: 12, lowTotal: 140, highTotal: 190, seesaw: 5, comfy: 40,
      pileOn: 130,
      matchCentre: { comeback: 24, smashing: 60, upsetMargin: 12 },   // four goals, ten goals, two goals
    },
  },
  // Play-by-play reconstruction — see buildProgression().
  progression: {
    conversionRate: 0.78,                    // NRL: share of tries converted
    // NRL: weights for 0/1/2/3 penalty goals per side. Most games have none:
    // about one game in three has one at all.
    penaltyGoals: [0.82, 0.15, 0.03, 0],
    lateWindow: 0.70,                        // field goals land in the last 30% of the game
    goldenPointWindow: 10,                   // extra-time minutes for a golden-point kick
    // NRL halves — see buildNrlTimeline(). Same momentum model as the AFL's.
    nrl: {
      halfMins: 40,
      phasesPerHalf: 4,
      flowSD: 0.30, phaseSD: 0.30,
      penaltyTilt: 0.5,        // penalty goals follow momentum less than tries do
      // Seconds before the next score can land: nothing inside three minutes
      // of a try (so no two tries are), a minute after a goal. A try's conversion is its own play,
      // kicked conversionDelay seconds after it (it doesn't count as a score
      // for these gaps).
      gapAfterTry: 180, gapAfterGoal: 60,
      conversionDelay: [25, 55],
      goldenPointWidth: 0.08,  // share of the worm's axis golden point takes up
      // Field goals come only from this minute of the match (the last ten
      // minutes of the second half), or in golden point.
      fieldGoalFrom: 70,
    },
    // AFL is played out in quarters — see buildAflTimeline().
    afl: {
      quarterMins: 31, quarterSD: 2,         // 20 minutes plus time on
      quarterMin: 28, quarterMax: 35,
      minGapSecs: 20,                        // no two scores closer than this, either side
      gapAfterGoal: 60,                      // a goal means a centre bounce: nothing else for a minute,
                                             // so no two goals ever share a minute
      phasesPerQuarter: 3,
      // Who's on top. FLOW is a quarter-long tilt shared by every phase in it;
      // PHASE is a shorter burst on top of that. Scoring plays are dealt out in
      // proportion to e^(+tilt) for the home side and e^(-tilt) for the away
      // side, so a quarter can belong to one team without the totals moving.
      // Tuned so a side goes goalless in ~5% of quarters, kicks 8+ in ~1%, and
      // an 8-goal swing in one quarter turns up in ~1% of games.
      flowSD: 0.26, phaseSD: 0.22,
      // No quarter may hold more than this share of a side's goals (or
      // quarterGoalFloor, for low scores where a share means little). A deal
      // that breaks it is re-dealt, up to maxRedeals times.
      maxQuarterShare: 0.45, quarterGoalFloor: 6, maxRedeals: 12,
      // Every quarter has at least this many scores, the two sides together:
      // a quarter with one behind in it doesn't happen.
      minScoresPerQuarter: 4,
      // Behinds follow momentum less than goals do — a side under the pump
      // still sprays a few. Their tilt is scaled by this.
      behindTilt: 0.5,
    },
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
    // Hard limits on a full-time G.B: at least this many behinds, and goals as a
    // share of scoring shots between minAccuracy and maxAccuracy (2.8 to 9.1
    // for ten shots). Nobody kicks 10.0.
    minBehinds: 4, minAccuracy: 0.2, maxAccuracy: 0.9,
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
//   archive.seedInputs(seasonKey)      -> { team: {phase, consistency, attOverride, defOverride} } | null
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

    // Base, in priority order:
    //   1. a real prior season, replayed and regressed toward the mean
    //   2. an expansion side's entry rating
    //   3. a pre-2012 finish position converted to a rating
    //   4. MEAN — anything else with no history
    // A typed attOverride/defOverride is applied AFTER all of this, because it
    // replaces the answer outright rather than feeding into it.
    let base, baseSource;
    const prevRating = end1 && end1[team] != null ? normRating(end1[team], common) : null;
    if (prevRating != null) {
      base = regressToMean(prevRating, common); baseSource = 'prev';
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

    // What history implies, before the user has a say.
    const derived = {
      att: clampRating(base.att + trajectory.att, common),
      def: clampRating(base.def + trajectory.def, common),
    };

    // A typed rating REPLACES the derived one rather than nudging it — if you
    // say a side's attack is 80, it is 80, whatever last season did. Attack and
    // defence are set independently, so either can be overridden alone.
    //
    // PHASE CONTRIBUTES NOTHING to any of this. It is carried through to the
    // detail so the preview can show it, and that is all — see common.phases.
    const attSet = inp.attOverride != null && inp.attOverride !== '';
    const defSet = inp.defOverride != null && inp.defOverride !== '';
    const seed = {
      att: attSet ? clampRating(num(inp.attOverride, derived.att), common) : derived.att,
      def: defSet ? clampRating(num(inp.defOverride, derived.def), common) : derived.def,
    };
    result.seeds[team] = seed;
    result.detail[team] = {
      seed, att: seed.att, def: seed.def, overall: (seed.att + seed.def) / 2,
      derived, attSet, defSet,
      base, baseSource, phase, trajectory, trend, prevRating,
    };
  });

  return result;
}

// computeSeeds({sport, seasonKey, archive, config}) -> { team: rating }
function computeSeeds(opts) {
  const config = opts.config || SIM_CONFIG;
  return computeSeedDetailInner(opts.sport, opts.seasonKey, opts.archive, config, 0, opts.memo || newMemo()).seeds;
}

// computeSeedDetail(...) -> { team: {seed, att, def, overall, derived, attSet, defSet,
//                              base, baseSource, phase, trajectory, trend} }
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
  const minB = gb.minBehinds || 0;
  while (behinds > goals * gb.sanityRatio && goals < maxGoals && behinds - 6 >= minB) {
    goals++;
    behinds = points - goals * 6;
  }
  // Then the hard limits. Too few behinds or too accurate (10.0, 9.0): trade a
  // goal for six behinds. Too wayward (1.14): the other way.
  const acc = () => goals / (goals + behinds);
  const maxA = gb.maxAccuracy || 1, minA = gb.minAccuracy || 0;
  while (goals > 0 && (behinds < minB || acc() > maxA)) {
    goals--;
    behinds += 6;
  }
  while (acc() < minA && goals < maxGoals && behinds - 6 >= minB) {
    goals++;
    behinds -= 6;
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
  // A loser's field goal needs a try after it to lose: only in a game within
  // a try (four points) before the kick, that the winner scored a try in.
  if (winner - loser <= 4 && winner >= 4 && rng() < fg.loserClose) loser++;
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
//      homeGoals, homeBehinds, awayGoals, awayBehinds,   (AFL only)
//      quarter, clock, t }]                              (AFL only — see buildAflTimeline)

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
  // A side that scores at all scores a try if it can: penalty goals alone
  // (4 = two of them) are very rare.
  if (units >= 2 && units - pens < 2) pens = units - 2;
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

// AFL: four quarters, each with its own length and its own ebb and flow.
// Every goal and behind is dealt to a phase of a quarter, weighted by who was
// on top in that phase, then given a clock time inside it.
//
// Returns { steps, quarterLengths, quarters, periods }:
//   steps          — as buildProgression, plus quarter (1-4), period (0-3),
//                    clock (seconds into the quarter) and t (0-1 across the
//                    match, each quarter an equal quarter of it — what the score
//                    worm plots against)
//   quarterLengths — seconds
//   quarters       — running G.B at the end of each quarter, for both sides
//   periods        — the sport-neutral view the match centre draws from; see
//                    buildNrlTimeline()
// fixed (optional): { home: [{goals, behinds}] x4, away: [...] } — what each
// side scored IN each quarter. Every score is then dealt inside its own
// quarter, so the breaks come out exactly as given.
function buildAflTimeline(home, away, homeSplit, awaySplit, rng, config, fixed) {
  const p = config.progression.afl;
  const P = p.phasesPerQuarter;

  const quarterLengths = [];
  for (let q = 0; q < 4; q++) {
    const mins = clamp(gaussian(rng, p.quarterMins, p.quarterSD), p.quarterMin, p.quarterMax);
    quarterLengths.push(Math.round(mins * 60));
  }

  // Deal every goal and behind to a phase. A deal that piles too much of a
  // side's scoring into one quarter (a 12-goal last quarter after 2.7 at the
  // final change) is thrown out and dealt again with fresh momentum; the last
  // attempt stands, so this always finishes.
  let events;
  if (fixed) {
    events = [];
    ['home', 'away'].forEach(team => fixed[team].forEach((qs, q) => {
      for (let i = 0; i < qs.goals; i++) events.push({ team, play: 'goal', points: 6, ph: q * P + Math.floor(rng() * P) });
      for (let i = 0; i < qs.behinds; i++) events.push({ team, play: 'behind', points: 1, ph: q * P + Math.floor(rng() * P) });
    }));
  }
  for (let attempt = 0; !fixed && attempt < p.maxRedeals; attempt++) {
    const tilts = [];
    for (let q = 0; q < 4; q++) {
      const flow = gaussian(rng, 0, p.flowSD);
      for (let ph = 0; ph < P; ph++) tilts.push(flow + gaussian(rng, 0, p.phaseSD));
    }
    const deal = (count, sign, scale) => {
      const w = tilts.map(m => Math.exp(sign * m * scale));
      const sum = w.reduce((a, b) => a + b, 0);
      return Array.from({ length: count }, () => pickCount(rng, w.map(x => x / sum)));
    };
    events = [];
    const place = (split, team) => {
      const sign = team === 'home' ? 1 : -1;
      deal(split.goals, sign, 1).forEach(ph => events.push({ team, play: 'goal', points: 6, ph }));
      deal(split.behinds, sign, p.behindTilt).forEach(ph => events.push({ team, play: 'behind', points: 1, ph }));
    };
    place(homeSplit, 'home');
    place(awaySplit, 'away');

    const tooLopsided = [['home', homeSplit], ['away', awaySplit]].some(([team, split]) => {
      const cap = Math.max(p.quarterGoalFloor, Math.round(split.goals * p.maxQuarterShare));
      const perQ = [0, 0, 0, 0];
      events.forEach(e => { if (e.team === team && e.play === 'goal') perQ[Math.floor(e.ph / P)]++; });
      return perQ.some(g => g > cap);
    });
    if (!tooLopsided) break;
  }

  // No quarter goes by with almost nothing scored: move scores across from
  // the busiest quarter until each has its minimum. (Fixed quarters are a real
  // breakdown, so they're left as given.)
  if (!fixed && p.minScoresPerQuarter && events.length >= 4 * p.minScoresPerQuarter) {
    const count = () => [0, 1, 2, 3].map(q => events.filter(e => Math.floor(e.ph / P) === q).length);
    for (let guard = 0; guard < 40; guard++) {
      const c = count();
      const thin = c.findIndex(n => n < p.minScoresPerQuarter);
      if (thin < 0) break;
      const busy = c.indexOf(Math.max(...c));
      const from = events.filter(e => Math.floor(e.ph / P) === busy);
      // Prefer a behind, so a quarter's goals barely move.
      const pick = from.find(e => e.play === 'behind') || from[0];
      pick.ph = thin * P + Math.floor(rng() * P);
    }
  }

  events.forEach(e => {
    const q = Math.floor(e.ph / P), ph = e.ph % P;
    const len = quarterLengths[q];
    // Nothing in the first 20 seconds — the ball has to get from the centre
    // bounce to a goal — but a score can land right on the siren.
    const lo = Math.max(20, len * ph / P), hi = Math.min(len - 1, len * (ph + 1) / P);
    e.quarter = q + 1;
    e.clock = Math.round(lo + rng() * (hi - lo));
    e.t = (q + e.clock / len) / 4;
  });
  events.sort((a, b) => a.t - b.t);
  // Spread out scores that landed on top of each other: push each one back to
  // at least minGapSecs after the last, then, if that ran a quarter past its
  // siren, pull them forward from the end the same way.
  for (let q = 1; q <= 4; q++) {
    const qe = events.filter(e => e.quarter === q);
    const len = quarterLengths[q - 1];
    const gap = e => (e.play === 'goal' ? p.gapAfterGoal : p.minGapSecs);
    for (let i = 1; i < qe.length; i++) qe[i].clock = Math.max(qe[i].clock, qe[i - 1].clock + gap(qe[i - 1]));
    if (qe.length) qe[qe.length - 1].clock = Math.min(qe[qe.length - 1].clock, len - 1);
    for (let i = qe.length - 2; i >= 0; i--) qe[i].clock = Math.min(qe[i].clock, qe[i + 1].clock - gap(qe[i]));
    qe.forEach(e => { e.clock = Math.max(0, e.clock); e.t = (q - 1 + e.clock / len) / 4; });
  }

  let h = 0, a = 0, hg = 0, hb = 0, ag = 0, ab = 0;
  const quarters = [];
  const snap = () => ({
    home: { goals: hg, behinds: hb, points: h },
    away: { goals: ag, behinds: ab, points: a },
  });
  let qi = 0;
  const steps = [];
  events.forEach(e => {
    while (e.quarter - 1 > qi) { quarters.push(snap()); qi++; }
    if (e.team === 'home') { h += e.points; if (e.play === 'goal') hg++; else hb++; }
    else { a += e.points; if (e.play === 'goal') ag++; else ab++; }
    let elapsed = e.clock;
    for (let i = 0; i < e.quarter - 1; i++) elapsed += quarterLengths[i];
    steps.push({
      home: h, away: a, team: e.team, play: e.play, points: e.points,
      minute: Math.round(elapsed / 60), quarter: e.quarter, period: e.quarter - 1, clock: e.clock, t: e.t,
      homeGoals: hg, homeBehinds: hb, awayGoals: ag, awayBehinds: ab,
    });
  });
  while (quarters.length < 4) quarters.push(snap());

  const periods = quarterLengths.map((len, q) => ({
    label: 'Q' + (q + 1), start: q / 4, end: (q + 1) / 4, len, offset: 0, score: quarters[q],
  }));
  return { steps, quarterLengths, quarters, periods };
}

// NRL: two 40-minute halves, plus golden point when a level game was settled by
// a field goal. Tries, conversions and penalty goals are dealt to phases of a
// half by who was on top, as the AFL deals goals; field goals still go late in
// the second half, or into golden point.
//
// Returns { steps, periods }:
//   steps   — as buildProgression, plus period (0 = 1st half, 1 = 2nd half,
//             2 = golden point), clock (seconds into the period), t (0-1 across
//             the match) and running homeTries/homeGoals/homeFieldGoals and the
//             away equivalents (goals = conversions + penalty goals)
//   periods — [{ label, start, end, len, offset, score }]: where each period
//             sits on the 0-1 axis, its length and match-clock offset in
//             seconds, and the running score at its end
// halves (optional): { home: [1st half, rest], away: [...] } in points. Each
// half's points are scored in that half (golden point counts as the rest), so
// the half-time score comes out exactly as given.
function buildNrlTimeline(home, away, rng, config, halves) {
  const p = config.progression;
  const n = p.nrl;
  const P = n.phasesPerHalf;
  const playsFor = (total, team) => halves
    ? nrlPlayList(halves[team][0], rng, config).map(pl => Object.assign(pl, { half: 0 }))
        .concat(nrlPlayList(halves[team][1], rng, config).map(pl => Object.assign(pl, { half: 1 })))
    : nrlPlayList(total, rng, config);
  const homePlays = playsFor(home, 'home');
  const awayPlays = playsFor(away, 'away');

  // A 1-point margin with the winner odd and the loser even is a golden-point
  // finish, so that field goal belongs after the siren rather than late in the
  // second half.
  const margin = home - away;
  const winnerOdd = (margin > 0 ? home : away) % 2 === 1;
  const loserEven = (margin > 0 ? away : home) % 2 === 0;
  // With fixed halves, golden point also needs the winner's odd point to be
  // in the second half (a first-half one is its siren field goal instead).
  const golden = Math.abs(margin) === 1 && winnerOdd && loserEven &&
    (!halves || halves[margin > 0 ? 'home' : 'away'][1] % 2 === 1);

  const half = n.halfMins * 60;
  const gpLen = p.goldenPointWindow * 60;
  // Golden point gets a sliver of the axis; the halves share the rest.
  const hw = golden ? (1 - n.goldenPointWidth) / 2 : 0.5;
  const periods = [
    { label: '1H', start: 0, end: hw, len: half, offset: 0 },
    { label: '2H', start: hw, end: 2 * hw, len: half, offset: half },
  ];
  if (golden) periods.push({ label: 'GP', start: 2 * hw, end: 1, len: gpLen, offset: 2 * half });

  const tilts = [];
  for (let hIdx = 0; hIdx < 2; hIdx++) {
    const flow = gaussian(rng, 0, n.flowSD);
    for (let ph = 0; ph < P; ph++) tilts.push(flow + gaussian(rng, 0, n.phaseSD));
  }
  const weights = (sign, scale) => {
    const w = tilts.map(m => Math.exp(sign * m * scale));
    const sum = w.reduce((a, b) => a + b, 0);
    return w.map(x => x / sum);
  };

  const events = [];
  const fieldGoals = [];
  const place = (list, team) => {
    const sign = team === 'home' ? 1 : -1;
    const tryW = weights(sign, 1), penW = weights(sign, n.penaltyTilt);
    list.forEach(pl => {
      // Field goals go in last, once the rest of the game is laid out, so they
      // can only land where the kicker isn't behind.
      if (pl.play === 'fieldGoal') { fieldGoals.push({ team, play: pl.play, points: pl.points, half: pl.half }); return; }
      let ph = pickCount(rng, pl.play === 'penaltyGoal' ? penW : tryW);
      // A fixed half keeps the play in its half, in the matching phase.
      if (pl.half != null) ph = pl.half * P + (ph % P);
      const period = Math.floor(ph / P);
      const k = ph % P;
      const lo = Math.max(30, half * k / P), hi = Math.min(half - 1, half * (k + 1) / P);
      const clock = Math.round(lo + rng() * (hi - lo));
      events.push({ team, play: pl.play, points: pl.points, period, clock });
    });
  };
  place(homePlays, 'home');
  place(awayPlays, 'away');

  // There's a restart after every score, so nothing lands on top of the last
  // one: push a play back until the gap is long enough.
  // If that ran a period past its siren, pull scores forward from the end the
  // same way, so nothing ever shares a second.
  const gapAfter = e => e.play === 'convertedTry' || e.play === 'try' ? n.gapAfterTry : n.gapAfterGoal;
  // A converted try needs room before the siren for its kick.
  const convRoom = n.conversionDelay[1] + 1;
  const abs = e => e.period * half + e.clock;
  const order = () => events.sort((a, b) => abs(a) - abs(b));
  const space = () => {
    order();
    periods.forEach((pd, pi) => {
      const pe = events.filter(e => e.period === pi);
      for (let i = 1; i < pe.length; i++) pe[i].clock = Math.max(pe[i].clock, pe[i - 1].clock + gapAfter(pe[i - 1]));
      if (pe.length) {
        const last = pe[pe.length - 1];
        last.clock = Math.min(last.clock, pd.len - 1 - (last.play === 'convertedTry' ? convRoom : 0));
      }
      for (let i = pe.length - 2; i >= 0; i--) pe[i].clock = Math.min(pe[i].clock, pe[i + 1].clock - gapAfter(pe[i]));
      pe.forEach(e => { e.clock = Math.max(0, e.clock); });
    });
    order();
  };
  // A side's lead (negative: how far behind) just before events[i].
  const leadBefore = (i, team) => {
    let m = 0;
    for (let j = 0; j < i; j++) m += (events[j].team === team ? 1 : -1) * events[j].points;
    return m;
  };
  space();

  // Nobody takes the two points when they're more than a converted try down.
  // A penalty goal that lands there moves back to the latest earlier moment
  // the side was within six (kick-off always is), which only ever helps its
  // own later kicks; a few passes settle the other side's.
  for (let pass = 0; pass < 12; pass++) {
    const i = events.findIndex((e, idx) => e.play === 'penaltyGoal' && !e.stuck && leadBefore(idx, e.team) < -6);
    if (i < 0) break;
    const pen = events.splice(i, 1)[0];
    // With fixed halves it can't leave its half; with nowhere valid there it
    // stays put.
    const floor = halves ? events.findIndex(e => e.period === pen.period) : 0;
    const lowest = halves ? (floor < 0 ? i : Math.min(floor, i)) : 0;
    // The latest earlier gap it's allowed in and that has room for it (the
    // start of the game always qualifies).
    const fromOf = k => (k > 0 ? abs(events[k - 1]) + gapAfter(events[k - 1]) : 30);
    const toOf = k => (events[k] ? abs(events[k]) - n.gapAfterGoal : fromOf(k) + 60);
    let k = i;
    while (k > lowest && (leadBefore(k, pen.team) < -6 || toOf(k) < fromOf(k))) k--;
    if (halves && (leadBefore(k, pen.team) < -6)) { pen.stuck = true; events.splice(i, 0, pen); continue; }
    const from = fromOf(k), to = toOf(k);
    let at = Math.max(0, Math.round(from + rng() * Math.max(0, to - from)));
    if (halves) at = Math.min(pen.period * half + half - 1, Math.max(pen.period * half, at));
    pen.period = Math.min(1, Math.floor(at / half));
    pen.clock = at - pen.period * half;
    events.splice(k, 0, pen);
    space();
  }

  // Field goals. A side only kicks one when it's level or ahead: nearly always
  // as the last score of the game, otherwise to go seven or thirteen points up
  // late in the second half. A golden-point winner's is the golden point.
  const lateFrom = (n.fieldGoalFrom - n.halfMins) * 60;   // seconds into the 2nd half
  // The losing side's kick first: placing it can move one of the winner's
  // tries, and the winner's kick is then placed around the finished picture.
  fieldGoals.sort((x, y) => ((x.team === 'home') === (margin > 0) ? 1 : 0) - ((y.team === 'home') === (margin > 0) ? 1 : 0));
  fieldGoals.forEach(fg => {
    const isWinner = (fg.team === 'home') === (margin > 0);
    if (fg.half === 0) {
      // A first-half point with fixed halves: the siren field goal.
      const firstHalf = events.filter(e => e.period === 0);
      const last = firstHalf[firstHalf.length - 1];
      const from = last ? last.clock + gapAfter(last) : half - 120;
      const clock = Math.round(Math.min(half - 1, from + rng() * Math.max(0, half - 1 - from)));
      events.splice(firstHalf.length, 0, Object.assign(fg, { period: 0, clock }));
      return;
    }
    if (golden && isWinner) {
      events.push(Object.assign(fg, { period: 2, clock: Math.round(10 + rng() * (gpLen - 10)) }));
      return;
    }
    const n2 = events.length;
    const lastLead = leadBefore(n2, fg.team);
    // Moments late in the 2nd half when a field goal would put the kicker 7 or 13 up.
    const sevens = [];
    for (let k = 1; k <= n2; k++) {
      const prev = events[k - 1];
      if (prev.period !== 1 || prev.clock < lateFrom) continue;
      const lead = leadBefore(k, fg.team);
      const next = events[k];
      const room = (next && next.period === 1 ? next.clock : half - 1) - (prev.clock + gapAfter(prev));
      // ...and not where it would leave the other side more than six down for
      // a penalty goal it kicks later.
      const breaksPen = events.slice(k).some((e, j) => e.play === 'penaltyGoal' && e.team !== fg.team &&
        leadBefore(k + j, e.team) - 1 < -6);
      if ((lead === 6 || lead === 12) && room >= n.gapAfterGoal && !breaksPen) sevens.push(k);
    }
    let k;
    // The losing side's: the latest moment it was level or ahead with a try
    // from the other side still to come, so that try is what beats it.
    // Fixed halves: a second-half kick stays in the second half.
    const minK = halves ? Math.max(0, events.findIndex(e => e.period >= 1)) : 0;
    const firstTwo = halves && events.findIndex(e => e.period >= 1) < 0 ? n2 : minK;
    // The gap a kick at position k would sit in, and whether it fits there
    // (it can't land between a try and its conversion, or on top of a score).
    const earliest = half + lateFrom;
    // A field goal isn't a try, so it only waits for the conversion (or a
    // minute after any other score), not the three minutes a try does.
    // `tight` squeezes it in closer (20 seconds either side), for a kick that
    // has nowhere roomier to go without breaking a rule.
    let tight = false;
    const fgGap = e => (e.play === 'convertedTry' ? n.conversionDelay[1] + 15 : tight ? 20 : n.gapAfterGoal);
    const fgFrom = j => Math.max(earliest, events[j - 1] ? abs(events[j - 1]) + fgGap(events[j - 1]) : 0);
    const fgTo = j => (events[j] ? abs(events[j]) - (tight ? 20 : n.gapAfterGoal) : 2 * half - 1);
    const fits = j => j === n2 || fgTo(j) >= fgFrom(j);
    if (!isWinner) {
      for (const squeeze of [false, true]) {
        tight = squeeze;
        for (let j = n2 - 1; j >= firstTwo && k == null; j--) {
          if (leadBefore(j, fg.team) < 0 || !fits(j)) continue;
          const after = events.slice(j);
          if (!after.some(e => e.team !== fg.team && (e.play === 'try' || e.play === 'convertedTry'))) continue;
          const breaksPen = after.some((e, i2) => e.play === 'penaltyGoal' && e.team !== fg.team && leadBefore(j + i2, e.team) - 1 < -6);
          if (!breaksPen) k = j;
        }
        if (k != null) break;
      }
      if (k == null) tight = false;
      // Nowhere late with a try still to come: make one. The winner's last
      // try moves to the closing minutes, and the kick goes in just before it,
      // where the losing side is level or ahead (it only kicks in games
      // decided by a try or less, so taking a try off always gets it there).
      if (k == null) {
        let ti = -1;
        for (let j = events.length - 1; j >= 0 && ti < 0; j--) {
          const e = events[j];
          // (With fixed halves, only a second-half try can move.)
          if (e.team !== fg.team && (e.play === 'convertedTry' || e.play === 'try') && (!halves || e.period === 1)) ti = j;
        }
        if (ti >= 0) {
          const tr = events.splice(ti, 1)[0];
          const m = events.length;
          // The latest spot from the 70th minute where the kicker is now level
          // or ahead (taking that try away always makes one).
          tight = true;
          let at = null, j = m;
          for (; j >= 0; j--) {
            if (leadBefore(j, fg.team) < 0) continue;
            const from = fgFrom(j), to = j === m ? 2 * half - 1 - convRoom - n.gapAfterGoal : fgTo(j);
            if (to >= from) { at = Math.round(from + rng() * Math.min(60, to - from)); break; }
          }
          tight = false;
          // No room anywhere: straight after the last score. The spacing below
          // pulls the closing minutes back to fit, keeping the order.
          if (at == null) { j = m; const lastE = events[m - 1]; at = Math.max(half + lateFrom, lastE ? abs(lastE) + fgGap(lastE) : 0); }
          events.splice(j, 0, Object.assign(fg, { period: 1, clock: at - half }));
          // The try that beats it goes at the very end (after everything, so it
          // stays last when the spacing tidies up).
          const lastE = events[events.length - 1];
          const tryAt = Math.max(at + n.gapAfterGoal, abs(lastE) + gapAfter(lastE)) + Math.floor(rng() * 60);
          events.push(Object.assign(tr, { period: 1, clock: tryAt - half }));
          space();
          return;
        }
      }
    }
    if (k != null) { /* placed above */ }
    else if (sevens.length && (lastLead < 0 || rng() < 0.25)) k = sevens[Math.floor(rng() * sevens.length)];
    else if (lastLead >= 0) k = n2;
    else {
      // Only an old, stored scoreline gets here: kick it wherever the side was
      // furthest in front.
      let best = -Infinity;
      for (let j = firstTwo; j <= n2; j++) { if (!fits(j)) continue; const l = leadBefore(j, fg.team); if (l > best) { best = l; k = j; } }
      if (k == null) k = n2;
    }
    // In the gap between the scores either side: late in the second half for
    // a winner's kick; anywhere it fits for a loser's (it needs that try
    // still to come).
    const from = fgFrom(k), to = fgTo(k);
    const at = Math.round(Math.min(2 * half - 1, from + rng() * Math.max(0, to - from)));
    const period = at >= half ? 1 : 0;
    events.splice(k, 0, Object.assign(fg, { period, clock: at - period * half }));
  });
  // Golden point ends on its first score: the period runs only until the kick.
  const gpKick = events.find(e => e.period === 2);
  if (gpKick) periods[2].len = gpKick.clock + 1;
  events.forEach(e => {
    const pd = periods[e.period];
    e.t = pd.start + (Math.max(0, e.clock) / pd.len) * (pd.end - pd.start);
  });
  events.sort((a, b) => a.t - b.t);

  // A converted try is two plays on the worm: the try (4), then the kick (2)
  // a little under a minute later. Delays are drawn last, so they never move
  // anything placed above.
  const plays = [];
  events.forEach(e => {
    if (e.play !== 'convertedTry') { plays.push(e); return; }
    const pd = periods[e.period];
    const d = Math.round(n.conversionDelay[0] + rng() * (n.conversionDelay[1] - n.conversionDelay[0]));
    const kick = Math.min(pd.len - 1, e.clock + d);
    plays.push(Object.assign({}, e, { play: 'try', points: 4 }));
    plays.push(Object.assign({}, e, { play: 'conversion', points: 2, clock: kick,
      t: pd.start + (kick / pd.len) * (pd.end - pd.start) }));
  });

  const c = { home: { points: 0, tries: 0, goals: 0, fieldGoals: 0 }, away: { points: 0, tries: 0, goals: 0, fieldGoals: 0 } };
  const snap = () => ({ home: Object.assign({}, c.home), away: Object.assign({}, c.away) });
  let pi = 0;
  const steps = plays.map(e => {
    while (e.period > pi) { periods[pi].score = snap(); pi++; }
    const side = c[e.team];
    side.points += e.points;
    if (e.play === 'try') side.tries++;
    else if (e.play === 'conversion' || e.play === 'penaltyGoal') side.goals++;
    else if (e.play === 'fieldGoal') side.fieldGoals++;
    return {
      home: c.home.points, away: c.away.points, team: e.team, play: e.play, points: e.points,
      minute: Math.round((periods[e.period].offset + e.clock) / 60),
      period: e.period, clock: e.clock, t: e.t,
      homeTries: c.home.tries, homeGoals: c.home.goals, homeFieldGoals: c.home.fieldGoals,
      awayTries: c.away.tries, awayGoals: c.away.goals, awayFieldGoals: c.away.fieldGoals,
    };
  });
  for (; pi < periods.length; pi++) periods[pi].score = snap();

  return { steps, periods };
}

function buildProgression(opts) {
  const config = opts.config || SIM_CONFIG;
  const rng = opts.rng || Math.random;
  const home = Math.max(0, Math.round(num(opts.home, 0)));
  const away = Math.max(0, Math.round(num(opts.away, 0)));

  if (opts.sport === 'afl') {
    // Splits can be passed in so the progression ends on the same G.B the
    // scorecard shows; otherwise one is generated here.
    return buildAflTimeline(home, away,
      opts.homeSplit || generateGoalsBehinds(home, rng, config),
      opts.awaySplit || generateGoalsBehinds(away, rng, config),
      rng, config).steps;
  }
  return buildNrlTimeline(home, away, rng, config).steps;
}

// ============================================================
// ONE GAME'S TIMELINE
// ============================================================
// The single recipe for a game's play-by-play. The live animation, the round
// headlines and the match centre all come through here, so what you watched,
// what the headline says and what the worm draws are the same game.
//
// Seeds are keyed on the season, the game and the scoreline — never on whether
// the score was simulated or typed. The AFL G.B split is keyed on team and side
// exactly as the scorecard's generateGoalsBehinds() in index.html keys it.
function aflSplitFor(team, side, points, config) {
  return generateGoalsBehinds(points, makeRng(hashKey(team + '|' + side + ':' + points)), config);
}

// buildMatchTimeline({sport, seasonKey, roundIdx, gameIdx, game, score, config})
//   AFL -> { steps, periods, quarterLengths, quarters, homeSplit, awaySplit }
//   NRL -> { steps, periods }
// opts.breaks (optional) pins the scores at the breaks, for a game whose real
// breakdown is known:
//   AFL: { home: [QT, HT, 3QT], away: [...] }, each { goals, behinds }, running
//   NRL: { home: [HT], away: [HT] }, points
// Breaks that can't fit the final score are ignored (tl.breaksIgnored).
function buildMatchTimeline(opts) {
  const config = opts.config || SIM_CONFIG;
  const s = opts.score;
  const home = Math.max(0, Math.round(num(s.home, 0)));
  const away = Math.max(0, Math.round(num(s.away, 0)));
  const rng = makeRng(hashKey((opts.seasonKey || '') + scoreKey(opts.roundIdx, opts.gameIdx) + home + ':' + away));
  const br = opts.breaks;
  if (opts.sport === 'afl') {
    let homeSplit = aflSplitFor(opts.game.home, 'H', home, config);
    let awaySplit = aflSplitFor(opts.game.away, 'A', away, config);
    let fixed = null, ignored = false;
    if (br) {
      const fit = (pts, split, q3) => {
        // The full-time G.B: the usual split if it covers 3QT, else the
        // nearest one for the same points that does.
        if (split.goals >= q3.goals && split.behinds >= q3.behinds) return split;
        let best = null;
        for (let g = q3.goals; g * 6 <= pts; g++) {
          const b = pts - 6 * g;
          if (b < q3.behinds) continue;
          if (!best || Math.abs(g - split.goals) < Math.abs(best.goals - split.goals)) best = { points: pts, goals: g, behinds: b };
        }
        return best;
      };
      const perQuarter = (q, ft) => {
        const run = q.concat([ft]);
        const out = run.map((x, i) => ({ goals: x.goals - (i ? run[i - 1].goals : 0), behinds: x.behinds - (i ? run[i - 1].behinds : 0) }));
        return out.every(x => x.goals >= 0 && x.behinds >= 0) ? out : null;
      };
      const hs = fit(home, homeSplit, br.home[2]), as = fit(away, awaySplit, br.away[2]);
      const hq = hs && perQuarter(br.home, hs), aq = as && perQuarter(br.away, as);
      if (hq && aq) { homeSplit = hs; awaySplit = as; fixed = { home: hq, away: aq }; }
      else ignored = true;
    }
    const tl = buildAflTimeline(home, away, homeSplit, awaySplit, rng, config, fixed);
    tl.homeSplit = homeSplit;
    tl.awaySplit = awaySplit;
    if (ignored) tl.breaksIgnored = true;
    return tl;
  }
  if (br) {
    const h = br.home[0], a = br.away[0];
    if (h >= 0 && a >= 0 && h <= home && a <= away) {
      return buildNrlTimeline(home, away, rng, config, { home: [h, home - h], away: [a, away - a] });
    }
    const tl = buildNrlTimeline(home, away, rng, config);
    tl.breaksIgnored = true;
    return tl;
  }
  return buildNrlTimeline(home, away, rng, config);
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
// "Carlton's", but "Gold Coast Suns'".
function possessive(name) { return /s$/i.test(name) ? name + "'" : name + "'s"; }

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
  // onlyGame asks for one game's headline — the match centre's — and always
  // gets one. Round headlines stay exclusive: the minor candidates below never
  // reach the round list.
  const only = opts.onlyGame != null ? opts.onlyGame : null;

  round.forEach((game, gi) => {
    if (only != null && gi !== only) return;
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
    let tl = null;

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
      tl = buildMatchTimeline({ sport, seasonKey, roundIdx, gameIdx: gi, game, score: s, config });
      let deficit = 0;
      tl.steps.forEach(step => {
        const behind = homeWon ? step.away - step.home : step.home - step.away;
        if (behind > deficit) deficit = behind;
      });
      if (deficit >= th.comeback) {
        cands.push({ kind: 'comeback', weight: 100 + deficit, text: pickVariant(rng, [
          winner + ' overturn ' + articleFor(deficit) + ' ' + deficit + '-point deficit to beat ' + loser + ' ' + ws + '–' + ls,
          winner + ' come from ' + deficit + ' down to beat ' + loser + ' ' + ws + '–' + ls,
          winner + ' storm back from ' + deficit + ' down to stun ' + loser,
          winner + ' come from ' + deficit + ' down to topple ' + loser,
        ], used, 'comeback') });
      }

      // Held off a late comeback: the winner was well clear late and the
      // loser clawed most of it back.
      let lateLead = 0;
      tl.steps.forEach(step => {
        if (step.t < 0.6) return;
        const lead = homeWon ? step.home - step.away : step.away - step.home;
        if (lead > lateLead) lateLead = lead;
      });
      const clawed = lateLead - margin;
      const hold = th.lateHold;
      if (hold && clawed >= hold.drop && margin <= hold.within && deficit < th.comeback) {
        cands.push({ kind: 'holdOff', weight: 90 + clawed / 2, text: pickVariant(rng, [
          winner + ' hold off a late ' + loser + ' comeback to win by ' + margin,
          winner + ' survive a late ' + loser + ' surge, ' + ws + '–' + ls,
          possessive(loser) + ' late charge falls ' + margin + ' short against ' + winner,
          winner + ' hang on as ' + loser + ' close ' + articleFor(clawed) + ' ' + clawed + '-point gap',
        ], used, 'holdOff') });
      }

      // How the game went: how often the lead changed hands, and whether the
      // winner only got in front for good late on.
      let leadChanges = 0, lastSide = 0, tookLead = 0;
      tl.steps.forEach(step => {
        const m = step.home - step.away;
        const side = m > 0 ? 1 : m < 0 ? -1 : 0;
        if (side && lastSide && side !== lastSide) leadChanges++;
        if (side) {
          if (side === (homeWon ? 1 : -1) && lastSide !== side) tookLead = step.t;
          lastSide = side;
        }
      });
      const total = ws + ls;
      const level = total <= th.lowTotal ? 'low' : total >= th.highTotal ? 'high' : 'mid';
      const close = margin <= th.close;
      const golden = sport === 'nrl' && margin === 1 && ws % 2 === 1 && ls % 2 === 0;
      // Only got in front for good in the last quarter (AFL) or the last
      // quarter-hour (NRL), in a tight one: they stole it late.
      const lateFrom = sport === 'afl' ? tl.periods[tl.periods.length - 1].start : 0.8;
      const late = !golden && tookLead >= lateFrom && margin <= th.close && deficit < th.comeback;
      const loserRun = streaks[loser] && streaks[loser].type === 'L' ? streaks[loser].count : 0;
      if (late) {
        cands.push({ kind: 'lateSteal', weight: 96, text: pickVariant(rng, [
          winner + ' steal a win late from ' + loser,
          winner + ' snatch it at the death against ' + loser + ', ' + ws + '–' + ls,
          'Late ' + winner + ' surge breaks ' + possessive(loser) + ' hearts',
          winner + ' pinch a late win over ' + loser,
          winner + ' leave it late to beat ' + loser + ' ' + ws + '–' + ls,
        ], used, 'late') });
      }
      if (close && !late && leadChanges >= th.seesaw) {
        cands.push({ kind: 'seesaw', weight: 82 + leadChanges, text: pickVariant(rng, level === 'low' ? [
          winner + ' edge ' + loser + ' in a tight, see-sawing affair',
          winner + ' win a gripping arm-wrestle with ' + loser + ', ' + ws + '–' + ls,
          winner + ' come out on top of a ' + leadChanges + '-lead-change scrap with ' + loser,
        ] : [
          winner + ' edge ' + loser + ' in an entertaining back-and-forth, ' + ws + '–' + ls,
          winner + ' win a see-sawing blockbuster against ' + loser,
          winner + ' edge ' + loser + ' in a thriller',
          winner + ' get the better of ' + loser + ' in a thriller with ' + leadChanges + ' lead changes',
        ], used, 'seesaw') });
      }
      if (!close && margin >= th.comfy && margin < th.thrashing) {
        cands.push({ kind: 'comfortable', weight: 44 + margin / 10, text: pickVariant(rng, loserRun >= 3 ? [
          winner + ' ease past struggling ' + loser,
          'Struggling ' + loser + ' no match for ' + winner + ', ' + ws + '–' + ls,
          winner + ' dominate out-of-sorts ' + loser,
        ] : [
          winner + ' ease past ' + loser + ', ' + ws + '–' + ls,
          winner + ' dominate ' + loser + ' to win by ' + margin,
          winner + ' cruise to a ' + margin + '-point win over ' + loser,
          winner + ' far too good for ' + loser,
        ], used, 'comfy') });
      }

      // Upset — the underdog by pre-game rating won.
      // Overall strength is attack and defence averaged — a side is only a real
      // underdog if it is behind on both counts, not just one.
      const ovr = t => {
        const r = normRating(ratings[t], config.common);
        return (r.att + r.def) / 2;
      };
      const rw = ovr(winner), rl = ovr(loser);
      // Home ground in the same units. expectedScore() turns an overall rating
      // gap into a margin at 2*W points per rating point, so HOME points of
      // home advantage is worth HOME / (2*W) rating points.
      const homeEdge = cfg.HOME / (2 * cfg.W);
      const gap = rl - rw + (loser === game.home ? homeEdge : -homeEdge);
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
        } else if (late || (close && leadChanges >= th.seesaw)) {
          tag = 'upsetThriller';
          variants = late ? [
            'Underdogs ' + winner + ' steal a win late from ' + loser,
            winner + ' snatch a late upset over ' + loser + ', ' + ws + '–' + ls,
          ] : [
            winner + ' upset ' + loser + ' in a thriller',
            'Underdogs ' + winner + ' edge ' + loser + ' in a thriller, ' + ws + '–' + ls,
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
        cands.push({ kind: 'upset', weight: (tag === 'upsetThriller' ? 100 : 70) + gap / 4, text: pickVariant(rng, variants, used, tag) });
      }

      // The match centre's lead story. Comebacks, upsets and hidings are told
      // on lower bars than the round list, and told together when a game had
      // more than one of them.
      if (only != null) {
        const mc = th.matchCentre;
        const comeback = deficit >= mc.comeback;
        const upset = gap * 2 * cfg.W >= mc.upsetMargin;   // the favourite's expected margin
        const smash = margin >= mc.smashing;
        const score = ws + '–' + ls;
        const golden = sport === 'nrl' && margin === 1 && ws % 2 === 1 && ls % 2 === 0;
        let variants = null, tag;
        if (golden && (comeback || upset)) {
          // Golden point is the headline; the rest is how they got there.
          tag = 'mcGolden';
          variants = comeback ? [
            winner + ' win it in golden point after trailing ' + loser + ' by ' + deficit,
            'Golden point: ' + winner + ' complete a ' + deficit + '-point comeback against ' + loser,
          ] : [
            'Underdogs ' + winner + ' edge ' + loser + ' in golden point',
            winner + ' stun favourites ' + loser + ' in golden point, ' + score,
          ];
        } else if (golden) {
          variants = null;   // the plain golden-point headline already leads
        } else if (comeback && upset) {
          tag = 'mcComebackUpset';
          variants = [
            winner + ' come from ' + deficit + ' down to upset ' + loser + ' ' + score,
            winner + ' stun favourites ' + loser + ' after trailing by ' + deficit,
            'Underdogs ' + winner + ' overturn ' + articleFor(deficit) + ' ' + deficit + '-point deficit to topple ' + loser,
          ];
        } else if (upset && smash) {
          tag = 'mcUpsetSmash';
          variants = [
            winner + ' smash favourites ' + loser + ' by ' + margin,
            'Underdogs ' + winner + ' thump ' + loser + ' ' + score,
            winner + ' tear favourites ' + loser + ' apart, ' + score,
          ];
        } else if (upset && late) {
          tag = 'mcUpsetLate';
          variants = [
            'Underdogs ' + winner + ' steal a win late from ' + loser,
            winner + ' stun ' + loser + ' late, ' + score,
            winner + ' snatch a late upset over ' + loser,
          ];
        } else if (upset && close) {
          tag = 'mcUpsetClose';
          variants = [
            winner + ' upset ' + loser + ' in a thriller',
            winner + ' upset ' + loser + ' in a thriller, ' + score,
            'Underdogs ' + winner + ' edge ' + loser + ' in a thriller',
          ];
        } else if (late) {
          tag = 'mcLate';
          variants = [
            winner + ' steal a win late from ' + loser,
            winner + ' snatch it at the death against ' + loser + ', ' + score,
            winner + ' leave it late to break ' + possessive(loser) + ' hearts',
            'Late ' + winner + ' surge sinks ' + loser,
          ];
        } else if (close && leadChanges >= th.seesaw) {
          tag = 'mcSeesaw';
          variants = level === 'low' ? [
            winner + ' edge ' + loser + ' in a tight, see-sawing affair',
            winner + ' win a gripping arm-wrestle with ' + loser + ', ' + score,
          ] : [
            winner + ' win a see-sawing blockbuster against ' + loser,
            winner + ' edge ' + loser + ' in a thriller, ' + score,
            winner + ' win a thriller against ' + loser,
            winner + ' edge ' + loser + ' in an entertaining back-and-forth',
          ];
        } else if (clawed >= hold.drop * 0.75 && margin <= hold.within) {
          tag = 'mcHoldOff';
          variants = [
            winner + ' hold off a late ' + loser + ' comeback to win by ' + margin,
            winner + ' survive a late surge from ' + loser + ', ' + score,
            possessive(loser) + ' fightback falls ' + margin + ' short against ' + winner,
            winner + ' hang on to beat ' + loser + ' after a nervy finish',
            loser + ' leave their run too late against ' + winner,
            winner + ' weather a late storm to beat ' + loser,
          ];
        } else if (comeback) {
          tag = 'mcComeback';
          variants = [
            winner + ' come from ' + deficit + ' down to beat ' + loser + ' ' + score,
            winner + ' fight back from ' + articleFor(deficit) + ' ' + deficit + '-point hole to beat ' + loser,
            winner + ' overturn ' + articleFor(deficit) + ' ' + deficit + '-point deficit against ' + loser,
            winner + ' recover from a slow start to beat ' + loser,
            winner + ' come from ' + deficit + ' down to topple ' + loser,
            loser + ' let ' + articleFor(deficit) + ' ' + deficit + '-point lead slip against ' + winner,
          ];
        } else if (upset) {
          tag = 'mcUpset';
          variants = margin <= th.narrowUpset ? [
            winner + ' edge favourites ' + loser + ' ' + score,
            'Favourites ' + loser + ' go down narrowly to ' + winner + ', ' + score,
            winner + ' pinch it against fancied ' + loser + ', ' + score,
          ] : [
            winner + ' upset ' + loser + ' ' + score,
            winner + ' stun favourites ' + loser + ' ' + score,
            'Favourites ' + loser + ' fall to ' + winner + ', ' + score,
          ];
        } else if (smash) {
          tag = 'mcSmash';
          variants = [
            winner + ' thrash ' + loser + ' by ' + margin,
            winner + ' put ' + loser + ' to the sword, ' + score,
            winner + ' hammer ' + loser + ' by ' + margin + ' points',
            winner + ' crush ' + loser + ' in a ' + margin + '-point hiding',
            ws >= th.pileOn * 0.9 ? winner + ' pile on ' + ws + ' points to thrash ' + loser : winner + ' run riot against ' + loser + ', ' + score,
          ];
        }
        if (variants) cands.push({ kind: 'story', minor: true, weight: 300, text: pickVariant(rng, variants, used, tag) });
      }

      if (th.shutout && ls === 0) {
        cands.push({ kind: 'shutout', weight: 78, text: pickVariant(rng, [
          winner + ' keep ' + loser + ' scoreless, ' + ws + '–0',
          winner + ' shut out ' + loser + ' ' + ws + '–0',
        ], used, 'shutout') });
      }

      if (margin >= th.thrashing) {
        const lRun = streaks[loser] && streaks[loser].type === 'L' ? streaks[loser].count : 0;
        cands.push({ kind: 'thrashing', weight: 50 + margin, text: pickVariant(rng, lRun >= 3 ? [
          'Struggling ' + loser + ' thrashed by ' + margin + ' against ' + winner,
          winner + ' pile more misery on struggling ' + loser + ', ' + ws + '–' + ls,
          possessive(loser) + ' woes deepen with a ' + margin + '-point thumping by ' + winner,
        ] : [
          winner + ' thrash ' + loser + ' by ' + margin,
          winner + ' hand ' + loser + ' a ' + margin + '-point thumping',
          winner + ' dominate ' + loser + ' from start to finish, ' + ws + '–' + ls,
          winner + ' run riot against ' + loser + ', winning by ' + margin,
          loser + ' flogged by ' + margin + ' as ' + winner + ' run rampant',
        ], used, 'thrash') });
      }

      // A big winning score is its own story, whatever the margin.
      if (th.pileOn && ws >= th.pileOn) {
        cands.push({ kind: 'pileOn', weight: 58 + (ws - th.pileOn) / 2, text: pickVariant(rng, [
          winner + ' pile on ' + ws + ' points to beat ' + loser,
          winner + ' put ' + ws + ' on ' + loser,
          winner + ' rack up ' + ws + ' in a ' + margin + '-point win over ' + loser,
        ], used, 'pileOn') });
      }

      // A tight finish is a story whether or not the favourite lost. Golden
      // point already covers the NRL 1-pointers, so this picks up the rest.
      if (margin <= th.thriller && !(sport === 'nrl' && margin === 1)) {
        // Low-scoring and close is a grind; high-scoring and close, a blockbuster.
        const tLevel = (ws + ls) <= th.lowTotal ? 'low' : (ws + ls) >= th.highTotal ? 'high' : 'mid';
        cands.push({ kind: 'thriller', margin: margin, weight: 68, text: pickVariant(rng, tLevel === 'low' ? [
          winner + ' grind out a win over ' + loser + ', ' + ws + '–' + ls,
          winner + ' edge ' + loser + ' in a tight affair',
          winner + ' win an arm-wrestle with ' + loser + ' by ' + margin,
          winner + ' scrap their way past ' + loser + ', ' + ws + '–' + ls,
        ] : tLevel === 'high' ? [
          winner + ' edge ' + loser + ' in a ' + (ws + ls) + '-point blockbuster',
          winner + ' outlast ' + loser + ' in a shootout, ' + ws + '–' + ls,
          winner + ' win an entertaining thriller against ' + loser,
          winner + ' hold on in a high-scoring classic with ' + loser,
        ] : [
          winner + ' edge ' + loser + ' in an entertaining clash, ' + ws + '–' + ls,
          winner + ' hold on to beat ' + loser + ' by ' + margin,
          winner + ' sneak home by ' + margin + ' against ' + loser,
          winner + ' survive a thriller against ' + loser + ', ' + ws + '–' + ls,
        ], used, 'thriller' + tLevel) });
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
          possessive(winner) + ' ' + ws + ' is the highest score of the season' });
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

    // Minor stories: how the game was won, quarter by quarter (or half by
    // half). Every game has one, so they only ever feed the match centre.
    if (only != null) {
      const fmt = sp => sp.goals + '.' + sp.behinds;
      if (!drawn && tl && sport === 'nrl') {
        const w = homeWon ? 'home' : 'away', l = homeWon ? 'away' : 'home';
        const ht = tl.periods[0].score, ft = tl.periods[1].score;
        const htLead = ht[w].points - ht[l].points;
        const tries2 = ft[w].tries - ht[w].tries, oTries2 = ft[l].tries - ht[l].tries;
        if (htLead < 0) {
          cands.push({ kind: 'secondHalf', minor: true, weight: 36 + -htLead / 2, text: pickVariant(rng, [
            winner + ' turn around ' + articleFor(-htLead) + ' ' + (-htLead) + '-point half-time deficit to beat ' + loser,
            winner + ' trail at the break but beat ' + loser + ' ' + ws + '–' + ls,
            winner + ' come out firing after half-time to topple ' + loser,
            loser + ' lead at the break but fade against ' + winner,
          ], used, 'nrlTurn') });
        }
        if (tries2 >= 3 && tries2 - oTries2 >= 2) {
          cands.push({ kind: 'secondHalfTries', minor: true, weight: 33 + tries2, text: pickVariant(rng, [
            winner + ' pull away after the break to beat ' + loser,
            'A big second half lifts ' + winner + ' past ' + loser,
            winner + ' turn up the heat after half-time to down ' + loser,
          ], used, 'nrl2H') });
        }
        if (htLead >= 6) {
          cands.push({ kind: 'wireToWire', minor: true, weight: 30, text: pickVariant(rng, [
            winner + ' lead at the break and never look back against ' + loser,
            winner + ' build an early lead to beat ' + loser + ' ' + ws + '–' + ls,
            winner + ' jump out of the blocks to beat ' + loser,
            winner + ' set the tone early to account for ' + loser,
            winner + ' lead from start to finish against ' + loser,
          ], used, 'nrlWire') });
        }
      }
      if (!drawn && tl && tl.quarters) {
        const w = homeWon ? 'home' : 'away', l = homeWon ? 'away' : 'home';
        const q = tl.quarters;
        const lead = i => q[i][w].points - q[i][l].points;
        const qtrName = ['first', 'second', 'third', 'last'];
        // The winner's best quarter, by goals kicked against goals conceded.
        let best = 0, bestDiff = -Infinity;
        for (let i = 0; i < 4; i++) {
          const prev = i ? q[i - 1] : { home: { goals: 0, behinds: 0 }, away: { goals: 0, behinds: 0 } };
          const diff = (q[i][w].goals - prev[w].goals) - (q[i][l].goals - prev[l].goals);
          if (diff > bestDiff) { bestDiff = diff; best = i; }
        }
        const prevB = best ? q[best - 1] : { home: { goals: 0, behinds: 0 }, away: { goals: 0, behinds: 0 } };
        const qGoals = q[best][w].goals - prevB[w].goals;
        const qBehinds = q[best][w].behinds - prevB[w].behinds;
        const oGoals = q[best][l].goals - prevB[l].goals;
        const oBehinds = q[best][l].behinds - prevB[l].behinds;

        if (lead(0) > 0 && lead(1) > 0 && lead(2) > 0) {
          cands.push({ kind: 'wireToWire', minor: true, weight: 26, text: pickVariant(rng, [
            winner + ' lead at every change to beat ' + loser + ' ' + ws + '–' + ls,
            winner + ' never headed in a ' + margin + '-point win over ' + loser,
            winner + ' in control from the first bounce against ' + loser,
            winner + ' lead all day to beat ' + loser,
          ], used, 'wire') });
        }
        if (lead(2) <= 0) {
          cands.push({ kind: 'lastQuarter', minor: true, weight: 36, text: pickVariant(rng, [
            winner + ' storm home in the last to beat ' + loser + ' ' + ws + '–' + ls,
            'Final-quarter surge lifts ' + winner + ' past ' + loser,
            winner + ' finish over the top of ' + loser,
            winner + ' kick away late to beat ' + loser,
          ], used, 'lastQ') });
        }
        // A big quarter is only the story if it's the last one, or the one
        // where the winner turned the game around.
        const turned = best > 0 && lead(best - 1) <= 0 && lead(best) > 0;
        if (bestDiff >= 4 && (best === 3 || turned)) {
          cands.push({ kind: 'bigQuarter', minor: true, weight: 33 + bestDiff, text: pickVariant(rng, best === 3 ? [
            possessive(winner) + ' ' + qGoals + '-goal last quarter sinks ' + loser,
            winner + ' finish all over ' + loser + ' with a big last quarter',
          ] : [
            winner + ' turn the game in the ' + qtrName[best] + ' quarter to beat ' + loser,
            'A ' + qGoals + '-goal ' + qtrName[best] + ' quarter turns the tide for ' + winner + ' against ' + loser,
          ], used, 'bigQ') });
        }
      }
      if (!drawn) {
        // Plain results, worded to suit how the game went: a scrap, a
        // comfortable win or a one-sided one.
        const score = ws + '–' + ls;
        const close = margin <= th.close;
        const big = margin >= th.comfy;
        const low = (ws + ls) <= th.lowTotal, high = (ws + ls) >= th.highTotal;
        const variants = close ? (low ? [
          winner + ' grind out a win over ' + loser + ', ' + score,
          winner + ' edge ' + loser + ' in a tight affair',
          winner + ' win a low-scoring scrap with ' + loser,
          loser + ' fall just short in an arm-wrestle with ' + winner,
        ] : high ? [
          winner + ' edge ' + loser + ' in an entertaining shootout, ' + score,
          winner + ' come out on top of a blockbuster with ' + loser,
          loser + ' fall just short in a high-scoring thriller with ' + winner,
        ] : [
          winner + ' edge past ' + loser + ', ' + score,
          winner + ' hang tough to beat ' + loser + ' ' + score,
          loser + ' fall just short against ' + winner,
          winner + ' scrape home against ' + loser,
        ]) : big ? [
          winner + ' hand ' + loser + ' a thumping, ' + score,
          winner + ' ease past ' + loser,
          winner + ' dominate ' + loser + ' to win by ' + margin,
          loser + ' outclassed by ' + winner + ', ' + score,
          winner + ' thrash ' + loser + ' by ' + margin,
        ] : [
          winner + ' too good for ' + loser + ', ' + score,
          winner + ' account for ' + loser + ' ' + score,
          winner + ' get the job done against ' + loser,
          winner + ' down ' + loser + ' ' + score,
          winner + ' prove too strong for ' + loser,
          loser + ' go down to ' + winner + ', ' + score,
        ];
        cands.push({ kind: 'result', minor: true, weight: 1, text: pickVariant(rng, variants, used, 'result' + (close ? 'C' : big ? 'B' : 'M')) });
      }
    }

    const real = only != null ? cands : cands.filter(c => !c.minor);
    if (real.length) {
      real.sort((a, b) => b.weight - a.weight);
      out.push(Object.assign({ gameIdx: gi }, real[0]));
    }
  });
  if (only != null) return out;

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

  // How open the game is: weaker pairings score more (see cfg.weakTempo).
  const pace = cfg.weakTempo
    ? -cfg.weakTempo * (((Rh.att + Rh.def) / 2 + (Ra.att + Ra.def) / 2) / 2 - common.MEAN)
    : 0;
  const expHome = expectedScore(cfg, common, Rh, Ra, true) + pace;
  const expAway = expectedScore(cfg, common, Ra, Rh, false) + pace;

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
      // Two points is a lone penalty goal. Nudge it to nil or a try, keeping
      // the result the same.
      if (loser === 2 && rng() >= cfg.fieldGoal.keepTwo) loser = winner >= 6 && rng() < 0.5 ? 4 : 0;
      if (winner === 2 && rng() >= cfg.fieldGoal.keepTwo) winner = 4;
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

  // NRL: hardly any game finishes with under minGameTotal between the two
  // sides. Top it up with tries, keeping the result: the loser gets one if it
  // still loses, otherwise the winner does; a draw gets one each.
  if (sport === 'nrl' && hs + as < cfg.fieldGoal.minGameTotal && rng() >= cfg.fieldGoal.keepLowTotal) {
    const tryPts = () => (rng() < cfg.fieldGoal.convertRate ? 6 : 4);
    for (let guard = 0; guard < 6 && hs + as < cfg.fieldGoal.minGameTotal; guard++) {
      if (hs === as) { const t = tryPts(); hs += t; as += t; continue; }
      const homeWon = hs > as;
      const w = homeWon ? hs : as, l = homeWon ? as : hs;
      const t = tryPts();
      if (l + t < w) { if (homeWon) as += t; else hs += t; }
      else if (homeWon) hs += t; else as += t;
    }
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
  buildProgression, buildMatchTimeline, buildHeadlines, hashKey,
  generateGoalsBehinds, nrlBreakdown,
};
});
