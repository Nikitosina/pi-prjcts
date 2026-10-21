export const CHUNK: number;
export const MAX_FRAME: number;
export const MAX_IN_FLIGHT: number;
export const PAIR_MS: number;

export function utf8(text: string): Uint8Array;
export function text(bytes: Uint8Array): string;
export function b64u(bytes: ArrayBuffer | Uint8Array): string;
export function fromB64u(value: string): Uint8Array;
export function random(length: number): Uint8Array;
export function sha256(data: string | Uint8Array): Promise<Uint8Array>;

export function generateSigningKey(extractable: boolean): Promise<CryptoKeyPair>;
export function keyId(publicKey: CryptoKey): Promise<string>;
export function importSigningKey(jwk: JsonWebKey): Promise<CryptoKey>;
export function sign(privateKey: CryptoKey, message: string): Promise<string>;
export function verify(id: string, message: string, signature: string): Promise<boolean>;
export function isId(value: unknown): value is string;

export function hostAuthText(nonce: string): string;
export function clientAuthText(hostId: string, nonce: string): string;
export function devicesText(list: string): string;

export function newPairCode(): string;
export function pairId(code: string): Promise<string>;
export function pairLink(relayOrigin: string, hostId: string, code: string, hostName: string): string;
export function parsePairFragment(hash: string): { hostId: string; code: string; hostName: string } | null;

export function withChannel(channel: number, payload: Uint8Array): Uint8Array;
export function splitChannel(frame: ArrayBuffer | Uint8Array): { channel: number; payload: Uint8Array };

export type TunnelHeader = { t: string; [key: string]: unknown };
export function encodeMessage(header: TunnelHeader, body?: Uint8Array): Uint8Array;
export function decodeMessage(bytes: Uint8Array): { header: TunnelHeader; body: Uint8Array };

export type Hello = { v: 1; mode: "device" | "pair"; deviceId: string; e: string; n: string; name?: string; sig: string; mac?: string };
export type Welcome = { v: 1; e: string; n: string; sig: string };
type SessionHandlers = { send: (record: Uint8Array) => void | Promise<void>; onMessage: (header: TunnelHeader, body: Uint8Array) => void | Promise<void>; onClose?: (reason: string) => void };

export function clientHello(input: { hostId: string; mode: "device" | "pair"; deviceKey: CryptoKey; deviceId: string; name?: string; code?: string }): Promise<{ hello: Hello; state: unknown }>;
export function readHello(hostId: string, hello: unknown): Promise<string>;
export function verifyPairMac(code: string, t1: string, mac: string): Promise<boolean>;
export function hostWelcome(input: { hostKey: CryptoKey; hello: Hello; t1: string } & SessionHandlers): Promise<{ welcome: Welcome; session: Session }>;
export function clientFinish(state: unknown, welcome: unknown, handlers: SessionHandlers): Promise<Session>;

export class Session {
  get closed(): boolean;
  write(header: TunnelHeader, body?: Uint8Array): Promise<void>;
  receive(record: ArrayBuffer | Uint8Array): Promise<void>;
  close(reason?: string): void;
}
