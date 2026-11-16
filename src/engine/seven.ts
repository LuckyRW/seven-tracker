/**
 * 7K tracker: 7K has no sim API, so maps are measured from real plays.
 *
 * Every 7K play is recorded off the game's socket, from the server's own
 * messages (`shared/play.ts`):
 * - `play:start` names the play's map, rate, mods and ruleset, and how tired
 *   (`fatigue`) and how warmed up (`warmupBar`) the character starts it;
 * - `play:result` says whether it failed, and per skill the XP gained and the
 *   level before the play (`gains[].fromLevel`).
 * The game keeps no failed play locally, so this record is the only one of
 * them.
 *
 * Base XP undoes the server's `applyXpRules` (`server/rulesets/mania/xpRules.ts`):
 * mindblock, fatigue, medals, genetics and mods, and the skill's own multiplier
 * from upgrades, overdrive and prestige (`skillXPMultiplier`). Left in: the
 * accuracy bonus for a first X, and LN genes' bonus on LN maps.
 *
 * Constants are copied from the game's source (Nov 8 2026): the add-on is built
 * against oss!idle 1.3, which has no 7K.
 */

import { beatmapStore, gameDb, type CharacterRow } from '@oss-idle/addon-sdk';
import cubic_bezier from '@oss-idle/shared/math/cubic_bezier';
import lerp from '@oss-idle/shared/math/lerp';
import { modsKey, parseMods, type Mod } from '@oss-idle/shared/mods';
import { playLevelOf } from '@oss-idle/shared/xp';

export const RULESET_7K = 'mania7k';
export const SKILLS_7K = ['accuracy', 'speed', 'stamina', 'jacks', 'independence', 'ln', 'technical', 'focus', 'sv', 'memory'] as const;
const PHYSICAL = new Set<string>(['speed', 'stamina', 'jacks', 'ln']);
const MINDBLOCK = new Set<string>(SKILLS_7K.filter(s => !PHYSICAL.has(s) && s !== 'memory'));

// ---- the server's multipliers ----

/** `upgrades.ts` */
const overdriveMultiplier = (overdrive: number) => Math.max(1, Math.min(overdrive, 2.5 * overdrive ** Math.log10(2)));
const skillXPMultiplier = (upgrades: number, overdrive: number, prestige: number) =>
	(1 + 0.1 * upgrades * overdriveMultiplier(overdrive)) * 1.1 ** prestige;

/** `mindblock.ts`: a map's plays among the character's last 50 in 24 hours. */
const BLOCK_CB = cubic_bezier(.6, 0, .6, 1);
const mindblockFactor = (recentPlays: number) => lerp(1, 0.25, BLOCK_CB(Math.min(1, recentPlays / 25)));
const RECENT_LIMIT = 50;
const RECENT_MS = 24 * 3600 * 1000;

/** `fatigue.ts` */
const fatigueXp = (level: number) => lerp(1, 0.05, level);

/** `mods.ts` and `7k/modXp.ts`: NF and other unranked mods earn nothing, EZ half, HR ×1.1 accuracy. */
const UNRANKED: Mod[] = ['NF', 'AT' as Mod];
const modXp = (mods: readonly Mod[], skill: string) => {
	if (mods.some(m => UNRANKED.includes(m))) return 0;
	return (mods.includes('EZ') ? 0.5 : 1) * (skill === 'accuracy' && mods.includes('HR') ? 1.1 : 1);
};

/** `7k/genes.ts`: the ring, each tree's XP gene, and which skill each gene is on. */
const RING = ['accuracy', 'ln', 'independence', 'speed', 'stamina', 'jacks', 'technical', 'sv', 'memory', 'focus'];
const TREES: Record<string, { xp: string; genes: string[] }> = {
	accuracy: { xp: 'talented', genes: ['talented', 'perfectPitch', 'calibrated', 'cleanStart', 'perfectStart', 'marvelousStart', 'learner', 'busyHands', 'outerFingers', 'chordCohesion'] },
	ln: { xp: 'tailChaser', genes: ['tailChaser', 'holdout', 'lnSpecialist', 'lightTouch', 'shieldBreaker', 'patience', 'letGoTogether', 'cleanLift', 'lnFlow', 'holdOn'] },
	independence: { xp: 'ambidextrous', genes: ['ambidextrous', 'twoMinds', 'splitFocus', 'handsApart', 'fullHands', 'looseFingers', 'firmGrip', 'inversePress', 'composure', 'safeFumble', 'regroup'] },
	speed: { xp: 'adrenaline', genes: ['adrenaline', 'rush', 'quickFingers', 'cleanStreams', 'pacing', 'secondHand', 'ceiling', 'topSpeed', 'comfortZone', 'rollingHands', 'chordPress'] },
	stamina: { xp: 'marathoner', genes: ['marathoner', 'longHaul', 'slowBurn', 'secondBreath', 'chordEndurance', 'deepLungs', 'restStops', 'lowGear', 'ironWrists', 'longSets', 'wellRested', 'quickWarmup', 'stayWarm'] },
	jacks: { xp: 'hammer', genes: ['hammer', 'anvil', 'anchor', 'bounce', 'freshFingers', 'shortRest', 'jackCeiling', 'easyJacks', 'chordjack', 'pump', 'trainedFingers', 'strongMiddle'] },
	technical: { xp: 'sightReader', genes: ['sightReader', 'secondGlance', 'patternSense', 'steadyEyes', 'rhythmSense', 'offBeat', 'twoRhythms', 'shapeReading', 'trillHands', 'settleIn', 'familiarShapes', 'graceNotes'] },
	sv: { xp: 'waveRider', genes: ['waveRider', 'undertow', 'speedReader', 'brake', 'lateLook', 'dejaVu', 'looseMatch', 'oldNews', 'shakeItOff', 'softLanding', 'svSurfer'] },
	memory: { xp: 'thoroughLearner', genes: ['thoroughLearner', 'prodigy', 'beatmapStudy', 'learnFromFailure', 'educatedGuess', 'mapperAdvantage', 'longMemory', 'personalFavorites', 'muscleMemory', 'accurateMemory'] },
	focus: { xp: 'deepFocus', genes: ['deepFocus', 'inTheZone', 'steady', 'smallChokes', 'cleanReleases', 'unshakeable', 'thickSkin', 'flowState', 'clutch', 'attentionSpan', 'slowFade', 'steadyHands', 'anchored', 'secondWind', 'freshStart'] },
};

