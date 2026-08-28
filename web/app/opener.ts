/**
 * The page half of open(1) in the guest: give the bytes a MIME type and hand
 * them to the browser, which renders what it can (PDF, HTML, images, video,
 * text) in a new tab and downloads the rest. Plus the base64 helpers the
 * terminal's OSC handlers need.
 *
 * window.open here usually runs outside a user gesture (the trigger was
 * serial output), so a popup blocker may say no; `OpenRequest.open()` reports
 * that, and the terminal shows a click-me chip whose click is a gesture.
 */

import { triggerDownload } from './downloads';

const decoder = new TextDecoder();

export function bytesFromB64(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

export function textFromB64(b64: string): string {
	return decoder.decode(bytesFromB64(b64));
}

/**
 * By extension, not by sniffing: the point is to tell the browser what it is
 * looking at, and the guest's files carry honest names. Types the browser
 * renders natively; everything else falls to octet-stream, which downloads.
 */
const MIME: Record<string, string> = {
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	html: 'text/html',
	htm: 'text/html',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	json: 'application/json',
	xml: 'text/xml',
};
/** Source and prose render as plain text rather than downloading. */
const TEXTISH = new Set([
	'txt', 'log', 'md', 'csv', 'ini', 'conf', 'sh', 'py', 'js', 'ts', 'c', 'h',
	'cpp', 'rs', 'go', 'yaml', 'yml', 'toml', 'diff', 'patch',
]);

export function mimeFor(name: string): string {
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	if (MIME[ext]) return MIME[ext];
	if (TEXTISH.has(ext)) return 'text/plain; charset=utf-8';
	return 'application/octet-stream';
}

export interface OpenRequest {
	/** What the fallback chip should say, e.g. the file name. */
	label: string;
	/** Try to open; false means the popup blocker won (try again on a click). */
	open(): boolean;
}

export function fileOpener(name: string, bytes: Uint8Array): OpenRequest {
	const type = mimeFor(name);
	// A type the browser cannot render would download anyway — but navigating
	// a blob URL loses the filename (blob URLs carry none; the file lands as
	// a UUID). The <a download> path keeps the name, and no popup means no
	// blocker to appease.
	if (type === 'application/octet-stream') {
		return {
			label: name,
			open: () => {
				triggerDownload(name, bytes);
				return true;
			},
		};
	}
	const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
	// Long fuse: the URL must survive until the person clicks the fallback
	// chip. Revocation is belt-and-braces against a chip nobody clicks.
	setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
	return {
		label: name,
		open: () => window.open(url, '_blank', 'noopener') !== null,
	};
}

export function urlOpener(url: string): OpenRequest {
	// The guest-side script only sends http(s), but the page is the security
	// boundary; anything else (javascript:, file:) stays unopened.
	if (!/^https?:\/\//i.test(url)) return { label: url, open: () => true };
	return {
		label: url.replace(/^https?:\/\//i, '').slice(0, 60),
		open: () => window.open(url, '_blank', 'noopener') !== null,
	};
}
