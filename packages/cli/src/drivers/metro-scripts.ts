/**
 * JS payloads injected into the RN runtime via `Runtime.evaluate`.
 *
 * These scripts mirror the approach in software-mansion/argent:
 *   - Detect Fabric (`nativeFabricUIManager`) vs Paper (`UIManager` via `__r`).
 *   - For component-tree: walk the fiber tree, filter wrappers via a SKIP set,
 *     batch-measure on-screen rects via Paper/Fabric measure APIs, return JSON
 *     via the `__conductor_callback` binding keyed on `requestId`.
 *   - For inspect-element: use `renderer.rendererConfig.getInspectorDataForViewAtPoint`
 *     (React's own inspector) and walk UP via `.return` from `data.closestInstance`.
 *
 * Both scripts return a small ack value synchronously and post the real result
 * asynchronously through the binding — that's why the caller uses
 * `MetroCdpClient.installCallbackBinding`.
 */

/** RN internals + navigation/safe-area wrappers we always strip from the tree. */
const SKIP_NAMES = [
  'View',
  'RCTView',
  'RCTText',
  'RCTScrollView',
  'RCTScrollContentView',
  'RCTImageView',
  'RCTSafeAreaView',
  'RCTVirtualText',
  'RCTSinglelineTextInputView',
  'RCTMultilineTextInputView',
  'RNCSafeAreaProvider',
  'RNSScreen',
  'RNSScreenStack',
  'RNSScreenContentWrapper',
  'RNSScreenNavigationContainer',
  'RNSScreenStackHeaderConfig',
  'ScreenStackHeaderConfig',
  'NavigationContent',
  'PreventRemoveProvider',
  'EnsureSingleNavigator',
  'StaticContainer',
  'SceneView',
  'NativeStackView',
  'NativeStackNavigator',
  'DelayedFreeze',
  'Freeze',
  'Suspender',
  'DebugContainer',
  'ScreenContentWrapper',
  'Screen',
  'ScreenStack',
  'ScreenContainer',
  'MaybeScreenContainer',
  'MaybeScreen',
  'FrameSizeProvider',
  'FrameSizeProviderInner',
  'FrameSizeListenerNativeFallback',
  'SafeAreaProviderCompat',
  'SafeAreaProvider',
  'SafeAreaInsetsContext',
  'SafeArea',
  'SafeAreaFrameContext',
  'ErrorOverlay',
  'ErrorToastContainer',
  'PerformanceLoggerContext',
  'AppContainer',
  'RootTagContext',
  'DebuggingOverlay',
  'DebuggingOverlayRegistrySubscription',
  'LogBoxStateSubscription',
  '_LogBoxNotificationContainer',
  'LogBoxInspectorContainer',
  'LogBoxInspector',
  'LogBoxInspectorCodeFrame',
  'CellRenderer',
  'VirtualizedListContextProvider',
  'VirtualizedListCellContextProvider',
  'wrapper',
  'Background',
  'Pressable',
  'PlatformPressable',
  'ExpoRoot',
  'ContextNavigator',
  'RootApp',
  'ThemeProvider',
  'StatusBar',
  'ReactNativeProfiler',
  'NavigationRouteContext',
  'BottomTabNavigator',
  'BottomTabView',
  'ImageAnalyticsTagContext',
  'GestureHandlerRootView',
  'GestureDetector',
  'Wrap',
  'NavigationContainerInner',
  'BaseNavigationContainer',
  'PlatformPressableInternal',
];

const HARD_SKIP_NAMES = [
  'BaseTextInput',
  'InternalTextInput',
  'RNTextInputWithRef',
  'RCTSinglelineTextInputView',
  'RCTMultilineTextInputView',
];

/**
 * Component-tree walker. Returns a script that, when evaluated, returns 'ok'
 * synchronously and posts a JSON payload `{ requestId, components, screenW,
 * screenH }` via `__conductor_callback(payload)`.
 *
 * Components carry `{ name, depth, rect, testID, label, text }` for nodes
 * that survive SKIP filtering. `rect` is in window coordinates and is
 * populated via batched `UIManager.measureInWindow` on Paper, or
 * `nativeFabricUIManager.measure` on Fabric.
 */
