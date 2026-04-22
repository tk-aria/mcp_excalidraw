import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeleted, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;
  // Arrow element binding
  start?: { id: string };
  end?: { id: string };
  strokeStyle?: string;
  endArrowhead?: string;
  startArrowhead?: string;
  // Image element fields
  fileId?: string;
  status?: string;
  scale?: [number, number];
  angle?: number;
  link?: string | null;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  files?: Record<string, unknown>;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
const AUTO_SYNC_DEBOUNCE_MS = 1200;

// Helper function to clean elements for Excalidraw
const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {
  const {
    createdAt,
    updatedAt,
    version,
    syncedAt,
    source,
    syncTimestamp,
    ...cleanElement
  } = element;
  return cleanElement;
}

// Helper function to validate and fix element binding data
const validateAndFixBindings = (elements: Partial<ExcalidrawElement>[]): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map(el => [el.id!, el]));

  return elements.map(element => {
    const fixedElement = { ...element };

    // Validate and fix boundElements
    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          // Ensure binding has required properties
          if (!binding || typeof binding !== 'object') return false;
          if (!binding.id || !binding.type) return false;

          // Ensure the referenced element exists
          const referencedElement = elementMap.get(binding.id);
          if (!referencedElement) return false;

          // Validate binding type
          if (!['text', 'arrow'].includes(binding.type)) return false;

          return true;
        });

        // Remove boundElements if empty
        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        // Invalid boundElements format, set to null
        fixedElement.boundElements = null;
      }
    }

    // Validate and fix containerId
    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        // Container doesn't exist, remove containerId
        fixedElement.containerId = null;
      }
    }

    return fixedElement;
  });
}

const isImageElement = (element: Partial<ExcalidrawElement>): boolean => {
  return element.type === 'image'
}

const isShapeContainerType = (type: string | undefined): boolean => {
  return type === 'rectangle' || type === 'ellipse' || type === 'diamond'
}

const recenterBoundShapeTextElements = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map((el) => [el.id, el]))

  return elements.map((element) => {
    if (element.type !== 'text' || !element.containerId) {
      return element
    }

    const textElement = element as ExcalidrawElement & { type: 'text'; containerId: string; autoResize?: boolean }
    const container = elementMap.get(textElement.containerId) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined
    if (!container || !isShapeContainerType(container.type)) {
      return element
    }

    if (textElement.autoResize === false) {
      return element
    }

    if (
      typeof container.x !== 'number' ||
      typeof container.y !== 'number' ||
      typeof container.width !== 'number' ||
      typeof container.height !== 'number' ||
      typeof textElement.width !== 'number' ||
      typeof textElement.height !== 'number'
    ) {
      return element
    }

    return {
      ...element,
      x: container.x + (container.width - textElement.width) / 2,
      y: container.y + (container.height - textElement.height) / 2,
    }
  })
}

const normalizeImageElement = (element: Partial<ExcalidrawElement>): Partial<ExcalidrawElement> => {
  const img = element as any
  return {
    ...img,
    angle: img.angle || 0,
    strokeColor: img.strokeColor || 'transparent',
    backgroundColor: img.backgroundColor || 'transparent',
    fillStyle: img.fillStyle || 'solid',
    strokeWidth: img.strokeWidth || 1,
    strokeStyle: img.strokeStyle || 'solid',
    roughness: img.roughness ?? 0,
    opacity: img.opacity ?? 100,
    groupIds: img.groupIds || [],
    roundness: null,
    seed: img.seed || Math.floor(Math.random() * 1000000),
    version: img.version || 1,
    versionNonce: img.versionNonce || Math.floor(Math.random() * 1000000),
    isDeleted: img.isDeleted ?? false,
    boundElements: img.boundElements || null,
    link: img.link || null,
    locked: img.locked || false,
    status: img.status || 'saved',
    fileId: img.fileId,
    scale: img.scale || [1, 1],
  }
}

