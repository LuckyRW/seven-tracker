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
check('fatigue taken off a physical skill (x0.05 when exhausted), genetics too', near(base.speed, 100 / (0.05 * 1.25)), base.speed);
check('not off accuracy; its own multiplier is', near(base.accuracy, 50), base.accuracy);
const ez = m.baseOf(attempt({ mods: 'EZ' }), []);
check('EZ halves XP: base doubles it back', near(ez.speed, 200), ez.speed);
// mindblock: 25 passes of the map in the day before fully block accuracy (x0.25), not speed
const before = Array.from({ length: 25 }, (_, i) => attempt({ startedAt: 1e12 - (i + 1) * 60_000 }));
const blocked = m.baseOf(attempt({}), before);
check('25 recent passes: mindblock x0.25 taken off accuracy', near(blocked.accuracy, 400), blocked.accuracy);
check('physical skills are not mindblocked', near(blocked.speed, 100), blocked.speed);

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
	check('progress reads the sent character', p?.levels.speed === 12 && p?.levels.jacks === 5, JSON.stringify(p?.levels));
	check('speed unlocks count upgrades and prestige', p?.speedUpgrades === 2);
}

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
