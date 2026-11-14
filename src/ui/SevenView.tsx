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
	attemptsOf, baseOf, failCeiling, levelSumNow, readFailRule, saveFailRule, type FailRule, MEDALS_KEY, medals7k, progress7k, readBars, recorderStatus, screenRates, statusOf, testsOf, totalOf,
	type Attempt, type Progress7k,
} from '../engine/seven.js';
import { formatTime, formatXp, NumberField, skillBreakdown, skillLabel } from './parts.js';

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
};

type Tab = 'playlist' | 'maps' | 'testing';

const MAX_ENTRIES_DEFAULT = 200;
const MAX_REPEAT = 100;

/** The maps picked for your playlist, by `beatmapId@rate`, with each one's repeat count: kept across restarts. */
const PICKED_KEY = 'seven-tracker:picked';
/** The order they were picked in: the playlist plays them in it. */
const ORDER_KEY = 'seven-tracker:picked-order';
const TAB_KEY = 'seven-tracker:tab';
const ALL_RATES_KEY = 'seven-tracker:all-rates';
/** Speed unlocks that open every rate, x0.5 to x1.5. */
const ALL_RATE_STEPS = 10;

const load = <T,>(key: string, fallback: T): T => {
	try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v) as T; } catch { return fallback; }
};
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ } };

