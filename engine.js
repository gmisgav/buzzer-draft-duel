/* BUZZER — game engine (shared by the app and the calibration script) */
(function (G) {
  const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const ERA_ORDER = ['60s', '70s', '80s', '90s', '00s', '10s', '20s'];

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let DB = null;
  function db() {
    if (DB) return DB;
    const src = Object.assign({}, G.NBA_WEST || {}, G.NBA_EAST || {});
    const teams = {}, pools = [];
    for (const t of Object.keys(src).sort()) {
      teams[t] = { abbr: t, city: src[t].city, eras: [] };
      for (const e of ERA_ORDER) {
        const rows = src[t].eras[e];
        if (!rows || rows.length < 5) continue;
        const players = rows.map((r, i) => ({
          id: t + '-' + e + '-' + i, n: r[0], pos: String(r[1]).split('/').map(s => s.trim()),
          p: +r[2], r: +r[3], a: +r[4], o: +r[5], t, e,
        }));
        teams[t].eras.push(e);
        pools.push({ i: pools.length, t, e, players });
      }
    }
    DB = { teams, pools, teamList: Object.keys(teams).filter(t => teams[t].eras.length) };
    return DB;
  }

  /* Every match is a seed. Both PvP players get the same spins AND the same respin results. */
  function makeSeq(seed) {
    const { pools } = db();
    const R = rng(seed);
    const pick = arr => arr[Math.floor(R() * arr.length)];
    const seq = [];
    for (let r = 0; r < 5; r++) {
      const base = pick(pools);
      const sameEra = pools.filter(p => p.e === base.e && p.t !== base.t);
      const sameTeam = pools.filter(p => p.t === base.t && p.e !== base.e);
      seq.push({
        spin: base.i,
        team: (sameEra.length ? pick(sameEra) : pick(pools)).i,
        era: (sameTeam.length ? pick(sameTeam) : pick(pools)).i,
      });
    }
    return seq;
  }

  function openSlotsFor(player, lineup) {
    return player.pos.filter(p => POS.includes(p) && !lineup[p]);
  }
  function takenNames(lineup) {
    return new Set(Object.values(lineup).filter(Boolean).map(x => x.n));
  }
  function eligible(pool, lineup) {
    const taken = takenNames(lineup);
    return pool.players.filter(p => !taken.has(p.n) && openSlotsFor(p, lineup).length);
  }

  /* Lineup → power → wins out of 82 (deterministic: same five = same record) */
  function score(lineup) {
    const five = POS.map(p => lineup[p]).filter(Boolean);
    const avg = five.reduce((s, x) => s + x.o, 0) / Math.max(1, five.length);
    const pts = five.reduce((s, x) => s + x.p, 0);
    const reb = five.reduce((s, x) => s + x.r, 0);
    const ast = five.reduce((s, x) => s + x.a, 0);
    const chem = [];
    let bonus = 0;
    const stars = five.filter(x => x.o >= 93).length;
    if (stars >= 2) { bonus += 0.6 * (stars - 1); chem.push({ k: 'Superteam', v: +(0.6 * (stars - 1)).toFixed(1) }); }
    if (pts >= 110) { bonus += 1.2; chem.push({ k: 'Firepower', v: 1.2 }); } else if (pts < 75) { bonus -= 1.2; chem.push({ k: 'Can\'t score', v: -1.2 }); }
    if (reb >= 40) { bonus += 0.9; chem.push({ k: 'Glass cleaners', v: 0.9 }); } else if (reb < 28) { bonus -= 1.4; chem.push({ k: 'Soft inside', v: -1.4 }); }
    if (ast >= 24) { bonus += 0.9; chem.push({ k: 'Ball movement', v: 0.9 }); } else if (ast < 13) { bonus -= 1.4; chem.push({ k: 'No playmaker', v: -1.4 }); }
    const eras = new Set(five.map(x => x.e));
    if (eras.size === 1 && five.length === 5) { bonus += 1; chem.push({ k: 'Same-era core', v: 1 }); }
    const power = avg + bonus;
    const wins = Math.max(8, Math.min(82, Math.round(CAL.base + (power - CAL.mid) * CAL.slope)));
    return { power: +power.toFixed(2), avg: +avg.toFixed(1), wins, losses: 82 - wins, pts, reb, ast, chem };
  }
  const CAL = { base: 41, mid: 90, slope: 4.3 };

  /* Bot drafter: skill 0..1 (also used to calibrate the payout ladder) */
  function botPick(pool, lineup, R, skill) {
    const el = eligible(pool, lineup);
    if (!el.length) return null;
    const scored = el.map(p => ({ p, v: p.o + (R() - 0.5) * (1 - skill) * 18 })).sort((a, b) => b.v - a.v);
    return scored[0].p;
  }
  function botDraft(seq, skill, seed) {
    const { pools } = db();
    const R = rng(seed);
    const lineup = {};
    let teamR = 1, eraR = 1;
    const log = [];
    for (let r = 0; r < 5; r++) {
      let pool = pools[seq[r].spin];
      let best = botPick(pool, lineup, R, skill);
      const want = 80 + skill * 6;
      if ((!best || best.o < want) && (teamR || eraR) && R() < 0.4 + skill * 0.6) {
        const alt = pools[teamR ? seq[r].team : seq[r].era];
        if (teamR) teamR = 0; else eraR = 0;
        const b2 = botPick(alt, lineup, R, skill);
        pool = alt; best = b2 || best;
        if (!b2) pool = pools[seq[r].spin];
      }
      if (!best) { log.push(null); continue; }
      const slots = openSlotsFor(best, lineup);
      const slot = slots[0];
      lineup[slot] = best;
      log.push({ slot, player: best, pool: pool.i });
    }
    return { lineup, log, ...score(lineup) };
  }

  /* Beat The Score payout ladder (calibrated in calibrate.js to ~90% RTP for a decent drafter) */
  const LADDER = [
    { w: 47, m: 0.5 }, { w: 53, m: 1.2 }, { w: 59, m: 2 }, { w: 64, m: 3 },
    { w: 70, m: 5 }, { w: 77, m: 10 }, { w: 82, m: 50 },
  ];
  function payoutMult(wins, ladder) {
    let m = 0;
    for (const s of (ladder || LADDER)) if (wins >= s.w) m = s.m;
    return m;
  }

  G.BZ = { POS, ERA_ORDER, rng, db, makeSeq, openSlotsFor, eligible, takenNames, score, botDraft, botPick, LADDER, payoutMult, CAL };
})(typeof window !== 'undefined' ? window : globalThis);
