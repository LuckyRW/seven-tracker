/** 7K tracker: base XP, the rule-outs, the screening grid. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } = await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.seventest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export * from '../src/engine/seven.js';\n`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022', logLevel: 'error',
	plugins: [sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()],
	absWorkingDir: REPO_ROOT,
});
const m = await import(pathToFileURL(join(dir, 'b.mjs')).href);
// the add-on's code reads localStorage: an in-memory one
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// genetics: a pick on speed is strength 1 there, 0.5 beside it (independence, stamina), none further
const g = m.geneticsMultipliers(JSON.stringify({ picks: [{ skill: 'speed' }], genes: { adrenaline: 2, rush: 1, slowBurn: 3 } }));
check('genetic pick: +10% on its skill, plus the XP gene at full strength and +5% a tier', near(g.speed, 1 + 0.1 + 0.05 * 2 + 0.05 * 3), g.speed);
check('half strength beside it', near(g.stamina, 1 + 0.05 + 0.05 * 3), g.stamina);
check('nothing further away', near(g.accuracy, 1), g.accuracy);
check('no genetics: all x1', Object.values(m.geneticsMultipliers('')).every(v => v === 1));

const attempt = (o) => ({ token: String(Math.random()), characterId: 1, beatmapId: 10, rate: 1, mods: '', startedAt: 1e12, fatigue: 0,
	failed: false, gains: { speed: 100, accuracy: 100 }, levels: {}, levelSum: 100, own: {}, genetics: {}, ...o });

// base XP: fatigue comes off physical skills only, multipliers off each skill
const tired = attempt({ fatigue: 1, own: { accuracy: 2 }, genetics: { speed: 1.25 } });
const base = m.baseOf(tired, [tired]);
check('fatigue taken off a physical skill (x0.05 when exhausted), genetics left in', near(base.speed, 100 / 0.05), base.speed);
check('not off accuracy; its own multiplier is', near(base.accuracy, 50), base.accuracy);
const ez = m.baseOf(attempt({ mods: 'EZ' }), []);
check('EZ halves XP: base doubles it back', near(ez.speed, 200), ez.speed);
// mindblock: 25 passes of the map in the day before fully block accuracy (x0.25), not speed
const before = Array.from({ length: 25 }, (_, i) => attempt({ startedAt: 1e12 - (i + 1) * 60_000 }));
const blocked = m.baseOf(attempt({}), before);
check('25 recent passes: mindblock x0.25 taken off accuracy', near(blocked.accuracy, 400), blocked.accuracy);
check('physical skills are not mindblocked', near(blocked.speed, 100), blocked.speed);
// a play without its multipliers takes the nearest play's in time, not today's (a prestige drops them)
const old = attempt({ startedAt: 1e12 - 5 * 864e5, own: { accuracy: 4 } });
const newer = attempt({ startedAt: 1e12 + 5 * 864e5, own: { accuracy: 1.1 } });
const imported = attempt({ startedAt: 1e12 - 4 * 864e5, beatmapId: 11 });
const fromNear = m.baseOf(imported, [old, imported, newer]);
check('no multipliers: the nearest plays are used', near(fromNear.accuracy, 25), fromNear.accuracy);
// a prestige between the plays around it: the multipliers that match the map's other passes win
const accOnly = (x) => ({ accuracy: x });
const prePrestige = attempt({ startedAt: 1e12 - 10 * 864e5, beatmapId: 13, gains: accOnly(400), own: { accuracy: 4 } });
const afterImport = attempt({ startedAt: 1e12, beatmapId: 12, gains: accOnly(100) });
const postPrestige = attempt({ startedAt: 1e12 + 864e5, beatmapId: 13, gains: accOnly(100), own: { accuracy: 1 } });
const sameMap = attempt({ startedAt: 1e12 + 2 * 864e5, beatmapId: 12, gains: accOnly(100), own: { accuracy: 1 } });
const chosen = m.baseOf(afterImport, [prePrestige, afterImport, postPrestige, sameMap]);
check('prestige in between: the multipliers matching the map’s other passes', near(chosen.accuracy, 100), chosen.accuracy);
const beforeImport = attempt({ startedAt: 1e12 - 864e5, beatmapId: 12, gains: accOnly(400) });
const sameMapOld = attempt({ startedAt: 1e12 - 20 * 864e5, beatmapId: 12, gains: accOnly(400), own: { accuracy: 4 } });
const chosenOld = m.baseOf(beforeImport, [sameMapOld, prePrestige, beforeImport, postPrestige]);
check('played before the prestige: the multipliers from before it', near(chosenOld.accuracy, 100), chosenOld.accuracy);

// the rule-outs
const plays = [
	attempt({ rate: 0.8, gains: {} }),               // 0 XP at x0.8: slower rates are out
	attempt({ rate: 1.2, failed: true, levelSum: 100 }), // failed at x1.2: faster rates are out, until a level-up
	attempt({ rate: 1 }),
];
const t = m.testsOf(plays, 100).get('10|');
check('0 XP at x0.8 rules out x0.75', m.statusOf(t, 0.75) === 'too easy');
check('x0.8 itself is tested', m.statusOf(t, 0.8) === 'tested');
check('a fail at x1.2 rules out x1.25', m.statusOf(t, 1.25) === 'too hard');
check('x1.2 itself shows as failed', m.statusOf(t, 1.2) === 'failed');
check('x1.1 is still untested', m.statusOf(t, 1.1) === 'untested');
check('one level-up is not enough by default', m.statusOf(m.testsOf(plays, 101).get('10|'), 1.25) === 'too hard');
check('5 level-ups open the faster rates again', m.statusOf(m.testsOf(plays, 105).get('10|'), 1.25) === 'untested');
check('the number of level-ups can be set', m.statusOf(m.testsOf(plays, 101, { liftAfter: 1, resetAt: 0 }).get('10|'), 1.25) === 'untested');
check('retest failed now lifts every fail so far', m.statusOf(m.testsOf(plays, 100, { liftAfter: 5, resetAt: Infinity }).get('10|'), 1.25) === 'untested');
check('the screening grid: every third, x1 and the fastest',
	m.screenRates([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1]).join() === '0.5,0.65,0.8,0.95,1,1.1');

// a fail rules out every harder map and rate (x1 stars x rate) until a skill levels up
{
	const stars = new Map([[1, 2.0], [2, 3.0], [3, 2.5]]);
	const failed = { beatmapId: 2, rate: 1, mods: '', failed: true, gains: {}, levelSum: 10 };
	const ceiling = m.failCeiling([failed], 10, id => stars.get(id));
	check('fail ceiling is the failed play stars x rate', near(ceiling, 3));
	check('a harder map is ruled out', m.statusOf(undefined, 1.3, 2.5 * 1.3, ceiling) === 'too hard');
	check('an easier map stays open', m.statusOf(undefined, 1, 2.5, ceiling) === 'untested');
	check('the failed play itself shows failed', m.statusOf(m.testsOf([failed], 10).get('2|'), 1, 3, ceiling) === 'failed');
	check('5 level-ups lift the ceiling', m.failCeiling([failed], 15, id => stars.get(id)) === Infinity);
	check('4 do not', m.failCeiling([failed], 14, id => stars.get(id)) === 3);
	check('a passed harder play stays tested', m.statusOf(m.testsOf([{ ...failed, beatmapId: 1, rate: 2, failed: false, gains: { speed: 5 } }], 10).get('1|'), 2, 4, ceiling) === 'tested');
}

// an account character's 7K progress comes from the server's character message, not the table
{
	const kept = m.noteCharacter({ id: 63, ruleset: 'mania7k', skills: { speed: { level: 12, xp: 5, upgrades: 1, overdrive: 1, prestige: 1 }, jacks: { level: 5, xp: 0, upgrades: 0, overdrive: 0, prestige: 0 } } });
	check('a 7K character message is kept', kept === true);
	check('a 4K one is not', m.noteCharacter({ id: 63, ruleset: 'mania4k', skills: {} }) === false);
	const p = await m.progress7k(63);
	check('progress reads the sent character as play levels (prestige added)', p?.levels.speed === 13 && p?.levels.jacks === 5, JSON.stringify(p?.levels));
	check('speed unlocks count upgrades and prestige', p?.speedUpgrades === 2);
	// play levels: an upgrade dropped speed's Upgrades level to 2, but its lifetime XP is still level 12's
	m.noteCharacter({ id: 64, ruleset: 'mania7k', skills: { speed: { level: 2, xp: 0, upgrades: 1, overdrive: 1, prestige: 1, lifetimeXp: 0 } } });
	const q = await m.progress7k(64);
	check('a skill with no lifetime XP plays at its level plus prestige', q?.levels.speed === 3, JSON.stringify(q?.levels));
	m.noteCharacter({ id: 65, ruleset: 'mania7k', skills: { speed: { level: 2, xp: 0, upgrades: 1, overdrive: 1, prestige: 0, lifetimeXp: 1e6 } } });
	const r = await m.progress7k(65);
	check('lifetime XP keeps the play level up after an upgrade', (r?.levels.speed ?? 0) > 2, JSON.stringify(r?.levels));
}

// screening: x1 first, then a step slower, a step faster...; slower only while XP/s rose; faster while passing
{
	check('ring order', m.ringOrder([0.9, 0.95, 1, 1.05, 1.1]).join() === '1,0.95,1.05,0.9,1.1');
	const rule = { liftAfter: 5, resetAt: 0, minAccuracy: 95 };
	const play = (rate, o = {}) => ({ token: String(Math.random()), characterId: 1, beatmapId: 7, rate, mods: '', startedAt: 1, fatigue: 0,
		failed: false, accuracy: 0.97, gains: { speed: 10 }, levels: {}, levelSum: 50, own: {}, genetics: {}, ...o });
	const ctx = (xps = {}) => ({ levelSum: 50, rule, stars: 2, ceiling: Infinity, xpsAt: r => xps[Math.round(r * 100) / 100] });
	const st = (plays, rate, xps, c) => m.screenState(m.testsOf(plays, 50, rule).get('7|'), rate, c ?? ctx(xps));
	check('x1 is open first', st([], 1) === 'open');
	check('x0.95 waits for x1', st([], 0.95) === 'waiting');
	check('x1.05 waits for x1', st([], 1.05) === 'waiting');
	check('after an x1 pass, x0.95 and x1.05 open', st([play(1)], 0.95) === 'open' && st([play(1)], 1.05) === 'open');
	check('slower gave more XP/s: x0.9 opens', st([play(1), play(0.95)], 0.9, { 1: 10, 0.95: 12 }) === 'open');
	check('slower gave less: x0.9 is out', st([play(1), play(0.95)], 0.9, { 1: 10, 0.95: 8 }) === 'slower is worse');
	check('x1 failed: x0.95 opens (slower may pass)', st([play(1, { failed: true })], 0.95) === 'open');
	check('x1 failed: x1.05 is too hard', st([play(1, { failed: true })], 1.05) === 'too hard');
	check('a fail at x1.05 closes x1.1', st([play(1), play(1.05, { failed: true })], 1.1) === 'too hard');
	{
		const low = { ...rule, topM: 10, skipSteps: 3 };
		const c = (xps, extra = {}) => ({ ...ctx(xps), rule: low, topCut: 20, maxRate: 1.5, ...extra });
		const at = (plays, rate, xps, extra) => m.screenState(m.testsOf(plays, 50, low).get('7|'), rate, c(xps, extra));
		check('a clean x1 pass outside the top closes x0.95', at([play(1)], 0.95, { 1: 10 }) === 'too little XP');
		check('a sloppy one does not', at([play(1, { accuracy: 0.9 })], 0.95, { 1: 10 }) === 'open');
		check('nor a clean one in the top', at([play(1)], 0.95, { 1: 25 }) === 'open');
		check('a weak clean x1 skips x1.05 to x1.15', ['1.05', '1.1', '1.15'].every(r => at([play(1)], Number(r), { 1: 10 }) === 'skipped ahead'));
		check('and tries x1.2', at([play(1)], 1.2, { 1: 10 }) === 'open');
		check('x1.25 waits for x1.2', at([play(1)], 1.25, { 1: 10 }) === 'waiting');
		check('near the top, the fastest rate is tried', at([play(1), play(1.4)], 1.5, { 1: 25, 1.4: 10 }) === 'open' && at([play(1), play(1.4)], 1.45, { 1: 25, 1.4: 10 }) === 'skipped ahead');
		check('a strong pass steps on as before', at([play(1)], 1.05, { 1: 25 }) === 'open');
		check('the fastest unlocked caps the jump', at([play(1)], 1.1, { 1: 10 }, { maxRate: 1.1 }) === 'open');
	}
	check('a pass under 95% stays tested before the level-ups', st([play(1, { accuracy: 0.9 })], 1) === 'tested');
	check('and is replayed after them', m.screenState(m.testsOf([play(1, { accuracy: 0.9 })], 55, rule).get('7|'), 1, { ...ctx(), levelSum: 55 }) === 'retest');
	check('a pass over 95% is never replayed', m.screenState(m.testsOf([play(1)], 99, rule).get('7|'), 1, { ...ctx(), levelSum: 99 }) === 'tested');
}

// reach: nothing far above the hardest pass is screened, unless slowed into range
{
	const stars = new Map([[7, 2], [8, 5]]);
	const passed = { token: 'a', characterId: 1, beatmapId: 7, rate: 1, mods: '', startedAt: 1, fatigue: 0, failed: false, gains: { speed: 5 }, levels: {}, levelSum: 50, own: {}, genetics: {} };
	const reach = m.reachOf([passed], id => stars.get(id), 2);
	check('reach is the hardest pass plus the margin', near(reach, 4));
	check('no passes: no limit', m.reachOf([], id => stars.get(id), 2) === Infinity);
	const rule = { liftAfter: 5, resetAt: 0, minAccuracy: 95, reachMargin: 2 };
	const c = { levelSum: 50, rule, stars: 5, ceiling: Infinity, reach, xpsAt: () => undefined };
	check('a 5 star map at x1 is out of reach', m.screenState(undefined, 1, c) === 'out of reach');
	check('so is x0.85 (4.25)', m.screenState(undefined, 0.85, c) === 'out of reach');
	check('x0.8 (4.0) slowed into reach opens', m.screenState(undefined, 0.8, c) === 'open');
}

// the level total now is the live play levels', not inflated by plays' Upgrades-screen level gains
{
	const play = { failed: false, levelSum: 300, levelSumAfter: 305, levelKind: 'play' };
	check('live play levels win over a play total', m.levelSumNow([play], { levelSum: 301 }) === 301);
	check('without them, the most a play left', m.levelSumNow([play], undefined) === 305);
}

// plays without play levels take the live play's before them (or after, with none before)
{
	const live = (t, sum) => ({ startedAt: t, levelKind: 'play', levels: { speed: sum }, levelSum: sum });
	const old = (t) => ({ startedAt: t, levelKind: 'upgrades', levels: { speed: 3 }, levelSum: 3, levelSumAfter: 4 });
	const out = m.withPlayLevels([old(5), live(10, 200), old(15), live(20, 210)]);
	check('levels from the live play before it', out[2].levelSum === 200 && out[2].levelKind === 'estimated', out[2].levelSum);
	check('none before: the one after', out[0].levelSum === 200, out[0].levelSum);
	check('live plays untouched', out[3].levelSum === 210 && out[3].levelKind === 'play');
	check('no live plays: left as they were', m.withPlayLevels([old(5)])[0].levelSum === 3);
}

// plays without play levels take the live play's before them (or after, with none before)
{
	const live = (t, sum) => ({ startedAt: t, levelKind: 'play', levels: { speed: sum }, levelSum: sum });
	const old = (t) => ({ startedAt: t, levelKind: 'upgrades', levels: { speed: 3 }, levelSum: 3, levelSumAfter: 4 });
	const out = m.withPlayLevels([old(5), live(10, 200), old(15), live(20, 210)]);
	check('levels from the live play before it', out[2].levelSum === 200 && out[2].levelKind === 'estimated', out[2].levelSum);
	check('none before: the one after', out[0].levelSum === 200, out[0].levelSum);
	check('live plays untouched', out[3].levelSum === 210 && out[3].levelKind === 'play');
	check('no live plays: left as they were', m.withPlayLevels([old(5)])[0].levelSum === 3);
}

// imported copies of recorded plays
{
	const a = (t, map, xp, own, token) => attempt({ token: token ?? `t${t}`, startedAt: 1e12 + t * 6e4, beatmapId: map, gains: accOnly(xp), own: own === undefined ? {} : { accuracy: own } });
	const live = a(10, 23, 100, 1, 'live'), copy = a(11, 23, 100, undefined, 'score:9');
	check('an imported copy of a recorded play is dropped', m.withoutCopies([live, copy]).length === 1);
	check('an import with no recorded play is kept', m.withoutCopies([copy]).length === 1);
}


// the level factors (low-level boost, accuracy band) counted at the play level, not the XP level
{
	check('x3 at level 0', near(m.lowLevelBoost(0), 3));
	check('none at 40 and above', near(m.lowLevelBoost(40), 1) && near(m.lowLevelBoost(90), 1));
	check('technical at 95.78%: full at Lv24', near(m.scoreFactor('technical', 24, 0.9578), 1.5));
	check('next to nothing at Lv101', m.scoreFactor('technical', 101, 0.9578) < 0.15, m.scoreFactor('technical', 101, 0.9578));
	const live = (o) => attempt({ levelKind: 'play', accuracy: 0.9578, own: { technical: 1 }, ...o });
	const prestiged = live({ gains: { technical: 300 }, levels: { technical: 101 }, xpLevels: { technical: 24 } });
	const scaled = m.baseOf(prestiged, [prestiged]).technical;
	check('a prestiged skill counted at its play level', near(scaled, 300 * m.levelScale('technical', 24, 101, 0.9578) ** -1) && scaled < 30, scaled);
	const same = live({ token: 's', beatmapId: 98, gains: { technical: 300 }, levels: { technical: 101 }, xpLevels: { technical: 101 } });
	check('XP level = play level: untouched', near(m.baseOf(same, [same]).technical, 300));
	const old = live({ token: 'old', startedAt: 1e12 + 1, beatmapId: 99, gains: { technical: 300 }, levels: { technical: 101 } });
	check('a play without XP levels: the nearest play’s', near(m.baseOf(old, [prestiged, old]).technical, scaled), m.baseOf(old, [prestiged, old]).technical);
}

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
