/**
 * Streaming-ish parser for Android/JVM HPROF binary heap dumps.
 *
 * Implements enough of the format to extract per-class instance counts and
 * bytes — equivalent to the "Class List" view in Android Studio's Memory
 * Profiler. Walks every record so the cursor stays correctly aligned, but
 * skips field bodies and reference graphs (we don't need retainer paths).
 *
 * Spec references:
 *   - Standard HPROF: https://hg.openjdk.org/jdk6/jdk6/jdk/raw-file/tip/src/share/demo/jvmti/hprof/manual.html
 *   - Android extensions (ART): art/runtime/hprof/hprof.cc in AOSP
 */

import type { ObjectClass } from './memory.js';

// ── Top-level record tags ────────────────────────────────────────────────────
const TAG_STRING = 0x01;
const TAG_LOAD_CLASS = 0x02;
const TAG_HEAP_DUMP = 0x0c;
const TAG_HEAP_DUMP_SEGMENT = 0x1c;
// const TAG_HEAP_DUMP_END = 0x2c; // marker only, no body

// ── Sub-record tags inside HEAP_DUMP / HEAP_DUMP_SEGMENT ─────────────────────
// Standard root types (just an ID, sometimes with thread/frame metadata).
const SUB_ROOT_UNKNOWN = 0xff;
const SUB_ROOT_JNI_GLOBAL = 0x01;
const SUB_ROOT_JNI_LOCAL = 0x02;
const SUB_ROOT_JAVA_FRAME = 0x03;
const SUB_ROOT_NATIVE_STACK = 0x04;
const SUB_ROOT_STICKY_CLASS = 0x05;
const SUB_ROOT_THREAD_BLOCK = 0x06;
const SUB_ROOT_MONITOR_USED = 0x07;
const SUB_ROOT_THREAD_OBJECT = 0x08;

// Object-bearing sub-records.
const SUB_CLASS_DUMP = 0x20;
const SUB_INSTANCE_DUMP = 0x21;
const SUB_OBJECT_ARRAY_DUMP = 0x22;
const SUB_PRIMITIVE_ARRAY_DUMP = 0x23;

// Android-specific extensions.
const SUB_HEAP_DUMP_INFO = 0xfe;
const SUB_ROOT_INTERNED_STRING = 0x89;
const SUB_ROOT_FINALIZING = 0x8a;
const SUB_ROOT_DEBUGGER = 0x8b;
const SUB_ROOT_REFERENCE_CLEANUP = 0x8c;
const SUB_ROOT_VM_INTERNAL = 0x8d;
const SUB_ROOT_JNI_MONITOR = 0x8e;
const SUB_UNREACHABLE = 0x90;
const SUB_PRIMITIVE_ARRAY_NODATA = 0xc3;

// ── HPROF basic types ────────────────────────────────────────────────────────
const T_OBJECT = 2;
const T_BOOLEAN = 4;
const T_CHAR = 5;
const T_FLOAT = 6;
const T_DOUBLE = 7;
const T_BYTE = 8;
const T_SHORT = 9;
const T_INT = 10;
const T_LONG = 11;

function valueSize(t: number, idSize: number): number {
  switch (t) {
    case T_OBJECT:
      return idSize;
    case T_BOOLEAN:
    case T_BYTE:
      return 1;
    case T_CHAR:
    case T_SHORT:
      return 2;
    case T_FLOAT:
    case T_INT:
      return 4;
    case T_DOUBLE:
    case T_LONG:
      return 8;
    default:
      // Some Android variants use non-standard type ids in constant pools.
      // Conservatively assume 1 — we only use this to advance the cursor and
      // bad alignment will surface as a parse error further down.
      return 1;
  }
}

