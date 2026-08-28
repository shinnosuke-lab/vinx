/**
 * Minimal Web Bluetooth declarations — Chromium-only, absent from
 * TypeScript's DOM lib. Just the surface ble.ts touches; `navigator.
 * bluetooth` and `requestLEScan` (an experimental-flag feature) are optional
 * so feature-detection stays honest.
 */

interface BluetoothRemoteGATTDescriptor {
	readonly uuid: string;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
	readonly uuid: string;
	readonly properties: {
		readonly read: boolean;
		readonly write: boolean;
		readonly writeWithoutResponse: boolean;
		readonly notify: boolean;
		readonly indicate: boolean;
	};
	readonly value: DataView | null;
	readValue(): Promise<DataView>;
	writeValue(value: BufferSource): Promise<void>;
	startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
	stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
	readonly uuid: string;
	readonly isPrimary: boolean;
	getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]>;
	getCharacteristic(uuid: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
	readonly connected: boolean;
	connect(): Promise<BluetoothRemoteGATTServer>;
	disconnect(): void;
	getPrimaryServices(): Promise<BluetoothRemoteGATTService[]>;
	getPrimaryService(uuid: string | number): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
	readonly id: string;
	readonly name?: string;
	readonly gatt?: BluetoothRemoteGATTServer;
}

interface BluetoothLEScan {
	stop(): void;
}

interface BluetoothAdvertisingEvent extends Event {
	readonly device: BluetoothDevice;
	readonly rssi?: number;
	readonly name?: string;
	readonly manufacturerData: Map<number, DataView>;
}

interface RequestDeviceOptions {
	filters?: { services?: (string | number)[] }[];
	optionalServices?: (string | number)[];
	acceptAllDevices?: boolean;
}

interface Bluetooth extends EventTarget {
	requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
	getDevices?(): Promise<BluetoothDevice[]>;
	/** Experimental: exists only behind chrome://flags web platform features. */
	requestLEScan?(options?: { acceptAllAdvertisements?: boolean }): Promise<BluetoothLEScan>;
}

interface Navigator {
	readonly bluetooth?: Bluetooth;
}

declare const BluetoothUUID:
	| {
			getService(name: string | number): string;
			getCharacteristic(name: string | number): string;
	  }
	| undefined;
