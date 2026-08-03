#import <objc/runtime.h>

/// Scan every malloc zone for live ObjC instances of `target` (or a subclass),
/// writing their pointers into `out` (up to `cap`). Returns the count found.
/// FLEX-style: read each block's isa, mask it, verify it's a known class, then
/// match against the target's class chain. In-process, same-task reads.
unsigned int conductor_heap_find_instances(Class target, void **out, unsigned int cap);

/// Newline-join names of registered classes matching `pattern` (case-insensitive
/// substring; empty = all) into `out`. Done in C so Swift never touches arbitrary
/// class objects — some (CloudKit, etc.) trap when Swift realizes their metadata.
/// Returns the number of matches written.
int conductor_class_names(const char *pattern, char *out, int out_size);
