declare module 'y-protocols/sync' {
  import * as Y from 'yjs';
  export function writeSyncStep1(encoder: any, doc: Y.Doc): void;
  export function writeSyncStep2(encoder: any, doc: Y.Doc, encodedStateVector: Uint8Array): void;
  export function readSyncMessage(decoder: any, encoder: any, doc: Y.Doc, transactionOrigin: any, errorHandler?: any): number;
  export function writeUpdate(encoder: any, update: Uint8Array): void;
  export const messageYjsSyncStep1: number;
  export const messageYjsSyncStep2: number;
  export const messageYjsUpdate: number;
}

declare module 'y-protocols/awareness' {
  import * as Y from 'yjs';
  export class Awareness {
    constructor(doc: Y.Doc);
    getStates(): Map<number, any>;
    setLocalState(state: any): void;
    setLocalStateField(field: string, value: any): void;
    getLocalState(): any;
    on(event: string, callback: (...args: any[]) => void): void;
    off(event: string, callback: (...args: any[]) => void): void;
    destroy(): void;
  }
  export function encodeAwarenessUpdate(awareness: Awareness, clients: number[]): Uint8Array;
  export function applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: any): void;
  export function removeAwarenessStates(awareness: Awareness, clients: number[], origin: any): void;
}

declare module 'lib0/encoding' {
  export function createEncoder(): any;
  export function writeVarUint(encoder: any, num: number): void;
  export function writeVarUint8Array(encoder: any, buf: Uint8Array): void;
  export function toUint8Array(encoder: any): Uint8Array;
  export function length(encoder: any): number;
}

declare module 'lib0/decoding' {
  export function createDecoder(buf: Uint8Array): any;
  export function readVarUint(decoder: any): number;
  export function readVarUint8Array(decoder: any): Uint8Array;
}
