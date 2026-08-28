/**
 * The boot-veil waiting game: a canvas endless runner in the spirit of the
 * offline dinosaur. Jump the obstacles, survive, score. It exists to give a
 * long first download (tens of MB on a slow link) a focal point; it is
 * dynamically imported the moment someone actually presses space, so it
 * never rides in the main bundle, and it dies with the veil — the machine
 * coming up is the real game.
 */

export interface BootGame {
	dispose(): void;
}

/** Logical canvas size; CSS pixels, scaled for the devicePixelRatio. */
const W = 360;
const H = 110;
const GROUND = H - 22;

const GRAVITY = 2400; /* px/s^2 */
const JUMP_V = -540; /* px/s; ~60px apex, clears the tallest obstacle */
const SPEED0 = 190; /* px/s at the start */
const SPEED_RAMP = 7; /* px/s gained per second, up to... */
const SPEED_MAX = 430;

/* Tokyo Night, same palette as the page theme. */
const FG = '#c0caf5';
const MUTED = '#565f89';
const ACCENT = '#7aa2f7';
const DANGER = '#f7768e';

interface Obstacle {
	x: number;
	w: number;
	h: number;
}

/** Keys that mean "jump" — the same ones the veil's hint advertises. */
function isJumpKey(e: KeyboardEvent): boolean {
	return e.code === 'Space' || e.code === 'ArrowUp';
}

/** True when the key press belongs to a text field the player is typing
 * in — the AI panel's chat box must keep its spaces. xterm's hidden helper
 * textarea is exempt: the terminal under the veil eats no input anyway. */
function typingElsewhere(e: KeyboardEvent): boolean {
	const t = e.target as HTMLElement | null;
	if (!t) return false;
	if (t.classList?.contains('xterm-helper-textarea')) return false;
	return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || !!t.isContentEditable;
}

export function startBootGame(container: HTMLElement): BootGame {
	const canvas = document.createElement('canvas');
	const dpr = window.devicePixelRatio || 1;
	canvas.width = W * dpr;
	canvas.height = H * dpr;
	canvas.style.width = `${W}px`;
	canvas.style.height = `${H}px`;
	container.appendChild(canvas);
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		canvas.remove();
		return { dispose() {} };
	}
	ctx.scale(dpr, dpr);

	let over = false;
	let py = GROUND; /* player's feet */
	let vy = 0;
	let speed = SPEED0;
	let score = 0;
	let best = 0;
	let obstacles: Obstacle[] = [];
	let untilNext = 0.9; /* seconds to the next obstacle */
	let raf = 0;
	let last = performance.now();

	const reset = () => {
		over = false;
		py = GROUND;
		vy = 0;
		speed = SPEED0;
		score = 0;
		obstacles = [];
		untilNext = 0.9;
	};

	const jump = () => {
		if (over) {
			reset();
			return;
		}
		if (py >= GROUND) vy = JUMP_V;
	};

	const onKey = (e: KeyboardEvent) => {
		if (!isJumpKey(e) || typingElsewhere(e)) return;
		e.preventDefault();
		if (!e.repeat) jump();
	};
	const onPointer = (e: PointerEvent) => {
		e.preventDefault();
		jump();
	};
	window.addEventListener('keydown', onKey);
	canvas.addEventListener('pointerdown', onPointer);

	const step = (dt: number) => {
		speed = Math.min(SPEED_MAX, speed + SPEED_RAMP * dt);
		score += dt * 10;
		vy += GRAVITY * dt;
		py = Math.min(GROUND, py + vy * dt);
		untilNext -= dt;
		if (untilNext <= 0) {
			// Spacing scales with speed so the required reaction time holds.
			untilNext = (0.75 + Math.random() * 0.9) * (SPEED0 / speed) + 0.35;
			obstacles.push({
				x: W + 20,
				w: 8 + Math.random() * 8,
				h: 14 + Math.random() * 16,
			});
		}
		for (const o of obstacles) o.x -= speed * dt;
		obstacles = obstacles.filter((o) => o.x + o.w > -10);
		// Collision: the player is a 14px square whose feet are at py.
		const px = 46;
		const ps = 14;
		for (const o of obstacles) {
			if (px + ps - 3 > o.x && px + 3 < o.x + o.w && py > GROUND - o.h + 2) {
				over = true;
				best = Math.max(best, Math.floor(score));
			}
		}
	};

	const draw = () => {
		ctx.clearRect(0, 0, W, H);
		ctx.font = '10px Monaco, "SF Mono", Menlo, monospace';
		// Ground.
		ctx.fillStyle = MUTED;
		ctx.fillRect(0, GROUND + 14, W, 1);
		// Player.
		ctx.fillStyle = over ? DANGER : ACCENT;
		ctx.fillRect(46, py, 14, 14);
		// Obstacles grow up from the ground line.
		ctx.fillStyle = FG;
		for (const o of obstacles) ctx.fillRect(o.x, GROUND + 14 - o.h, o.w, o.h);
		// Score, top right; best score once there is one.
		ctx.fillStyle = MUTED;
		ctx.textAlign = 'right';
		ctx.fillText(
			`${String(Math.floor(score)).padStart(5, '0')}${best ? `  HI ${best}` : ''}`,
			W - 4,
			12,
		);
		if (over) {
			ctx.textAlign = 'center';
			ctx.fillStyle = FG;
			ctx.fillText('GAME OVER', W / 2, H / 2 - 6);
			ctx.fillStyle = MUTED;
			ctx.fillText('space / tap', W / 2, H / 2 + 8);
		}
	};

	const loop = (now: number) => {
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		if (!over) step(dt);
		draw();
		raf = requestAnimationFrame(loop);
	};
	raf = requestAnimationFrame(loop);

	return {
		dispose() {
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', onKey);
			canvas.removeEventListener('pointerdown', onPointer);
			canvas.remove();
		},
	};
}
