#!/usr/bin/env node

// Disable colors to prevent ANSI color codes from breaking JSON parsing
process.env.NODE_DISABLE_COLORS = '1';
process.env.NO_COLOR = '1';

import { fileURLToPath } from "url";
import { deflateSync, inflateSync } from 'zlib';
import { webcrypto } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  CallToolRequest,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';
import {
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  validateElement,
  normalizeFontFamily
} from './types.js';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

// Safe file path validation to prevent path traversal attacks
const ALLOWED_EXPORT_DIRS = [
  process.env.EXCALIDRAW_EXPORT_DIR || process.cwd(),
  '/tmp',
  ...(process.env.EXCALIDRAW_EXTRA_DIRS ? process.env.EXCALIDRAW_EXTRA_DIRS.split(':') : [])
].map(d => path.resolve(d));

function sanitizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const allowed = ALLOWED_EXPORT_DIRS.some(dir =>
    resolved.startsWith(dir + path.sep) || resolved === dir
  );
  if (!allowed) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves outside allowed directories [${ALLOWED_EXPORT_DIRS.join(', ')}]. ` +
      `Set EXCALIDRAW_EXPORT_DIR or EXCALIDRAW_EXTRA_DIRS to add more.`
    );
  }
  return resolved;
}

// CRC32 for PNG tEXt chunk embedding
function crc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]!) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Express server configuration
const EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL || 'http://localhost:3000';
const ENABLE_CANVAS_SYNC = process.env.ENABLE_CANVAS_SYNC !== 'false'; // Default to true

// API Response types
interface ApiResponse {
  success: boolean;
  element?: ServerElement;
  elements?: ServerElement[];
  message?: string;
  error?: string;
  count?: number;
}

interface SyncResponse {
  element?: ServerElement;
  elements?: ServerElement[];
}

// Helper functions to sync with Express server (canvas)
async function syncToCanvas(operation: string, data: any): Promise<SyncResponse | null> {
  if (!ENABLE_CANVAS_SYNC) {
    logger.debug('Canvas sync disabled, skipping');
    return null;
  }

  try {
    let url: string;
    let options: any;
    
    switch (operation) {
      case 'create':
        url = `${EXPRESS_SERVER_URL}/api/elements`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;
        
      case 'update':
        url = `${EXPRESS_SERVER_URL}/api/elements/${data.id}`;
        options = {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;
        
      case 'delete':
        url = `${EXPRESS_SERVER_URL}/api/elements/${data.id}`;
        options = { method: 'DELETE' };
        break;
        
      case 'batch_create':
        url = `${EXPRESS_SERVER_URL}/api/elements/batch`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: data })
        };
        break;
        
      default:
        logger.warn(`Unknown sync operation: ${operation}`);
        return null;
    }

    logger.debug(`Syncing to canvas: ${operation}`, { url, data });
    const response = await fetch(url, options);

    // Parse JSON response regardless of HTTP status
    const result = await response.json() as ApiResponse;

    if (!response.ok) {
      logger.warn(`Canvas sync returned error status: ${response.status}`, result);
      throw new Error(result.error || `Canvas sync failed: ${response.status} ${response.statusText}`);
    }

    logger.debug(`Canvas sync successful: ${operation}`, result);
    return result as SyncResponse;
    
  } catch (error) {
    logger.warn(`Canvas sync failed for ${operation}:`, (error as Error).message);
    // Don't throw - we want MCP operations to work even if canvas is unavailable
    return null;
  }
}

// Helper to sync element creation to canvas
async function createElementOnCanvas(elementData: ServerElement): Promise<ServerElement | null> {
  const result = await syncToCanvas('create', elementData);
  return result?.element || elementData;
}

// Helper to sync element update to canvas  
async function updateElementOnCanvas(elementData: Partial<ServerElement> & { id: string }): Promise<ServerElement | null> {
  const result = await syncToCanvas('update', elementData);
  return result?.element || null;
}

// Helper to sync element deletion to canvas
async function deleteElementOnCanvas(elementId: string): Promise<any> {
  const result = await syncToCanvas('delete', { id: elementId });
  return result;
}

// Helper to sync batch creation to canvas
async function batchCreateElementsOnCanvas(elementsData: ServerElement[]): Promise<ServerElement[] | null> {
  const result = await syncToCanvas('batch_create', elementsData);
  return result?.elements || elementsData;
}

// Helper to fetch element from canvas
async function getElementFromCanvas(elementId: string): Promise<ServerElement | null> {
  if (!ENABLE_CANVAS_SYNC) {
    logger.debug('Canvas sync disabled, skipping fetch');
    return null;
  }

  try {
    const response = await fetch(`${EXPRESS_SERVER_URL}/api/elements/${elementId}`);
    if (!response.ok) {
      logger.warn(`Failed to fetch element ${elementId}: ${response.status}`);
      return null;
    }
    const data = await response.json() as { element?: ServerElement };
    return data.element || null;
  } catch (error) {
    logger.error('Error fetching element from canvas:', error);
    return null;
  }
}

// In-memory storage for scene state
interface SceneState {
  theme: string;
  viewport: { x: number; y: number; zoom: number };
  selectedElements: Set<string>;
  groups: Map<string, string[]>;
}

const sceneState: SceneState = {
  theme: 'light',
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedElements: new Set(),
  groups: new Map()
};

// Points schema: accept both {x, y} objects and [x, y] tuples
const PointObjectSchema = z.object({ x: z.number(), y: z.number() });
const PointTupleSchema = z.tuple([z.number(), z.number()]);
const PointSchema = z.union([PointObjectSchema, PointTupleSchema]);

// Normalize points to [x, y] tuple format that Excalidraw expects
function normalizePoints(points: Array<{ x: number; y: number } | [number, number]>): [number, number][] {
  return points.map(p => {
    if (Array.isArray(p)) return p as [number, number];
    return [p.x, p.y] as [number, number];
  });
}

// Schema definitions using zod
const ElementSchema = z.object({
  id: z.string().optional(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  points: z.array(PointSchema).optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  strokeStyle: z.string().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  elbowed: z.boolean().optional(),
  startElementId: z.string().optional(),
  endElementId: z.string().optional(),
  endArrowhead: z.string().optional(),
  startArrowhead: z.string().optional(),
});

const ElementIdSchema = z.object({
  id: z.string()
});

const ElementIdsSchema = z.object({
  elementIds: z.array(z.string())
});

const GroupIdSchema = z.object({
  groupId: z.string()
});

const AlignElementsSchema = z.object({
  elementIds: z.array(z.string()),
  alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom'])
});

const DistributeElementsSchema = z.object({
  elementIds: z.array(z.string()),
  direction: z.enum(['horizontal', 'vertical'])
});

const QuerySchema = z.object({
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  filter: z.record(z.any()).optional()
});

const ResourceSchema = z.object({
  resource: z.enum(['scene', 'library', 'theme', 'elements'])
});

// Diagram design guide — injected into LLM context via read_diagram_guide tool
const DIAGRAM_DESIGN_GUIDE = `# Excalidraw Diagram Design Guide

## Color Palette

### Stroke Colors (use for borders & text)
| Name    | Hex       | Use for                     |
|---------|-----------|-----------------------------|
| Black   | #1e1e1e   | Default text & borders      |
| Red     | #e03131   | Errors, warnings, critical  |
| Green   | #2f9e44   | Success, approved, healthy  |
| Blue    | #1971c2   | Primary actions, links      |
| Purple  | #9c36b5   | Services, middleware        |
| Orange  | #e8590c   | Async, queues, events       |
| Cyan    | #0c8599   | Data stores, databases      |
| Gray    | #868e96   | Annotations, secondary      |

### Fill Colors (use for backgroundColor — pastel fills)
| Name         | Hex       | Pairs with stroke |
|--------------|-----------|-------------------|
| Light Red    | #ffc9c9   | #e03131           |
| Light Green  | #b2f2bb   | #2f9e44           |
| Light Blue   | #a5d8ff   | #1971c2           |
| Light Purple | #eebefa   | #9c36b5           |
| Light Orange | #ffd8a8   | #e8590c           |
| Light Cyan   | #99e9f2   | #0c8599           |
| Light Gray   | #e9ecef   | #868e96           |
| White        | #ffffff   | #1e1e1e           |

## Sizing Rules

- **Minimum shape size**: width >= 120px, height >= 60px
- **Font sizes**: body text >= 16, titles/headers >= 20, small labels >= 14
- **Padding**: leave at least 20px inside shapes for text breathing room
- **Arrow length**: minimum 80px between connected shapes
- **Consistent sizing**: keep same-role shapes identical dimensions

## Layout Patterns

- **Grid snap**: align to 20px grid for clean layouts
- **Spacing**: 40–80px gap between adjacent shapes
- **Flow direction**: top-to-bottom (vertical) or left-to-right (horizontal)
- **Hierarchy**: important nodes larger or higher; left-to-right = temporal order
- **Grouping**: cluster related elements visually; use background rectangles as zones

## Arrow Binding Best Practices

