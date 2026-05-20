// Public header for the ConductorInjectCtor target.
//
// The target's only purpose is to expose a Mach-O __mod_init_func entry via
// __attribute__((constructor)). Nothing here is meant to be #imported — the
// header exists so Swift Package Manager has a valid `include/` directory.
#ifndef CONDUCTOR_INJECT_CTOR_H
#define CONDUCTOR_INJECT_CTOR_H
#endif