export function makeComponentTreeScript(requestId: string): string {
  const skip = JSON.stringify(SKIP_NAMES);
  const hardSkip = JSON.stringify(HARD_SKIP_NAMES);
  return `(async function() {
    var REQ = ${JSON.stringify(requestId)};
    function done(payload) {
      try { globalThis.__conductor_callback(JSON.stringify(Object.assign({ requestId: REQ }, payload))); } catch (e) {}
    }
    try {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) { done({ error: 'No React DevTools hook' }); return 'ok'; }
      var roots = hook.getFiberRoots ? hook.getFiberRoots(1) : null;
      if (!roots || roots.size === 0) { done({ error: 'No fiber roots' }); return 'ok'; }
      var root = Array.from(roots)[0];

      var useFabric = typeof nativeFabricUIManager !== 'undefined';
      var UIManagerMod = null;
      if (!useFabric) {
        try {
          if (typeof __r === 'function' && typeof __r.getModules === 'function') {
            var mods = __r.getModules();
            for (var e of mods) {
              if (!e[1].isInitialized) continue;
              try {
                var m = __r(e[0]);
                if (m && m.UIManager) { UIManagerMod = m.UIManager; break; }
              } catch (er) {}
            }
          }
          if (!UIManagerMod && typeof __r === 'function') {
            for (var i = 0; i < 300; i++) {
              try {
                var m2 = __r(i);
                if (m2 && m2.UIManager) { UIManagerMod = m2.UIManager; break; }
              } catch (er) {}
            }
          }
        } catch (er) {}
      }

      var SKIP = new Set(${skip});
      var HARD = new Set(${hardSkip});
      function isHardSkip(n) {
        if (HARD.has(n)) return true;
        if (n.indexOf('AnimatedComponent(') === 0) return true;
        if (n.indexOf('Animated(') === 0) return true;
        return false;
      }
      function shouldSkip(n) {
        if (isHardSkip(n)) return true;
        if (SKIP.has(n)) return true;
        if (n.charAt(0) === '_' && n.charAt(1) === '_') return true;
        if (n.length > 8 && n.slice(-8) === 'Provider') return true;
        if (n.length > 7 && n.slice(-7) === 'Context') return true;
        if (n.indexOf('Route(') === 0) return true;
        return false;
      }
      function getName(f) {
        var t = f.type;
        if (!t) return null;
        if (typeof t === 'string') return t;
        return t.displayName || t.name || null;
      }
      function getProps(f) { return f.memoizedProps || null; }
      function getHostInfo(f) {
        if (typeof f.type !== 'string' || !f.stateNode) return null;
        if (useFabric && f.stateNode.node) return { fabric: true, node: f.stateNode.node };
        if (!useFabric) {
          if (f.stateNode.canonical && typeof f.stateNode.canonical.nativeTag === 'number')
            return { fabric: false, tag: f.stateNode.canonical.nativeTag };
          if (typeof f.stateNode._nativeTag === 'number')
            return { fabric: false, tag: f.stateNode._nativeTag };
        }
        return null;
      }
      function findHost(f, d) {
        if (!f || d > 15) return null;
        var hi = getHostInfo(f);
        if (hi) return hi;
        return findHost(f.child, d + 1);
      }

      // Screen dimensions via Dimensions API.
      var screenW = 0, screenH = 0;
      try {
        if (typeof __r === 'function' && typeof __r.getModules === 'function') {
          var mods2 = __r.getModules();
          for (var e2 of mods2) {
            if (!e2[1].isInitialized) continue;
            try {
              var mm = __r(e2[0]);
              if (mm && mm.Dimensions && typeof mm.Dimensions.get === 'function') {
                var w = mm.Dimensions.get('window');
                if (w && w.width) { screenW = w.width; screenH = w.height; break; }
              }
            } catch (er) {}
          }
        }
      } catch (er) {}

      // Walk fibers, collect candidates.
      var candidates = [];
      var stack = [{ f: root.current, d: 0 }];
      while (stack.length && candidates.length < 2000) {
        var item = stack.pop();
        var f = item.f, d = item.d;
        if (!f) continue;
        var name = getName(f);
        if (name && !shouldSkip(name)) {
          var hi = findHost(f, 0);
          var props = getProps(f);
          candidates.push({
            name: name,
            depth: d,
            testID: (props && (props.testID || props['data-testid'])) || null,
            label: (props && (props.accessibilityLabel || props['aria-label'])) || null,
            text: (props && typeof props.children === 'string') ? props.children : null,
            host: hi,
          });
        }
        if (f.sibling) stack.push({ f: f.sibling, d: d });
        if (f.child) stack.push({ f: f.child, d: d + 1 });
      }

      // Batch measure rects.
      function measureFabric(node) {
        try {
          var r = nativeFabricUIManager.measure(node, function() {});
          if (Array.isArray(r) && r.length >= 6) {
            return { x: r[4], y: r[5], w: r[2], h: r[3] };
          }
        } catch (e) {}
        return null;
      }
      function measurePaper(tag) {
        return new Promise(function(res) {
          try {
            UIManagerMod.measureInWindow(tag, function(x, y, w, h) {
              res({ x: x, y: y, w: w, h: h });
            });
          } catch (e) { res(null); }
        });
      }

      var promises = [];
      for (var c of candidates) {
        if (!c.host) { promises.push(Promise.resolve(null)); continue; }
        if (c.host.fabric) {
          promises.push(Promise.resolve(measureFabric(c.host.node)));
        } else if (UIManagerMod) {
          promises.push(measurePaper(c.host.tag));
        } else {
          promises.push(Promise.resolve(null));
        }
      }
      var rects = await Promise.all(promises);
      var components = candidates.map(function(c, i) {
        return {
          name: c.name,
          depth: c.depth,
          testID: c.testID,
          label: c.label,
          text: c.text,
          rect: rects[i],
        };
      });

      done({ screenW: screenW, screenH: screenH, fabric: useFabric, components: components });
      return 'ok';
    } catch (e) {
      done({ error: String((e && e.message) || e) });
      return 'ok';
    }
  })();`;
}

