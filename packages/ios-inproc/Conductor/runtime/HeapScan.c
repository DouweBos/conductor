#include "HeapScan.h"
#include <malloc/malloc.h>
#include <mach/mach.h>
#include <stdlib.h>
#include <string.h>

// Weak so we fall back if the runtime doesn't export it.
extern uintptr_t objc_debug_isa_class_mask __attribute__((weak));

// Scan state (single-threaded use; the Swift caller serializes on main).
static Class s_target;
static void **s_out;
static unsigned int s_cap;
static unsigned int s_found;
static uintptr_t s_mask;
static Class *s_classes;   // sorted class pointers, for validating candidate isas
static unsigned int s_class_count;

static int ptr_cmp(const void *a, const void *b) {
    uintptr_t pa = *(const uintptr_t *)a, pb = *(const uintptr_t *)b;
    return (pa < pb) ? -1 : (pa > pb) ? 1 : 0;
}

static int is_known_class(Class c) {
    uintptr_t key = (uintptr_t)c;
    return bsearch(&key, s_classes, s_class_count, sizeof(uintptr_t), ptr_cmp) != NULL;
}

static void recorder(task_t task, void *ctx, unsigned type, vm_range_t *ranges, unsigned count) {
    (void)task; (void)ctx; (void)type;
    for (unsigned i = 0; i < count; i++) {
        vm_range_t r = ranges[i];
        if (r.size < sizeof(void *)) continue;
        uintptr_t raw = *(uintptr_t *)r.address;
        Class cls = (Class)(raw & s_mask);
        if (!cls || !is_known_class(cls)) continue;
        // Walk the class chain to the target.
        Class c = cls;
        while (c) {
            if (c == s_target) {
                if (s_found < s_cap) s_out[s_found++] = (void *)r.address;
                break;
            }
            c = class_getSuperclass(c);
        }
        if (s_found >= s_cap) return;
    }
}

int conductor_class_names(const char *pattern, char *out, int out_size) {
    unsigned int n = objc_getClassList(NULL, 0);
    Class *classes = (Class *)malloc(sizeof(Class) * n);
    if (!classes) return 0;
    objc_getClassList(classes, n);
    int pos = 0, matched = 0;
    int has_pattern = pattern && pattern[0];
    for (unsigned int i = 0; i < n; i++) {
        const char *name = class_getName(classes[i]);
        if (!name) continue;
        if (has_pattern && !strcasestr(name, pattern)) continue;
        int len = (int)strlen(name);
        if (pos + len + 1 >= out_size) break;
        memcpy(out + pos, name, len);
        pos += len;
        out[pos++] = '\n';
        matched++;
    }
    out[pos] = 0;
    free(classes);
    return matched;
}

unsigned int conductor_heap_find_instances(Class target, void **out, unsigned int cap) {
    if (!target || !out || cap == 0) return 0;
    s_target = target;
    s_out = out;
    s_cap = cap;
    s_found = 0;
    s_mask = (&objc_debug_isa_class_mask != NULL) ? objc_debug_isa_class_mask : 0x0000000ffffffff8ULL;

    // Snapshot + sort every registered class so recorder can validate candidate isas.
    s_class_count = objc_getClassList(NULL, 0);
    s_classes = (Class *)malloc(sizeof(Class) * s_class_count);
    if (!s_classes) return 0;
    objc_getClassList(s_classes, s_class_count);
    qsort(s_classes, s_class_count, sizeof(uintptr_t), ptr_cmp);

    vm_address_t *zones = NULL;
    unsigned int zone_count = 0;
    if (malloc_get_all_zones(mach_task_self(), NULL, &zones, &zone_count) == KERN_SUCCESS) {
        for (unsigned int i = 0; i < zone_count; i++) {
            malloc_zone_t *zone = (malloc_zone_t *)zones[i];
            if (!zone || !zone->introspect || !zone->introspect->enumerator) continue;
            zone->introspect->enumerator(mach_task_self(), NULL,
                                         MALLOC_PTR_IN_USE_RANGE_TYPE,
                                         (vm_address_t)zone, NULL, recorder);
            if (s_found >= s_cap) break;
        }
    }

    free(s_classes);
    s_classes = NULL;
    return s_found;
}
