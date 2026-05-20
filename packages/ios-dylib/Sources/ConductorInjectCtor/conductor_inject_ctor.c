// Module-load constructor for libConductorInject.
//
// Swift module-level `let` initializers don't fire on DYLD_INSERT_LIBRARIES
// load — they run on first access of the symbol, which the target app never
// performs. A real Mach-O __mod_init_func entry is required so dyld invokes
// us during image binding, before main(). This file provides that entry via
// __attribute__((constructor)).
//
// The Swift side declares `ConductorInjectInit` with @_cdecl, so we can call
// it from C with no header bridging. It dispatches its real work onto the
// main run loop, so it's safe to invoke this early in process startup.
extern void ConductorInjectInit(void);

__attribute__((constructor))
static void conductor_inject_ctor(void) {
    ConductorInjectInit();
}