function primArrayName(t: number): string {
  switch (t) {
    case T_BOOLEAN:
      return 'boolean[]';
    case T_CHAR:
      return 'char[]';
    case T_FLOAT:
      return 'float[]';
    case T_DOUBLE:
      return 'double[]';
    case T_BYTE:
      return 'byte[]';
    case T_SHORT:
      return 'short[]';
    case T_INT:
      return 'int[]';
    case T_LONG:
      return 'long[]';
    default:
      return `prim<${t}>[]`;
  }
}

/**
 * Convert a JNI-encoded type name to a Java-source-style name.
 * Handles both the bare class names ART writes (`java.lang.String`) and
 * canonical JNI names (`Ljava/lang/String;`, `[I`, `[[Ljava/util/Map$Entry;`).
 */
function prettyClassName(raw: string): string {
  if (!raw) return '<unknown>';
  // ART often emits already-pretty names like "java.lang.String" or "byte[]".
  // Detect the JNI-style encoding by leading "[" or "L...;".
  if (raw[0] !== '[' && !(raw[0] === 'L' && raw.endsWith(';'))) {
    // HotSpot HPROF writes instance class names with slashes (e.g.
    // "java/lang/String"); ART writes them dotted. Normalise to dots.
    return raw.includes('/') ? raw.replace(/\//g, '.') : raw;
  }

  let dims = 0;
  let i = 0;
  while (i < raw.length && raw[i] === '[') {
    dims++;
    i++;
  }
  let base: string;
  if (i >= raw.length) {
    base = raw;
  } else {
    const c = raw[i];
    switch (c) {
      case 'L': {
        const end = raw.endsWith(';') ? raw.length - 1 : raw.length;
        base = raw.slice(i + 1, end).replace(/\//g, '.');
        break;
      }
      case 'B':
        base = 'byte';
        break;
      case 'C':
        base = 'char';
        break;
      case 'D':
        base = 'double';
        break;
      case 'F':
        base = 'float';
        break;
      case 'I':
        base = 'int';
        break;
      case 'J':
        base = 'long';
        break;
      case 'S':
        base = 'short';
        break;
      case 'Z':
        base = 'boolean';
        break;
      default:
        base = raw.slice(i);
        break;
    }
  }
  return base + '[]'.repeat(dims);
}

export interface HprofResult {
  classes: ObjectClass[];
  totals: { count: number; bytes: number };
  /** Per-heap (Android) totals: e.g. { app: {...}, image: {...}, zygote: {...} } */
  heaps?: Record<string, { count: number; bytes: number }>;
}

/**
 * Parse an HPROF file buffer and return per-class instance counts/bytes.
 *
 * "Bytes" is the sum of instance-data sizes (object body, array contents) —
 * not retained size. This matches what Android Studio's Memory Profiler shows
 * in its "Shallow Size" column.
 */
export function parseHprof(buf: Buffer): HprofResult {
  let pos = 0;

  // Header: NUL-terminated ASCII string ("JAVA PROFILE 1.0.X")
  const headerEnd = buf.indexOf(0, pos);
  if (headerEnd < 0) throw new Error('Invalid HPROF: missing header NUL terminator');
  const header = buf.slice(pos, headerEnd).toString('ascii');
  if (!header.startsWith('JAVA PROFILE')) {
    throw new Error(`Not an HPROF file (header: ${JSON.stringify(header)})`);
  }
  pos = headerEnd + 1;

  if (pos + 12 > buf.length) throw new Error('HPROF truncated in header');
  const idSize = buf.readUInt32BE(pos);
  pos += 4;
  if (idSize !== 4 && idSize !== 8) {
    throw new Error(`Unsupported HPROF identifier size: ${idSize}`);
  }
  pos += 8; // timestamp: 2x u4 (high, low) — unused

  // ── State ──────────────────────────────────────────────────────────────────
  const strings = new Map<string, string>(); // string id → utf8
  const classNameByObjId = new Map<string, string>(); // class object id → class name string
  const stats = new Map<string, { count: number; bytes: number }>();
  const heapStats = new Map<string, { count: number; bytes: number }>();
  let currentHeap = 'default';
  let totalCount = 0;
  let totalBytes = 0;

  // ── Helpers (closures over `pos` / `idSize`) ───────────────────────────────
  const readId = (): string => {
    if (idSize === 4) {
      const v = buf.readUInt32BE(pos);
      pos += 4;
      return v.toString();
    }
    const v = buf.readBigUInt64BE(pos);
    pos += 8;
    return v.toString();
  };
  const skipId = (): void => {
    pos += idSize;
  };
  const readU4 = (): number => {
    const v = buf.readUInt32BE(pos);
    pos += 4;
    return v;
  };
  const readU2 = (): number => {
    const v = buf.readUInt16BE(pos);
    pos += 2;
    return v;
  };
  const readU1 = (): number => buf[pos++];

  const bump = (rawClassName: string, bytes: number): void => {
    const name = prettyClassName(rawClassName);
    const cur = stats.get(name);
    if (cur) {
      cur.count++;
      cur.bytes += bytes;
    } else {
      stats.set(name, { count: 1, bytes });
    }
    totalCount++;
    totalBytes += bytes;
    const h = heapStats.get(currentHeap);
    if (h) {
      h.count++;
      h.bytes += bytes;
    } else {
      heapStats.set(currentHeap, { count: 1, bytes });
    }
  };

  const classNameFor = (classObjId: string): string =>
    classNameByObjId.get(classObjId) ?? `<class@${classObjId}>`;

  // ── Heap dump body parser (one pass over sub-records) ──────────────────────
  const parseHeapDumpBody = (end: number): void => {
    while (pos < end) {
      const sub = readU1();
      switch (sub) {
        // Roots that are just a single ID.
        case SUB_ROOT_UNKNOWN:
        case SUB_ROOT_STICKY_CLASS:
        case SUB_ROOT_MONITOR_USED:
        case SUB_ROOT_INTERNED_STRING:
        case SUB_ROOT_FINALIZING:
        case SUB_ROOT_DEBUGGER:
        case SUB_ROOT_REFERENCE_CLEANUP:
        case SUB_ROOT_VM_INTERNAL:
        case SUB_UNREACHABLE:
          skipId();
          break;

        case SUB_ROOT_JNI_GLOBAL:
          skipId(); // object id
          skipId(); // jni global ref id
          break;

        case SUB_ROOT_JNI_LOCAL:
        case SUB_ROOT_JAVA_FRAME:
        case SUB_ROOT_JNI_MONITOR:
          skipId();
          pos += 4 + 4; // thread serial + frame number
          break;

        case SUB_ROOT_NATIVE_STACK:
        case SUB_ROOT_THREAD_BLOCK:
          skipId();
          pos += 4; // thread serial
          break;

        case SUB_ROOT_THREAD_OBJECT:
          skipId();
          pos += 4 + 4; // thread serial + stack trace serial
          break;

        case SUB_HEAP_DUMP_INFO: {
          // Switches the "current heap" context for subsequent records.
          // Layout: u4 heap_id, ID heap_name_string_id
          pos += 4;
          const nameId = readId();
          currentHeap = strings.get(nameId) ?? `heap${nameId}`;
          break;
        }

        case SUB_CLASS_DUMP: {
          // Variable-length: header + constant pool + static fields + instance fields.
          skipId(); // class object id
          pos += 4; // stack trace serial
          skipId(); // super class id
          skipId(); // classloader id
          skipId(); // signers id
          skipId(); // protection domain id
          skipId(); // reserved
          skipId(); // reserved
          pos += 4; // instance size

          // Constant pool: u2 count, then [u2 idx, u1 type, value]
          const cpCount = readU2();
          for (let i = 0; i < cpCount; i++) {
            pos += 2; // constant pool index
            const t = readU1();
            pos += valueSize(t, idSize);
          }

          // Static fields: u2 count, then [ID name, u1 type, value]
          const staticCount = readU2();
          for (let i = 0; i < staticCount; i++) {
            skipId(); // name string id
            const t = readU1();
            pos += valueSize(t, idSize);
          }

          // Instance field declarations: u2 count, then [ID name, u1 type]
          const instanceCount = readU2();
          for (let i = 0; i < instanceCount; i++) {
            skipId(); // name string id
            pos += 1; // type
          }
          break;
        }

        case SUB_INSTANCE_DUMP: {
          skipId(); // object id
          pos += 4; // stack trace serial
          const classObjId = readId();
          const dataSize = readU4();
          // Field bytes follow; we don't care about the values.
          pos += dataSize;
          // Account 16 bytes of object header on top of the field area —
          // matches the convention Android Studio uses.
          bump(classNameFor(classObjId), dataSize + 16);
          break;
        }

        case SUB_OBJECT_ARRAY_DUMP: {
          skipId(); // array object id
          pos += 4; // stack trace serial
          const numElements = readU4();
          const arrayClassId = readId();
          pos += numElements * idSize; // element ids
          // Object[] payload size = elements * idSize, plus 16-byte array header.
          bump(classNameFor(arrayClassId), numElements * idSize + 16);
          break;
        }

        case SUB_PRIMITIVE_ARRAY_DUMP: {
          skipId(); // array object id
          pos += 4; // stack trace serial
          const numElements = readU4();
          const elemType = readU1();
          const elemSize = valueSize(elemType, idSize);
          pos += numElements * elemSize; // primitive bytes
          bump(primArrayName(elemType), numElements * elemSize + 16);
          break;
        }

        case SUB_PRIMITIVE_ARRAY_NODATA: {
          // Same shape as primitive array minus the actual data bytes.
          skipId();
          pos += 4;
          const numElements = readU4();
          const elemType = readU1();
          bump(primArrayName(elemType), numElements * valueSize(elemType, idSize) + 16);
          break;
        }

        default: {
          // Unknown sub-record — we can't safely advance, so abort the segment.
          throw new Error(`Unknown HPROF sub-record 0x${sub.toString(16)} at offset ${pos - 1}`);
        }
      }
    }
  };

  // ── Main record loop ───────────────────────────────────────────────────────
  while (pos < buf.length) {
    if (pos + 9 > buf.length) break; // not enough for a record header
    const tag = readU1();
    pos += 4; // time delta (unused)
    const len = readU4();
    const recordEnd = pos + len;
    if (recordEnd > buf.length) break; // truncated tail

    switch (tag) {
      case TAG_STRING: {
        const id = readId();
        const str = buf.slice(pos, recordEnd).toString('utf8');
        strings.set(id, str);
        break;
      }
      case TAG_LOAD_CLASS: {
        pos += 4; // class serial
        const classObjId = readId();
        pos += 4; // stack trace serial
        const nameStrId = readId();
        const name = strings.get(nameStrId);
        if (name !== undefined) classNameByObjId.set(classObjId, name);
        break;
      }
      case TAG_HEAP_DUMP:
      case TAG_HEAP_DUMP_SEGMENT:
        parseHeapDumpBody(recordEnd);
        break;
      default:
        // Unknown / uninteresting top-level record (UNLOAD_CLASS, STACK_FRAME,
        // STACK_TRACE, ALLOC_SITES, ...). Skip the body via recordEnd.
        break;
    }
    pos = recordEnd;
  }

  const classes: ObjectClass[] = [...stats.entries()]
    .map(([cls, v]) => ({ class: cls, count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes);

  const heaps: Record<string, { count: number; bytes: number }> = {};
  for (const [h, v] of heapStats) heaps[h] = v;

  return {
    classes,
    totals: { count: totalCount, bytes: totalBytes },
    heaps: Object.keys(heaps).length > 0 ? heaps : undefined,
  };
}
