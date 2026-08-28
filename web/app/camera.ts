/**
 * The page half of camera(1): one webcam frame, PNG-encoded, dropped into the
 * guest's /data where the script is polling for it.
 *
 * getUserMedia is the permission gate — the browser prompts on first use, and
 * a denial simply means no file appears and the guest script times out with
 * its own message. The stream lives only for the single frame.
 */

import type { VinxVm } from './vm';
import { storeShareFile } from './share-store';

export async function captureFrame(vm: VinxVm, name: string): Promise<void> {
	const stream = await navigator.mediaDevices.getUserMedia({ video: true });
	try {
		const video = document.createElement('video');
		video.srcObject = stream;
		// iOS-style inline hints are harmless elsewhere and keep any future
		// mobile Safari from trying to fullscreen an invisible element.
		video.muted = true;
		video.playsInline = true;
		await video.play();
		// play() resolving does not mean a frame is decodable; wait until the
		// element knows its dimensions (loadedmetadata has fired by then).
		if (!video.videoWidth) {
			await new Promise<void>((resolve, reject) => {
				video.onloadedmetadata = () => resolve();
				video.onerror = () => reject(new Error('the camera stream never produced metadata'));
				setTimeout(() => reject(new Error('the camera stream never started')), 10_000);
			});
		}
		// One more tick so the first real frame lands in the element; without
		// it some cameras yield an all-black canvas.
		await new Promise((r) => requestAnimationFrame(r));
		const canvas = document.createElement('canvas');
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		canvas.getContext('2d')!.drawImage(video, 0, 0);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
		if (!blob) throw new Error('PNG encoding failed');
		const bytes = new Uint8Array(await blob.arrayBuffer());
		// 9p first so the guest's poll sees it, then the mirror so it
		// survives a reload like any other /data file.
		await vm.putFile(name, bytes);
		await storeShareFile(name, bytes).catch(() => {});
	} finally {
		for (const track of stream.getTracks()) track.stop();
	}
}
