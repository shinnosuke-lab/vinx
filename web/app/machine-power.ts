/**
 * The machine stays the way you left it.
 *
 * The machine costs RAM, CPU and (once) a 22 MB download, and a person who
 * only wants the chat or a web app should pay none of it. Rather than a
 * setting about booting, the page remembers one fact — the machine's
 * power, as of the last gesture that changed it — and restores it on load,
 * like a real computer that is on or off when you come back to it:
 *
 *   - 'on'    left running (the power key, or "Power on" on first load):
 *             boot on page load, silently
 *   - 'off'   left off (a power-off, a stop mid-boot, "Not now" on first
 *             load): stay off; the power key boots it
 *   - null    never decided: the chat page asks, once, on first load
 *
 * Every power gesture writes here, so there is no separate "boot with the
 * page" preference to fall out of step with what the person just did.
 *
 * The remembered power also decides what an IMPLICIT need for the machine
 * does — a file dropped into the chat, an app installed from the Apps
 * page, a tool the model calls: left 'on' (only ever reachable when a boot
 * failed) the machine boots for it; otherwise the need is refused with a
 * MachineOffError (vm.ts whenUp) and the caller says so. Only the explicit
 * gestures — the power key, the first-load question — boot a machine the
 * person left off.
 *
 * Its own module with no imports on purpose: vm.ts reads it, and
 * vm-status.ts (which imports vm.ts) re-exports it for the UI.
 */

export type MachinePower = 'on' | 'off';

const POWER_KEY = 'vinx.machine.power';

/** What the person last left the machine as; null when never decided. */
export function rememberedPower(): MachinePower | null {
	try {
		const v = localStorage.getItem(POWER_KEY);
		return v === 'on' || v === 'off' ? v : null;
	} catch {
		return null;
	}
}

export function rememberPower(power: MachinePower): void {
	try {
		localStorage.setItem(POWER_KEY, power);
	} catch {
		/* a private window asks again next load; harmless */
	}
}