- **Always bind**: use \`startElementId\` / \`endElementId\` to connect arrows to shapes
- **Dashed arrows**: use \`strokeStyle: "dashed"\` for async, optional, or event flows
- **Dotted arrows**: use \`strokeStyle: "dotted"\` for weak dependencies or annotations
- **Arrowheads**: default "arrow" for directed flow; "dot" for data stores; null for lines
- **Label arrows**: set \`text\` on arrows to describe the relationship (e.g., "HTTP", "publishes")

## Diagram Type Templates

### Architecture Diagram
- Shapes: 160×80 rectangles for services, 120×60 for small components
- Colors: different fill per layer (frontend=blue, backend=purple, data=cyan)
- Arrows: solid for sync calls, dashed for async/events
- Zones: large light-gray background rectangles with 20px fontSize labels

### Flowchart
- Shapes: 140×70 rectangles for steps, 100×100 diamonds for decisions
- Flow: top-to-bottom, 60px vertical spacing
- Colors: green start, red end, blue for process steps
- Arrows: solid, with "Yes"/"No" labels from diamonds

### ER Diagram
- Shapes: 180×40 per entity (wider for attribute lists)
- Layout: 80px between entities
- Arrows: use start/end arrowheads to show cardinality
- Colors: light-blue fill for entities, no fill for junction tables

## Anti-Patterns to Avoid

1. **Overlapping elements** — always leave gaps; use distribute_elements
2. **Cramped spacing** — minimum 40px between shapes
3. **Tiny fonts** — never below 14px; prefer 16+
4. **Manual arrow coordinates** — always use startElementId/endElementId binding
5. **Too many colors** — limit to 3–4 fill colors per diagram
6. **Inconsistent sizes** — same-role shapes should be same width/height
7. **No labels** — every shape and meaningful arrow should have text
8. **Flat layouts** — use zones/groups to create visual hierarchy

## Drawing Order (Recommended)

1. **Background zones** — large rectangles with light fill, low opacity
2. **Primary shapes** — services, entities, steps (with labels via \`text\`)
3. **Arrows** — connect shapes using binding IDs
4. **Annotations** — standalone text elements for notes, titles
5. **Refinement** — align, distribute, adjust spacing, screenshot to verify
`;

// Tool definitions
const tools: Tool[] = [
  {
    name: 'create_element',
    description: 'Create a new Excalidraw element. For arrows, use startElementId/endElementId to bind to shapes (auto-routes to edges).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Custom element ID (optional, auto-generated if omitted). Use with startElementId/endElementId in batch_create_elements.' },
        type: {
          type: 'string',
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES)
        },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        backgroundColor: { type: 'string' },
        strokeColor: { type: 'string' },
        strokeWidth: { type: 'number' },
        strokeStyle: { type: 'string', description: 'Stroke style: solid, dashed, dotted' },
        roughness: { type: 'number' },
        opacity: { type: 'number' },
        text: { type: 'string' },
        fontSize: { type: 'number' },
        fontFamily: { type: ['string', 'number'], description: 'Font family: virgil/hand/handwritten (1), helvetica/sans/sans-serif (2), cascadia/mono/monospace (3), excalifont (5), nunito (6), lilita/lilita one (7), comic shanns/comic (8), or numeric ID' },
        startElementId: { type: 'string', description: 'For arrows: ID of the element to bind the arrow start to. Arrow auto-routes to element edge.' },
        endElementId: { type: 'string', description: 'For arrows: ID of the element to bind the arrow end to. Arrow auto-routes to element edge.' },
        endArrowhead: { type: 'string', description: 'Arrowhead style at end: arrow, bar, dot, triangle, or null' },
        startArrowhead: { type: 'string', description: 'Arrowhead style at start: arrow, bar, dot, triangle, or null' }
      },
      required: ['type', 'x', 'y']
    }
  },
  {
    name: 'update_element',
    description: 'Update an existing Excalidraw element',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: {
          type: 'string',
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES)
        },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        backgroundColor: { type: 'string' },
        strokeColor: { type: 'string' },
        strokeWidth: { type: 'number' },
        strokeStyle: { type: 'string' },
        roughness: { type: 'number' },
        opacity: { type: 'number' },
        text: { type: 'string' },
        fontSize: { type: 'number' },
        fontFamily: { type: ['string', 'number'], description: 'Font family: virgil/hand/handwritten (1), helvetica/sans/sans-serif (2), cascadia/mono/monospace (3), excalifont (5), nunito (6), lilita/lilita one (7), comic shanns/comic (8), or numeric ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_element',
    description: 'Delete an Excalidraw element',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'query_elements',
    description: 'Query Excalidraw elements with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        type: { 
          type: 'string', 
          enum: Object.values(EXCALIDRAW_ELEMENT_TYPES) 
        },
        filter: { 
          type: 'object',
          additionalProperties: true
        }
      }
    }
  },
  {
    name: 'get_resource',
    description: 'Get an Excalidraw resource',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { 
          type: 'string', 
          enum: ['scene', 'library', 'theme', 'elements'] 
        }
      },
      required: ['resource']
    }
  },
  {
    name: 'group_elements',
    description: 'Group multiple elements together',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'ungroup_elements',
    description: 'Ungroup a group of elements',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' }
      },
      required: ['groupId']
    }
  },
  {
    name: 'align_elements',
    description: 'Align elements to a specific position',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        },
        alignment: { 
          type: 'string', 
          enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] 
        }
      },
      required: ['elementIds', 'alignment']
    }
  },
  {
    name: 'distribute_elements',
    description: 'Distribute elements evenly',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        },
        direction: { 
          type: 'string', 
          enum: ['horizontal', 'vertical'] 
        }
      },
      required: ['elementIds', 'direction']
    }
  },
  {
    name: 'lock_elements',
    description: 'Lock elements to prevent modification',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'unlock_elements',
    description: 'Unlock elements to allow modification',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { 
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'create_from_mermaid',
    description: 'Convert a Mermaid diagram to Excalidraw elements and render them on the canvas',
    inputSchema: {
      type: 'object',
      properties: {
        mermaidDiagram: {
          type: 'string',
          description: 'The Mermaid diagram definition (e.g., "graph TD; A-->B; B-->C;")'
        },
        config: {
          type: 'object',
          description: 'Optional Mermaid configuration',
          properties: {
            startOnLoad: { type: 'boolean' },
            flowchart: {
              type: 'object',
              properties: {
                curve: { type: 'string', enum: ['linear', 'basis'] }
              }
            },
            themeVariables: {
              type: 'object',
              properties: {
                fontSize: { type: 'string' }
              }
            },
            maxEdges: { type: 'number' },
            maxTextSize: { type: 'number' }
          }
        }
      },
      required: ['mermaidDiagram']
    }
  },
  {
    name: 'batch_create_elements',
    description: 'Create multiple Excalidraw elements at once. For arrows, use startElementId/endElementId to bind arrows to shapes — Excalidraw auto-routes to element edges. Assign custom id to shapes so arrows can reference them.',
    inputSchema: {
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Custom element ID. Arrows can reference this via startElementId/endElementId.' },
              type: {
                type: 'string',
                enum: Object.values(EXCALIDRAW_ELEMENT_TYPES)
              },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              backgroundColor: { type: 'string' },
              strokeColor: { type: 'string' },
              strokeWidth: { type: 'number' },
              strokeStyle: { type: 'string', description: 'Stroke style: solid, dashed, dotted' },
              roughness: { type: 'number' },
              opacity: { type: 'number' },
              text: { type: 'string' },
              fontSize: { type: 'number' },
              fontFamily: { type: ['string', 'number'], description: 'Font family: virgil/hand/handwritten (1), helvetica/sans/sans-serif (2), cascadia/mono/monospace (3), excalifont (5), nunito (6), lilita/lilita one (7), comic shanns/comic (8), or numeric ID' },
              startElementId: { type: 'string', description: 'For arrows: ID of element to bind arrow start to' },
              endElementId: { type: 'string', description: 'For arrows: ID of element to bind arrow end to' },
              endArrowhead: { type: 'string', description: 'Arrowhead style at end: arrow, bar, dot, triangle, or null' },
              startArrowhead: { type: 'string', description: 'Arrowhead style at start: arrow, bar, dot, triangle, or null' }
            },
            required: ['type', 'x', 'y']
          }
        }
      },
      required: ['elements']
    }
  },
  {
    name: 'get_element',
    description: 'Get a single Excalidraw element by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The element ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'clear_canvas',
    description: 'Clear all elements from the canvas',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'export_scene',
    description: 'Export the current canvas to .excalidraw JSON format. Optionally write to a file.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Optional file path to write the .excalidraw JSON file'
        }
      }
    }
  },
  {
    name: 'import_scene',
    description: 'Import elements from a .excalidraw JSON file or raw JSON data',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to a .excalidraw JSON file'
        },
        data: {
          type: 'string',
          description: 'Raw .excalidraw JSON string (alternative to filePath)'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          description: '"replace" clears canvas first, "merge" appends to existing elements'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'export_to_image',
    description: 'Export the current canvas to PNG or SVG image with embedded scene data (the image can be re-imported to restore the diagram). Requires the canvas frontend to be open in a browser.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['png', 'svg'],
          description: 'Image format'
        },
        filePath: {
          type: 'string',
          description: 'Optional file path to save the image'
        },
        background: {
          type: 'boolean',
          description: 'Include background in export (default: true)'
        }
      },
      required: ['format']
    }
  },
  {
    name: 'duplicate_elements',
    description: 'Duplicate elements with a configurable offset',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of elements to duplicate'
        },
        offsetX: { type: 'number', description: 'Horizontal offset (default: 20)' },
        offsetY: { type: 'number', description: 'Vertical offset (default: 20)' }
      },
      required: ['elementIds']
    }
  },
  {
    name: 'snapshot_scene',
    description: 'Save a named snapshot of the current canvas state for later restoration',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for this snapshot'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'restore_snapshot',
    description: 'Restore the canvas from a previously saved named snapshot',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the snapshot to restore'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'describe_scene',
    description: 'Get an AI-readable description of the current canvas: element types, positions, connections, labels, spatial layout, and bounding box. Use this to understand what is on the canvas before making changes.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_canvas_screenshot',
    description: 'Take a screenshot of the current canvas and return it as an image. Requires the canvas frontend to be open in a browser. Use this to visually verify what the diagram looks like.',
    inputSchema: {
      type: 'object',
      properties: {
        background: {
          type: 'boolean',
          description: 'Include background in screenshot (default: true)'
        }
      }
    }
  },
  {
    name: 'read_diagram_guide',
    description: 'Returns a comprehensive design guide for creating beautiful Excalidraw diagrams: color palette, sizing rules, layout patterns, arrow binding best practices, diagram templates, and anti-patterns. Call this before creating diagrams to produce professional results.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'export_to_excalidraw_url',
    description: 'Export the current canvas to a shareable excalidraw.com URL. The diagram is encrypted and uploaded; anyone with the URL can view it. Returns the shareable link.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'set_viewport',
    description: 'Control the canvas viewport (camera). Auto-fit all elements, center on a specific element, or set zoom/scroll directly. Requires the canvas frontend open in a browser.',
    inputSchema: {
      type: 'object',
      properties: {
        scrollToContent: {
          type: 'boolean',
          description: 'Auto-fit all elements in view (zoom-to-fit)'
        },
        scrollToElementId: {
          type: 'string',
          description: 'Center the view on a specific element by ID'
        },
        zoom: {
          type: 'number',
          description: 'Zoom level (0.1–10, where 1 = 100%)'
        },
        offsetX: {
          type: 'number',
          description: 'Horizontal scroll offset'
        },
        offsetY: {
          type: 'number',
          description: 'Vertical scroll offset'
        }
      }
    }
  },
  {
    name: 'search_libraries',
    description: 'Search the public Excalidraw library repository (libraries.excalidraw.com) for reusable shape collections. Returns library metadata — use add_library to install one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g. "aws", "network", "flowchart", "icons")'
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 50)'
        }
      }
    }
  },
  {
    name: 'add_library',
    description: 'Install a public Excalidraw library by its source path. The library items become available in the canvas library panel. Use search_libraries to find libraries first.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Library source path from search_libraries (e.g. "jumpingrivers/r.excalidrawlib") or full URL'
        }
      },
      required: ['source']
    }
  },
  {
    name: 'use_library_item',
    description: 'Place a library item (shape/icon) onto the canvas at the specified position. The item must have been added via add_library first. Use get_library_items to see available items.',
    inputSchema: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: 'Name (or partial name) of the library item to place'
        },
        itemIndex: {
          type: 'number',
          description: 'Index of the library item (alternative to itemName). Use get_library_items to see indices.'
        },
        x: {
          type: 'number',
          description: 'X coordinate to place the item (default: 0)'
        },
        y: {
          type: 'number',
          description: 'Y coordinate to place the item (default: 0)'
        }
      }
    }
  },
  {
    name: 'get_library_items',
    description: 'List all library items currently loaded in the canvas. Shows item names and indices for use with use_library_item.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'export_image_with_scene',
    description: 'Export the canvas to PNG or SVG with embedded Excalidraw scene data. The exported file can be re-imported later to restore the full editable diagram. PNG embeds data in a tEXt chunk; SVG embeds it in a <!-- payload-type:excalidraw --> comment (same format as excalidraw.com).',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['png', 'svg'],
          description: 'Image format'
        },
        filePath: {
          type: 'string',
          description: 'File path to save the image (required)'
        },
        background: {
          type: 'boolean',
          description: 'Include background in export (default: true)'
        }
      },
      required: ['format', 'filePath']
    }
  },
  {
    name: 'import_from_image',
    description: 'Import an Excalidraw scene from a PNG or SVG file that has embedded scene data (created by export_image_with_scene or Excalidraw app "Export with scene data"). Extracts the embedded JSON and restores the diagram on canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the PNG or SVG file with embedded scene data'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          description: '"replace" clears canvas first, "merge" appends to existing elements'
        }
      },
      required: ['filePath', 'mode']
    }
  }
];