type Genetics = { picks?: { skill: string }[]; genes?: Record<string, number>; genetic?: string };

/** `genetics.ts` `geneticsXpMultiplier`: the picks' strength, the XP gene at it, and +5% a tier held. */
export const geneticsMultipliers = (json: string): Record<string, number> => {
	let g: Genetics = {};
	try { g = json ? JSON.parse(json) as Genetics : {}; } catch { /* none */ }
	const picked = g.picks?.map(p => p.skill) ?? (g.genetic ? [g.genetic] : []);
	const genes = g.genes ?? {};
	const strength = (skill: string) => {
		const at = RING.indexOf(skill), n = RING.length;
		return picked.reduce((sum, p) => sum + (p === skill ? 1 : p === RING[(at + 1) % n] || p === RING[(at + n - 1) % n] ? 0.5 : 0), 0);
	};
	return Object.fromEntries(Object.entries(TREES).map(([skill, tree]) => {
		const power = strength(skill);
		const tiers = tree.genes.reduce((sum, id) => sum + (genes[id] ?? 0), 0);
		return [skill, 1 + 0.1 * power + 0.05 * (genes[tree.xp] ?? 0) * power + 0.05 * tiers];
	}));
};

// ---- the character ----

export type Progress7k = {
	levels: Record<string, number>;
	own: Record<string, number>;
	genetics: Record<string, number>;
	speedUpgrades: number;
	levelSum: number;
};

type Row = Record<string, number | string>;
/** The 7K character the server last sent (`character` on the game's socket: on connecting, and
 *  whenever it changes), kept so the progress is known before the next one comes. */
const SENT_KEY = 'seven-tracker:character';
/** The character the server last sent in 7K: whose a 7K play is, whichever character the game has selected. */
const sevenCharacterId = (): number | undefined => {
	try { return (JSON.parse(localStorage.getItem(SENT_KEY) ?? 'null') as { id?: number } | null)?.id || undefined; } catch { return undefined; }
};
type SentSkill = { level: number; xp: number; upgrades: number; overdrive: number; prestige: number; lifetimeXp?: number };
type Sent = { id: number; skills: Record<string, SentSkill>; genetics?: unknown; at: number };

/** Keep a `character` message's character when it is in 7K. */
export const noteCharacter = (dto: { id?: number; ruleset?: string; skills?: Record<string, SentSkill>; genetics?: unknown } | undefined): boolean => {
	if (!dto || dto.ruleset !== RULESET_7K || !dto.id || !dto.skills) return false;
	try { localStorage.setItem(SENT_KEY, JSON.stringify({ id: dto.id, skills: dto.skills, genetics: dto.genetics, at: Date.now() } satisfies Sent)); } catch { return false; }
	return true;
};

/** The sent character as the table's columns, when it is this character's. */
const sentRow = (characterId: number): Row | undefined => {
	let sent: Sent | undefined;
	try { sent = JSON.parse(localStorage.getItem(SENT_KEY) ?? 'null') ?? undefined; } catch { return undefined; }
	// the game's local id for a character can differ from the server's: the last one sent is still
	// the character being played
	if (!sent) return undefined;
	if (sent.id !== characterId) console.info(`[7K tracker] character ${characterId} read from the one the server sent (${sent.id})`);
	const row: Row = { characterId, geneticsJson: sent.genetics ? JSON.stringify(sent.genetics) : '' };
	for (const [skill, p] of Object.entries(sent.skills)) {
		row[skill] = p.level; row[`${skill}XP`] = p.xp; row[`${skill}Upgrades`] = p.upgrades;
		row[`${skill}Overdrive`] = p.overdrive; row[`${skill}Prestige`] = p.prestige; row[`${skill}LifetimeXp`] = p.lifetimeXp ?? 0;
	}
	return row;
};

/** The game's API: production's, or the beta's own origin on the beta test server. */
const API_BASE = (() => {
	try { if (/^pbe\./.test(location.hostname)) return location.origin; } catch { /* no location */ }
	return 'https://api.oss.idle.rhythmgamers.net';
})();
const SERVER_FRESH_MS = 10_000;
let served: { at: number; row: Row | undefined } | undefined;

/**
 * The character being played, in 7K, as the server has it: its id from the add-on API's `/me`, its
 * progress from the public `GET /v1/characters/:id?ruleset=mania7k` (level, XP, lifetime XP,
 * upgrades, overdrive and prestige per skill). Undefined offline, as a guest, or for a character
 * reborn into 4K only.
 */
const serverRow = async (): Promise<Row | undefined> => {
	if (served && Date.now() - served.at < SERVER_FRESH_MS) return served.row;
	let row: Row | undefined;
	try {
		const api = (globalThis as { ossIdle?: { api?: { me?: (o?: { ruleset?: string }) => Promise<unknown> } } }).ossIdle?.api;
		const me = await api?.me?.({ ruleset: RULESET_7K }) as { character_id?: number } | undefined;
		const id = Number(me?.character_id);
		if (id) {
			const res = await fetch(`${API_BASE}/v1/characters/${id}?ruleset=${RULESET_7K}`);
			const json = res.ok ? await res.json() as Row & { rulesetLock?: string } : undefined;
			if (json && (!json.rulesetLock || json.rulesetLock === RULESET_7K)) {
				// the server names a skill's level and XP `jacksLevel` / `jacksXp`; the tables, `jacks` / `jacksXP`
				row = { characterId: id, geneticsJson: '' };
				for (const [k, v] of Object.entries(json)) {
					if (k.endsWith('Level') && k !== 'overallLevel') row[k.slice(0, -5)] = v;
					else if (k.endsWith('Xp') && !k.endsWith('TotalXp') && !k.endsWith('LifetimeXp')) row[`${k.slice(0, -2)}XP`] = v;
					else if (/(Upgrades|Overdrive|Prestige|LifetimeXp)$/.test(k)) row[k] = v;
				}
				// genes are not in that answer: the ones the socket last sent
				const sent = sentRow(id);
				if (sent?.geneticsJson) row.geneticsJson = sent.geneticsJson;
			}
		}
		else console.warn('[7K tracker] the add-on API gave no character id for 7K', me);
	} catch (err) { console.warn('[7K tracker] 7K progress not read from the API:', err); }
	served = { at: Date.now(), row };
	return row;
};

