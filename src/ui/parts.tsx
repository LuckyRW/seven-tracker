import { useState, type InputHTMLAttributes } from 'react';

/** A skill as the game names it: `reading` shows as technical. */
export const skillLabel = (skill: string) => skill === 'reading' ? 'technical' : skill;

export const formatTime = (seconds: number) => {
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * A hover breakdown of an XP / s figure: each skill's XP per second, most first, and
 * what its multiplier makes of it when the target weighs skills.
 */
export const skillBreakdown = (perSkill: Readonly<Record<string, number>> | undefined, weights?: Readonly<Record<string, number>>, unit = 'XP/s'): string | undefined => {
	const rows = Object.entries(perSkill ?? {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
	if (!rows.length) return undefined;
	const total = rows.reduce((sum, [, v]) => sum + v, 0);
	return rows.map(([skill, v]) => {
		const w = weights?.[skill];
		const share = `${Math.round(v / total * 100)}%`;
		return `${skillLabel(skill)}: ${formatRate(v)} ${unit} (${share})${w !== undefined && w !== 1 ? ` ×${w} = ${formatRate(v * w)}` : ''}`;
	}).join('\n') + `\ntotal: ${formatRate(total)} ${unit}`;
};

/** A target's multipliers, when it weights skills. */
export const weightsOf = (target: { kind: string; weights?: Record<string, number> }) =>
	target.kind === 'skills' ? target.weights : undefined;

export const formatRate = (value: number) =>
	value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

export const formatXp = (value: number) =>
	value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : Math.round(value).toLocaleString();

/**
 * A number the player types. The field holds what they type while they type it, so
 * clearing it to write another number leaves it empty rather than putting a number
 * back under the cursor, and nothing is applied halfway through ("150" is not a 1
 * then a 15). What they leave it at (Enter or elsewhere) is applied, kept within
 * `min` and `max`; left empty or not a number, it goes back to the value it had.
 * A comma counts as the decimal mark, as keyboards in many places type it.
 * A text field, not a number one: its spinner arrows sit where the digits are typed.
 */
/** A typed number: a comma is a decimal mark ("1,25" is 1.25), spaces are ignored. NaN when it is not a number. */
export const parseTyped = (text: string): number => {
	const plain = text.replace(/\s+/g, '').replace(',', '.');
	return plain === '' || plain.includes(',') ? NaN : Number(plain);
};

export function NumberField({ value, onChange, min, max, integer, ...rest }: {
	value: number;
	onChange: (value: number) => void;
	min: number;
	max?: number;
	/** Whole numbers only. */
	integer?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'>) {
	const [draft, setDraft] = useState<string>();
	const apply = () => {
		if (draft === undefined) return;
		const typed = parseTyped(draft);
		if (Number.isFinite(typed)) {
			const kept = Math.min(max ?? Infinity, Math.max(min, integer ? Math.round(typed) : typed));
			if (kept !== value) onChange(kept);
		}
		setDraft(undefined);
	};
	return (
		<input
			{...rest}
			type="text" inputMode={integer ? 'numeric' : 'decimal'} autoComplete="off"
			value={draft ?? value}
			onChange={e => setDraft(e.target.value)}
			onBlur={apply}
			onKeyDown={e => {
				if (e.key === 'Enter') e.currentTarget.blur();
			}}
		/>
	);
}
