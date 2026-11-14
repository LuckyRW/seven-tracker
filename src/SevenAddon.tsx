/**
 * 7K tracker: every 7K play recorded off the game's socket as it finishes (7K has
 * no sim), a panel of what each map and rate is worth in base XP per second, and
 * a small box at song select with the selected difficulty's last play.
 *
 * The panel is mounted for the add-on's whole life and only hidden when closed.
 */

import { gameCharacter, gameDb, type CharacterRow } from '@oss-idle/addon-sdk';
import { ReactAddon } from '@oss-idle/addon-sdk/react';
import type { ReactNode } from 'react';
import { recordPlays } from './engine/seven.js';
import SevenBox from './ui/SevenBox.js';
import SevenView from './ui/SevenView.js';
import styles from './ui/styles.css';

const TOGGLE = 'Ctrl+Shift+J';

export class SevenAddon extends ReactAddon {

	private open = false;
	/** Bumped on each 7K play recorded: the panel and the box read the record again. */
	private version = 0;
	private character?: CharacterRow;
	private escape?: () => void;

	constructor() {
		super({ name: '7K tracker', overlayId: 'seven-tracker', styles });
	}

	protected override async onReady(): Promise<void> {
		this.own(this.hotkeys.register(TOGGLE, () => this.toggle(), { allowInText: true }));
		this.log.info(`ready - press ${TOGGLE} to open`);
		gameDb.ready().catch(() => this.log.warn('game database never opened'));

		const whose = async () => {
			try {
				const row = await gameCharacter.live();
				if (row && row.id !== this.character?.id) { this.character = row; this.refresh(); } else if (row) this.character = row;
			} catch { /* not open yet */ }
		};
		void whose();
		const timer = setInterval(() => void whose(), 10_000);
		this.own(() => clearInterval(timer));
		this.own(recordPlays(() => this.character?.id, () => { this.version++; this.refresh(); }, () => this.strainNow()));
	}

	/** The strain minutes the server has for the signed-in character (the API's /me fatigue.minutes). */
	private async strainNow(): Promise<number | undefined> {
		const api = (this.host as { api?: { me(): Promise<unknown> } } | undefined)?.api;
		if (!api) return undefined;
		try {
			const me = await api.me() as { fatigue?: { minutes?: unknown } };
			const minutes = Number(me?.fatigue?.minutes);
			return Number.isFinite(minutes) ? minutes : undefined;
		} catch {
			return undefined;
		}
	}

	private toggle(): void {
		this.open = !this.open;
		this.escape?.();
		this.escape = this.open ? this.hotkeys.register('Escape', () => this.toggle(), { allowInText: true }) : undefined;
		this.refresh();
	}

	protected render(): ReactNode {
		return (
			<>
				<div style={{ display: this.open ? 'contents' : 'none' }} aria-hidden={!this.open}>
					<div className="backdrop" onClick={() => this.toggle()} />
					<div className="panel" role="dialog" aria-label="7K tracker">
						<header>
							<h1>7K tracker</h1>
							<span className="spacer" />
							<button onClick={() => this.toggle()} aria-label="Close">✕</button>
						</header>
						<SevenView character={this.character} version={this.version} />
					</div>
				</div>
				{!this.open && <SevenBox version={this.version} />}
			</>
		);
	}
}