/**
 * The character's row of `character_mania7k`. The game keys it on `characterId`, but a
 * database made by an earlier beta can lack that column ("no such column: characterId"):
 * then it is read by whichever key the table has, or as its only row.
 */
const progressRow = async (characterId: number): Promise<Row | undefined> => {
	// the server's own answer first: the character being played, asked of the public API
	const served = await serverRow();
	if (served) return served;
	// an account character's 7K progress is never written to the table (only a guest's is): what
	// the server last sent over the socket comes next
	const sent = sentRow(characterId);
	if (sent) return sent;
	const byKey = (key: string) => gameDb.first<Row>(`SELECT * FROM character_mania7k WHERE ${key} = ?`, [characterId]);
	try { return await byKey('characterId') ?? undefined; } catch { /* no such column */ }
	try {
		const columns = (await gameDb.select<{ name: string }>('PRAGMA table_info(character_mania7k)')).map(c => c.name);
		const key = ['character_id', 'charId', 'id'].find(c => columns.includes(c));
		if (key) return await byKey(key) ?? undefined;
		const rows = await gameDb.select<Row>('SELECT * FROM character_mania7k LIMIT 2');
		return rows.length === 1 ? rows[0] : undefined;
	} catch {
		return undefined;
	}
};

/** The character's 7K progress: its own table, `character_mania7k`. */
/** The last 7K progress read: what a play whose start was missed is recorded with. */
let latestProgress: Progress7k | undefined;

export const progress7k = async (characterId: number): Promise<Progress7k | undefined> => {
	const row = await progressRow(characterId);
	if (!row) return undefined;
	const num = (key: string) => Number(row[key]) || 0;
	// each skill's play level: its lifetime XP's level plus its prestige, as the game shows it. Unlike
	// the Upgrades screen's level, buying an upgrade never takes it down
	const levels = Object.fromEntries(SKILLS_7K.map(s => [s, Math.floor(playLevelOf(num(s), num(`${s}XP`), num(`${s}LifetimeXp`), num(`${s}Prestige`)))]));
	const progress: Progress7k = {
		levels,
		own: Object.fromEntries(SKILLS_7K.map(s => [s, skillXPMultiplier(num(`${s}Upgrades`), num(`${s}Overdrive`), num(`${s}Prestige`))])),
		genetics: geneticsMultipliers(String(row.geneticsJson ?? '')),
		// rates open a step per Speed upgrade and per Speed prestige (rate.ts rateUnlocks)
		speedUpgrades: num('speedUpgrades') + num('speedPrestige'),
		levelSum: Object.values(levels).reduce((a, b) => a + b, 0),
	};
	latestProgress = progress;
	return progress;
};

// ---- the record ----

export type Attempt = {
	token: string;
	characterId: number;
	beatmapId: number;
	rate: number;
	/** `modsKey` */
	mods: string;
	startedAt: number;
	/** 0 rested to 1 exhausted, as the server played it */
	fatigue: number;
	/** the warm-up bar at the start, 0 cold to 1 exhausted */
	bar?: number;
	/** strain minutes at its start, as the game's API had them */
	minutes?: number;
	failed: boolean;
	/** the play's accuracy, 0 to 1 (from its score); unknown for plays recorded before it was kept */
	accuracy?: number;
	/** XP given, per skill */
	gains: Record<string, number>;
	/** each skill's level before the play */
	levels: Record<string, number>;
	levelSum: number;
	/** the level total after it: its result's levels, for when the 7K progress cannot be read */
	levelSumAfter?: number;
	/** which levels these are: play levels (lifetime + prestige, never down), or the Upgrades screen's (older plays) */
	levelKind?: 'play' | 'upgrades';
	own: Record<string, number>;
	genetics: Record<string, number>;
};

const STORE_KEY = 'oss-idle-sim:7k-attempts';
const MAX_ATTEMPTS = 6000;

/** A character's recorded plays, or every one when none are its: the ids the recorder and the panel read may differ. */
export const attemptsOf = (characterId: number): Attempt[] => {
	const all = readAttempts();
	const own = all.filter(a => a.characterId === characterId);
	return own.length ? own : all;
};

export const readAttempts = (): Attempt[] => {
	let all: Attempt[];
	try { all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as Attempt[]; } catch { return []; }
	// a play is kept once, however many recorders saw its result (an add-on loaded twice)
	const seen = new Set<string>();
	return all.filter(a => !seen.has(a.token) && (seen.add(a.token), true));
};
const writeAttempts = (all: Attempt[]): boolean => {
	try { localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(-MAX_ATTEMPTS))); return true; } catch { return false; }
};

/**
 * Plays the recorder never saw (before it was installed, or while it was not running), taken from
 * the game's own database: `score` (map, rate, mods, accuracy, when) joined to `score_xp` (XP per
 * skill). Only passes are saved there, and without the character's levels or multipliers at the
 * time: they are kept like plays whose progress could not be read (today's multipliers, levels
 * since unknown). A score is matched to a recorded play of the same map and rate that started at
 * most 30 minutes before it; the newest scores are left a while for the recorder to take first.
 * Returns how many were added.
 */
let sevenMapCache: Promise<Set<number>> | undefined;
/** Every 7K map's id, from the game's map list (asked once). */
const sevenMapIds = (): Promise<Set<number>> => (sevenMapCache ??= beatmapStore.difficulties()
	.then(list => new Set(list.filter(({ version: v }) => v.mode === 3 && v.keys === 7).map(({ version: v }) => v.id)))
	.catch(() => { sevenMapCache = undefined; return new Set<number>(); }));