// Helper: restore startBinding/endBinding/boundElements after convertToExcalidrawElements strips them
const restoreBindings = (
  convertedElements: readonly any[],
  originalElements: Partial<ExcalidrawElement>[]
): any[] => {
  const originalMap = new Map<string, any>();
  for (const el of originalElements) {
    if (el.id) originalMap.set(el.id, el);
  }

  return convertedElements.map((el: any) => {
    const orig = originalMap.get(el.id);
    if (!orig) return el;

    const patched = { ...el };

    if (orig.startBinding && !el.startBinding) {
      patched.startBinding = orig.startBinding;
    }
    if (orig.endBinding && !el.endBinding) {
      patched.endBinding = orig.endBinding;
    }
    if (orig.boundElements && (!el.boundElements || el.boundElements.length === 0)) {
      patched.boundElements = orig.boundElements;
    }
    if (orig.elbowed !== undefined && el.elbowed === undefined) {
      patched.elbowed = orig.elbowed;
    }

    return patched;
  });
};

const convertElementsPreservingImageProps = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  if (elements.length === 0) return []

  const validatedElements = validateAndFixBindings(elements)
  const imageElements = validatedElements.filter(isImageElement).map(normalizeImageElement)
  const nonImageElements = validatedElements.filter(el => !isImageElement(el))
  // convertToExcalidrawElements may expand labeled shapes into [shape, textElement],
  // so we cannot assume a 1:1 mapping — return all converted elements directly.
  const convertedNonImageElements = convertToExcalidrawElements(nonImageElements as any, { regenerateIds: false })
  const restoredNonImageElements = restoreBindings(convertedNonImageElements, nonImageElements)
  return recenterBoundShapeTextElements([...restoredNonImageElements, ...imageElements])
}

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  // Ref so WS message handlers (captured in stale closures) always see the latest API instance
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI

    // When excalidrawAPI becomes available, apply any Yjs elements that arrived
    // before the API was ready (initial sync race condition fix)
    if (excalidrawAPI && yElementsRef.current) {
      const yElements = yElementsRef.current
      if (yElements.size > 0) {
        console.log(`[Yjs] API ready — applying ${yElements.size} existing elements`)
        suppressYjsSyncRef.current = true
        const currentMap = new Map<string, any>()
        yElements.forEach((val: any, key: string) => {
          currentMap.set(key, cleanElementForExcalidraw(val))
        })
        const merged = Array.from(currentMap.values())
        const converted = convertElementsPreservingImageProps(merged as any)
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: converted,
          captureUpdate: CaptureUpdateAction.NEVER
        })
        // Update nonce tracking
        const newPrev = new Map<string, number>()
        excalidrawAPI.getSceneElements().forEach((el: any) => {
          newPrev.set(el.id, el.versionNonce)
        })
        prevElementNoncesRef.current = newPrev
        setTimeout(() => { suppressYjsSyncRef.current = false }, 0)
      }
    }
  }, [excalidrawAPI])
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)

  // Sync state management
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncInFlightRef = useRef<boolean>(false)
  const suppressAutoSyncCountRef = useRef<number>(0)

  // ── Yjs state ────────────────────────────────────────────────
  const ydocRef = useRef<Y.Doc | null>(null)
  const yjsProviderRef = useRef<WebsocketProvider | null>(null)
  const yElementsRef = useRef<Y.Map<any> | null>(null)
  const suppressYjsSyncRef = useRef<boolean>(false) // prevent infinite loop
  const prevElementNoncesRef = useRef<Map<string, number>>(new Map()) // id → versionNonce for change detection
  const prevFileIdsRef = useRef<Set<string>>(new Set()) // track uploaded file IDs
  const userInteractedRef = useRef<boolean>(false)

  const applySceneUpdateWithoutAutoSync = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    suppressAutoSyncCountRef.current += 1
    api.updateScene(scene)
    setTimeout(() => {
      suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
    }, 0)
  }

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
    }
  }, [])

  // ── Yjs initialization with fallback URLs ───────────────────
  useEffect(() => {
    const doc = new Y.Doc()
    ydocRef.current = doc
    const yElements = doc.getMap('elements')
    yElementsRef.current = yElements

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'

    // Build candidate URLs in priority order:
    // 1. VITE_YJS_WS_URL env var (explicit override)
    // 2. window.location.host (same host:port — works when canvas serves directly)
    // 3. window.location.hostname (port 80/443 — works behind non-WS proxy)
    const envUrl = (import.meta as any).env?.VITE_YJS_WS_URL as string | undefined
    const hostUrl = `${wsProtocol}//${window.location.host}/yjs`
    const hostnameUrl = `${wsProtocol}//${window.location.hostname}/yjs`
    const candidateUrls = envUrl ? [envUrl] : [hostUrl, hostnameUrl]
    // Deduplicate (host === hostname when using default port)
    const urls = [...new Set(candidateUrls)]

    let currentUrlIndex = 0
    const FALLBACK_TIMEOUT_MS = 3000

    const connectProvider = (url: string): WebsocketProvider => {
      console.log(`[Yjs] Trying: ${url}`)
      return new WebsocketProvider(url, 'excalidraw-room', doc)
    }

    let provider = connectProvider(urls[0])
    yjsProviderRef.current = provider
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null

    const tryNextUrl = () => {
      currentUrlIndex++
      if (currentUrlIndex < urls.length) {
        console.log(`[Yjs] Falling back to: ${urls[currentUrlIndex]}`)
        provider.disconnect()
        provider.destroy()
        provider = connectProvider(urls[currentUrlIndex])
        yjsProviderRef.current = provider
        setupProviderListeners()
        // Set another fallback timer for the next candidate
        if (currentUrlIndex + 1 < urls.length) {
          fallbackTimer = setTimeout(tryNextUrl, FALLBACK_TIMEOUT_MS)
        }
      }
    }

    const setupProviderListeners = () => {
      provider.on('status', (event: { status: string }) => {
        console.log(`[Yjs] ${urls[currentUrlIndex]} status: ${event.status}`)
        if (event.status === 'connected' && fallbackTimer) {
          clearTimeout(fallbackTimer)
          fallbackTimer = null
          console.log(`[Yjs] Connected successfully to: ${urls[currentUrlIndex]}`)
        }
      })
    }

    setupProviderListeners()
    // Start fallback timer if we have more candidates
    if (urls.length > 1) {
      fallbackTimer = setTimeout(tryNextUrl, FALLBACK_TIMEOUT_MS)
    }

    // Observe Y.Map changes → apply to Excalidraw canvas
    yElements.observe((event: Y.YMapEvent<any>) => {
      if (event.transaction.origin === 'local') return // skip our own changes

      const api = excalidrawAPIRef.current
      if (!api) return

      suppressYjsSyncRef.current = true

      const currentElements = api.getSceneElements()
      const currentMap = new Map(currentElements.map(el => [el.id, el]))

      // Apply additions and updates
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'add' || change.action === 'update') {
          const serverEl = yElements.get(key)
          if (serverEl) {
            const cleaned = cleanElementForExcalidraw(serverEl)
            currentMap.set(key, cleaned as any)
          }
        } else if (change.action === 'delete') {
          currentMap.delete(key)
        }
      })

      const merged = Array.from(currentMap.values())
      const converted = convertElementsPreservingImageProps(merged as any)
      applySceneUpdateWithoutAutoSync(api, {
        elements: converted,
        captureUpdate: CaptureUpdateAction.NEVER
      })

      // Update prev tracking with current nonces
      const newPrev = new Map<string, number>()
      api.getSceneElements().forEach(el => {
        newPrev.set(el.id, el.versionNonce)
      })
      prevElementNoncesRef.current = newPrev

      setTimeout(() => {
        suppressYjsSyncRef.current = false
      }, 0)
    })

    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer)
      provider.disconnect()
      provider.destroy()
      doc.destroy()
    }
  }, [])

  // ── Yjs onChange handler: push local changes to Y.Map ────────
  const handleYjsSync = useCallback(() => {
    if (suppressYjsSyncRef.current) return
    const api = excalidrawAPIRef.current
    const yElements = yElementsRef.current
    const doc = ydocRef.current
    if (!api || !yElements || !doc) return

    const currentElements = api.getSceneElements()
    const currentNonces = new Map<string, number>()
    const prev = prevElementNoncesRef.current
    let hasChanges = false

    doc.transact(() => {
      // Only write elements whose versionNonce changed
      // versionNonce is regenerated on EVERY element modification in Excalidraw
      currentElements.forEach(el => {
        currentNonces.set(el.id, el.versionNonce)
        const prevNonce = prev.get(el.id)
        if (prevNonce === undefined || prevNonce !== el.versionNonce) {
          yElements.set(el.id, { ...el })
          hasChanges = true
        }
      })

      // Delete elements that are no longer in the scene (eraser, delete key)
      prev.forEach((_, id) => {
        if (!currentNonces.has(id) && yElements.has(id)) {
          yElements.delete(id)
          hasChanges = true
        }
      })
    }, 'local')

    prevElementNoncesRef.current = currentNonces

    // Sync new files (images) to server via REST API
    // Excalidraw stores image binary data separately from elements
    if (hasChanges) {
      const files = api.getFiles()
      const fileIds = Object.keys(files)
      if (fileIds.length > 0) {
        const prev = prevFileIdsRef.current
        const newFiles = fileIds.filter(id => !prev.has(id))
        if (newFiles.length > 0) {
          const filesToUpload = newFiles.map(id => files[id])
          fetch('/api/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: filesToUpload })
          }).catch(err => console.error('[Yjs] Failed to upload files:', err))
          newFiles.forEach(id => prev.add(id))
        }
      }
    }
  }, [])

  // WebSocket connection (legacy - for MCP notifications like viewport, export, mermaid)
  useEffect(() => {
    connectWebSocket()
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close()
      }
    }
  }, [])

  // Ensure legacy WebSocket is connected (for viewport/export/mermaid notifications)
  useEffect(() => {
    if (excalidrawAPI) {
      if (!isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected])

  const loadExistingElements = async (): Promise<void> => {
    try {
      const response = await fetch('/api/elements')
      const result: ApiResponse = await response.json()

      if (result.success && result.elements && result.elements.length > 0) {
        const cleanedElements = result.elements.map(cleanElementForExcalidraw)
        const convertedElements = convertElementsPreservingImageProps(cleanedElements)
        if (excalidrawAPI) {
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: convertedElements,
            captureUpdate: CaptureUpdateAction.NEVER
          })
        }
      }

      const filesResponse = await fetch('/api/files')
      if (filesResponse.ok) {
        const filesResult = await filesResponse.json() as ApiResponse
        if (filesResult.files) {
          excalidrawAPI?.addFiles(Object.values(filesResult.files))
        }
      }
    } catch (error) {
      console.error('Error loading existing elements:', error)
    }
  }

  const connectWebSocket = (urlIndex = 0): void => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const candidates = [
      `${protocol}//${window.location.host}`,
      `${protocol}//${window.location.hostname}`,
    ]
    const urls = [...new Set(candidates)]
    if (urlIndex >= urls.length) return

    const wsUrl = urls[urlIndex]
    console.log(`[WS] Trying: ${wsUrl}`)
    websocketRef.current = new WebSocket(wsUrl)

    websocketRef.current.onopen = () => {
      setIsConnected(true)
      // Element loading is handled by Yjs sync — no need to fetch via HTTP
    }

    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }

    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)

      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000)
      }
    }

    websocketRef.current.onerror = (error: Event) => {
      console.error(`[WS] Error on ${wsUrl}:`, error)
      setIsConnected(false)
      // Try next URL candidate
      if (urlIndex + 1 < urls.length) {
        console.log(`[WS] Falling back to next candidate...`)
        websocketRef.current?.close()
        websocketRef.current = null
        connectWebSocket(urlIndex + 1)
      }
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    const excalidrawAPI = excalidrawAPIRef.current
    if (!excalidrawAPI) {
      return
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      const mergeAndApplySceneElements = (incomingElements: Partial<ExcalidrawElement>[]): void => {
        if (incomingElements.length === 0) return

        const incomingById = new Map<string, Partial<ExcalidrawElement>>()
        incomingElements.forEach((element) => {
          if (element.id) {
            incomingById.set(element.id, element)
          }
        })

        const mergedElements: Partial<ExcalidrawElement>[] = currentElements.map((element) => {
          const incoming = incomingById.get(element.id)
          if (!incoming) return element
          incomingById.delete(element.id)
          return { ...element, ...incoming }
        })

        mergedElements.push(...incomingById.values())

        const convertedElements = convertElementsPreservingImageProps(mergedElements)
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: convertedElements,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }

      switch (data.type) {
        // ── Element sync is now handled by Yjs — skip legacy merge handlers ──
        case 'initial_elements':
        case 'element_created':
        case 'element_updated':
        case 'element_deleted':
        case 'elements_batch_created':
        case 'elements_synced':
          // No-op: Yjs Y.Map handles element synchronization
          console.log(`[legacy WS] Ignoring element sync message: ${data.type}`)
          break

        case 'files_added':
          if (Array.isArray((data as any).files)) {
            excalidrawAPI.addFiles((data as any).files)
          }
          break

        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break

        case 'canvas_cleared':
          console.log('Canvas cleared by server')
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          break

        case 'export_image_request':
          if (data.requestId) {
            try {
              const elements = excalidrawAPI.getSceneElements()
              const appState = excalidrawAPI.getAppState()
              const files = excalidrawAPI.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch('/api/export/image/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString
                  })
                })
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files,
                  mimeType: 'image/png'
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) {
                      throw new Error('Could not extract base64 data from result')
                    }
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message
                      })
                    }).catch(() => { })
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch('/api/export/image/result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed'
                    })
                  }).catch(() => { })
                }
                reader.readAsDataURL(blob)
              }
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await fetch('/api/export/image/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message
                })
              })
            }
          }
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = excalidrawAPI.getSceneElements()
                if (allElements.length > 0) {
                  excalidrawAPI.scrollToContent(allElements, { fitToViewport: true, animate: true })
                }
              } else if (data.scrollToElementId) {
                const allElements = excalidrawAPI.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  excalidrawAPI.scrollToContent([targetElement], { fitToViewport: false, animate: true })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                // Direct zoom/scroll control
                const appState: any = {}
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom }
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY
                }
                if (Object.keys(appState).length > 0) {
                  applySceneUpdateWithoutAutoSync(excalidrawAPI, { appState })
                }
              }

              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: 'Viewport updated'
                })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message
                })
              }).catch(() => { })
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: false })
                applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                  elements: convertedElements,
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  excalidrawAPI.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')

                // Sync to backend automatically after creating elements
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  // Data format conversion for backend
  const convertToBackendFormat = (element: ExcalidrawElement): ServerElement => {
    return {
      ...element
    } as ServerElement
  }

  // Format sync time display
  const formatSyncTime = (time: Date | null): string => {
    if (!time) return ''
    return time.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  // Main sync function
  const syncToBackend = async (options: { silent?: boolean } = {}): Promise<void> => {
    const { silent = false } = options

    if (!excalidrawAPI) {
      console.warn('Excalidraw API not available')
      return
    }

    if (syncInFlightRef.current) {
      return
    }

    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }

    syncInFlightRef.current = true
    if (!silent) {
      setSyncStatus('syncing')
    }

    try {
      // 1. Get current elements (include isDeleted so server can propagate deletions)
      const currentElements = excalidrawAPI.getSceneElements()
      console.log(`Syncing ${currentElements.length} elements to backend`)

      // Convert to backend format (keep isDeleted elements for deletion propagation)
      const backendElements = currentElements.map(convertToBackendFormat)

      // 4. Send to backend
      const response = await fetch('/api/elements/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          elements: backendElements,
          timestamp: new Date().toISOString()
        })
      })

      if (response.ok) {
        const result: ApiResponse = await response.json()
        setLastSyncTime(new Date())
        console.log(`Sync successful: ${result.count} elements synced`)

        if (!silent) {
          setSyncStatus('success')
          // Reset status after 2 seconds
          setTimeout(() => setSyncStatus('idle'), 2000)
        }
      } else {
        const error: ApiResponse = await response.json()
        console.error('Sync failed:', error.error)
        if (!silent) {
          setSyncStatus('error')
        }
      }
    } catch (error) {
      console.error('Sync error:', error)
      if (!silent) {
        setSyncStatus('error')
      }
    } finally {
      syncInFlightRef.current = false
    }
  }

  const scheduleAutoSync = (): void => {
    if (!isConnected || !excalidrawAPI) {
      return
    }
    if (!userInteractedRef.current) {
      return
    }
    if (suppressAutoSyncCountRef.current > 0) {
      return
    }
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
    }

    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      if (suppressAutoSyncCountRef.current > 0 || syncInFlightRef.current) {
        return
      }
      void syncToBackend({ silent: true })
    }, AUTO_SYNC_DEBOUNCE_MS)
  }

  const clearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
        // Get all current elements and delete them from backend
        const response = await fetch('/api/elements')
        const result: ApiResponse = await response.json()

        if (result.success && result.elements) {
          const deletePromises = result.elements.map(element =>
            fetch(`/api/elements/${element.id}`, { method: 'DELETE' })
          )
          await Promise.all(deletePromises)
        }

        // Clear the frontend canvas
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      } catch (error) {
        console.error('Error clearing canvas:', error)
        // Still clear frontend even if backend fails
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      }
    }
  }

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <h1>Excalidraw Canvas</h1>
        <div className="controls">
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>

          {/* Sync Controls */}
          <div className="sync-controls">
            <button
              className={`btn-primary ${syncStatus === 'syncing' ? 'btn-loading' : ''}`}
              onClick={syncToBackend}
              disabled={syncStatus === 'syncing' || !excalidrawAPI}
            >
              {syncStatus === 'syncing' && <span className="spinner"></span>}
              {syncStatus === 'syncing' ? 'Syncing...' : 'Sync to Backend'}
            </button>

            {/* Sync Status */}
            <div className="sync-status">
              {syncStatus === 'success' && (
                <span className="sync-success">✅ Synced</span>
              )}
              {syncStatus === 'error' && (
                <span className="sync-error">❌ Sync Failed</span>
              )}
              {lastSyncTime && syncStatus === 'idle' && (
                <span className="sync-time">
                  Last sync: {formatSyncTime(lastSyncTime)}
                </span>
              )}
            </div>
          </div>

          <button className="btn-secondary" onClick={clearCanvas}>Clear Canvas</button>
        </div>
      </div>

      {/* Canvas Container */}
      <div className="canvas-container">
        <div
          onPointerDownCapture={() => {
            userInteractedRef.current = true
          }}
          onKeyDownCapture={() => {
            userInteractedRef.current = true
          }}
          style={{ width: '100%', height: '100%' }}
        >
          <Excalidraw
            excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
            onChange={() => {
              handleYjsSync()
            }}
            initialData={{
              elements: [],
              appState: {
                theme: 'light',
                viewBackgroundColor: '#ffffff'
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}

export default App
