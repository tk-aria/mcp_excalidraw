/**
 * Yjs-backed element storage that exposes a Map-compatible interface.
 * Drop-in replacement for the plain `elements: Map<string, ServerElement>` used
 * throughout server.ts, so every REST endpoint and MCP tool keeps working without
 * changes — while gaining CRDT-based bidirectional sync for free.
 */

import * as Y from 'yjs';
import { WebSocketServer, WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Server as HTTPServer } from 'http';
import type { ServerElement } from './types.js';
import logger from './utils/logger.js';

// ── Y.Doc singleton ──────────────────────────────────────────────
export const ydoc = new Y.Doc();
export const yElements: Y.Map<ServerElement> = ydoc.getMap('elements');

// ── Awareness (cursor positions etc. — optional future use) ──────
export const awareness = new awarenessProtocol.Awareness(ydoc);

// ── Map-compatible wrapper ───────────────────────────────────────
// Implements the subset of Map<string, ServerElement> used in server.ts
// so we can swap `elements` without touching any endpoint code.

export class YjsElementsMap {
  get size(): number {
    return yElements.size;
  }

  get(key: string): ServerElement | undefined {
    return yElements.get(key) as ServerElement | undefined;
  }

  has(key: string): boolean {
    return yElements.has(key);
  }

  set(key: string, value: ServerElement): this {
    ydoc.transact(() => {
      yElements.set(key, value);
    }, 'server');
    return this;
  }

  delete(key: string): boolean {
    if (!yElements.has(key)) return false;
    ydoc.transact(() => {
      yElements.delete(key);
    }, 'server');
    return true;
  }

  clear(): void {
    ydoc.transact(() => {
      const keys = Array.from(yElements.keys());
      keys.forEach(k => yElements.delete(k));
    }, 'server');
  }

  values(): IterableIterator<ServerElement> {
    return yElements.values() as IterableIterator<ServerElement>;
  }

  keys(): IterableIterator<string> {
    return yElements.keys();
  }

  forEach(callback: (value: ServerElement, key: string, map: any) => void): void {
    yElements.forEach((value, key) => {
      callback(value as ServerElement, key, this);
    });
  }

  entries(): IterableIterator<[string, ServerElement]> {
    return yElements.entries() as IterableIterator<[string, ServerElement]>;
  }

  [Symbol.iterator](): IterableIterator<[string, ServerElement]> {
    return this.entries();
  }
}

// ── Yjs WebSocket server ─────────────────────────────────────────
// Handles the Yjs binary sync protocol on a separate WS path (/yjs).

const messageSync = 0;
const messageAwareness = 1;

const yjsClients = new Set<WebSocket>();

function sendYjsMessage(ws: WebSocket, buf: Uint8Array): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(buf, (err) => {
      if (err) logger.warn('Yjs send error', err);
    });
  }
}

// Broadcast server-originated updates (REST API / MCP) to all Yjs clients
function broadcastServerUpdate(update: Uint8Array): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const buf = encoding.toUint8Array(encoder);
  yjsClients.forEach(ws => sendYjsMessage(ws, buf));
}

// Only broadcast updates from server (REST API / MCP), not from Yjs clients
// Client-to-client sync is handled by raw message forwarding in the WS handler
ydoc.on('update', (update: Uint8Array, origin: any) => {
  if (origin === 'yjs-client') return; // forwarded separately
  broadcastServerUpdate(update);
});

export function setupYjsWebSocket(_server: HTTPServer): WebSocketServer {
  const yjsWss = new WebSocketServer({ noServer: true });

  yjsWss.on('connection', (ws: WebSocket) => {
    yjsClients.add(ws);
    logger.info('Yjs WebSocket connection established');

    // Send initial sync step 1
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, ydoc);
    sendYjsMessage(ws, encoding.toUint8Array(encoder));

    // Send awareness state
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, messageAwareness);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys()))
    );
    sendYjsMessage(ws, encoding.toUint8Array(awarenessEncoder));

    ws.on('message', (data: Buffer) => {
      try {
        const rawBuf = new Uint8Array(data);
        const decoder = decoding.createDecoder(rawBuf);
        const msgType = decoding.readVarUint(decoder);

        switch (msgType) {
          case messageSync: {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageSync);
            syncProtocol.readSyncMessage(decoder, encoder, ydoc, 'yjs-client');
            // Reply to sender if needed (e.g. SyncStep2 response)
            const reply = encoding.toUint8Array(encoder);
            if (encoding.length(encoder) > 1) {
              sendYjsMessage(ws, reply);
            }
            // Forward raw message to all OTHER clients (no re-encoding)
            yjsClients.forEach(client => {
              if (client !== ws) {
                sendYjsMessage(client, rawBuf);
              }
            });
            break;
          }
          case messageAwareness: {
            awarenessProtocol.applyAwarenessUpdate(
              awareness,
              decoding.readVarUint8Array(decoder),
              ws as any
            );
            // Broadcast awareness to other clients
            const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
              awareness,
              Array.from(awareness.getStates().keys())
            );
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(encoder, awarenessUpdate);
            const buf = encoding.toUint8Array(encoder);
            yjsClients.forEach(client => {
              if (client !== ws) sendYjsMessage(client, buf);
            });
            break;
          }
        }
      } catch (err) {
        logger.error('Yjs message handling error:', err);
      }
    });

    ws.on('close', () => {
      yjsClients.delete(ws);
      logger.info('Yjs WebSocket connection closed');
    });

    ws.on('error', (err) => {
      logger.error('Yjs WebSocket error:', err);
      yjsClients.delete(ws);
    });
  });

  logger.info('Yjs WebSocket server running on path /yjs');
  return yjsWss;
}