export const importScores = async (characterId: number): Promise<number> => {
	let rows: { id: number; beatmapId: number; playedAt: number; rate: number; mods: string; accuracy: number; gains: string }[];
	try {
		await gameDb.ready();
		rows = await gameDb.select(
			`SELECT s.id AS id, s.beatmapId AS beatmapId, s.playedAt AS playedAt, s.rate AS rate, s.mods AS mods, s.accuracy AS accuracy, x.gains AS gains
			 FROM score s LEFT JOIN score_xp x ON x.scoreId = s.id WHERE s.characterId = ? ORDER BY s.playedAt`, [characterId]);
	} catch (err) { console.warn('[7K tracker] the scores could not be read:', err); return 0; }
	// a pass that gave no XP has no score_xp row, and no XP to tell its mode by: a 7K map's has 7 keys
	const sevenMaps = await sevenMapIds();
	const all = readAttempts();
	const imported = new Set(all.filter(a => a.token.startsWith('score:')).map(a => a.token));
	const used = new Set<string>();
	const live = all.filter(a => !a.failed && !a.token.startsWith('score:'));
	const fresh = Date.now() - 2 * 60_000;
	let added = 0;
	let fixed = 0;
	for (const r of rows) {
		const token = `score:${r.id}`;
		if (imported.has(token) || Number(r.playedAt) > fresh) continue;
		let gains: Record<string, number> = {};
		try { gains = JSON.parse(String(r.gains || '{}')) as Record<string, number>; } catch { continue; }
		if (!sevenMaps.has(Number(r.beatmapId)) && !Object.keys(gains).some(k => ONLY_7K.has(k) && gains[k] > 0)) continue;
		const rate = round2(Number(r.rate) || 1);
		const at = Number(r.playedAt);
		// the recorded play it is, if any: the latest of that map and rate started before it
		const match = live
			.filter(a => !used.has(a.token) && a.beatmapId === Number(r.beatmapId) && round2(a.rate) === rate && a.startedAt <= at && at - a.startedAt < 30 * 60_000)
			.at(-1);
		if (match) {
			used.add(match.token);
			// a play kept for whichever character was selected when it ended: the score says whose it was
			if (match.characterId !== characterId) { match.characterId = characterId; fixed++; }
			continue;
		}
		all.push({
			token, characterId, beatmapId: Number(r.beatmapId), rate, mods: modsKey(parseMods(String(r.mods ?? ''))),
			startedAt: at, fatigue: 0, failed: false, accuracy: accuracyOf(r.accuracy), gains,
			levels: {}, levelSum: 0, levelKind: 'upgrades', own: {}, genetics: {},
		});
		added++;
	}
	if (added || fixed) {
		all.sort((a, b) => a.startedAt - b.startedAt);
		writeAttempts(all);
		if (added) console.info(`[7K tracker] ${added} 7K plays taken from the game's scores`);
		if (fixed) console.info(`[7K tracker] ${fixed} 7K plays moved to character ${characterId}, whose scores they are`);
	}
	return added + fixed;
};

/** The medals' multiplier: the same on every skill, so it changes no ranking; typed in by the player. */
export const MEDALS_KEY = 'oss-idle-sim:7k-medals';
export const medals7k = (): number => {
	try { return Number(localStorage.getItem(MEDALS_KEY)) || 1; } catch { return 1; }
};

/** The warm-up bar at a 7K play's start: every start is noted, fails and unrecorded plays
 *  included, so drift (one start's bar to the next's) is not broken by a play that was not kept. */
export type BarMark = { token: string; at: number; bar?: number; characterId: number; /** strain minutes at the start (the API's fatigue.minutes) */ minutes?: number };
const BARS_KEY = 'seven-tracker:bars';
const MAX_BARS = 6000;
export const readBars = (): BarMark[] => {
	try { return JSON.parse(localStorage.getItem(BARS_KEY) ?? '[]') as BarMark[]; } catch { return []; }
};
const noteBar = (mark: BarMark) => {
	const all = readBars();
	if (all.some(m => m.token === mark.token)) return;
	all.push(mark);
	try { localStorage.setItem(BARS_KEY, JSON.stringify(all.slice(-MAX_BARS))); } catch { /* not kept */ }
};

/** A score's accuracy as 0 to 1, whether the server gives a fraction or a percent. */
const accuracyOf = (v: unknown): number | undefined => {
	const n = Number(v);
	if (v === undefined || v === null || !Number.isFinite(n)) return undefined;
	return n > 1.5 ? n / 100 : n;
};

/** Skills only 7K has: a result gaining any of them is a 7K play's. */
const ONLY_7K = new Set(['jacks', 'independence', 'ln', 'technical', 'focus', 'sv']);

type Started = { characterId: number; beatmapId: number; rate: number; mods: string; startedAt: number; fatigue: number; bar?: number; minutes?: number; progress?: Progress7k };

/** What the recorder has seen, for the 7K tab to show. */
export const recorderStatus = {
	sockets: 0,
	/** when it last saw a play message, of any ruleset */
	lastMessage: 0,
	/** 7K plays it saw start and is waiting on */
	waiting: 0,
	recorded: 0,
	/** the last thing that stopped a play being recorded */
	problem: '',
};

/**
 * Record 7K plays off the game's socket. `characterId` names whose plays these are.
 * Returns what stops it.
 */
