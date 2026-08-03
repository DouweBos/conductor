// dyld entry point for the injected Conductor in-process control library.
// The constructor fires at load time, before the host app's main(), and hands
// off to Swift. Server startup is deferred to didFinishLaunching (see loader).
extern void ConductorBootstrap(void);

__attribute__((constructor))
static void conductor_inproc_init(void) {
    ConductorBootstrap();
}
