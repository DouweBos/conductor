import { runAll } from "./runner";
import { flowProperties } from "./flowProperties.test";
import { projects } from "./projects.test";
import { qase } from "./qase.test";
import { parity } from "./parity.test";

void runAll([qase, projects, flowProperties, parity]);
