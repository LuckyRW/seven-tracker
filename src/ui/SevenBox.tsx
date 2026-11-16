/**
 * A small box at the left of 7K song select: the selected difficulty's last
 * recorded play at the rate and mods picked, in base XP per second, the levels it
 * was played at, and whether the rate is still worth testing. It reads the
 * selection off the song select cards (the active one carries its difficulty's
 * id, and a playlist lock its rate and mods) and the picked rate and mods from
 * the game's own settings in localStorage.
 */

import { useEffect, useRef, useState } from 'react';
import { beatmapStore, gameCharacter, type CharacterRow } from '@oss-idle/addon-sdk';
import { modsKey, parseMods, type Mod } from '@oss-idle/shared/mods';
import { allowedRate } from '@oss-idle/shared/rate';
import { attemptsOf, baseOf, failCeiling, reachOf, levelSumNow, readFailRule, progress7k, RULESET_7K, screenState, testsOf, totalOf, type ScreenState } from '../engine/seven.js';
import { formatXp, skillBreakdown, skillLabel, Tip } from './parts.js';

/** The ruleset the player picked, as the game's add-on host says it. */
const ruleset = (): string => {
	try { return (globalThis as { ossIdle?: { ruleset?: { current?: () => string } } }).ossIdle?.ruleset?.current?.() ?? 'mania4k'; } catch { return 'mania4k'; }
};

const SELECTION_MS = 300;
const CHARACTER_MS = 3000;

const stored = <T,>(key: string, fallback: T): T => {
	try {
		const value = localStorage.getItem(key);
		return value === null ? fallback : JSON.parse(value) as T;
	} catch {
		return fallback;
	}
};

type Picked = { beatmapId: number; rate: number; mods: string };

/** The selected difficulty, with the rate and mods it would play at. */
const selection = (speedUpgrades: number): Picked | undefined => {
	const card = document.querySelector<HTMLElement>('.bm-card.is-active[data-id]');
	if (!card) return undefined;
	const beatmapId = Number(card.dataset.id);
	if (!beatmapId) return undefined;
	// a playlist lock, `rate+MODS`, wins over what is picked
	const lock = card.dataset.lock;
	if (lock) {
		const [rate, mods = ''] = lock.split('+');
		const letters = (mods.match(/.{2}/g) ?? []) as Mod[];
		return { beatmapId, rate: Math.round(Number(rate) * 100) / 100, mods: modsKey(letters) };
	}
	const rate = Math.round(allowedRate(stored('rate', 1), speedUpgrades) * 100) / 100;
	return { beatmapId, rate, mods: modsKey(parseMods(stored<Mod[]>('mods', []).join(','))) };
};