export const recordPlays = (
	characterId: () => number | undefined,
	onAttempt: () => void,
	/** the signed-in character's strain minutes now (the API's fatigue.minutes), when it can be asked */
	strainNow: () => Promise<number | undefined> = async () => undefined,
): (() => void) => {
	const started = new Map<string, Started>();
	const done = new Set<string>();
	const hooked = new WeakSet<WebSocket>();
	const sockets: WebSocket[] = [];
	/** every 7K map's id, to tell a fail whose start was missed */
	const sevenMaps = new Set<number>();
	void beatmapStore.difficulties()
		.then(list => { for (const { version: v } of list) if (v.mode === 3 && v.keys === 7) sevenMaps.add(v.id); })
		.catch(() => undefined);

	let lastId: number | undefined;
	/** plays seen running in the server's checkpoints, by token */
	const seen = new Map<string, { beatmapId: number; rate: number; mods: string; at: number }>();
	/**
	 * A result whose start the recorder never saw: a 7K play by its skills (7K's own names in
	 * its gains), with the map, rate and mods from its score or the server's checkpoints. How
	 * tired and warm it started is unknown, so fatigue counts as none.
	 */
	const unstarted = (token: string, result: Record<string, unknown>): Started | undefined => {
		const gains = (result.gains ?? []) as { skill: string }[];
		const score = result.score as { beatmapId?: number; rate?: number; mods?: Mod[] } | undefined;
		const state = seen.get(token);
		// a fail gives no XP and names no ruleset: a 7K play when its map, from the server's checkpoints, has 7 keys
		const sevenFail = result.failed === true && state !== undefined && sevenMaps.has(state.beatmapId);
		if (!sevenFail && !gains.some(g => ONLY_7K.has(g.skill))) return undefined;
		const beatmapId = score?.beatmapId ?? state?.beatmapId;
		const id = sevenCharacterId() ?? characterId() ?? lastId;
		if (!beatmapId || id === undefined) { console.warn(`[7K tracker] 7K result ${token.slice(0, 6)} not recorded: ${beatmapId ? 'no character yet' : 'its map is unknown'}`); return undefined; }
		console.info(`[7K tracker] recording a 7K play whose start was not seen: ${beatmapId}`);
		return {
			characterId: id, beatmapId, rate: round2(Number(score?.rate ?? state?.rate) || 1),
			mods: score?.mods ? modsKey(score.mods) : state?.mods ?? '', startedAt: state?.at ?? Date.now(), fatigue: 0,
			// the latest progress read: its play levels, multipliers and genes
			progress: latestProgress,
		};
	};
	let stopped = false;
	const onMessage = (e: MessageEvent) => {
		if (stopped || typeof e.data !== 'string') return;
		// the character as the server has it: 7K's levels, upgrades, overdrive and genes
		if (e.data.includes('"type":"character"')) {
			try {
				const msg = JSON.parse(e.data) as { type?: string; character?: Parameters<typeof noteCharacter>[0] };
				if (msg.type === 'character' && noteCharacter(msg.character)) {
					console.info('[7K tracker] 7K character received');
					if (recorderStatus.problem.startsWith('no 7K progress')) recorderStatus.problem = '';
					onAttempt();
				}
			} catch { /* not JSON */ }
			return;
		}
		if (!e.data.includes('"play:')) return;
		let msg: { type?: string; token?: string; result?: Record<string, unknown> };
		try { msg = JSON.parse(e.data); } catch { return; }
		recorderStatus.lastMessage = Date.now();
		const r = msg.result as { status?: string; ruleset?: string; ok?: boolean; failed?: boolean } | undefined;
		if (msg.type === 'play:start' || msg.type === 'play:result') console.info(`[7K tracker] socket: ${msg.type}${r?.status ? ` ${r.status}` : ''}${r?.ruleset ? ` ${r.ruleset}` : ''}${r?.ok !== undefined ? ` ok=${r.ok}` : ''}${r?.failed !== undefined ? ` failed=${r.failed}` : ''}${msg.token ? ` token=${String(msg.token).slice(0, 6)}` : ''}`);
		if (msg.type === 'play:start' && msg.result?.status === 'ranked' && msg.result.ruleset === RULESET_7K) {
			// a joined start resumes a play (a reload, a rejoin): kept as first seen, or taken up if missed
			if (started.has(String(msg.result.token)) || done.has(String(msg.result.token))) return;
			const r = msg.result as { token: string; beatmapId: number; rate: number; mods?: Mod[]; fatigue?: number; warmupBar?: number };
			const id = sevenCharacterId() ?? characterId() ?? lastId;
			if (id === undefined) { recorderStatus.problem = 'a 7K play started before the character was known'; console.warn('[7K tracker] 7K play not recorded: no character yet'); return; }
			lastId = id;
			const at = Date.now();
			void strainNow().catch(() => undefined).then(minutes => {
				if (minutes !== undefined) play.minutes = minutes;
				if (minutes !== undefined || r.warmupBar !== undefined) noteBar({ token: r.token, at, bar: r.warmupBar, minutes, characterId: id });
			});
			const play: Started = { characterId: id, beatmapId: r.beatmapId, rate: round2(Number(r.rate) || 1), mods: modsKey(r.mods ?? []), startedAt: Date.now(), fatigue: r.fatigue ?? 0, bar: r.warmupBar };
			started.set(r.token, play);
			recorderStatus.waiting = started.size;
			void progress7k(id).then(p => {
				play.progress = p;
				if (!p) recorderStatus.problem = 'no 7K progress row (character_mania7k) for this character: levels and multipliers come from the result alone';
			});
		} else if (msg.type === 'play:state') {
			// a play the game follows or chains into without a start of its own (after a fail, a
			// reconnect, another window): what is known of it from the server's checkpoints
			const s = (msg as { state?: { phase?: string; token?: string; beatmapId?: number; rate?: number; mods?: Mod[] } }).state;
			if (s?.phase === 'active' && s.token && !seen.has(s.token) && s.beatmapId) {
				seen.set(s.token, { beatmapId: s.beatmapId, rate: Number(s.rate) || 1, mods: modsKey(s.mods ?? []), at: Date.now() });
			}
		} else if (msg.type === 'play:result' && msg.token && msg.result?.ok === true) {
			if (done.has(msg.token)) return;
			const play = started.get(msg.token) ?? unstarted(msg.token, msg.result);
			if (!play) return;
			// the score names whose play it was: another character may be selected in the game meanwhile
			const scoredBy = Number((msg.result.score as { characterId?: unknown } | undefined)?.characterId);
			if (scoredBy && scoredBy !== play.characterId) {
				console.info(`[7K tracker] 7K play kept for character ${scoredBy}, not ${play.characterId}`);
				play.characterId = scoredBy;
			}
			// the read at its start failed or has not come back: the last progress read instead, so its
			// multipliers still come out of its XP
			if (!play.progress && latestProgress) {
				console.warn('[7K tracker] 7K progress missing at the play start: the last one read is used');
				play.progress = latestProgress;
			}
			recorderStatus.waiting = started.size - 1;
			done.add(msg.token);
			started.delete(msg.token);
			const gains = (msg.result.gains ?? []) as { skill: string; gained: number; fromLevel: number; toLevel?: number }[];
			// play levels (lifetime + prestige) from the character at the start; without it, the result's
			// own levels, which are the Upgrades screen's
			const playLevels = play.progress !== undefined;
			const levels = playLevels
				? { ...play.progress?.levels }
				: Object.fromEntries(gains.map(g => [g.skill, g.fromLevel]));
			const levelSum = Object.values(levels).reduce((a, b) => a + Number(b), 0);
			const gainedLevels = gains.reduce((sum, g) => sum + Math.max(0, (g.toLevel ?? g.fromLevel) - g.fromLevel), 0);
			const all = readAttempts();
			if (all.some(a => a.token === msg.token)) { console.info('[7K tracker] 7K play already recorded by another recorder'); return; }
			all.push({
				token: msg.token,
				...play,
				failed: msg.result.failed === true,
				accuracy: accuracyOf((msg.result.score as { accuracy?: unknown } | undefined)?.accuracy),
				gains: Object.fromEntries(gains.filter(g => g.gained > 0).map(g => [g.skill, g.gained])),
				levels,
				levelSum,
				// the result's level gains are the Upgrades screen's: added only to that kind of total
				levelSumAfter: playLevels ? undefined : levelSum + gainedLevels,
				levelKind: playLevels ? 'play' : 'upgrades',
				own: play.progress?.own ?? {},
				genetics: play.progress?.genetics ?? {},
			});
			delete (all[all.length - 1] as Partial<Started>).progress;
			const kept = writeAttempts(all);
			if (!kept) { recorderStatus.problem = 'the browser refused to store more: storage is full'; console.warn('[7K tracker] 7K play not stored: localStorage full'); }
			else { recorderStatus.recorded++; recorderStatus.problem = ''; console.info(`[7K tracker] 7K play recorded: ${play.beatmapId} x${play.rate}${msg.result.failed ? ' (failed)' : ''}`); }
			onAttempt();
			// no progress at all: read it now, after the play, and count the play from there (its
			// levels a play late, but the same kind as every other row's)
			if (!playLevels) {
				const token = msg.token;
				void progress7k(play.characterId).then(p => {
					if (!p) return;
					const list = readAttempts();
					const a = list.find(x => x.token === token);
					if (!a) return;
					Object.assign(a, { levels: { ...p.levels }, levelSum: p.levelSum, levelSumAfter: undefined, levelKind: 'play', own: p.own, genetics: p.genetics });
					writeAttempts(list);
					onAttempt();
				}).catch(() => undefined);
			}
		} else if (msg.type === 'play:aborted' && msg.token) {
			started.delete(msg.token);
		}
	};

	const hook = (ws: WebSocket) => {
		if (hooked.has(ws)) return;
		hooked.add(ws);
		sockets.push(ws);
		recorderStatus.sockets++;
		console.info(`[7K tracker] listening on socket ${ws.url.replace(/\?.*/, '')}`);
		ws.addEventListener('message', onMessage);
	};
	// The game's socket is found the next time it sends; a reconnect's when it sends in turn.
	// Other add-ons wrap `send` too, and one that puts back what it found drops this wrapper:
	// it is checked every few seconds and put on again over whatever is there.
	const proto = WebSocket.prototype;
	const original = proto.send;
	let ours: WebSocket['send'] | undefined;
	const arm = () => {
		if (proto.send === ours) return;
		const under = proto.send;
		ours = function (this: WebSocket, ...args: Parameters<WebSocket['send']>) {
			hook(this);
			return under.apply(this, args);
		};
		proto.send = ours;
	};
	arm();
	const timer = setInterval(arm, 3000);
	// a socket opened from now on (a reconnect, a switch of ruleset) is hooked as it is made, so the
	// server's first messages (the character among them) are heard too
	const Original = globalThis.WebSocket;
	const Watched = function (this: unknown, ...args: ConstructorParameters<typeof WebSocket>) {
		const ws = new Original(...args);
		hook(ws);
		return ws;
	} as unknown as typeof WebSocket;
	Watched.prototype = Original.prototype;
	Object.assign(Watched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
	globalThis.WebSocket = Watched;
	(globalThis as { sevenTracker?: unknown }).sevenTracker = recorderStatus;
	const stop = () => {
		stopped = true;
		for (const ws of sockets) ws.removeEventListener('message', onMessage);
		clearInterval(timer);
		if (proto.send === ours) proto.send = original;
		if (globalThis.WebSocket === Watched) globalThis.WebSocket = Original;
	};
	// one recorder only: a copy loaded earlier (a build pasted over another) is stopped
	const g = globalThis as { sevenTrackerStop?: () => void };
	try { g.sevenTrackerStop?.(); } catch { /* already gone */ }
	g.sevenTrackerStop = stop;
	return () => { stop(); if (g.sevenTrackerStop === stop) delete g.sevenTrackerStop; };
};

// ---- what an attempt was worth ----

/** Base XP per skill: the server's multipliers taken back out. Mindblock is counted off the passes before it. */
export const baseOf = (attempt: Attempt, before: readonly Attempt[]): Record<string, number> => {
	const recent = before
		.filter(a => !a.failed && a.characterId === attempt.characterId && a.startedAt < attempt.startedAt && a.startedAt >= attempt.startedAt - RECENT_MS)
		.slice(-RECENT_LIMIT)
		.filter(a => a.beatmapId === attempt.beatmapId).length;
	const block = mindblockFactor(recent);
	const tired = fatigueXp(attempt.fatigue);
	const mods = parseMods(attempt.mods);
	const medals = medals7k();
	return Object.fromEntries(Object.entries(attempt.gains).map(([skill, xp]) => {
		// genetics stay in: base XP is what the character earns with the genes it has (they are kept,
		// per play, in `genetics`)
		// a play recorded without its multipliers: today's, which is closer than none
		const own = attempt.own[skill] || latestProgress?.own[skill] || 1;
		const by = own * medals * modXp(mods, skill)
			* (MINDBLOCK.has(skill) ? block : 1) * (PHYSICAL.has(skill) ? tired : 1);
		return [skill, by > 0 ? xp / by : 0];
	}));
};

export const totalOf = (xp: Record<string, number>) => Object.values(xp).reduce((a, b) => a + b, 0);

// ---- what is left to test ----

export type RateStatus = 'tested' | 'failed' | 'too easy' | 'too hard' | 'untested';

/** Where a map with these mods stands: the rule-outs, and its attempts by rate. */
export type MapTests = {
	byRate: Map<number, Attempt[]>;
	/** Rates below this gave 0 XP once: slower is only easier. */
	easyAt?: number;
	/** Rates above this failed since the last level-up. */
	hardAt?: number;
};

/**
 * The character's 7K level total now: its progress row's, or, when that cannot be read, the
 * highest any recorded play left it at (a play's levels after it, else before it). The rule-outs
 * from fails lift once this passes the total a fail was played at.
 */
export const levelSumNow = (attempts: readonly Attempt[], progress?: { levelSum: number }): number =>
	// the live play levels when they can be read; only without them, the most any play left them at
	progress ? progress.levelSum : attempts.reduce((most, a) => Math.max(most, a.levelSumAfter ?? a.levelSum), 0);

/**
 * When a fail stops skipping maps: once the level total has gained `liftAfter` levels since it
 * (5 by default), or once it is older than `resetAt` (the player's own "retest fails now").
 */
export type FailRule = {
	liftAfter: number;
	resetAt: number;
	/** a pass under this accuracy, in percent, is screened again after `liftAfter` level-ups: more levels may play it better */
	minAccuracy: number;
	/** screen nothing more than this many stars (x1 stars × rate) above the hardest pass */
	reachMargin: number;
	/** base XP/s a clean pass (at or over `minAccuracy`) must give for slower rates of that map to be screened; 0 is off */
	minXps: number;
};
export const DEFAULT_FAIL_RULE: FailRule = { liftAfter: 5, resetAt: 0, minAccuracy: 95, reachMargin: 2, minXps: 0 };
const FAIL_RULE_KEY = 'seven-tracker:fail-rule';
export const readFailRule = (): FailRule => {
	try { return { ...DEFAULT_FAIL_RULE, ...JSON.parse(localStorage.getItem(FAIL_RULE_KEY) ?? '{}') as Partial<FailRule> }; } catch { return DEFAULT_FAIL_RULE; }
};
export const saveFailRule = (rule: FailRule) => { try { localStorage.setItem(FAIL_RULE_KEY, JSON.stringify(rule)); } catch { /* not kept */ } };
/** Whether a fail still skips maps at level total `levelSum`. */
export const failHolds = (a: Attempt, levelSum: number, rule: FailRule = DEFAULT_FAIL_RULE): boolean =>
	a.failed && !(a.startedAt <= rule.resetAt) && levelSum - a.levelSum < Math.max(1, rule.liftAfter);

export const testsOf = (attempts: readonly Attempt[], levelSum: number, rule: FailRule = DEFAULT_FAIL_RULE): Map<string, MapTests> => {
	const out = new Map<string, MapTests>();
	for (const a of attempts) {
		const key = `${a.beatmapId}|${a.mods}`;
		let t = out.get(key);
		if (!t) out.set(key, t = { byRate: new Map() });
		// rates as the game names them (x0.95): a rate sent as 0.9499999 is the same one
		const rate = round2(a.rate);
		const list = t.byRate.get(rate) ?? [];
		list.push(a);
		t.byRate.set(rate, list);
		if (!a.failed && totalOf(a.gains) <= 0) t.easyAt = Math.max(t.easyAt ?? -Infinity, rate);
		// a fail rules out the faster rates until enough levels are gained, or the player lifts it
		if (failHolds(a, levelSum, rule)) t.hardAt = Math.min(t.hardAt ?? Infinity, rate);
	}
	return out;
};

/**
 * The hardest a play may be, as its x1 stars × rate, before a fail rules it out: the easiest
 * play failed that still holds (see {@link failHolds}), of any map. Infinity when none does.
 * Stars × rate stands in for the stars at that rate, which only the server knows.
 */
export const failCeiling = (attempts: readonly Attempt[], levelSum: number, starsOf: (beatmapId: number) => number | undefined, rule: FailRule = DEFAULT_FAIL_RULE): number => {
	let ceiling = Infinity;
	for (const a of attempts) {
		if (!failHolds(a, levelSum, rule)) continue;
		const stars = starsOf(a.beatmapId);
		if (stars) ceiling = Math.min(ceiling, stars * a.rate);
	}
	return ceiling;
};

/**
 * Where a map stands at a rate. With `hardness` (its x1 stars × rate) and the `ceiling` of
 * {@link failCeiling}, anything harder than a fail that still holds is too hard.
 */
export const statusOf = (t: MapTests | undefined, rate: number, hardness?: number, ceiling = Infinity): RateStatus => {
	const here = t?.byRate.get(rate);
	if (here?.some(a => !a.failed)) return 'tested';
	if (t?.easyAt !== undefined && rate < t.easyAt) return 'too easy';
	if (t?.hardAt !== undefined && rate > t.hardAt) return 'too hard';
	if (hardness !== undefined && hardness > ceiling + 1e-9) return 'too hard';
	if (here?.length) return 'failed';
	return 'untested';
};

const round2 = (rate: number) => Math.round(rate * 100) / 100;

/**
 * The order rates are screened in: x1, then a step slower, a step faster, two slower, two faster
 * and so on, within `rates` (the ones unlocked).
 */
export const ringOrder = (rates: readonly number[]): number[] => {
	const have = new Set(rates.map(round2));
	const out: number[] = have.has(1) ? [1] : [];
	for (let k = 1; k <= 20; k++) {
		for (const r of [round2(1 - 0.05 * k), round2(1 + 0.05 * k)]) if (have.has(r)) out.push(r);
	}
	return out;
};

export type ScreenState =
	/** passed: measured */
	| 'tested'
	/** to play now */
	| 'open'
	/** passed under the accuracy bar, and enough level-ups since: to play again */
	| 'retest'
	/** opens once the rate next to it towards x1 is played */
	| 'waiting'
	/** the rate a step faster gave less XP/s than the one faster still: slower only gets worse */
	| 'slower is worse'
	/** a faster rate was passed cleanly (at the accuracy bar) and still gave too little XP/s */
	| 'too little XP'
	/** a rate at or above it gave 0 XP */
	| '0 XP'
	/** failed here, and not enough level-ups since */
	| 'failed'
	/** a fail at a slower rate, or on an easier map, holds */
	| 'too hard'
	/** far harder (x1 stars × rate) than the hardest play passed yet */
	| 'out of reach'
	/** checked off by hand: screening skips it */
	| 'checked off';

// ---- maps checked off by hand ----

/** Map and rate (`beatmapId@rate`), or a whole map (`beatmapId@*`), that screening skips: kept across restarts. */
const CHECKED_KEY = 'seven-tracker:checked';
export const readChecked = (): Set<string> => {
	try { return new Set(JSON.parse(localStorage.getItem(CHECKED_KEY) ?? '[]') as string[]); } catch { return new Set(); }
};
const writeChecked = (set: Set<string>) => { try { localStorage.setItem(CHECKED_KEY, JSON.stringify([...set])); } catch { /* not kept */ } };
export const checkedKey = (beatmapId: number, rate?: number) => `${beatmapId}@${rate === undefined ? '*' : round2(rate)}`;
/** Check a map at a rate (or every rate) off, or back on. */
export const toggleChecked = (beatmapId: number, rate?: number): boolean => {
	const set = readChecked();
	const key = checkedKey(beatmapId, rate);
	const on = !set.has(key);
	if (on) set.add(key); else set.delete(key);
	writeChecked(set);
	return on;
};
export const clearChecked = () => writeChecked(new Set());
export const isChecked = (set: Set<string>, beatmapId: number, rate: number) => set.has(checkedKey(beatmapId)) || set.has(checkedKey(beatmapId, rate));

/**
 * How hard a play may be (x1 stars × rate) to be screened: `margin` stars above the hardest play
 * passed yet. Infinity before any pass, so the first plays find where the character stands.
 */
export const reachOf = (attempts: readonly Attempt[], starsOf: (beatmapId: number) => number | undefined, margin: number): number => {
	let hardest = -Infinity;
	for (const a of attempts) {
		const stars = !a.failed ? starsOf(a.beatmapId) : undefined;
		if (stars) hardest = Math.max(hardest, stars * a.rate);
	}
	return hardest === -Infinity ? Infinity : hardest + margin;
};

export type ScreenContext = {
	/** the level total now ({@link levelSumNow}) */
	levelSum: number;
	rule: FailRule;
	/** the map's base XP / s at a rate, from its last pass there */
	xpsAt: (rate: number) => number | undefined;
	/** the map's x1 stars */
	stars: number;
	/** {@link failCeiling} */
	ceiling: number;
	/** the hardest a play may be (x1 stars × rate) to be screened: {@link reachOf} */
	reach?: number;
	/** the map, and the maps and rates checked off by hand ({@link readChecked}) */
	beatmapId?: number;
	checked?: Set<string>;
};

/**
 * Where a map stands at a rate in screening. From x1 outwards, a step at a time:
 * - slower: a rate opens once the one a step faster is played; if that one failed, slower may
 *   pass; if it passed, slower stays open only while going slower raised XP/s (from x1 down);
 * - faster: a rate opens once the one a step slower passed; a fail closes everything faster (and
 *   every harder map) until the level-ups the rule asks for;
 * - a pass under the accuracy bar opens again after the same level-ups.
 */
export const screenState = (t: MapTests | undefined, rate: number, c: ScreenContext): ScreenState => {
	const r = round2(rate);
	if (c.beatmapId !== undefined && c.checked && isChecked(c.checked, c.beatmapId, r)) return 'checked off';
	const at = (x: number) => t?.byRate.get(round2(x)) ?? [];
	const passed = (x: number) => at(x).some(a => !a.failed);
	const last = at(r).filter(a => !a.failed).at(-1);
	if (last) {
		const low = last.accuracy !== undefined && last.accuracy * 100 < c.rule.minAccuracy;
		return low && c.levelSum - last.levelSum >= Math.max(1, c.rule.liftAfter) ? 'retest' : 'tested';
	}
	if (t?.easyAt !== undefined && r < t.easyAt) return '0 XP';
	// a faster rate played cleanly that still gave too little: slower plays it no better
	if (c.rule.minXps > 0 && t) for (const [x, list] of t.byRate) {
		if (x <= r) continue;
		const clean = list.filter(a => !a.failed).at(-1);
		const xps = clean && c.xpsAt(x);
		if (clean?.accuracy !== undefined && clean.accuracy * 100 >= c.rule.minAccuracy && xps !== undefined && xps < c.rule.minXps) return 'too little XP';
	}
	const reach = c.reach ?? Infinity;
	if (c.stars * r > reach + 1e-9) return 'out of reach';
	if (at(r).some(a => failHolds(a, c.levelSum, c.rule))) return 'failed';
	if (r >= 1) {
		if (t?.hardAt !== undefined && r > t.hardAt) return 'too hard';
		if (c.stars * r > c.ceiling + 1e-9) return 'too hard';
		return r === 1 || passed(r - 0.05) ? 'open' : 'waiting';
	}
	const faster = round2(r + 0.05);
	// the rate a step faster is out of reach: this one, slowed into reach, is where the map starts
	if (c.stars * faster > reach + 1e-9 && !at(faster).length) return 'open';
	if (!at(faster).length) return 'waiting';
	if (!passed(faster)) return 'open';
	if (faster >= 1) return 'open';
	const here = c.xpsAt(faster) ?? 0;
	const above = c.xpsAt(faster + 0.05);
	return above === undefined || here > above ? 'open' : 'slower is worse';
};

/** Every third rate, x1 and the fastest: addon-sim's screening grid (`screenRates`). */
export const screenRates = (rates: readonly number[]): number[] =>
	rates.length <= 5 ? [...rates] : rates.filter((rate, i) => i % 3 === 0 || i === rates.length - 1 || rate === 1);

export { modsKey, parseMods };
