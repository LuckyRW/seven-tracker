/**
 * The 7K tracker's panel, laid out like oss!idle sim's: a Playlist tab (the maps you picked,
 * each repeated so many times, and what a loop of them is worth), an All maps tab (every map
 * and rate measured from your plays, best first) and a Testing tab (what is left to test, and
 * playlists that test it). See `engine/seven.ts`.
 */

import { useEffect, useMemo, useState } from 'react';
import { beatmapStore, type CharacterRow } from '@oss-idle/addon-sdk';
import { rateSteps } from '@oss-idle/shared/rate';
import { replacePlaylist } from '../engine/playlist.js';
import {
	attemptsOf, baseOf, failCeiling, levelSumNow, readFailRule, saveFailRule, type FailRule, MEDALS_KEY, medals7k, progress7k, readBars, recorderStatus, reachOf, ringOrder, screenState, testsOf, totalOf, type ScreenState,
	type Attempt, type Progress7k,
	importScores, readChecked, clearChecked,
} from '../engine/seven.js';
import { formatTime, formatXp, NumberField, skillBreakdown, skillLabel, Tip } from './parts.js';

type Map7k = { beatmapId: number; title: string; artist: string; version: string; difficulty: number; lengthSec: number };

/** A map tested at a rate: its last pass, worth so much base XP a second. */
type Measured = {
	map: Map7k;
	rate: number;
	perSecond: number;
	/** base XP / s by skill */
	skills: Record<string, number>;
	top: string;
	topPerSecond: number;
	level?: number;
	at: number;
	plays: number;
	fails: number;
	/** mean strain minutes added per play, start to the next play's start (less than 0 rests) */
	drift?: number;
	/** base XP / s of the pass before the last at this rate */
	prevPerSecond?: number;
	/** the level total at its last pass, to tell how far you have come since */
	levelSum: number;
	/** whether that total is in play levels (lifetime + prestige) or, for older plays, the Upgrades screen's */
	playLevels: boolean;
};

type Tab = 'playlist' | 'maps' | 'recent' | 'testing';

const MAX_ENTRIES_DEFAULT = 200;
const MAX_REPEAT = 100;

/** The maps picked for your playlist, by `beatmapId@rate`, with each one's repeat count: kept across restarts. */
const PICKED_KEY = 'seven-tracker:picked';
/** The order they were picked in: the playlist plays them in it. */
const ORDER_KEY = 'seven-tracker:picked-order';
const TAB_KEY = 'seven-tracker:tab';
const MIX_KEY = 'seven-tracker:mix';
const RECENT_SHOWN = 100;
/** Every rate, not only Speed's: off unless ticked (a new key, so it starts off once Speed can be read). */
const ALL_RATES_KEY = 'seven-tracker:every-rate';
/** Speed unlocks that open every rate, x0.5 to x1.5. */
const ALL_RATE_STEPS = 10;

const load = <T,>(key: string, fallback: T): T => {
	try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v) as T; } catch { return fallback; }
};
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ } };

const rowKey = (row: { map: { beatmapId: number }; rate: number }) => `${row.map.beatmapId}@${row.rate}`;
const signed = (n: number, digits = 1) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
/** The last pass against the one before it at the same rate: green more, red less, an arrow from 5%. */
const changeOf = (row: { perSecond: number; prevPerSecond?: number }) =>
	row.prevPerSecond ? row.perSecond / row.prevPerSecond - 1 : undefined;
const changeColor = (row: { perSecond: number; prevPerSecond?: number }) => {
	const c = changeOf(row);
	return c === undefined || Math.abs(c) < 0.005 ? undefined : c > 0 ? '#4ade80' : '#f87171';
};
const changeArrow = (row: { perSecond: number; prevPerSecond?: number }) => {
	const c = changeOf(row);
	return c === undefined || Math.abs(c) < 0.05 ? '' : c > 0 ? ' ▲' : ' ▼';
};
const changeNote = (row: { perSecond: number; prevPerSecond?: number }) => {
	const c = changeOf(row);
	return c === undefined ? '' : `${c >= 0 ? '+' : ''}${(c * 100).toFixed(1)}% on the pass before (${formatXp(row.prevPerSecond ?? 0)} base XP/s)
`;
};

/** Levels gained since a pass: how far out of date its numbers may be. */
const sinceLabel = (n: number) => (n > 0 ? `+${n}` : '0');
const driftColor = (d?: number) => (d === undefined ? 'var(--faint, #888)' : d > 0 ? '#f87171' : '#38bdf8');