const ago = (ms: number) => {
	const minutes = Math.round((Date.now() - ms) / 60000);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

type Shown = { playedAt: number; base: Record<string, number>; seconds: number; levels: Record<string, number>; /** levels gained since it */ since: number; /** counted in play levels (lifetime + prestige) */ playLevels: boolean };

/** Where the box was dragged to, kept across restarts; unset, it sits at the left, halfway down. */
const POS_KEY = 'seven-tracker:box-pos';
type Pos = { left: number; top: number };
const readPos = (): Pos | undefined => {
	try { const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as Pos | null; return p && Number.isFinite(p.left) && Number.isFinite(p.top) ? p : undefined; } catch { return undefined; }
};
/** Kept on screen, however the window was resized since. */
const onScreen = (p: Pos, el: HTMLElement | null): Pos => {
	const w = el?.offsetWidth ?? 200, h = el?.offsetHeight ?? 100;
	return { left: Math.max(0, Math.min(window.innerWidth - w, p.left)), top: Math.max(0, Math.min(window.innerHeight - h, p.top)) };
};

export default function SevenBox({ version }: { version: number }) {
	const [pos, setPos] = useState<Pos | undefined>(readPos);
	const boxRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{ dx: number; dy: number } | undefined>(undefined);
	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	};
	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!drag.current) return;
		setPos(onScreen({ left: e.clientX - drag.current.dx, top: e.clientY - drag.current.dy }, boxRef.current));
	};
	const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!drag.current) return;
		drag.current = undefined;
		try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ }
		const r = e.currentTarget.getBoundingClientRect();
		const kept = { left: r.left, top: r.top };
		setPos(kept);
		try { localStorage.setItem(POS_KEY, JSON.stringify(kept)); } catch { /* not kept */ }
	};
	const [character, setCharacter] = useState<CharacterRow>();
	const [picked, setPicked] = useState<Picked>();
	const [play, setPlay] = useState<Shown | null>();
	const [status, setStatus] = useState<ScreenState>();
	const [speed, setSpeed] = useState(0);
	const [lengths, setLengths] = useState<Map<number, number>>(new Map());
	const pickedKey = picked && `${picked.beatmapId}@${picked.rate}@${picked.mods}`;

	const [stars, setStars] = useState<Map<number, number>>(new Map());
	useEffect(() => {
		void beatmapStore.difficulties()
			.then(list => {
				setLengths(new Map(list.map(({ version: v }) => [v.id, v.total_length / 1000])));
				setStars(new Map(list.map(({ version: v }) => [v.id, v.difficulty])));
			})
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		let gone = false;
		const tick = async () => {
			try {
				const row = await gameCharacter.live();
				if (!gone && row) setCharacter(old => (old?.id === row.id ? old : row));
			} catch { /* the database is not open yet */ }
		};
		void tick();
		const timer = setInterval(() => void tick(), CHARACTER_MS);
		return () => { gone = true; clearInterval(timer); };
	}, []);

	useEffect(() => {
		const timer = setInterval(() => {
			const now = ruleset() === RULESET_7K ? selection(speed) : undefined;
			setPicked(old => (old?.beatmapId === now?.beatmapId && old?.rate === now?.rate && old?.mods === now?.mods ? old : now));
		}, SELECTION_MS);
		return () => clearInterval(timer);
	}, [speed]);

	useEffect(() => {
		if (!character || !picked) { setPlay(undefined); return; }
		const length = lengths.get(picked.beatmapId);
		if (!length) { setPlay(undefined); return; }
		let gone = false;
		void progress7k(Number(character.id)).then(progress => {
			if (gone) return;
			setSpeed(progress?.speedUpgrades ?? 0);
			const all = attemptsOf(Number(character.id)).sort((a, b) => a.startedAt - b.startedAt);
			const levelSum = levelSumNow(all, progress);
			const rule = readFailRule();
			const tests = testsOf(all, levelSum, rule).get(`${picked.beatmapId}|${picked.mods}`);
			const own = stars.get(picked.beatmapId);
			// the same screening rules as the Testing tab
			const xpsAt = (r: number) => {
				const at = Math.round(r * 100) / 100;
				const pass = tests?.byRate.get(at)?.filter(a => !a.failed).at(-1);
				return pass ? totalOf(baseOf(pass, all)) / (length / at) : undefined;
			};
			setStatus(screenState(tests, picked.rate, { levelSum, rule, stars: own ?? 0, ceiling: failCeiling(all, levelSum, id => stars.get(id), rule), xpsAt, reach: reachOf(all, id => stars.get(id), rule.reachMargin ?? 2) }));
			const last = tests?.byRate.get(picked.rate)?.filter(a => !a.failed).at(-1);
			setPlay(last ? { playedAt: last.startedAt, base: baseOf(last, all), seconds: length / last.rate, levels: last.levels, since: levelSum - last.levelSum, playLevels: last.levelKind === 'play' } : null);
		});
		return () => { gone = true; };
	}, [pickedKey, character?.id, lengths, stars, version]);

	if (!picked || play === undefined) return null;
	const label = `x${picked.rate}${picked.mods ? ` +${picked.mods.replace(/,/g, '')}` : ''}`;
	const skills = play ? Object.entries(play.base).filter(([, xp]) => xp > 0).sort((a, b) => b[1] - a[1]) : [];
	const total = skills.reduce((sum, [, xp]) => sum + xp, 0);

	return (
		<div
			ref={boxRef} className="last-play draggable" role="status" aria-label="Last 7K play at this rate" title="Drag to move"
			style={pos ? { ...onScreen(pos, boxRef.current), transform: 'none' } : undefined}
			onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
			onDoubleClick={() => { setPos(undefined); try { localStorage.removeItem(POS_KEY); } catch { /* not kept */ } }}
		>
			<div className="last-play__head">7K · Last play at {label}</div>
			{status && status !== 'tested' && (
				<div className="last-play__none" style={{ color: status === 'open' || status === 'retest' ? '#fbbf24' : '#888' }}>
					{status === 'open' ? 'Untested: next to screen'
						: status === 'retest' ? 'Played under your accuracy bar, levels since: worth replaying'
						: status === 'waiting' ? 'Untested: play the rate next to it towards x1 first'
						: status === 'failed' ? 'Failed here: not passed yet'
						: `Ruled out: ${status}`}
				</div>
			)}
			{play === null ? (
				<div className="last-play__none">Never passed at this rate and mods</div>
			) : (
				<>
					<Tip className="last-play__total" text={skillBreakdown(Object.fromEntries(skills.map(([s, xp]) => [s, xp / play.seconds])))}>
						{formatXp(total / play.seconds)} <span>base XP/s</span>
					</Tip>
					{skills.slice(0, 4).map(([skill, xp]) => (
						<div className="last-play__row" key={skill}>
							<span>{skillLabel(skill)}</span>
							<span>{formatXp(xp / play.seconds)}/s</span>
							<span className="last-play__lvl">{play.levels[skill] !== undefined ? `Lv ${Number(play.levels[skill]).toFixed(1)}` : ''}</span>
						</div>
					))}
					<div className="last-play__foot">{ago(play.playedAt)} · <b title="7K levels gained since this pass: the higher, the more out of date it is">{!play.playLevels ? 'levels since unknown (replay to fix)' : play.since > 0 ? `+${play.since} levels since` : 'no levels since'}</b> · fatigue, mindblock and upgrades taken out; genes kept</div>
				</>
			)}
		</div>
	);
}
