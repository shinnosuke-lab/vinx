/**
 * The milestone gate: benchmark the image's own /usr/bin/nes (the Buildroot
 * gcc -O2 cross build) inside the real VM -- the number no host build can
 * fake.
 *
 *   (cd web && node ../nes/test/vm-bench.mjs)
 *
 * Env: ROM (default test/roms/nestest.nes), BENCH_FRAMES (default 600).
 */
import { DEFAULT_ROM, dropRom, frameUntil, mark, frameType, setup } from './lib.mjs';

const ROM = process.env.ROM || DEFAULT_ROM;
const FRAMES = Number(process.env.BENCH_FRAMES || 600);

const { page, frame, close } = await setup();
try {
	console.log('==> VM up; dropping the ROM');
	await dropRom(page, frame, ROM);

	console.log(`==> bench, ${FRAMES} frames headless`);
	await frameType(page, frame, `nes --bench ${FRAMES} /data/bench.nes && ${mark('B1-END')}`);
	const b1 = await frameUntil(frame, (t) => t.includes('B1-END'), 'the headless bench', 600_000);
	const core = b1.match(/^\d+ frames in .*$/m)?.[0];

	console.log(`==> bench, ${FRAMES} frames with the fb blit`);
	await frameType(page, frame, `nes --bench-video ${FRAMES} /data/bench.nes && ${mark('B2-END')}`);
	const b2 = await frameUntil(frame, (t) => t.includes('B2-END'), 'the video bench', 600_000);
	const video = b2.match(/^\d+ frames \(with blit\) in .*$/m)?.[0];

	console.log('\n=== in-VM results (/usr/bin/nes) ===');
	console.log(`core:  ${core ?? '(not captured)'}`);
	console.log(`video: ${video ?? '(not captured)'}`);
} finally {
	await close();
}