/** A map's title and, under it, its difficulty, stars and length at its rate. */
function MapName({ map, rate }: { map: Map7k; rate: number }) {
	return (
		<div className="map">
			<div className="title">{map.artist} - {map.title}</div>
			<div className="sub">{map.version} · {map.difficulty.toFixed(2)}★ · {formatTime(map.lengthSec / rate)}</div>
		</div>
	);
}

export default function SevenView({ character, version, onClose }: { character?: CharacterRow; version: number; onClose: () => void }) {
	const [tab, setTabState] = useState<Tab>(() => load<Tab>(TAB_KEY, 'playlist'));
	const setTab = (t: Tab) => { setTabState(t); keep(TAB_KEY, t); };
	const [maps, setMaps] = useState<Map7k[]>([]);
	const [progress, setProgress] = useState<Progress7k>();
	const [attempts, setAttempts] = useState<Attempt[]>([]);
	const [medals, setMedals] = useState(medals7k());
	const [saved, setSaved] = useState('');

	// the recorder's status changes on its own: drawn again every few seconds
	const [, setTick] = useState(0);
	useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 2000); return () => clearInterval(t); }, []);

	useEffect(() => {
		void beatmapStore.difficulties().then(list => setMaps(list
			.filter(({ version: v }) => v.mode === 3 && v.keys === 7)
			.map(({ set, version: v }) => ({
				beatmapId: v.id, title: set.title, artist: set.artist, version: v.version, difficulty: v.difficulty, lengthSec: v.total_length / 1000,
			}))))
			.catch(() => setMaps([]));
	}, []);
	useEffect(() => {
		if (!character) return;
		void progress7k(Number(character.id)).then(setProgress);
		setAttempts(attemptsOf(Number(character.id)));
	}, [character?.id, version]);
	// plays the recorder missed, from the game's own scores: on opening, then every minute
	useEffect(() => {
		if (!character) return;
		const id = Number(character.id);
		const take = () => void importScores(id).then(n => { if (n) setAttempts(attemptsOf(id)); });
		take();
		const timer = setInterval(take, 60_000);
		return () => clearInterval(timer);
	}, [character?.id]);

	const byId = useMemo(() => new Map(maps.map(m => [m.beatmapId, m])), [maps]);
	// the rates the character's Speed has unlocked, or every rate there is
	// kept as true, or as '1' (which reads back as 1) by an earlier version
	const [allRates, setAllRatesState] = useState(() => { const v = load<unknown>(ALL_RATES_KEY, false); return v === true || v === 1; });
	const setAllRates = (on: boolean) => { setAllRatesState(on); keep(ALL_RATES_KEY, on); };
	// the rates your 7K Speed has unlocked (upgrades and prestiges); every rate when ticked, or while
	// Speed cannot be read yet
	const speedKnown = progress !== undefined;
	const rates = useMemo(() => rateSteps(allRates || !speedKnown ? ALL_RATE_STEPS : progress.speedUpgrades), [allRates, speedKnown, progress?.speedUpgrades]);
	// every unlocked rate, screened from x1 outwards: x1, a step slower, a step faster, two slower...
	const rings = useMemo(() => ringOrder(rates), [rates]);
	const levelNow = useMemo(() => levelSumNow(attempts, progress), [attempts, progress]);
	const [failRule, setFailRuleState] = useState<FailRule>(readFailRule);
	const setFailRule = (rule: FailRule) => { setFailRuleState(rule); saveFailRule(rule); };
	const tests = useMemo(() => testsOf(attempts, levelNow, failRule), [attempts, levelNow, failRule]);
	// a fail rules out every harder map and rate too, until a skill levels up
	const ceiling = useMemo(() => failCeiling(attempts, levelNow, id => byId.get(id)?.difficulty, failRule), [attempts, levelNow, byId, failRule]);
	const holding = attempts.filter(a => a.failed && a.startedAt > failRule.resetAt && levelNow - a.levelSum < Math.max(1, failRule.liftAfter)).length;
	// nothing far harder than the hardest play passed yet (slowed into reach, a harder map still is)
	const reach = useMemo(() => reachOf(attempts, id => byId.get(id)?.difficulty, failRule.reachMargin ?? 2), [attempts, byId, failRule.reachMargin]);
	// maps checked off by hand (in the song select box): read again whenever the panel redraws
	const checked = readChecked();
	const stateAt = (m: Map7k, rate: number): ScreenState => screenState(tests.get(`${m.beatmapId}|`), rate, {
		levelSum: levelNow, rule: failRule, stars: m.difficulty, ceiling, reach, beatmapId: m.beatmapId, checked,
		topCut: failRule.topM > 0 ? bestRows[failRule.topM - 1]?.perSecond : undefined, maxRate: rates[rates.length - 1],
		xpsAt: r => byKey.get(`${m.beatmapId}@${Math.round(r * 100) / 100}`)?.perSecond,
	});

	const measured = useMemo(() => {
		const rows: Measured[] = [];
		const ordered = [...attempts].sort((a, b) => a.startedAt - b.startedAt);
		// drift in strain minutes, as the game's API counts them at each 7K start (fails and
		// unrecorded plays included): a play's drift is the change to the next start
		const id = Number(character?.id);
		const marks = [
			...readBars().filter(m => m.characterId === id && m.minutes !== undefined).map(m => ({ at: m.at, minutes: m.minutes as number })),
			...ordered.filter(a => a.minutes !== undefined).map(a => ({ at: a.startedAt, minutes: a.minutes as number })),
		].sort((a, b) => a.at - b.at);
		const drifts = new Map<string, number[]>();
		for (const a of ordered) {
			const map = byId.get(a.beatmapId);
			if (!map || a.minutes === undefined) continue;
			const next = marks.find(m => m.at > a.startedAt + 1000);
			// the next play started soon after: the change is this play's, and the wait after it
			if (!next || next.at - a.startedAt > (map.lengthSec / a.rate + 600) * 1000) continue;
			const key = `${a.beatmapId}@${a.rate}@${a.mods}`;
			drifts.set(key, [...drifts.get(key) ?? [], next.minutes - a.minutes]);
		}
		for (const [key, t] of tests) {
			const [mapId, mods] = key.split('|');
			if (mods) continue; // no mods only, for now
			const map = byId.get(Number(mapId));
			if (!map) continue;
			for (const [rate, list] of t.byRate) {
				const passes = list.filter(a => !a.failed);
				const last = passes.at(-1);
				if (!last) continue;
				const base = baseOf(last, ordered);
				const seconds = map.lengthSec / rate;
				const [top, topXp] = Object.entries(base).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
				const d = drifts.get(`${mapId}@${rate}@`);
				const before = passes.at(-2);
				const prevPerSecond = before ? totalOf(baseOf(before, ordered)) / seconds : undefined;
				rows.push({
					map, rate, perSecond: totalOf(base) / seconds, skills: Object.fromEntries(Object.entries(base).map(([s, xp]) => [s, xp / seconds])), top, topPerSecond: topXp / seconds,
					level: top ? last.levels[top] : undefined, at: last.startedAt, plays: list.length, fails: list.length - passes.length, levelSum: last.levelSum, playLevels: last.levelKind === 'play',
					drift: d?.length ? d.reduce((x, y) => x + y, 0) / d.length : undefined,
					prevPerSecond,
				});
			}
		}
		return rows.sort((a, b) => b.perSecond - a.perSecond);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tests, byId, attempts, medals]);
	const byKey = useMemo(() => new Map(measured.map(r => [rowKey(r), r])), [measured]);
	const ordered = useMemo(() => [...attempts].sort((a, b) => a.startedAt - b.startedAt), [attempts]);
	const recent = useMemo(() => ordered.slice(-RECENT_SHOWN).reverse(), [ordered]);

	// ---- your playlist ----
	const [picked, setPickedState] = useState<Record<string, number>>(() => load(PICKED_KEY, {}));
	const [order, setOrderState] = useState<string[]>(() => load<string[]>(ORDER_KEY, []));
	const [pickedName, setPickedName] = useState('7K farm');
	const setPicked = (next: Record<string, number>) => {
		setPickedState(next);
		keep(PICKED_KEY, next);
		// the order follows what is picked: new ones at the end, removed ones gone
		const kept = order.filter(k => next[k]);
		for (const k of Object.keys(next)) if (!kept.includes(k)) kept.push(k);
		setOrderState(kept);
		keep(ORDER_KEY, kept);
	};
	const toggle = (key: string) => {
		const next = { ...picked };
		if (next[key]) delete next[key]; else next[key] = 1;
		setPicked(next);
	};
	const rotation = [...order, ...Object.keys(picked).filter(k => !order.includes(k))]
		.filter(k => picked[k] && byKey.has(k))
		.map(k => byKey.get(k) as Measured);
	const loop = rotation.reduce((sum, row) => {
		const times = picked[rowKey(row)];
		const seconds = row.map.lengthSec / row.rate * times;
		const skills = { ...sum.skills };
		for (const [skill, v] of Object.entries(row.skills)) skills[skill] = (skills[skill] ?? 0) + v * seconds;
		return {
			plays: sum.plays + times,
			seconds: sum.seconds + seconds,
			xp: sum.xp + row.perSecond * seconds,
			drift: sum.drift + (row.drift ?? 0) * times,
			unknownDrift: sum.unknownDrift || row.drift === undefined,
			skills,
		};
	}, { plays: 0, seconds: 0, xp: 0, drift: 0, unknownDrift: false, skills: {} as Record<string, number> });
	const savePicked = async () => {
		if (!rotation.length) return;
		setSaved('Saving...');
		try {
			const { created } = await replacePlaylist(pickedName, rotation.map(row => ({ beatmapId: row.map.beatmapId, rate: row.rate, mods: [], repeat: picked[rowKey(row)] })));
			setSaved(`${created ? 'Created' : 'Updated'} "${pickedName}" with ${rotation.length} maps (${loop.plays} plays a loop). Reopen song select to see it.`);
		} catch (e) {
			setSaved(e instanceof Error ? e.message : String(e));
		}
	};

	// ---- all maps ----
	const [query, setQuery] = useState('');
	const [everyRate, setEveryRate] = useState(false);
	const [driftFilter, setDriftFilter] = useState<'all' | 'warm' | 'cool'>('all');
	const listed = useMemo(() => {
		let list = measured;
		if (!everyRate) {
			const seen = new Set<number>();
			list = list.filter(r => !seen.has(r.map.beatmapId) && (seen.add(r.map.beatmapId), true));
		}
		if (driftFilter === 'warm') list = list.filter(r => r.drift !== undefined && r.drift > 0);
		if (driftFilter === 'cool') list = list.filter(r => r.drift !== undefined && r.drift <= 0);
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (words.length) list = list.filter(r => words.every(w => `${r.map.artist} ${r.map.title} ${r.map.version}`.toLowerCase().includes(w)));
		return list;
	}, [measured, everyRate, driftFilter, query]);

	/** each difficulty at its best rate, best first */
	const bestRows = useMemo(() => {
		const seen = new Set<number>();
		return measured.filter(r => !seen.has(r.map.beatmapId) && (seen.add(r.map.beatmapId), true));
	}, [measured]);
	const bestTen = bestRows.slice(0, 10);

	// ---- testing ----
	const [testName, setTestName] = useState('7K tests');
	const [maxEntries, setMaxEntries] = useState(MAX_ENTRIES_DEFAULT);
	/** mixed screening: a farm map after every `every` tests, the best `top` in turn */
	const [mix, setMixState] = useState<{ every: number; top: number }>(() => load(MIX_KEY, { every: 10, top: 3 }));
	const setMix = (next: { every: number; top: number }) => { setMixState(next); keep(MIX_KEY, next); };
	const counts = useMemo(() => {
		const n = { open: 0, tested: 0, waiting: 0, out: 0 };
		for (const m of maps) {
			for (const rate of rings) {
				const st = stateAt(m, rate);
				if (st === 'open' || st === 'retest') n.open++;
				else if (st === 'tested') n.tested++;
				else if (st === 'waiting') n.waiting++;
				else n.out++;
			}
		}
		return n;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [maps, rings, tests, ceiling, byKey, failRule, levelNow, reach]);
	const saveTests = async (kind: 'x1' | 'screen' | 'mixed') => {
		// maps hardest first by their x1 stars, ring by ring: every map at x1, then every map a step
		// slower, then a step faster... A ring's maps are in only once the ring before was played for
		// them: rebuild the playlist as results come in.
		const ordered = [...maps].sort((a, b) => b.difficulty - a.difficulty);
		const entries: { beatmapId: number; rate: number }[] = [];
		for (const rate of kind === 'x1' ? rings.filter(r => r === 1) : rings) {
			for (const m of ordered) {
				const st = stateAt(m, rate);
				if (st === 'open' || st === 'retest') entries.push({ beatmapId: m.beatmapId, rate });
			}
		}
		let kept = entries.slice(0, maxEntries);
		// mixed: after every `every` tests, the next of your best maps (top 1, top 2, ... top N, then top 1 again)
		const farm = bestRows.slice(0, Math.max(1, mix.top));
		if (kind === 'mixed' && farm.length && entries.length) {
			const every = Math.max(1, mix.every);
			const out: typeof entries = [];
			let next = 0;
			for (let i = 0; i < entries.length && out.length < maxEntries; i++) {
				out.push(entries[i]);
				if ((i + 1) % every === 0 && out.length < maxEntries) {
					const f = farm[next++ % farm.length];
					out.push({ beatmapId: f.map.beatmapId, rate: f.rate });
				}
			}
			kept = out;
		}
		if (!kept.length) { setSaved('Nothing left to test there.'); return; }
		setSaved('Saving...');
		try {
			const { created } = await replacePlaylist(testName, kept.map(e => ({ ...e, mods: [] })));
			setSaved(`${created ? 'Created' : 'Updated'} "${testName}" with ${kept.length} plays${kind !== 'mixed' && entries.length > kept.length ? ` (of ${entries.length})` : ''}. Reopen song select to see it.`);
		} catch (e) {
			setSaved(e instanceof Error ? e.message : String(e));
		}
	};

	const listening = recorderStatus.sockets > 0;
	const statusTitle = [
		listening ? 'Recording your 7K plays as they finish.' : 'Not connected yet: it starts with your next play.',
		recorderStatus.lastMessage ? `Last play message ${Math.round((Date.now() - recorderStatus.lastMessage) / 60000)} min ago.` : '',
		recorderStatus.problem ? `Problem: ${recorderStatus.problem}` : '',
	].filter(Boolean).join('\n');

	return (
		<>
			<header>
				<h1>7K tracker</h1>
				<nav className="seg" aria-label="View">
					<button className={tab === 'playlist' ? 'on' : ''} onClick={() => setTab('playlist')}>
						Playlist {!!rotation.length && <span className="count">{rotation.length}</span>}
					</button>
					<button className={tab === 'maps' ? 'on' : ''} onClick={() => setTab('maps')}>
						All maps {!!measured.length && <span className="count">{measured.length}</span>}
					</button>
					<button className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>
						Recent
					</button>
					<button className={tab === 'testing' ? 'on' : ''} onClick={() => setTab('testing')}>
						Testing
					</button>
				</nav>
				<span className="spacer" />
				<span className="hint" title={statusTitle} style={{ color: recorderStatus.problem ? '#fbbf24' : listening ? '#4ade80' : 'var(--faint, #888)' }}>
					{listening ? '● recording' : '○ waiting for a play'} · {attempts.length.toLocaleString()} plays
				</span>
				<button className="icon" aria-label="Close" onClick={onClose}>✕</button>
			</header>
			{saved && <p className="hint seven-saved">{saved}</p>}

			{tab === 'playlist' && (
				<section className="list seven-list">
					<div className="list-head">
						<input aria-label="Playlist name" value={pickedName} onChange={e => setPickedName(e.target.value)} />
						<Tip className="hint" text={loop.seconds ? skillBreakdown(Object.fromEntries(Object.entries(loop.skills).map(([k, v]) => [k, v / loop.seconds]))) : undefined}>
							{rotation.length
								? <>{rotation.length} maps · {loop.plays} plays · loops every {Math.max(1, Math.round(loop.seconds / 60))} min · <b>{formatXp(loop.xp / loop.seconds)}</b> base XP/s · drift <span style={{ color: driftColor(loop.unknownDrift && !loop.drift ? undefined : loop.drift) }}>{signed(loop.drift)} min</span> a loop{loop.unknownDrift ? ' (some unknown)' : ''}</>
								: 'Empty: add maps with + in All maps.'}
						</Tip>
						<span className="spacer" />
						<button disabled={!bestTen.length} onClick={() => setPicked(Object.fromEntries(bestTen.map(r => [rowKey(r), 1])))}
							title="Replace the playlist with your 10 best maps by base XP/s, each at its best rate">Top 10</button>
						<button disabled={!rotation.length} onClick={() => setPicked({})}>Clear</button>
						<button className="primary" disabled={!rotation.length} onClick={() => void savePicked()} title="Save these maps, each at its rate and repeats, as a game playlist">Save playlist</button>
					</div>
					<div className="rows">
						<div className="row playlist seven-playlist head">
							<span /><span>Map</span><span>Plays as</span><span className="num">Base XP/s</span><span className="num" title="Strain minutes a play adds, start to the next play's start: less than 0 rests">Drift</span><span className="num" title="7K levels gained since this was last passed: the higher, the more out of date its numbers">Lv since</span><span />
						</div>
						{rotation.map((row, i) => {
							const key = rowKey(row);
							const times = picked[key];
							return (
								<div className="row playlist seven-playlist" key={key}>
									<span className="num muted">{i + 1}</span>
									<MapName map={row.map} rate={row.rate} />
									<span className="chips">
										<span className="chip">x{row.rate}</span>
										<span className="stepper" title="Times in a row">
											<button aria-label="Fewer times" disabled={times <= 1} onClick={() => setPicked({ ...picked, [key]: times - 1 })}>−</button>
											<NumberField aria-label="Times in a row" min={1} max={MAX_REPEAT} integer value={times} onChange={v => setPicked({ ...picked, [key]: v })} />
											<button aria-label="More times" disabled={times >= MAX_REPEAT} onClick={() => setPicked({ ...picked, [key]: times + 1 })}>+</button>
										</span>
									</span>
									<Tip className="num strong" text={changeNote(row) + skillBreakdown(row.skills)}><span style={{ color: changeColor(row) }}>{formatXp(row.perSecond)}{changeArrow(row)}</span></Tip>
									<span className="num" style={{ color: driftColor(row.drift) }}>{row.drift === undefined ? '–' : `${signed(row.drift)}m`}</span>
									<span className="num muted" title={row.playLevels ? `${levelNow - row.levelSum} play levels (lifetime + prestige) gained since it was last passed` : 'Passed before play levels were kept: counted from the levels on the Upgrades screen, which read lower, so it cannot be counted. Replay it to fix.'}>{row.playLevels ? sinceLabel(levelNow - row.levelSum) : '?'}</span>
									<button className="icon" aria-label="Remove from the playlist" title="Remove" onClick={() => toggle(key)}>✕</button>
								</div>
							);
						})}
						{!rotation.length && <p className="empty">No maps yet. Open All maps and press + on the ones you want; set how many times each repeats here.</p>}
					</div>
				</section>
			)}

			{tab === 'recent' && (
				<section className="maps">
					<div className="maps-tools">
						<span className="hint">Your last {RECENT_SHOWN} 7K plays, newest first. <b>live</b>: recorded as it finished, with your levels; <b>no progress</b>: recorded, but your levels could not be read; <b>imported</b>: taken later from the game's scores</span>
					</div>
					<div className="rows">
						<div className="row seven-recent head">
							<span>When</span><span>Map</span><span>Rate</span><span className="num">Acc</span><span className="num">XP</span><span className="num">Base XP/s</span><span className="num">From</span>
						</div>
						{recent.map(a => {
							const map = byId.get(a.beatmapId);
							const xp = totalOf(a.gains);
							const base = map ? baseOf(a, ordered) : {};
							const seconds = map ? map.lengthSec / a.rate : 0;
							const from = a.token.startsWith('score:') ? 'imported' : a.levelKind === 'play' ? 'live' : 'no progress';
							return (
								<div className="row seven-recent" key={a.token}>
									<span className="muted" title={new Date(a.startedAt).toLocaleString()}>{new Date(a.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
									{map ? <MapName map={map} rate={a.rate} /> : <span className="muted">map {a.beatmapId}</span>}
									<span className="chips"><span className="chip">x{a.rate}{a.mods ? ` +${a.mods.replace(/,/g, '')}` : ''}</span></span>
									<span className="num" style={{ color: a.failed ? '#f87171' : undefined }}>{a.failed ? 'fail' : a.accuracy !== undefined ? `${(a.accuracy * 100).toFixed(2)}%` : '–'}</span>
									<Tip className="num" text={Object.entries(a.gains).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${skillLabel(k)}: ${Math.round(v).toLocaleString()}`).join(String.fromCharCode(10))}>{formatXp(xp)}</Tip>
									<Tip className="num strong" text={seconds ? skillBreakdown(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v / seconds]))) : undefined}>{seconds && !a.failed ? formatXp(totalOf(base) / seconds) : '–'}</Tip>
									<span className="num" style={{ color: from === 'live' ? '#4ade80' : from === 'imported' ? '#60a5fa' : '#fbbf24' }}>{from}</span>
								</div>
							);
						})}
						{!recent.length && <p className="empty">No 7K plays recorded yet.</p>}
					</div>
				</section>
			)}

			{tab === 'maps' && (
				<section className="maps">
					<div className="maps-tools">
						<input type="search" aria-label="Search maps" placeholder="Search title, artist, difficulty" value={query} onChange={e => setQuery(e.target.value)} />
						<div className="seg" role="group" aria-label="Drift filter">
							<button className={driftFilter === 'all' ? 'on' : ''} onClick={() => setDriftFilter('all')}>All</button>
							<button className={driftFilter === 'warm' ? 'on' : ''} onClick={() => setDriftFilter('warm')} title="Plays that add strain (drift > 0)">Top warming</button>
							<button className={driftFilter === 'cool' ? 'on' : ''} onClick={() => setDriftFilter('cool')} title="Plays that let you rest (drift ≤ 0)">Top cooling</button>
						</div>
						<div className="seg" role="group" aria-label="Rates listed">
							<button className={everyRate ? '' : 'on'} onClick={() => setEveryRate(false)} title="Each difficulty once, at its best rate">Best</button>
							<button className={everyRate ? 'on' : ''} onClick={() => setEveryRate(true)} title="Every rate you have passed of each difficulty">Every rate</button>
						</div>
						<span className="spacer" />
						<span className="hint">Base XP/s from your last pass at each rate</span>
					</div>
					<div className="rows">
						<div className="row seven-maps head">
							<span /><span>Map</span><span>Rate</span><span className="num">Base XP/s</span><span className="num">Best skill</span><span className="num" title="Strain minutes a play adds, start to the next play's start: less than 0 rests">Drift</span><span className="num" title="7K levels gained since this was last passed: the higher, the more out of date its numbers">Lv since</span><span className="num">Plays</span>
						</div>
						{listed.map(row => {
							const key = rowKey(row);
							const on = !!picked[key];
							return (
								<div className={`row seven-maps${on ? ' picked' : ''}`} key={key}>
									<button className={`icon add${on ? ' on' : ''}`} aria-pressed={on} title={on ? 'In your playlist: press to take it out' : 'Add to your playlist'} onClick={() => toggle(key)}>{on ? '✓' : '+'}</button>
									<MapName map={row.map} rate={row.rate} />
									<span className="chips"><span className="chip">x{row.rate}</span></span>
									<Tip className="num strong" text={changeNote(row) + skillBreakdown(row.skills)}><span style={{ color: changeColor(row) }}>{formatXp(row.perSecond)}{changeArrow(row)}</span></Tip>
									<span className="num" title={row.level !== undefined ? `played at level ${row.level}` : undefined}>
										{row.top ? <>{skillLabel(row.top)} <span className="muted">Lv {row.level ?? '?'}</span></> : ''}
									</span>
									<span className="num" style={{ color: driftColor(row.drift) }}>{row.drift === undefined ? '–' : `${signed(row.drift)}m`}</span>
									<span className="num muted" title={row.playLevels ? `${levelNow - row.levelSum} play levels (lifetime + prestige) gained since it was last passed` : 'Passed before play levels were kept: counted from the levels on the Upgrades screen, which read lower, so it cannot be counted. Replay it to fix.'}>{row.playLevels ? sinceLabel(levelNow - row.levelSum) : '?'}</span>
									<span className="num muted" title={`last played ${new Date(row.at).toLocaleString()}`}>{row.plays}{row.fails ? ` (${row.fails}✗)` : ''}</span>
								</div>
							);
						})}
						{!listed.length && <p className="empty">{measured.length ? 'Nothing matches.' : 'No 7K plays recorded yet: play some (the Testing tab makes playlists for it), then come back.'}</p>}
					</div>
				</section>
			)}

			{tab === 'testing' && (
				<section className="maps target">
					<div className="target-form">
						<p className="hint">
							Every 7K play is recorded as it finishes, fails included. Base XP leaves out mindblock, fatigue, medals, mods and your upgrades (genes are kept in), so maps compare fairly. Screening goes out from x1 one step at a time
							(x1 for every map, hardest first, then a step slower, then a step faster, and so on, within the rates your Speed has unlocked). A slower rate stays
							in only while going slower raised XP/s; a faster rate opens once the one before it passed, and a fail closes the faster rates (and every harder
							map) until the level-ups below. A rate that gave 0 XP closes the slower ones for good. Press Screening again after playing to take in the results.
						</p>
						<div className="target-row">
							<span className="hint" title="Each Speed upgrade or prestige unlocks one more rate step (0.05) each way">
								{maps.length.toLocaleString()} 7K maps ·{' '}
								{speedKnown
									? <>7K Speed {progress.speedUpgrades} → <b>x{rates[0]}–x{rates[rates.length - 1]}</b> ({rates.length} rates{allRates ? ', every rate ticked' : ''})</>
									: <>7K Speed not received yet: every rate for now (x{rates[0]}–x{rates[rates.length - 1]})</>}
							</span>
							<label className="strain-filter" title="Every rate from x0.5 to x1.5, past what your 7K Speed has unlocked: to plan ahead">
								<input type="checkbox" checked={allRates} onChange={e => setAllRates(e.target.checked)} /> Every rate
							</label>
							<span className="spacer" />
							<label className="strain-filter" title="Your medals' XP multiplier, from the Character screen: the same on every skill, so it changes no ranking, only the numbers">
								Medals ×
								<NumberField aria-label="Medal multiplier" min={1} max={100} value={medals}
									onChange={v => { setMedals(v); try { localStorage.setItem(MEDALS_KEY, String(v)); } catch { /* not kept */ } }} />
							</label>
						</div>
						<p className="why" title="Slower rates stay open only while going slower raised XP/s; faster rates open one step at a time while you keep passing">
							Screening order {rings.slice(0, 7).map(r => `x${r}`).join(', ')}{rings.length > 7 ? ', …' : ''}:{' '}
							<b>{counts.open.toLocaleString()}</b> to play now, {counts.tested.toLocaleString()} tested,{' '}
							{counts.waiting.toLocaleString()} waiting on the rate before, {counts.out.toLocaleString()} ruled out.
						</p>
						<div className="target-row">
							<label className="strain-filter" title="A fail skips that map's faster rates and every harder map until your 7K level total has gone up by this many levels">
								Fails skip harder maps until
								<NumberField aria-label="Levels before a fail stops skipping" min={1} max={500} integer value={failRule.liftAfter}
									onChange={v => setFailRule({ ...failRule, liftAfter: v })} />
								level-ups
							</label>
							<span className="hint">{holding ? `${holding} fail${holding === 1 ? '' : 's'} skipping maps now` : 'no fails skipping maps'}</span>
							<span className="hint" title="Checked off in the song select box: screening skips them">{checked.size} checked off</span>
							<button disabled={!checked.size} onClick={() => { if (window.confirm(`Put all ${checked.size} checked-off maps back into screening?`)) { clearChecked(); setSaved('Check-offs cleared.'); } }}>Clear check-offs</button>
							<button disabled={!holding} onClick={() => setFailRule({ ...failRule, resetAt: Date.now() })}
								title="Stop every fail so far from skipping maps: they are tested again. Fails from now on skip as usual.">
								Retest failed now
							</button>
						</div>
						<div className="target-row">
							<label className="strain-filter" title="A pass played under this accuracy may give more XP/s with more levels: it goes back into screening after the same number of level-ups as fails">
								Replay passes under
								<NumberField aria-label="Accuracy bar, percent" min={0} max={100} value={failRule.minAccuracy}
									onChange={v => setFailRule({ ...failRule, minAccuracy: v })} />
								% accuracy after those level-ups
							</label>
							<label className="strain-filter" title="Maps and rates harder than this (x1 stars × rate) above your hardest pass are not screened; a slower rate that brings a hard map into range still is">
								Skip more than
								<NumberField aria-label="Stars above the hardest pass" min={0} max={10} value={failRule.reachMargin ?? 2}
									onChange={v => setFailRule({ ...failRule, reachMargin: v })} />
								★ above your hardest pass{Number.isFinite(reach) ? ` (up to ${reach.toFixed(2)}★)` : ''}
							</label>
							<label className="strain-filter" title="A rate passed at or over the accuracy bar whose base XP/s is not in your top maps: slower rates of that map are not screened, and the next faster ones are skipped (the fastest rate you have is always tried). 0 turns it off.">
								Passes over the bar outside your top
								<NumberField aria-label="Top maps by base XP/s" min={0} max={200} integer value={failRule.topM ?? 10}
									onChange={v => setFailRule({ ...failRule, topM: v })} />
								: skip slower rates, and skip
								<NumberField aria-label="Faster rates skipped" min={0} max={20} integer value={failRule.skipSteps ?? 3}
									onChange={v => setFailRule({ ...failRule, skipSteps: v })} />
								faster{failRule.topM > 0 && bestRows[failRule.topM - 1] ? ` (top ${failRule.topM} from ${formatXp(bestRows[failRule.topM - 1].perSecond)} base XP/s)` : failRule.topM > 0 ? ` (off until ${failRule.topM} maps are passed)` : ''}
							</label>
						</div>
						<div className="target-row">
							<input aria-label="Test playlist name" value={testName} onChange={e => setTestName(e.target.value)} />
							<label className="strain-filter" title="The most plays one playlist holds">
								Up to
								<NumberField aria-label="Most plays" min={1} max={2000} integer value={maxEntries} onChange={setMaxEntries} />
							</label>
							<button disabled={!maps.length} onClick={() => void saveTests('x1')} title="Every 7K map not yet tested at x1">Untested at x1</button>
							<button disabled={!maps.length} onClick={() => void saveTests('screen')} title="Every map and rate open now, ring by ring from x1 outwards, maps hardest first: press again after playing to take in the results">Screening</button>
						</div>
						<div className="target-row">
							<label className="strain-filter" title="Screening with a farm map mixed in: after this many tests, one of your best maps by base XP/s">
								Mixed: after every
								<NumberField aria-label="Tests between farm maps" min={1} max={200} integer value={mix.every} onChange={v => setMix({ ...mix, every: v })} />
								tests, play your top
								<NumberField aria-label="Best maps to cycle through" min={1} max={50} integer value={mix.top} onChange={v => setMix({ ...mix, top: v })} />
								in turn (top 1, top 2 ... then top 1 again)
							</label>
							<button disabled={!maps.length || !bestRows.length} onClick={() => void saveTests('mixed')}
								title={bestRows.length ? `Screening, with ${bestRows.slice(0, mix.top).map(r => `${r.map.title} [${r.map.version}] x${r.rate}`).join(', ')} mixed in` : 'No passes yet to farm'}>
								Mixed screening
							</button>
						</div>
					</div>
				</section>
			)}
		</>
	);
}