// Factory function to create a configured MCP server instance
export function createMcpServer(): Server {

// Initialize MCP server
const server = new Server(
  {
    name: "mcp-excalidraw-server",
    version: "2.0.0",
    description: "Programmatic canvas toolkit for Excalidraw with file I/O, image export, and real-time sync"
  },
  {
    capabilities: {
      tools: Object.fromEntries(tools.map(tool => [tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema
      }]))
    }
  }
);

// Helper function to convert text property to label format for Excalidraw
function convertTextToLabel(element: ServerElement): ServerElement {
  const { text, ...rest } = element;
  if (text) {
    // For standalone text elements, keep text as direct property
    if (element.type === 'text') {
      return element; // Keep text as direct property
    }
    // For other elements (rectangle, ellipse, diamond), convert to label format
    return {
      ...rest,
      label: { text }
    } as ServerElement;
  }
  return element;
}

// Set up request handler for tool calls
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  try {
    const { name, arguments: args } = request.params;
    logger.info(`Handling tool call: ${name}`);
    
    switch (name) {
      case 'create_element': {
        const params = ElementSchema.parse(args);
        logger.info('Creating element via MCP', { type: params.type });

        const { startElementId, endElementId, id: customId, ...elementProps } = params;
        const id = customId || generateId();
        const element: ServerElement = {
          id,
          ...elementProps,
          points: elementProps.points ? normalizePoints(elementProps.points) : undefined,
          // Convert binding IDs to Excalidraw's start/end format
          ...(startElementId ? { start: { id: startElementId } } : {}),
          ...(endElementId ? { end: { id: endElementId } } : {}),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        };

        // Normalize fontFamily from string names to numeric values
        if (element.fontFamily !== undefined) {
          element.fontFamily = normalizeFontFamily(element.fontFamily);
        }

        // For bound arrows without explicit points, set a default
        if ((startElementId || endElementId) && !elementProps.points) {
          (element as any).points = [[0, 0], [100, 0]];
        }

        // Convert text to label format for Excalidraw
        const excalidrawElement = convertTextToLabel(element);

        // Create element directly on HTTP server (no local storage)
        const canvasElement = await createElementOnCanvas(excalidrawElement);
        
        if (!canvasElement) {
          throw new Error('Failed to create element: HTTP server unavailable');
        }
        
        logger.info('Element created via MCP and synced to canvas', { 
          id: excalidrawElement.id, 
          type: excalidrawElement.type,
          synced: !!canvasElement 
        });
        
        return {
          content: [{ 
            type: 'text', 
            text: `Element created successfully!\n\n${JSON.stringify(canvasElement, null, 2)}\n\n✅ Synced to canvas` 
          }]
        };
      }
      
      case 'update_element': {
        const params = ElementIdSchema.merge(ElementSchema.partial()).parse(args);
        const { id, points: rawPoints, ...updates } = params;

        if (!id) throw new Error('Element ID is required');

        // Build update payload with timestamp and version increment
        const updatePayload: Partial<ServerElement> & { id: string } = {
          id,
          ...updates,
          points: rawPoints ? normalizePoints(rawPoints) : undefined,
          updatedAt: new Date().toISOString()
        };

        // Normalize fontFamily from string names to numeric values
        if (updatePayload.fontFamily !== undefined) {
          updatePayload.fontFamily = normalizeFontFamily(updatePayload.fontFamily);
        }

        // Convert text to label format for Excalidraw
        const excalidrawElement = convertTextToLabel(updatePayload as ServerElement);
        
        // Update element directly on HTTP server (no local storage)
        const canvasElement = await updateElementOnCanvas(excalidrawElement);
        
        if (!canvasElement) {
          throw new Error('Failed to update element: HTTP server unavailable or element not found');
        }
        
        logger.info('Element updated via MCP and synced to canvas', { 
          id: excalidrawElement.id, 
          synced: !!canvasElement 
        });
        
        return {
          content: [{ 
            type: 'text', 
            text: `Element updated successfully!\n\n${JSON.stringify(canvasElement, null, 2)}\n\n✅ Synced to canvas` 
          }]
        };
      }
      
      case 'delete_element': {
        const params = ElementIdSchema.parse(args);
        const { id } = params;

        // Delete element directly on HTTP server (no local storage)
        const canvasResult = await deleteElementOnCanvas(id);

        if (!canvasResult || !(canvasResult as ApiResponse).success) {
          throw new Error('Failed to delete element: HTTP server unavailable or element not found');
        }

        const result = { id, deleted: true, syncedToCanvas: true };
        logger.info('Element deleted via MCP and synced to canvas', result);

        return {
          content: [{
            type: 'text',
            text: `Element deleted successfully!\n\n${JSON.stringify(result, null, 2)}\n\n✅ Synced to canvas`
          }]
        };
      }
      
      case 'query_elements': {
        const params = QuerySchema.parse(args || {});
        const { type, filter } = params;
        
        try {
          // Build query parameters
          const queryParams = new URLSearchParams();
          if (type) queryParams.set('type', type);
          if (filter) {
            Object.entries(filter).forEach(([key, value]) => {
              queryParams.set(key, String(value));
            });
          }
          
          // Query elements from HTTP server
          const url = `${EXPRESS_SERVER_URL}/api/elements/search?${queryParams}`;
          const response = await fetch(url);
          
          if (!response.ok) {
            throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
          }
          
          const data = await response.json() as ApiResponse;
          const results = data.elements || [];
          
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to query elements: ${(error as Error).message}`);
        }
      }
      
      case 'get_resource': {
        const params = ResourceSchema.parse(args);
        const { resource } = params;
        logger.info('Getting resource', { resource });
        
        let result: any;
        switch (resource) {
          case 'scene':
            result = {
              theme: sceneState.theme,
              viewport: sceneState.viewport,
              selectedElements: Array.from(sceneState.selectedElements)
            };
            break;
          case 'library':
          case 'elements':
            try {
              // Get elements from HTTP server
              const response = await fetch(`${EXPRESS_SERVER_URL}/api/elements`);
              if (!response.ok) {
                throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
              }
              const data = await response.json() as ApiResponse;
              result = {
                elements: data.elements || []
              };
            } catch (error) {
              throw new Error(`Failed to get elements: ${(error as Error).message}`);
            }
            break;
          case 'theme':
            result = {
              theme: sceneState.theme
            };
            break;
          default:
            throw new Error(`Unknown resource: ${resource}`);
        }
        
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
      
      case 'group_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;

        try {
          const groupId = generateId();
          sceneState.groups.set(groupId, elementIds);

          // Update elements on canvas with proper error handling
          // Fetch existing groups and append new groupId to preserve multi-group membership
          const updatePromises = elementIds.map(async (id) => {
            const element = await getElementFromCanvas(id);
            const existingGroups = element?.groupIds || [];
            const updatedGroupIds = [...existingGroups, groupId];
            return await updateElementOnCanvas({ id, groupIds: updatedGroupIds });
          });

          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;

          if (successCount === 0) {
            sceneState.groups.delete(groupId); // Rollback local state
            throw new Error('Failed to group any elements: HTTP server unavailable');
          }

          logger.info('Grouping elements', { elementIds, groupId, successCount });

          const result = { groupId, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to group elements: ${(error as Error).message}`);
        }
      }
      
      case 'ungroup_elements': {
        const params = GroupIdSchema.parse(args);
        const { groupId } = params;

        if (!sceneState.groups.has(groupId)) {
          throw new Error(`Group ${groupId} not found`);
        }

        try {
          const elementIds = sceneState.groups.get(groupId);
          sceneState.groups.delete(groupId);

          // Update elements on canvas, removing only this specific groupId
          const updatePromises = (elementIds ?? []).map(async (id) => {
            // Fetch current element to get existing groupIds
            const element = await getElementFromCanvas(id);
            if (!element) {
              logger.warn(`Element ${id} not found on canvas, skipping ungroup`);
              return null;
            }

            // Remove only the specific groupId, preserve others
            const updatedGroupIds = (element.groupIds || []).filter(gid => gid !== groupId);
            return await updateElementOnCanvas({ id, groupIds: updatedGroupIds });
          });

          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result !== null).length;

          if (successCount === 0) {
            throw new Error('Failed to ungroup: no elements were updated (elements may not exist on canvas)');
          }

          logger.info('Ungrouping elements', { groupId, elementIds, successCount });

          const result = { groupId, ungrouped: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to ungroup elements: ${(error as Error).message}`);
        }
      }
      
      case 'align_elements': {
        const params = AlignElementsSchema.parse(args);
        const { elementIds, alignment } = params;
        logger.info('Aligning elements', { elementIds, alignment });

        // Fetch all elements
        const elementsToAlign: ServerElement[] = [];
        for (const id of elementIds) {
          const el = await getElementFromCanvas(id);
          if (el) elementsToAlign.push(el);
        }

        if (elementsToAlign.length < 2) {
          throw new Error('Need at least 2 elements to align');
        }

        // Calculate alignment target
        let updateFn: (el: ServerElement) => { x?: number; y?: number };
        switch (alignment) {
          case 'left': {
            const minX = Math.min(...elementsToAlign.map(el => el.x));
            updateFn = () => ({ x: minX });
            break;
          }
          case 'right': {
            const maxRight = Math.max(...elementsToAlign.map(el => el.x + (el.width || 0)));
            updateFn = (el) => ({ x: maxRight - (el.width || 0) });
            break;
          }
          case 'center': {
            const centers = elementsToAlign.map(el => el.x + (el.width || 0) / 2);
            const avgCenter = centers.reduce((a, b) => a + b, 0) / centers.length;
            updateFn = (el) => ({ x: avgCenter - (el.width || 0) / 2 });
            break;
          }
          case 'top': {
            const minY = Math.min(...elementsToAlign.map(el => el.y));
            updateFn = () => ({ y: minY });
            break;
          }
          case 'bottom': {
            const maxBottom = Math.max(...elementsToAlign.map(el => el.y + (el.height || 0)));
            updateFn = (el) => ({ y: maxBottom - (el.height || 0) });
            break;
          }
          case 'middle': {
            const middles = elementsToAlign.map(el => el.y + (el.height || 0) / 2);
            const avgMiddle = middles.reduce((a, b) => a + b, 0) / middles.length;
            updateFn = (el) => ({ y: avgMiddle - (el.height || 0) / 2 });
            break;
          }
        }

        // Apply updates
        const updatePromises = elementsToAlign.map(async (el) => {
          const coords = updateFn(el);
          return await updateElementOnCanvas({ id: el.id, ...coords });
        });
        const results = await Promise.all(updatePromises);
        const successCount = results.filter(r => r).length;

        if (successCount === 0) {
          throw new Error('Failed to align any elements: HTTP server unavailable');
        }

        const result = { aligned: true, elementIds, alignment, successCount };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
      
      case 'distribute_elements': {
        const params = DistributeElementsSchema.parse(args);
        const { elementIds, direction } = params;
        logger.info('Distributing elements', { elementIds, direction });

        // Fetch all elements
        const elementsToDist: ServerElement[] = [];
        for (const id of elementIds) {
          const el = await getElementFromCanvas(id);
          if (el) elementsToDist.push(el);
        }

        if (elementsToDist.length < 3) {
          throw new Error('Need at least 3 elements to distribute');
        }

        if (direction === 'horizontal') {
          // Sort by x position
          elementsToDist.sort((a, b) => a.x - b.x);
          const first = elementsToDist[0]!;
          const last = elementsToDist[elementsToDist.length - 1]!;
          const totalSpan = (last.x + (last.width || 0)) - first.x;
          const totalElementWidth = elementsToDist.reduce((sum, el) => sum + (el.width || 0), 0);
          const gap = (totalSpan - totalElementWidth) / (elementsToDist.length - 1);

          let currentX = first.x;
          for (const el of elementsToDist) {
            await updateElementOnCanvas({ id: el.id, x: currentX });
            currentX += (el.width || 0) + gap;
          }
        } else {
          // Sort by y position
          elementsToDist.sort((a, b) => a.y - b.y);
          const first = elementsToDist[0]!;
          const last = elementsToDist[elementsToDist.length - 1]!;
          const totalSpan = (last.y + (last.height || 0)) - first.y;
          const totalElementHeight = elementsToDist.reduce((sum, el) => sum + (el.height || 0), 0);
          const gap = (totalSpan - totalElementHeight) / (elementsToDist.length - 1);

          let currentY = first.y;
          for (const el of elementsToDist) {
            await updateElementOnCanvas({ id: el.id, y: currentY });
            currentY += (el.height || 0) + gap;
          }
        }

        const result = { distributed: true, elementIds, direction, count: elementsToDist.length };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
      
      case 'lock_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;
        
        try {
          // Lock elements through HTTP API updates
          const updatePromises = elementIds.map(async (id) => {
            return await updateElementOnCanvas({ id, locked: true });
          });
          
          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;
          
          if (successCount === 0) {
            throw new Error('Failed to lock any elements: HTTP server unavailable');
          }
          
          const result = { locked: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to lock elements: ${(error as Error).message}`);
        }
      }
      
      case 'unlock_elements': {
        const params = ElementIdsSchema.parse(args);
        const { elementIds } = params;
        
        try {
          // Unlock elements through HTTP API updates
          const updatePromises = elementIds.map(async (id) => {
            return await updateElementOnCanvas({ id, locked: false });
          });
          
          const results = await Promise.all(updatePromises);
          const successCount = results.filter(result => result).length;
          
          if (successCount === 0) {
            throw new Error('Failed to unlock any elements: HTTP server unavailable');
          }
          
          const result = { unlocked: true, elementIds, successCount };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (error) {
          throw new Error(`Failed to unlock elements: ${(error as Error).message}`);
        }
      }
      
      case 'create_from_mermaid': {
        const params = z.object({
          mermaidDiagram: z.string(),
          config: z.object({
            startOnLoad: z.boolean().optional(),
            flowchart: z.object({
              curve: z.enum(['linear', 'basis']).optional()
            }).optional(),
            themeVariables: z.object({
              fontSize: z.string().optional()
            }).optional(),
            maxEdges: z.number().optional(),
            maxTextSize: z.number().optional()
          }).optional()
        }).parse(args);
        
        logger.info('Creating Excalidraw elements from Mermaid diagram via MCP', {
          diagramLength: params.mermaidDiagram.length,
          hasConfig: !!params.config
        });

        try {
          // Send the Mermaid diagram to the frontend via the API
          // The frontend will use mermaid-to-excalidraw to convert it
          const response = await fetch(`${EXPRESS_SERVER_URL}/api/elements/from-mermaid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mermaidDiagram: params.mermaidDiagram,
              config: params.config
            })
          });

          if (!response.ok) {
            throw new Error(`HTTP server error: ${response.status} ${response.statusText}`);
          }

          const result = await response.json() as ApiResponse;
          
          logger.info('Mermaid diagram sent to frontend for conversion', {
            success: result.success
          });

          return {
            content: [{
              type: 'text',
              text: `Mermaid diagram sent for conversion!\n\n${JSON.stringify(result, null, 2)}\n\n⚠️  Note: The actual conversion happens in the frontend canvas with DOM access. Open the canvas at ${EXPRESS_SERVER_URL} to see the diagram rendered.`
            }]
          };
        } catch (error) {
          throw new Error(`Failed to process Mermaid diagram: ${(error as Error).message}`);
        }
      }
      
      case 'batch_create_elements': {
        const params = z.object({ elements: z.array(ElementSchema) }).parse(args);
        logger.info('Batch creating elements via MCP', { count: params.elements.length });

        const createdElements: ServerElement[] = [];

        for (const elementData of params.elements) {
          const { startElementId, endElementId, id: customId, ...elementProps } = elementData;
          const id = customId || generateId();
          const element: ServerElement = {
            id,
            ...elementProps,
            points: elementProps.points ? normalizePoints(elementProps.points) : undefined,
            // Convert binding IDs to Excalidraw's start/end format
            ...(startElementId ? { start: { id: startElementId } } : {}),
            ...(endElementId ? { end: { id: endElementId } } : {}),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
          };

          // Normalize fontFamily from string names to numeric values
          if (element.fontFamily !== undefined) {
            element.fontFamily = normalizeFontFamily(element.fontFamily);
          }

          // For bound arrows without explicit points, set a default
          if ((startElementId || endElementId) && !elementProps.points) {
            (element as any).points = [[0, 0], [100, 0]];
          }

          const excalidrawElement = convertTextToLabel(element);
          createdElements.push(excalidrawElement);
        }

        const canvasElements = await batchCreateElementsOnCanvas(createdElements);

        if (!canvasElements) {
          throw new Error('Failed to batch create elements: HTTP server unavailable');
        }

        const result = {
          success: true,
          elements: canvasElements,
          count: canvasElements.length,
          syncedToCanvas: true
        };

        logger.info('Batch elements created via MCP and synced to canvas', {
          count: result.count,
          synced: result.syncedToCanvas
        });

        return {
          content: [{
            type: 'text',
            text: `${result.count} elements created successfully!\n\n${JSON.stringify(result, null, 2)}\n\n${result.syncedToCanvas ? '✅ All elements synced to canvas' : '⚠️  Canvas sync failed (elements still created locally)'}`
          }]
        };
      }

      case 'get_element': {
        const params = ElementIdSchema.parse(args);
        const { id } = params;

        const element = await getElementFromCanvas(id);
        if (!element) {
          throw new Error(`Element ${id} not found`);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(element, null, 2) }]
        };
      }

      case 'clear_canvas': {
        logger.info('Clearing canvas via MCP');

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/elements/clear`, {
          method: 'DELETE'
        });

        if (!response.ok) {
          throw new Error(`Failed to clear canvas: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as ApiResponse;

        return {
          content: [{
            type: 'text',
            text: `Canvas cleared.\n\n${JSON.stringify(data, null, 2)}`
          }]
        };
      }

      case 'export_scene': {
        const params = z.object({
          filePath: z.string().optional()
        }).parse(args || {});

        logger.info('Exporting scene via MCP');

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/elements`);
        if (!response.ok) {
          throw new Error(`Failed to fetch elements: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as ApiResponse;
        const sceneElements = data.elements || [];

        // Fetch files for image elements
        let sceneFiles: Record<string, any> = {};
        try {
          const filesResponse = await fetch(`${EXPRESS_SERVER_URL}/api/files`);
          if (filesResponse.ok) {
            const filesData = await filesResponse.json() as any;
            sceneFiles = filesData.files || {};
          }
        } catch { /* files endpoint may not exist */ }

        const excalidrawScene: any = {
          type: 'excalidraw',
          version: 2,
          source: 'mcp-excalidraw-server',
          elements: sceneElements,
          appState: {
            viewBackgroundColor: '#ffffff',
            gridSize: null
          },
          ...(Object.keys(sceneFiles).length > 0 ? { files: sceneFiles } : {})
        };

        const jsonString = JSON.stringify(excalidrawScene, null, 2);

        if (params.filePath) {
          const safePath = sanitizeFilePath(params.filePath);
          fs.writeFileSync(safePath, jsonString, 'utf-8');
          return {
            content: [{
              type: 'text',
              text: `Scene exported to ${safePath} (${sceneElements.length} elements)`
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: jsonString
          }]
        };
      }

      case 'import_scene': {
        const params = z.object({
          filePath: z.string().optional(),
          data: z.string().optional(),
          mode: z.enum(['replace', 'merge'])
        }).parse(args);

        logger.info('Importing scene via MCP', { mode: params.mode });

        let sceneData: any;
        if (params.filePath) {
          const safeImportPath = sanitizeFilePath(params.filePath);
          const fileContent = fs.readFileSync(safeImportPath, 'utf-8');
          sceneData = JSON.parse(fileContent);
        } else if (params.data) {
          sceneData = JSON.parse(params.data);
        } else {
          throw new Error('Either filePath or data must be provided');
        }

        // Extract elements from .excalidraw format or raw array
        const importElements: ServerElement[] = Array.isArray(sceneData)
          ? sceneData
          : (sceneData.elements || []);

        if (importElements.length === 0) {
          throw new Error('No elements found in the import data');
        }

        // If replace mode, clear first
        if (params.mode === 'replace') {
          await fetch(`${EXPRESS_SERVER_URL}/api/elements/clear`, { method: 'DELETE' });
        }

        // Batch create the imported elements
        const elementsToCreate = importElements.map(el => ({
          ...el,
          id: el.id || generateId(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        }));

        const canvasElements = await batchCreateElementsOnCanvas(elementsToCreate);

        // Import files if present (for image elements)
        let importedFileCount = 0;
        const importFiles = sceneData.files;
        if (importFiles && typeof importFiles === 'object') {
          const fileList = Object.values(importFiles);
          if (fileList.length > 0) {
            try {
              await fetch(`${EXPRESS_SERVER_URL}/api/files`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fileList)
              });
              importedFileCount = fileList.length;
            } catch { /* best effort */ }
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Imported ${elementsToCreate.length} elements${importedFileCount > 0 ? ` and ${importedFileCount} files` : ''} (mode: ${params.mode})\n\n✅ Synced to canvas`
          }]
        };
      }

      case 'export_to_image': {
        const params = z.object({
          format: z.enum(['png', 'svg']),
          filePath: z.string().optional(),
          background: z.boolean().optional()
        }).parse(args);

        logger.info('Exporting to image via MCP', { format: params.format });

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/export/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: params.format,
            background: params.background ?? true
          })
        });

        if (!response.ok) {
          const errorData = await response.json() as ApiResponse;
          throw new Error(errorData.error || `Export failed: ${response.status}`);
        }

        const result = await response.json() as { success: boolean; format: string; data: string };

        if (params.filePath) {
          const safeImagePath = sanitizeFilePath(params.filePath);
          if (params.format === 'svg') {
            fs.writeFileSync(safeImagePath, result.data, 'utf-8');
          } else {
            fs.writeFileSync(safeImagePath, Buffer.from(result.data, 'base64'));
          }
          return {
            content: [{
              type: 'text',
              text: `Image exported to ${safeImagePath} (format: ${params.format})`
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: params.format === 'svg'
              ? result.data
              : `Base64 ${params.format} data (${result.data.length} chars). Use filePath to save to disk.`
          }]
        };
      }

      case 'duplicate_elements': {
        const params = z.object({
          elementIds: z.array(z.string()),
          offsetX: z.number().optional(),
          offsetY: z.number().optional()
        }).parse(args);

        const offsetX = params.offsetX ?? 20;
        const offsetY = params.offsetY ?? 20;

        logger.info('Duplicating elements via MCP', { count: params.elementIds.length });

        const duplicates: ServerElement[] = [];
        for (const id of params.elementIds) {
          const original = await getElementFromCanvas(id);
          if (!original) {
            logger.warn(`Element ${id} not found, skipping duplicate`);
            continue;
          }

          const { createdAt, updatedAt, version, syncedAt, source, syncTimestamp, ...rest } = original;
          const duplicate: ServerElement = {
            ...rest,
            id: generateId(),
            x: original.x + offsetX,
            y: original.y + offsetY,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
          };
          duplicates.push(duplicate);
        }

        if (duplicates.length === 0) {
          throw new Error('No elements could be duplicated (none found)');
        }

        const canvasElements = await batchCreateElementsOnCanvas(duplicates);

        return {
          content: [{
            type: 'text',
            text: `Duplicated ${duplicates.length} elements (offset: ${offsetX}, ${offsetY})\n\n${JSON.stringify(canvasElements, null, 2)}\n\n✅ Synced to canvas`
          }]
        };
      }

      case 'snapshot_scene': {
        const params = z.object({ name: z.string() }).parse(args);
        logger.info('Saving snapshot via MCP', { name: params.name });

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/snapshots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: params.name })
        });

        if (!response.ok) {
          throw new Error(`Failed to save snapshot: ${response.status} ${response.statusText}`);
        }

        const result = await response.json() as any;

        return {
          content: [{
            type: 'text',
            text: `Snapshot "${params.name}" saved (${result.elementCount} elements)\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      }

      case 'restore_snapshot': {
        const params = z.object({ name: z.string() }).parse(args);
        logger.info('Restoring snapshot via MCP', { name: params.name });

        // Fetch the snapshot
        const response = await fetch(`${EXPRESS_SERVER_URL}/api/snapshots/${encodeURIComponent(params.name)}`);
        if (!response.ok) {
          throw new Error(`Snapshot "${params.name}" not found`);
        }

        const data = await response.json() as { success: boolean; snapshot: { name: string; elements: ServerElement[]; createdAt: string } };

        // Clear current canvas
        await fetch(`${EXPRESS_SERVER_URL}/api/elements/clear`, { method: 'DELETE' });

        // Restore elements
        const canvasElements = await batchCreateElementsOnCanvas(data.snapshot.elements);

        return {
          content: [{
            type: 'text',
            text: `Snapshot "${params.name}" restored (${data.snapshot.elements.length} elements)\n\n✅ Canvas updated`
          }]
        };
      }

      case 'describe_scene': {
        logger.info('Describing scene via MCP');

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/elements`);
        if (!response.ok) {
          throw new Error(`Failed to fetch elements: ${response.status}`);
        }

        const data = await response.json() as ApiResponse;
        const allElements = data.elements || [];

        if (allElements.length === 0) {
          return {
            content: [{ type: 'text', text: 'The canvas is empty. No elements to describe.' }]
          };
        }

        // Count by type
        const typeCounts: Record<string, number> = {};
        for (const el of allElements) {
          typeCounts[el.type] = (typeCounts[el.type] || 0) + 1;
        }

        // Bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const el of allElements) {
          minX = Math.min(minX, el.x);
          minY = Math.min(minY, el.y);
          maxX = Math.max(maxX, el.x + (el.width || 0));
          maxY = Math.max(maxY, el.y + (el.height || 0));
        }

        // Build element descriptions sorted top-to-bottom, left-to-right
        const sorted = [...allElements].sort((a, b) => {
          const rowDiff = Math.floor(a.y / 50) - Math.floor(b.y / 50);
          return rowDiff !== 0 ? rowDiff : a.x - b.x;
        });

        const elementDescs: string[] = [];
        for (const el of sorted) {
          const parts: string[] = [];
          parts.push(`[${el.id}] ${el.type}`);
          parts.push(`at (${Math.round(el.x)}, ${Math.round(el.y)})`);
          if (el.width || el.height) {
            parts.push(`size ${Math.round(el.width || 0)}x${Math.round(el.height || 0)}`);
          }
          if (el.text) parts.push(`text: "${el.text}"`);
          if (el.label?.text) parts.push(`label: "${el.label.text}"`);
          if (el.backgroundColor && el.backgroundColor !== 'transparent') {
            parts.push(`bg: ${el.backgroundColor}`);
          }
          if (el.strokeColor && el.strokeColor !== '#000000') {
            parts.push(`stroke: ${el.strokeColor}`);
          }
          if (el.locked) parts.push('(locked)');
          if (el.groupIds && el.groupIds.length > 0) {
            parts.push(`groups: [${el.groupIds.join(', ')}]`);
          }
          elementDescs.push(`  ${parts.join(' | ')}`);
        }

        // Find connections (arrows)
        const arrows = allElements.filter(el => el.type === 'arrow');
        const connectionDescs: string[] = [];
        for (const arrow of arrows) {
          const arrowAny = arrow as any;
          if (arrowAny.startBinding?.elementId || arrowAny.endBinding?.elementId) {
            const from = arrowAny.startBinding?.elementId || '?';
            const to = arrowAny.endBinding?.elementId || '?';
            connectionDescs.push(`  ${from} --> ${to} (arrow: ${arrow.id})`);
          }
        }

        // Build description
        const lines: string[] = [];
        lines.push(`## Canvas Description`);
        lines.push(`Total elements: ${allElements.length}`);
        lines.push(`Types: ${Object.entries(typeCounts).map(([t, c]) => `${t}(${c})`).join(', ')}`);
        lines.push(`Bounding box: (${Math.round(minX)}, ${Math.round(minY)}) to (${Math.round(maxX)}, ${Math.round(maxY)}) = ${Math.round(maxX - minX)}x${Math.round(maxY - minY)}`);
        lines.push('');
        lines.push('### Elements (top-to-bottom, left-to-right):');
        lines.push(...elementDescs);

        if (connectionDescs.length > 0) {
          lines.push('');
          lines.push('### Connections:');
          lines.push(...connectionDescs);
        }

        // Groups
        const groupedElements = allElements.filter(el => el.groupIds && el.groupIds.length > 0);
        if (groupedElements.length > 0) {
          const groupMap: Record<string, string[]> = {};
          for (const el of groupedElements) {
            for (const gid of (el.groupIds || [])) {
              if (!groupMap[gid]) groupMap[gid] = [];
              groupMap[gid]!.push(el.id);
            }
          }
          lines.push('');
          lines.push('### Groups:');
          for (const [gid, ids] of Object.entries(groupMap)) {
            lines.push(`  Group ${gid}: [${ids.join(', ')}]`);
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }]
        };
      }

      case 'get_canvas_screenshot': {
        const params = z.object({
          background: z.boolean().optional()
        }).parse(args || {});

        logger.info('Taking canvas screenshot via MCP');

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/export/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: 'png',
            background: params.background ?? true
          })
        });

        if (!response.ok) {
          const errorData = await response.json() as ApiResponse;
          throw new Error(errorData.error || `Screenshot failed: ${response.status}`);
        }

        const result = await response.json() as { success: boolean; format: string; data: string };

        return {
          content: [
            {
              type: 'image' as const,
              data: result.data,
              mimeType: 'image/png'
            },
            {
              type: 'text',
              text: 'Canvas screenshot captured. This is what the diagram currently looks like.'
            }
          ]
        };
      }

      case 'read_diagram_guide': {
        return {
          content: [{ type: 'text', text: DIAGRAM_DESIGN_GUIDE }]
        };
      }

      case 'export_to_excalidraw_url': {
        logger.info('Exporting to excalidraw.com URL');

        // 1. Fetch current scene elements
        const urlExportResponse = await fetch(`${EXPRESS_SERVER_URL}/api/elements`);
        if (!urlExportResponse.ok) {
          throw new Error(`Failed to fetch elements: ${urlExportResponse.status}`);
        }
        const urlExportData = await urlExportResponse.json() as ApiResponse;
        const urlExportElements = urlExportData.elements || [];

        if (urlExportElements.length === 0) {
          throw new Error('Canvas is empty — nothing to export');
        }

        // 2. Clean elements: strip server metadata, add Excalidraw defaults,
        // generate bound text elements, and resolve arrow bindings
        const cleanedExportElements: Record<string, any>[] = [];
        const boundTextElements: Record<string, any>[] = [];
        let indexCounter = 0;

        function makeBaseElement(el: any, rest: any): Record<string, any> {
          return {
            ...rest,
            angle: rest.angle ?? 0,
            strokeColor: rest.strokeColor ?? '#1e1e1e',
            backgroundColor: rest.backgroundColor ?? 'transparent',
            fillStyle: rest.fillStyle ?? 'solid',
            strokeWidth: rest.strokeWidth ?? 2,
            strokeStyle: rest.strokeStyle ?? 'solid',
            roughness: rest.roughness ?? 1,
            opacity: rest.opacity ?? 100,
            groupIds: rest.groupIds ?? [],
            frameId: rest.frameId ?? null,
            index: rest.index ?? `a${indexCounter++}`,
            roundness: rest.roundness ?? (
              el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse'
                ? { type: 3 } : null
            ),
            seed: rest.seed ?? Math.floor(Math.random() * 2147483647),
            version: rest.version ?? 1,
            versionNonce: rest.versionNonce ?? Math.floor(Math.random() * 2147483647),
            isDeleted: false,
            boundElements: rest.boundElements ?? null,
            updated: Date.now(),
            link: rest.link ?? null,
            locked: rest.locked ?? false
          };
        }

        for (const el of urlExportElements) {
          // Strip server-only fields
          const {
            createdAt, updatedAt, syncedAt, source: _src,
            syncTimestamp, label, start, end, text,
            version: _ver,
            ...rest
          } = el as any;

          const base = makeBaseElement(el, rest);

          // Standalone text elements: keep text directly
          if (el.type === 'text') {
            base.text = text ?? '';
            base.originalText = text ?? '';
            base.fontSize = rest.fontSize ?? 20;
            base.fontFamily = normalizeFontFamily(rest.fontFamily) ?? 1;
            base.textAlign = rest.textAlign ?? 'center';
            base.verticalAlign = rest.verticalAlign ?? 'middle';
            base.autoResize = rest.autoResize ?? true;
            base.lineHeight = rest.lineHeight ?? 1.25;
            base.containerId = rest.containerId ?? null;
            cleanedExportElements.push(base);
            continue;
          }

          // Arrows: server already resolved bindings (start/end → startBinding/endBinding + positions)
          if (el.type === 'arrow' || el.type === 'line') {
            base.points = rest.points ?? [[0, 0], [100, 0]];
            base.lastCommittedPoint = null;
            // Preserve server-resolved bindings with fixedPoint for excalidraw.com
            if (rest.startBinding) {
              base.startBinding = { ...rest.startBinding, fixedPoint: rest.startBinding.fixedPoint ?? null };
            } else {
              base.startBinding = null;
            }
            if (rest.endBinding) {
              base.endBinding = { ...rest.endBinding, fixedPoint: rest.endBinding.fixedPoint ?? null };
            } else {
              base.endBinding = null;
            }
            base.startArrowhead = rest.startArrowhead ?? null;
            base.endArrowhead = rest.endArrowhead ?? (el.type === 'arrow' ? 'arrow' : null);
            base.elbowed = rest.elbowed ?? false;
          }

          // Generate bound text element for label on shapes and arrows
          const labelText = label?.text || text;
          if (labelText) {
            const textId = `${base.id}-label`;
            // Add binding reference to parent
            base.boundElements = [
              ...(Array.isArray(base.boundElements) ? base.boundElements : []),
              { type: 'text', id: textId }
            ];

            // Compute text position: centered in shape, or at arrow midpoint
            let textX: number, textY: number, textW: number, textH: number;
            const isArrow = el.type === 'arrow' || el.type === 'line';

            if (isArrow) {
              // Position at midpoint of arrow path
              const pts = base.points || [[0, 0], [100, 0]];
              const lastPt = pts[pts.length - 1];
              const midX = base.x + (lastPt[0] / 2);
              const midY = base.y + (lastPt[1] / 2);
              const labelW = Math.max(labelText.length * 10, 60);
              textX = midX - labelW / 2;
              textY = midY - 12;
              textW = labelW;
              textH = 24;
            } else {
              // Center inside shape container
              const containerW = base.width ?? 160;
              const containerH = base.height ?? 80;
              textX = base.x + 10;
              textY = base.y + containerH / 4;
              textW = containerW - 20;
              textH = containerH / 2;
            }

            boundTextElements.push({
              id: textId,
              type: 'text',
              x: textX,
              y: textY,
              width: textW,
              height: textH,
              angle: 0,
              strokeColor: isArrow ? '#1e1e1e' : base.strokeColor,
              backgroundColor: 'transparent',
              fillStyle: 'solid',
              strokeWidth: 1,
              strokeStyle: 'solid',
              roughness: 1,
              opacity: 100,
              groupIds: [],
              frameId: null,
              index: `a${indexCounter++}`,
              roundness: null,
              seed: Math.floor(Math.random() * 2147483647),
              version: 1,
              versionNonce: Math.floor(Math.random() * 2147483647),
              isDeleted: false,
              boundElements: null,
              updated: Date.now(),
              link: null,
              locked: false,
              text: labelText,
              originalText: labelText,
              fontSize: isArrow ? 14 : (rest.fontSize ?? 16),
              fontFamily: normalizeFontFamily(rest.fontFamily) ?? 1,
              textAlign: 'center',
              verticalAlign: 'middle',
              autoResize: true,
              lineHeight: 1.25,
              containerId: base.id
            });
          }

          cleanedExportElements.push(base);
        }

        // Patch shapes' boundElements to include connected arrows
        const shapeBoundArrows = new Map<string, { type: string; id: string }[]>();
        for (const el of cleanedExportElements) {
          if (el.startBinding?.elementId) {
            const arr = shapeBoundArrows.get(el.startBinding.elementId) || [];
            arr.push({ type: 'arrow', id: el.id });
            shapeBoundArrows.set(el.startBinding.elementId, arr);
          }
          if (el.endBinding?.elementId) {
            const arr = shapeBoundArrows.get(el.endBinding.elementId) || [];
            arr.push({ type: 'arrow', id: el.id });
            shapeBoundArrows.set(el.endBinding.elementId, arr);
          }
        }
        for (const el of cleanedExportElements) {
          const arrowBindings = shapeBoundArrows.get(el.id);
          if (arrowBindings) {
            el.boundElements = [
              ...(Array.isArray(el.boundElements) ? el.boundElements : []),
              ...arrowBindings
            ];
          }
        }

        // Append all bound text elements after their parents
        cleanedExportElements.push(...boundTextElements);

        // Build .excalidraw scene JSON
        const excalidrawScene = {
          type: 'excalidraw',
          version: 2,
          source: 'https://excalidraw.com',
          elements: cleanedExportElements,
          appState: {
            viewBackgroundColor: '#ffffff',
            gridSize: null
          },
          files: {}
        };
        const sceneJson = JSON.stringify(excalidrawScene);
        const dataBytes = new TextEncoder().encode(sceneJson);

        // Excalidraw's concatBuffers: [4-byte version=1][4-byte len][chunk]...
        function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
          let total = 4; // version header
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
          let off = 4;
          for (const b of bufs) {
            dv.setUint32(off, b.length);
            off += 4;
            out.set(b, off);
            off += b.length;
          }
          return out;
        }

        const encoder = new TextEncoder();

        // 3. Inner data: concatBuffers(fileMetadata, dataJSON)
        const fileMetadata = encoder.encode('{}');
        const innerData = concatBuffers(fileMetadata, dataBytes);

        // 4. Compress with zlib deflate
        const compressed = deflateSync(Buffer.from(innerData));

        // 5. Encrypt with AES-GCM 128-bit key
        const cryptoKey = await webcrypto.subtle.generateKey(
          { name: 'AES-GCM', length: 128 },
          true,
          ['encrypt']
        );

        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        const encrypted = await webcrypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          cryptoKey,
          compressed
        );

        // 6. Outer payload: concatBuffers(encodingMeta, iv, ciphertext)
        const encodingMeta = encoder.encode(JSON.stringify({
          version: 2,
          compression: 'pako@1',
          encryption: 'AES-GCM'
        }));
        const ciphertext = new Uint8Array(encrypted);
        const payload = concatBuffers(encodingMeta, iv, ciphertext);

        // 7. POST to excalidraw.com JSON store
        const uploadResponse = await fetch('https://json.excalidraw.com/api/v2/post/', {
          method: 'POST',
          body: Buffer.from(payload)
        });

        if (!uploadResponse.ok) {
          throw new Error(`Upload to excalidraw.com failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
        }

        const uploadResult = await uploadResponse.json() as { id: string };

        // 8. Export key as JWK to get the "k" field
        const jwk = await webcrypto.subtle.exportKey('jwk', cryptoKey);

        // 9. Build shareable URL
        const shareUrl = `https://excalidraw.com/#json=${uploadResult.id},${jwk.k}`;

        return {
          content: [{
            type: 'text',
            text: `Diagram exported to excalidraw.com!\n\nShareable URL: ${shareUrl}\n\nAnyone with this link can view and edit the diagram.`
          }]
        };
      }

      case 'set_viewport': {
        const viewportParams = z.object({
          scrollToContent: z.boolean().optional(),
          scrollToElementId: z.string().optional(),
          zoom: z.number().min(0.1).max(10).optional(),
          offsetX: z.number().optional(),
          offsetY: z.number().optional()
        }).parse(args || {});

        logger.info('Setting viewport via MCP', viewportParams);

        const viewportResponse = await fetch(`${EXPRESS_SERVER_URL}/api/viewport`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(viewportParams)
        });

        if (!viewportResponse.ok) {
          const viewportError = await viewportResponse.json() as ApiResponse;
          throw new Error(viewportError.error || `Viewport request failed: ${viewportResponse.status}`);
        }

        const viewportResult = await viewportResponse.json() as { success: boolean; message?: string };

        return {
          content: [{
            type: 'text',
            text: `Viewport updated successfully.\n\n${JSON.stringify(viewportResult, null, 2)}`
          }]
        };
      }

      case 'search_libraries': {
        const query = (args?.query as string) || '';
        const limit = Math.min((args?.limit as number) || 10, 50);

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/library/search?q=${encodeURIComponent(query)}&limit=${limit}`);
        const result = await response.json() as ApiResponse & { libraries?: any[]; total?: number; query?: string };

        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Library search failed');
        }

        return {
          content: [{
            type: 'text',
            text: `Found ${result.total} libraries${query ? ` matching "${query}"` : ''}:\n\n${
              (result.libraries || []).map((lib: any, i: number) =>
                `${i + 1}. **${lib.name}** (source: \`${lib.source}\`)\n   ${lib.description || 'No description'}\n   Authors: ${(lib.authors || []).map((a: any) => a.name).join(', ')}`
              ).join('\n\n')
            }`
          }]
        };
      }

      case 'add_library': {
        const source = args?.source as string;
        if (!source) throw new Error('source is required');

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/library/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source })
        });
        const result = await response.json() as any;

        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Failed to add library');
        }

        return {
          content: [{
            type: 'text',
            text: `Library added successfully!\n\nItems loaded: ${result.itemCount}\nItem names: ${(result.itemNames || []).join(', ')}\n\nUse get_library_items to see all available items, then use_library_item to place them on the canvas.`
          }]
        };
      }

      case 'get_library_items': {
        const response = await fetch(`${EXPRESS_SERVER_URL}/api/library/items`);
        const result = await response.json() as any;

        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Failed to get library items');
        }

        const items = result.items || [];
        if (items.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No library items loaded. Use search_libraries to find libraries, then add_library to install one.'
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Library items (${items.length}):\n\n${
              items.map((item: any, i: number) =>
                `${i}. **${item.name}** (${item.elementCount} elements, status: ${item.status})`
              ).join('\n')
            }\n\nUse use_library_item with itemIndex or itemName to place an item on the canvas.`
          }]
        };
      }

      case 'use_library_item': {
        const itemName = args?.itemName as string | undefined;
        const itemIndex = args?.itemIndex as number | undefined;
        const x = (args?.x as number) ?? 0;
        const y = (args?.y as number) ?? 0;

        const response = await fetch(`${EXPRESS_SERVER_URL}/api/library/use`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemName, itemIndex, x, y })
        });
        const result = await response.json() as any;

        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Failed to use library item');
        }

        const placed = result.items?.[0];
        return {
          content: [{
            type: 'text',
            text: `Placed library item "${placed?.name}" (${placed?.elementCount} elements) at (${placed?.placedAt?.x}, ${placed?.placedAt?.y})`
          }]
        };
      }

      case 'export_image_with_scene': {
        const params = z.object({
          format: z.enum(['png', 'svg']),
          filePath: z.string(),
          background: z.boolean().optional()
        }).parse(args);

        logger.info('Exporting image with embedded scene data', { format: params.format });

        // 1. Get image data from frontend
        const imgResponse = await fetch(`${EXPRESS_SERVER_URL}/api/export/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: params.format,
            background: params.background ?? true
          })
        });

        if (!imgResponse.ok) {
          const errData = await imgResponse.json() as ApiResponse;
          throw new Error(errData.error || `Image export failed: ${imgResponse.status}`);
        }

        const imgResult = await imgResponse.json() as { success: boolean; format: string; data: string };

        // 2. Get scene JSON
        const sceneResponse = await fetch(`${EXPRESS_SERVER_URL}/api/elements`);
        if (!sceneResponse.ok) {
          throw new Error(`Failed to fetch elements: ${sceneResponse.status}`);
        }
        const sceneApiData = await sceneResponse.json() as ApiResponse;
        const sceneElements = sceneApiData.elements || [];

        let sceneFiles: Record<string, any> = {};
        try {
          const filesResp = await fetch(`${EXPRESS_SERVER_URL}/api/files`);
          if (filesResp.ok) {
            const filesData = await filesResp.json() as any;
            sceneFiles = filesData.files || {};
          }
        } catch { /* best effort */ }

        const excalidrawScene = {
          type: 'excalidraw',
          version: 2,
          source: 'mcp-excalidraw-server',
          elements: sceneElements,
          appState: { viewBackgroundColor: '#ffffff', gridSize: null },
          ...(Object.keys(sceneFiles).length > 0 ? { files: sceneFiles } : {})
        };

        const sceneJson = JSON.stringify(excalidrawScene);
        const safePath = sanitizeFilePath(params.filePath);

        if (params.format === 'svg') {
          // SVG: Excalidraw frontend already embeds scene data in native format
          // (payload-start/payload-end with bstring+zlib compression).
          // If native payload is present, save as-is. Otherwise add our format.
          let svgData = imgResult.data;
          if (!svgData.includes('<!-- payload-start -->')) {
            const encodedScene = `<!-- payload-type:excalidraw payload-version:2 data-encoded:${encodeURIComponent(sceneJson)} -->`;
            const closingIdx = svgData.lastIndexOf('</svg>');
            if (closingIdx !== -1) {
              svgData = svgData.slice(0, closingIdx) + '\n' + encodedScene + '\n' + svgData.slice(closingIdx);
            } else {
              svgData += '\n' + encodedScene;
            }
          }
          fs.writeFileSync(safePath, svgData, 'utf-8');
        } else {
          // PNG: embed scene data as a tEXt chunk matching Excalidraw's native format
          // Keyword: "application/vnd.excalidraw+json" (not "excalidraw")
          // Value: JSON.stringify({version:"1", encoding:"bstring", compressed:true, encoded:<deflated>})
          const pngBuffer = Buffer.from(imgResult.data, 'base64');

          // Skip manual injection if the frontend already embedded the scene
          // natively (exportEmbedScene: true) — avoid duplicate tEXt chunks.
          const sceneKeyword = Buffer.from('application/vnd.excalidraw+json', 'latin1');
          if (pngBuffer.includes(sceneKeyword)) {
            fs.writeFileSync(safePath, pngBuffer);
          } else {
            // Compress scene JSON using deflate (same as Excalidraw's Si() function)
            const deflated = deflateSync(Buffer.from(sceneJson, 'utf-8'));
            // Convert to bstring (latin1) for JSON-safe storage
            const bstringEncoded = deflated.toString('latin1');
            const wrapper = JSON.stringify({
              version: '1',
              encoding: 'bstring',
              compressed: true,
              encoded: bstringEncoded
            });

            const keyword = Buffer.from('application/vnd.excalidraw+json\0', 'latin1');
            const textData = Buffer.from(wrapper, 'latin1');
            const chunkData = Buffer.concat([keyword, textData]);

            // tEXt chunk = length(4) + type(4) + data + crc(4)
            const chunkType = Buffer.from('tEXt', 'latin1');
            const lengthBuf = Buffer.alloc(4);
            lengthBuf.writeUInt32BE(chunkData.length, 0);

            // CRC32 over type + data
            const crcInput = Buffer.concat([chunkType, chunkData]);
            const crc = crc32(crcInput);
            const crcBuf = Buffer.alloc(4);
            crcBuf.writeUInt32BE(crc >>> 0, 0);

            const textChunk = Buffer.concat([lengthBuf, chunkType, chunkData, crcBuf]);

            // Insert before IEND (last 12 bytes of a valid PNG)
            const iendOffset = pngBuffer.length - 12;
            const result = Buffer.concat([
              pngBuffer.slice(0, iendOffset),
              textChunk,
              pngBuffer.slice(iendOffset)
            ]);

            fs.writeFileSync(safePath, result);
          }
        }

        // Verify the written file actually contains embedded scene data
        {
          const written = fs.readFileSync(safePath);
          const hasScene = params.format === 'svg'
            ? (written.includes('payload-start') || written.includes('payload-type:excalidraw'))
            : written.includes(Buffer.from('application/vnd.excalidraw+json', 'latin1'));
          if (!hasScene) {
            throw new Error(`Scene data embedding verification failed for ${safePath} — no embedded scene found in the exported ${params.format.toUpperCase()}`);
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Exported ${params.format.toUpperCase()} with embedded scene data to ${safePath} (${sceneElements.length} elements)`
          }]
        };
      }

      case 'import_from_image': {
        const params = z.object({
          filePath: z.string(),
          mode: z.enum(['replace', 'merge'])
        }).parse(args);

        const safePath = sanitizeFilePath(params.filePath);
        const ext = path.extname(safePath).toLowerCase();

        logger.info('Importing scene from image', { path: safePath, ext });

        let sceneData: any;

        if (ext === '.svg') {
          const svgContent = fs.readFileSync(safePath, 'utf-8');

          // Method 1: Excalidraw native format (payload-start/payload-end with bstring+zlib)
          const nativeMatch = svgContent.match(/<!-- payload-start -->([\s\S]*?)<!-- payload-end -->/);
          if (nativeMatch) {
            const b64 = nativeMatch[1]!.trim();
            const rawBuf = Buffer.from(b64, 'base64');
            const wrapper = JSON.parse(rawBuf.toString('latin1'));
            if (wrapper.compressed && wrapper.encoded) {
              const encodedBuf = Buffer.from(wrapper.encoded, 'latin1');
              const decompressed = inflateSync(encodedBuf);
              sceneData = JSON.parse(decompressed.toString('utf-8'));
            } else if (wrapper.encoded) {
              const innerBuf = Buffer.from(wrapper.encoded, 'base64');
              sceneData = JSON.parse(innerBuf.toString('utf-8'));
            }
          }

          // Method 2: Our custom data-encoded format
          if (!sceneData) {
            const payloadMatch = svgContent.match(/<!-- payload-type:excalidraw[^>]*data-encoded:([^>\s]+)\s*-->/);
            if (payloadMatch) {
              const decoded = decodeURIComponent(payloadMatch[1]!);
              sceneData = JSON.parse(decoded);
            }
          }

          // Method 3: JSON in <desc> tag
          if (!sceneData) {
            const descMatch = svgContent.match(/<desc>([\s\S]*?)<\/desc>/);
            if (descMatch) {
              try {
                const parsed = JSON.parse(descMatch[1]!.trim());
                if (parsed.type === 'excalidraw' || parsed.elements) {
                  sceneData = parsed;
                }
              } catch { /* not excalidraw data */ }
            }
          }

          if (!sceneData) {
            throw new Error('No embedded Excalidraw scene data found in SVG. The file may be a plain SVG without embedded data.');
          }
        } else if (ext === '.png') {
          const pngBuffer = fs.readFileSync(safePath);

          // Parse PNG chunks to find tEXt chunk with keyword "excalidraw"
          if (pngBuffer.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
            throw new Error('Not a valid PNG file');
          }

          let offset = 8; // skip PNG signature
          let found = false;

          while (offset < pngBuffer.length - 4) {
            const chunkLength = pngBuffer.readUInt32BE(offset);
            const chunkType = pngBuffer.slice(offset + 4, offset + 8).toString('latin1');

            if (chunkType === 'tEXt' || chunkType === 'iTXt') {
              const chunkDataStart = offset + 8;
              const chunkDataBuf = pngBuffer.slice(chunkDataStart, chunkDataStart + chunkLength);

              const nullIdx = chunkDataBuf.indexOf(0);
              if (nullIdx !== -1) {
                const keyword = chunkDataBuf.slice(0, nullIdx).toString('latin1');
                const excalidrawKeywords = ['application/vnd.excalidraw+json', 'excalidraw'];
                if (excalidrawKeywords.includes(keyword)) {
                  // tEXt: keyword + null + text (latin1 encoded for bstring)
                  const textContent = chunkDataBuf.slice(nullIdx + 1).toString('latin1');
                  const parsed = JSON.parse(textContent);

                  // Check if it's a bstring wrapper (Excalidraw native format)
                  if (parsed.encoding === 'bstring' && parsed.compressed && parsed.encoded) {
                    const encodedBuf = Buffer.from(parsed.encoded, 'latin1');
                    const decompressed = inflateSync(encodedBuf);
                    sceneData = JSON.parse(decompressed.toString('utf-8'));
                  } else if (parsed.encoded) {
                    const innerBuf = Buffer.from(parsed.encoded, 'base64');
                    sceneData = JSON.parse(innerBuf.toString('utf-8'));
                  } else if (parsed.type === 'excalidraw' || parsed.elements) {
                    sceneData = parsed;
                  }
                  found = true;
                  break;
                }
              }
            }

            if (chunkType === 'IEND') break;
            offset += 12 + chunkLength; // length(4) + type(4) + data + crc(4)
          }

          if (!found || !sceneData) {
            throw new Error('No embedded Excalidraw scene data found in PNG. The file may be a plain PNG without embedded data.');
          }
        } else {
          throw new Error(`Unsupported file type: ${ext}. Expected .png or .svg`);
        }

        // Import the extracted scene
        const importElements: ServerElement[] = Array.isArray(sceneData)
          ? sceneData
          : (sceneData.elements || []);

        if (importElements.length === 0) {
          throw new Error('Embedded scene data contains no elements');
        }

        if (params.mode === 'replace') {
          await fetch(`${EXPRESS_SERVER_URL}/api/elements/clear`, { method: 'DELETE' });
        }

        const elementsToCreate = importElements.map(el => ({
          ...el,
          id: el.id || generateId(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1
        }));

        await batchCreateElementsOnCanvas(elementsToCreate);

        // Import files if present
        let importedFileCount = 0;
        if (sceneData.files && typeof sceneData.files === 'object') {
          const fileList = Object.values(sceneData.files);
          if (fileList.length > 0) {
            try {
              await fetch(`${EXPRESS_SERVER_URL}/api/files`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fileList)
              });
              importedFileCount = fileList.length;
            } catch { /* best effort */ }
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Imported ${elementsToCreate.length} elements${importedFileCount > 0 ? ` and ${importedFileCount} files` : ''} from ${ext.toUpperCase()} (mode: ${params.mode})\n\n✅ Scene restored from embedded data`
          }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error(`Error handling tool call: ${(error as Error).message}`, { error });
    return {
      content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
      isError: true
    };
  }
});

// Set up request handler for listing available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.info('Listing available tools');
  return { tools };
});

return server;
}

// Start server (stdio mode)
async function runServer(): Promise<void> {
  try {
    logger.info('Starting Excalidraw MCP server...');

    const server = createMcpServer();
    const transport = new StdioServerTransport();
    logger.debug('Connecting to stdio transport...');

    await server.connect(transport);
    logger.info('Excalidraw MCP server running on stdio');

    process.stdin.resume();
  } catch (error) {
    logger.error('Error starting server:', error);
    process.stderr.write(`Failed to start MCP server: ${(error as Error).message}\n${(error as Error).stack}\n`);
    process.exit(1);
  }
}

// Add global error handlers
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception:', error);
  process.stderr.write(`UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}\n`);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  logger.error('Unhandled promise rejection:', reason);
  process.stderr.write(`UNHANDLED REJECTION: ${reason}\n`);
  setTimeout(() => process.exit(1), 1000);
});

// For testing and debugging purposes
if (process.env.DEBUG === 'true') {
  logger.debug('Debug mode enabled');
}

// Start the server if this file is run directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runServer().catch(error => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export default runServer;