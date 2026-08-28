/**
 * Minimal Web Serial declarations — the API is Chromium-only and TypeScript's
 * DOM lib does not carry it. Just the surface vm.ts and terminal.tsx touch;
 * `navigator.serial` is optional so feature-detection stays honest.
 */

interface SerialPort {
	open(options: { baudRate: number }): Promise<void>;
	close(): Promise<void>;
	readonly readable: ReadableStream<Uint8Array> | null;
	readonly writable: WritableStream<Uint8Array> | null;
	getInfo(): { usbVendorId?: number; usbProductId?: number };
}

interface Serial {
	requestPort(): Promise<SerialPort>;
	getPorts(): Promise<SerialPort[]>;
}

interface Navigator {
	readonly serial?: Serial;
}