const rowKey = (row: { map: { beatmapId: number }; rate: number }) => `${row.map.beatmapId}@${row.rate}`;
const signed = (n: number, digits = 1) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
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

	const byId = useMemo(() => new Map(maps.map(m => [m.beatmapId, m])), [maps]);
	// the rates the character's Speed has unlocked, or every rate there is
	// kept as true, or as '1' (which reads back as 1) by an earlier version
	const [allRates, setAllRatesState] = useState(() => { const v = load<unknown>(ALL_RATES_KEY, false); return v === true || v === 1; });
	const setAllRates = (on: boolean) => { setAllRatesState(on); keep(ALL_RATES_KEY, on); };
	const rates = useMemo(() => rateSteps(allRates ? ALL_RATE_STEPS : progress?.speedUpgrades ?? 0), [allRates, progress?.speedUpgrades]);
	const screened = useMemo(() => screenRates(rates), [rates]);
	const levelNow = useMemo(() => levelSumNow(attempts, progress), [attempts, progress]);
	const [failRule, setFailRuleState] = useState<FailRule>(readFailRule);
	const setFailRule = (rule: FailRule) => { setFailRuleState(rule); saveFailRule(rule); };
	const tests = useMemo(() => testsOf(attempts, levelNow, failRule), [attempts, levelNow, failRule]);
	// a fail rules out every harder map and rate too, until a skill levels up
	const ceiling = useMemo(() => failCeiling(attempts, levelNow, id => byId.get(id)?.difficulty, failRule), [attempts, levelNow, byId, failRule]);
	const holding = attempts.filter(a => a.failed && a.startedAt > failRule.resetAt && levelNow - a.levelSum < Math.max(1, failRule.liftAfter)).length;
	const statusAt = (m: Map7k, rate: number) => statusOf(tests.get(`${m.beatmapId}|`), rate, m.difficulty * rate, ceiling);

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
				rows.push({
					map, rate, perSecond: totalOf(base) / seconds, skills: Object.fromEntries(Object.entries(base).map(([s, xp]) => [s, xp / seconds])), top, topPerSecond: topXp / seconds,
					level: top ? last.levels[top] : undefined, at: last.startedAt, plays: list.length, fails: list.length - passes.length,
					drift: d?.length ? d.reduce((x, y) => x + y, 0) / d.length : undefined,
				});
			}
		}
		return rows.sort((a, b) => b.perSecond - a.perSecond);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tests, byId, attempts, medals]);
	const byKey = useMemo(() => new Map(measured.map(r => [rowKey(r), r])), [measured]);

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

	// ---- testing ----
	const [testName, setTestName] = useState('7K tests');
	const [maxEntries, setMaxEntries] = useState(MAX_ENTRIES_DEFAULT);
	const [refineMaps, setRefineMaps] = useState(20);
	const counts = useMemo(() => {
		let untested = 0, ruledOut = 0, tested = 0;
		for (const m of maps) {
			for (const rate of screened) {
				const s = statusAt(m, rate);
				if (s === 'untested') untested++;
				else if (s === 'too easy' || s === 'too hard') ruledOut++;
				else tested++;
			}
		}
		return { untested, ruledOut, tested };
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [maps, screened, tests, ceiling]);
	const saveTests = async (kind: 'x1' | 'screen' | 'refine') => {
		const entries: { beatmapId: number; rate: number }[] = [];
		const open = (id: number, rate: number) => { const m = byId.get(id); return !!m && statusAt(m, rate) === 'untested'; };
		if (kind === 'x1') {
			for (const m of maps) if (rates.includes(1) && open(m.beatmapId, 1)) entries.push({ beatmapId: m.beatmapId, rate: 1 });
		} else if (kind === 'screen') {
			// a map's rates from x1 outwards: the nearest tests narrow it fastest
			for (const m of maps) {
				for (const rate of [...screened].sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1))) {
					if (open(m.beatmapId, rate)) entries.push({ beatmapId: m.beatmapId, rate });
				}
			}
		} else {
			const best = new Map<number, Measured>();
			for (const row of measured) if (!best.has(row.map.beatmapId)) best.set(row.map.beatmapId, row);
			for (const row of [...best.values()].slice(0, refineMaps)) {
				const at = screened.indexOf(row.rate);
				const below = at >= 0 ? screened[at - 1] ?? -Infinity : row.rate - 0.051;
				const above = at >= 0 ? screened[at + 1] ?? Infinity : row.rate + 0.051;
				for (const rate of rates) if (rate > below && rate < above && open(row.map.beatmapId, rate)) entries.push({ beatmapId: row.map.beatmapId, rate });
			}
		}
		// easiest first (x1 stars × rate): the plays most likely to pass come first, and a 0 XP early on
		// rules out the slower rates further down; a fail rules out everything harder after it
		const hardness = (e: { beatmapId: number; rate: number }) => (byId.get(e.beatmapId)?.difficulty ?? 0) * e.rate;
		entries.sort((a, b) => hardness(a) - hardness(b));
		const kept = entries.slice(0, maxEntries);
		if (!kept.length) { setSaved('Nothing left to test there.'); return; }
		setSaved('Saving...');
		try {
			const { created } = await replacePlaylist(testName, kept.map(e => ({ ...e, mods: [] })));
			setSaved(`${created ? 'Created' : 'Updated'} "${testName}" with ${kept.length} plays${entries.length > kept.length ? ` (of ${entries.length})` : ''}. Reopen song select to see it.`);
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
						<span className="hint" title={loop.seconds ? skillBreakdown(Object.fromEntries(Object.entries(loop.skills).map(([k, v]) => [k, v / loop.seconds]))) : undefined}>
							{rotation.length
								? <>{rotation.length} maps · {loop.plays} plays · loops every {Math.max(1, Math.round(loop.seconds / 60))} min · <b>{formatXp(loop.xp / loop.seconds)}</b> base XP/s · drift <span style={{ color: driftColor(loop.unknownDrift && !loop.drift ? undefined : loop.drift) }}>{signed(loop.drift)} min</span> a loop{loop.unknownDrift ? ' (some unknown)' : ''}</>
								: 'Empty: add maps with + in All maps.'}
						</span>
						<span className="spacer" />
						<button disabled={!rotation.length} onClick={() => setPicked({})}>Clear</button>
						<button className="primary" disabled={!rotation.length} onClick={() => void savePicked()} title="Save these maps, each at its rate and repeats, as a game playlist">Save playlist</button>
					</div>
					<div className="rows">
						<div className="row playlist seven-playlist head">
							<span /><span>Map</span><span>Plays as</span><span className="num">Base XP/s</span><span className="num" title="Strain minutes a play adds, start to the next play's start: less than 0 rests">Drift</span><span />
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
									<span className="num strong" title={skillBreakdown(row.skills)}>{formatXp(row.perSecond)}</span>
									<span className="num" style={{ color: driftColor(row.drift) }}>{row.drift === undefined ? '–' : `${signed(row.drift)}m`}</span>
									<button className="icon" aria-label="Remove from the playlist" title="Remove" onClick={() => toggle(key)}>✕</button>
								</div>
							);
						})}
						{!rotation.length && <p className="empty">No maps yet. Open All maps and press + on the ones you want; set how many times each repeats here.</p>}
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
							<span /><span>Map</span><span>Rate</span><span className="num">Base XP/s</span><span className="num">Best skill</span><span className="num" title="Strain minutes a play adds, start to the next play's start: less than 0 rests">Drift</span><span className="num">Plays</span>
						</div>
						{listed.map(row => {
							const key = rowKey(row);
							const on = !!picked[key];
							return (
								<div className={`row seven-maps${on ? ' picked' : ''}`} key={key}>
									<button className={`icon add${on ? ' on' : ''}`} aria-pressed={on} title={on ? 'In your playlist: press to take it out' : 'Add to your playlist'} onClick={() => toggle(key)}>{on ? '✓' : '+'}</button>
									<MapName map={row.map} rate={row.rate} />
									<span className="chips"><span className="chip">x{row.rate}</span></span>
									<span className="num strong" title={skillBreakdown(row.skills)}>{formatXp(row.perSecond)}</span>
									<span className="num" title={row.level !== undefined ? `played at level ${row.level}` : undefined}>
										{row.top ? <>{skillLabel(row.top)} <span className="muted">Lv {row.level ?? '?'}</span></> : ''}
									</span>
									<span className="num" style={{ color: driftColor(row.drift) }}>{row.drift === undefined ? '–' : `${signed(row.drift)}m`}</span>
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
							Every 7K play is recorded as it finishes, fails included. Base XP leaves out every multiplier (mindblock, fatigue, medals, genes, mods,
							upgrades), so maps compare fairly. To save plays, some are skipped: a rate that gave 0 XP skips the map&apos;s slower rates, and a fail skips
							its faster rates and every harder map (x1 stars × rate) until you gain the level-ups set below. Test playlists go easiest first.
						</p>
						<div className="target-row">
							<span className="hint">{maps.length.toLocaleString()} 7K maps downloaded · {rates.length} rates{progress ? '' : ' (your 7K Speed could not be read)'}</span>
							<label className="strain-filter" title="Every rate from x0.5 to x1.5, not only the ones your 7K Speed has unlocked">
								<input type="checkbox" checked={allRates} onChange={e => setAllRates(e.target.checked)} /> All rates
							</label>
							<span className="spacer" />
							<label className="strain-filter" title="Your medals' XP multiplier, from the Character screen: the same on every skill, so it changes no ranking, only the numbers">
								Medals ×
								<NumberField aria-label="Medal multiplier" min={1} max={100} value={medals}
									onChange={v => { setMedals(v); try { localStorage.setItem(MEDALS_KEY, String(v)); } catch { /* not kept */ } }} />
							</label>
						</div>
						<p className="why">
							Screening rates {screened.map(r => `x${r}`).join(', ')}: <b>{counts.untested.toLocaleString()}</b> map and rate pairs left to test,{' '}
							{counts.tested.toLocaleString()} tested, {counts.ruledOut.toLocaleString()} skipped.
						</p>
						<div className="target-row">
							<label className="strain-filter" title="A fail skips that map's faster rates and every harder map until your 7K level total has gone up by this many levels">
								Fails skip harder maps until
								<NumberField aria-label="Levels before a fail stops skipping" min={1} max={500} integer value={failRule.liftAfter}
									onChange={v => setFailRule({ ...failRule, liftAfter: v })} />
								level-ups
							</label>
							<span className="hint">{holding ? `${holding} fail${holding === 1 ? '' : 's'} skipping maps now` : 'no fails skipping maps'}</span>
							<button disabled={!holding} onClick={() => setFailRule({ ...failRule, resetAt: Date.now() })}
								title="Stop every fail so far from skipping maps: they are tested again. Fails from now on skip as usual.">
								Retest failed now
							</button>
						</div>
						<div className="target-row">
							<input aria-label="Test playlist name" value={testName} onChange={e => setTestName(e.target.value)} />
							<label className="strain-filter" title="The most plays one playlist holds">
								Up to
								<NumberField aria-label="Most plays" min={1} max={2000} integer value={maxEntries} onChange={setMaxEntries} />
							</label>
							<button disabled={!maps.length} onClick={() => void saveTests('x1')} title="Every 7K map not yet tested at x1">Untested at x1</button>
							<button disabled={!maps.length} onClick={() => void saveTests('screen')} title="Each map at its screening rates not yet tested or skipped, nearest x1 first">Screening</button>
							<label className="strain-filter" title="How many of the best measured maps the refining playlist takes">
								best
								<NumberField aria-label="Maps to refine" min={1} max={500} integer value={refineMaps} onChange={setRefineMaps} />
							</label>
							<button disabled={!measured.length} onClick={() => void saveTests('refine')} title="The best measured maps at the untested rates between the screening rates either side of their best">Refining</button>
						</div>
					</div>
				</section>
			)}
		</>
	);
}