/**
 * Shared JS: locate a host fiber by its native reactTag, across every registered
 * renderer and both RN architectures (Paper `_nativeTag`/`canonical.nativeTag`,
 * Fabric bridgeless `__nativeTag` on the state node / public instance). Defines
 * `findByTag(hook, TAG)` returning `{ fiber, renderer }` or null.
 */
const FIBER_BY_TAG_HELPERS = `
    function nativeTagOf(f) {
      if (typeof f.type !== 'string' || !f.stateNode) return null;
      var sn = f.stateNode;
      if (typeof sn._nativeTag === 'number') return sn._nativeTag;
      if (typeof sn.__nativeTag === 'number') return sn.__nativeTag;
      if (sn.canonical) {
        if (typeof sn.canonical.nativeTag === 'number') return sn.canonical.nativeTag;
        var pi = sn.canonical.publicInstance;
        if (pi && typeof pi.__nativeTag === 'number') return pi.__nativeTag;
      }
      if (sn.node && typeof sn.node.__nativeTag === 'number') return sn.node.__nativeTag;
      return null;
    }
    function findHostByTag(root, TAG) {
      var stack = [root.current || root], seen = 0;
      while (stack.length && seen < 40000) {
        var f = stack.pop(); seen++;
        if (!f) continue;
        if (nativeTagOf(f) === TAG) return f;
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
      return null;
    }
    function findByTag(hook, TAG) {
      var entries = [];
      hook.renderers.forEach(function(r, id) { entries.push([id, r]); });
      for (var i = 0; i < entries.length; i++) {
        var id = entries[i][0], r = entries[i][1], roots = null;
        try { roots = hook.getFiberRoots(id); } catch (e) {}
        if (!roots) continue;
        var arr = Array.from(roots);
        for (var j = 0; j < arr.length; j++) {
          var hf = findHostByTag(arr[j], TAG);
          if (hf) return { fiber: hf, renderer: r };
        }
      }
      return null;
    }`;

/**
 * Live-edit props via React DevTools' `overrideProps(fiber, path, value)` — the
 * same call the DevTools "edit prop" UI makes. Maps `reactTag` → host fiber, then
 * picks the fiber that owns the top-level path key (for `children`, prefers the
 * composite `<Text>` ancestor, so the visible string changes). Returns a JSON
 * string: `{status:'ok',applied:true}` or `{status:'error',message}`.
 */
