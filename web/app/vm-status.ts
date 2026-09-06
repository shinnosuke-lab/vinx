/**
 * The machine's boot, as one status every waiting surface reads the same
 * way: state, progress, and a line of text saying what is going on.
 *
 * Boot used to be a fact only the terminal page told (its veil has the
 * stage line and the bar). On the chat page the machine was invisible
 * until something needed it — the Apps page pulsed four skeletons for the
 * length of a boot, a run_shell card said "running on the VM…" while
 * nothing ran yet, and a failed boot looked exactly like a powered-off
 * machine. Everything here derives from vm.ts's existing signals
 * (onState, onBootProgress, bootError); the point is one vocabulary.
 *
 * Two readers: page code subscribes through `useVmStatus`; the vendored UI,
 * which must not import app code, reads the same facts off
 * `document.documentElement.dataset` (vmState, vmBootProgress, vmBootPhase
 * — written by vm.ts). The machine's power is the capsule's alone: no
 * other surface boots it or asks to.
 */

import { useEffect, useState } from 'react';

import { t, tf } from './i18n';
import { existingVm, sharedVm, type BootProgress, type VmState } from './vm';

export interface VmStatus {
	state: VmState;
	/** Where the boot is, while booting; null otherwise. */
	progress: BootProgress | null;
	/** Whole percent of `progress`, 0..100. */
	percent: number;
	/** The recorded reason, in 'failed'; null otherwise. */
	error: string | null;
}

/** The remembered power lives in machine-power.ts (no imports there, so
 * vm.ts can read it); re-exported here for the UI, which already looks
 * here for everything about the machine's state. */
export { rememberedPower, rememberPower, type MachinePower } from './machine-power';

/** The status as the document tells it — what a first render sees before
 * the subscription below delivers, and all the vendored UI ever reads. */
function fromDocument(): VmStatus {
	const vm = existingVm();
	const ds = document.documentElement.dataset;
	const state = vm?.getState() ?? ((ds.vmState as VmState | undefined) ?? 'off');
	const fraction = state === 'booting' && ds.vmBootProgress ? Number(ds.vmBootProgress) : 0;
	return {
		state,
		progress:
			state === 'booting'
				? { phase: ds.vmBootPhase === 'kernel' ? 'kernel' : 'download', fraction }
				: null,
		percent: Math.round(fraction * 100),
		error: vm?.bootError() ?? null,
	};
}

/**
 * Subscribe to the shared machine's state and boot progress. Constructs the
 * singleton if needed — fine on the chat page, where main.tsx builds it with
 * its options long before any of these surfaces mount.
 */
export function useVmStatus(): VmStatus {
	const [status, setStatus] = useState<VmStatus>(fromDocument);
	useEffect(() => {
		const vm = sharedVm();
		let progress: BootProgress | null = null;
		const publish = (state: VmState) => {
			if (state !== 'booting') progress = null;
			setStatus({
				state,
				progress,
				percent: Math.round((progress?.fraction ?? 0) * 100),
				error: vm.bootError(),
			});
		};
		const unState = vm.onState(publish);
		const unProgress = vm.onBootProgress((p) => {
			progress = p;
			publish(vm.getState());
		});
		return () => {
			unState();
			unProgress();
		};
	}, []);
	return status;
}

/** One line for the status, in the page's language; empty when the machine
 * is ready (nothing to wait for). */
export function bootStatusLine(s: VmStatus): string {
	switch (s.state) {
		case 'booting':
			return s.progress?.phase === 'kernel'
				? tf('vmBootStarting', s.percent)
				: tf('vmBootDownloading', s.percent);
		case 'failed':
			return s.error ? tf('vmBootFailed', s.error) : t('vmBootFailedShort');
		case 'off':
			return t('vmOff');
		default:
			return '';
	}
}