export function makeOverridePropsScript(
  reactTag: number,
  path: string[],
  valueJson: string
): string {
  return `(function() {
    try {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || !hook.renderers || !hook.getFiberRoots) {
        return JSON.stringify({ status: 'error', message: 'No React DevTools hook — not a dev/debug build?' });
      }
      var TAG = ${JSON.stringify(reactTag)};
      var PATH = ${JSON.stringify(path)};
      var VALUE = ${valueJson};
      ${FIBER_BY_TAG_HELPERS}
      var hit = findByTag(hook, TAG);
      if (!hit) return JSON.stringify({ status: 'error', message: 'no fiber for reactTag ' + TAG });
      var renderer = hit.renderer;
      if (!renderer || typeof renderer.overrideProps !== 'function') {
        return JSON.stringify({ status: 'error', message: 'renderer has no overrideProps — is this a dev build?' });
      }
      // Pick the fiber that owns the top path key. For 'children' prefer the
      // nearest fiber whose children is a string (the renderable <Text>/RCTText),
      // so overriding actually swaps the visible glyphs.
      var key = PATH[0];
      var cur = hit.fiber, hops = 0, fallback = null;
      while (cur && hops < 10) {
        var p = cur.memoizedProps;
        if (p && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, key)) {
          if (fallback === null) fallback = cur;
          if (key !== 'children') { fallback = cur; break; }
          if (typeof p.children === 'string') { fallback = cur; break; }
        }
        cur = cur.return; hops++;
      }
      var target = fallback || hit.fiber;
      // RN styles are often arrays (StyleSheet composition). overrideProps' setIn
      // can't create missing intermediates, and a key set on the array object is
      // ignored by flattening — so for a 'style.<key>' path we flatten the current
      // style to a plain object (what RN does anyway), apply the override, and set
      // the whole 'style'. Works whether style started as an object or an array.
      if (PATH[0] === 'style' && PATH.length >= 2) {
        function flattenStyle(s) {
          var acc = {};
          (function merge(x) {
            if (!x) return;
            if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) merge(x[i]); return; }
            if (typeof x === 'object') { for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k)) acc[k] = x[k]; }
          })(s);
          return acc;
        }
        var flat = flattenStyle(target.memoizedProps && target.memoizedProps.style);
        var keys = PATH.slice(1), o = flat;
        for (var i = 0; i < keys.length - 1; i++) {
          if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {};
          o = o[keys[i]];
        }
        o[keys[keys.length - 1]] = VALUE;
        renderer.overrideProps(target, ['style'], flat);
        return JSON.stringify({ status: 'ok', applied: true, note: 'style flattened to object; override applied' });
      }
      renderer.overrideProps(target, PATH, VALUE);
      return JSON.stringify({ status: 'ok', applied: true });
    } catch (e) {
      return JSON.stringify({ status: 'error', message: String((e && e.message) || e) });
    }
  })();`;
}

/**
 * Dump a host fiber's `memoizedProps` (the real JSX props RN passed to the native
 * view — the JS-side analog of the native `/props` rawProps that Fabric drops).
 * Functions become `"[Function: name]"`; cycles/over-depth become markers.
 * Returns a JSON string `{status:'ok',props:{...}}` or `{status:'error',message}`.
 */
export function makeRnPropsScript(reactTag: number): string {
  return `(function() {
    try {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || !hook.renderers || !hook.getFiberRoots) {
        return JSON.stringify({ status: 'error', message: 'No React DevTools hook — not a dev/debug build?' });
      }
      var TAG = ${JSON.stringify(reactTag)};
      ${FIBER_BY_TAG_HELPERS}
      var hit = findByTag(hook, TAG);
      if (!hit) return JSON.stringify({ status: 'error', message: 'no fiber for reactTag ' + TAG });
      var seen = [];
      function ser(v, depth) {
        if (v === null || v === undefined) return v === undefined ? undefined : null;
        var t = typeof v;
        if (t === 'string' || t === 'boolean') return v;
        if (t === 'number') return isFinite(v) ? v : String(v);
        if (t === 'function') return '[Function: ' + (v.name || 'anonymous') + ']';
        if (t === 'symbol') return v.toString();
        if (t === 'bigint') return String(v) + 'n';
        if (t === 'object') {
          if (depth > 6) return '[Object: max depth]';
          if (seen.indexOf(v) !== -1) return '[Circular]';
          if (v && v.$$typeof) return '[ReactElement]';
          seen.push(v);
          var out;
          if (Array.isArray(v)) {
            out = [];
            for (var i = 0; i < v.length && i < 200; i++) out.push(ser(v[i], depth + 1));
          } else {
            out = {};
            var keys = Object.keys(v);
            for (var k = 0; k < keys.length; k++) {
              var val = ser(v[keys[k]], depth + 1);
              if (val !== undefined) out[keys[k]] = val;
            }
          }
          seen.pop();
          return out;
        }
        return String(v);
      }
      var props = ser(hit.fiber.memoizedProps || {}, 0);
      return JSON.stringify({ status: 'ok', props: props });
    } catch (e) {
      return JSON.stringify({ status: 'error', message: String((e && e.message) || e) });
    }
  })();`;
}

/**
 * Inspect-at-point script. Uses React DevTools's own
 * `renderer.rendererConfig.getInspectorDataForViewAtPoint(inspectRef, x, y, cb)`,
 * which is the authoritative point lookup. Then walks UP via `.return` from
 * `data.closestInstance`, preferring `_debugStack` for source resolution and
 * falling back to `_debugSource`.
 */
export function makeInspectElementScript(x: number, y: number, requestId: string): string {
  return `(function() {
    var REQ = ${JSON.stringify(requestId)};
    function done(payload) {
      try { globalThis.__conductor_callback(JSON.stringify(Object.assign({ requestId: REQ }, payload))); } catch (e) {}
    }
    try {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) { done({ error: 'No React DevTools hook' }); return 'ok'; }
      var renderer = Array.from(hook.renderers.values())[0];
      var roots = hook.getFiberRoots(1);
      if (!roots || roots.size === 0) { done({ error: 'No fiber roots' }); return 'ok'; }
      var root = Array.from(roots)[0];

      var useFabric = typeof nativeFabricUIManager !== 'undefined';

      function findHostFiber(f, d) {
        if (!f || d > 30) return null;
        if (typeof f.type === 'string' && f.stateNode) {
          if (useFabric && f.stateNode.node) return f;
          if (!useFabric && f.stateNode.canonical) return f;
        }
        return findHostFiber(f.child, d + 1) || null;
      }

      function getName(f) {
        var t = f.type;
        if (!t || typeof t === 'string') return null;
        if (typeof t === 'function') return t.displayName || t.name || null;
        if (typeof t === 'object') {
          var inner = t.render || t.type;
          if (inner && typeof inner === 'function') return inner.displayName || inner.name || null;
          return t.displayName || null;
        }
        return null;
      }

      function parseFrame(stack) {
        if (!stack) return null;
        var s = typeof stack === 'string' ? stack : (stack.stack || '');
        var lines = s.split('\\n').slice(1).filter(function(l) { return l.trim().indexOf('at ') === 0; });
        var target = lines[1] || lines[0];
        if (!target) return null;
        var m = target.trim().match(/at (?:([^\\s(]+) \\()?([^)]+):(\\d+):(\\d+)\\)?/);
        return m ? { fn: m[1] || 'anon', file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) } : null;
      }

      function getFrame(fiber) {
        var frame = parseFrame(fiber._debugStack);
        if (frame) return frame;
        var ds = fiber._debugSource;
        if (ds && ds.fileName) {
          return { fn: 'component', file: ds.fileName, line: ds.lineNumber || 0, col: ds.columnNumber || 0, original: true };
        }
        return null;
      }

      var hostFiber = findHostFiber(root.current.child, 0);
      if (!hostFiber) { done({ error: 'no host fiber' }); return 'ok'; }

      var inspectRef;
      if (useFabric) {
        inspectRef = hostFiber.stateNode;
      } else {
        inspectRef = hostFiber.stateNode.canonical && hostFiber.stateNode.canonical.publicInstance;
      }
      if (!inspectRef) { done({ error: 'no inspect ref' }); return 'ok'; }

      var cfg = renderer.rendererConfig;
      if (!cfg || typeof cfg.getInspectorDataForViewAtPoint !== 'function') {
        done({ error: 'rendererConfig.getInspectorDataForViewAtPoint unavailable' });
        return 'ok';
      }

      cfg.getInspectorDataForViewAtPoint(inspectRef, ${Math.round(x)}, ${Math.round(y)}, function(data) {
        try {
          var items = [];
          var fiber = data.closestInstance;
          if (fiber) {
            var f = fiber, depth = 0;
            while (f && depth < 200) {
              var nm = getName(f);
              if (nm) items.push({ name: nm, depth: depth, frame: getFrame(f) });
              f = f.return;
              depth++;
            }
          } else if (data.hierarchy && data.hierarchy.length) {
            for (var hi of data.hierarchy) items.push({ name: hi.name, depth: 0, frame: null });
          }
          done({ x: ${Math.round(x)}, y: ${Math.round(y)}, items: items });
        } catch (e) {
          done({ error: String((e && e.message) || e) });
        }
      });
      return 'ok';
    } catch (e) {
      done({ error: String((e && e.message) || e) });
      return 'ok';
    }
  })();`;
}
